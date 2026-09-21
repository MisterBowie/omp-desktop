/**
 * Real-time connections owned by the host (permission `net.websocket`).
 *
 * A plugin asks for a socket and then sends and receives frames; it never gets
 * the socket object, the TLS session, or the event loop behind it. That is what
 * makes the three things this file enforces possible at all:
 *
 * - Egress stays on the existing allowlist. `connect` is refused for any host
 *   outside `manifest.net.domains`, exactly like `pi.net.fetch`.
 * - Every socket is bounded: a per-plugin count, a maximum frame size in both
 *   directions, and a send queue that refuses rather than growing without
 *   limit, so a plugin that stops reading cannot pin memory in the host.
 * - Every socket dies with its plugin. `releasePlugin` runs on disable, unload,
 *   crash and quit through the same teardown the runtime already performs.
 *
 * The socket factory is injected, so tests drive the whole surface with a fake
 * transport and CI never needs a real server.
 */
import { WebSocket } from "ws";

/** Four sockets is already several more than a voice session needs. */
export const MAX_SOCKETS_PER_PLUGIN = 4;
/** One audio or JSON frame; larger than any real-time protocol frame. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Unflushed bytes allowed per socket before `send` refuses. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export type PluginSocketErrorCode =
  | "INVALID_ARGUMENT"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "CONNECT_FAILED"
  | "TIMEOUT";

/** Thrown for every refusal; `code` is what the plugin sees as `error`. */
export class PluginSocketError extends Error {
  readonly code: PluginSocketErrorCode;

  constructor(code: PluginSocketErrorCode, message: string) {
    super(message);
    this.name = "PluginSocketError";
    this.code = code;
  }
}

/** One frame or lifecycle change, routed to the plugin that owns the socket. */
export type PluginSocketEvent =
  | { type: "open"; socketId: string; protocol: string }
  | { type: "message"; socketId: string; data: string | Uint8Array }
  | { type: "close"; socketId: string; code: number; reason: string; wasClean: boolean }
  | { type: "error"; socketId: string; code: string; message: string };

export type PluginSocketHandlers = {
  onOpen: (info: { protocol: string }) => void;
  onMessage: (data: string | Uint8Array) => void;
  onClose: (info: { code: number; reason: string; wasClean: boolean }) => void;
  onError: (info: { code: string; message: string }) => void;
};

/** The only socket surface this host needs; `ws` provides it in the app. */
export type PluginSocket = {
  send: (data: string | Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
  /** Discard the connection without a close handshake (unload, revocation). */
  terminate: () => void;
  bufferedAmount: () => number;
};

export type PluginSocketFactory = (
  init: { url: string; headers?: Record<string, string>; protocols?: string[] },
  handlers: PluginSocketHandlers,
) => PluginSocket;

export type PluginSocketEntry = {
  pluginId: string;
  socketId: string;
  url: string;
  state: "connecting" | "open" | "closed";
  framesSent: number;
  framesReceived: number;
};

export type PluginWebSocketDependencies = {
  /** Injectable so tests never open a real connection. */
  createSocket?: PluginSocketFactory;
  /** One event per plugin; the runtime forwards it to that plugin's process. */
  onEvent: (pluginId: string, event: PluginSocketEvent) => void;
  maxPerPlugin?: number;
  connectTimeoutMs?: number;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
};

type Entry = { meta: PluginSocketEntry; socket: PluginSocket };

export class PluginWebSocketRegistry {
  private readonly sockets = new Map<string, Entry>();
  private readonly deps: PluginWebSocketDependencies;
  private readonly maxPerPlugin: number;
  private readonly connectTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private nextId = 1;

  constructor(deps: PluginWebSocketDependencies) {
    this.deps = deps;
    this.maxPerPlugin = deps.maxPerPlugin ?? MAX_SOCKETS_PER_PLUGIN;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxFrameBytes = deps.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  }

  /**
   * Open one socket and resolve once it is usable. The hostname is assumed to
   * have passed the caller's egress check already; the shape and the bounds
   * here are this method's own.
   */
  async connect(request: {
    pluginId: string;
    url: string;
    headers?: Record<string, string>;
    protocols?: string[];
    timeoutMs?: number;
  }): Promise<{ socketId: string }> {
    const { pluginId, url } = request;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PluginSocketError("INVALID_ARGUMENT", `url is not absolute: ${url}`);
    }
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      throw new PluginSocketError(
        "INVALID_ARGUMENT",
        `websocket url must be ws:// or wss://: ${url}`,
      );
    }
    if (this.countFor(pluginId) >= this.maxPerPlugin) {
      throw new PluginSocketError(
        "LIMIT_EXCEEDED",
        `a plugin may hold at most ${this.maxPerPlugin} sockets`,
      );
    }
    const protocols = request.protocols?.filter((value) => typeof value === "string");
    if (protocols?.some((value) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value))) {
      throw new PluginSocketError("INVALID_ARGUMENT", "protocols must be token strings");
    }

    const socketId = `ws-${this.nextId++}`;
    const meta: PluginSocketEntry = {
      pluginId,
      socketId,
      url,
      state: "connecting",
      framesSent: 0,
      framesReceived: 0,
    };
    const key = entryKey(pluginId, socketId);

    /** Resolves the pending `connect`; set once, then called at most once. */
    let settle: ((error: PluginSocketError | null) => void) | null = null;
    const opened = new Promise<void>((resolve, reject) => {
      settle = (error) => (error ? reject(error) : resolve());
    });
    const decide = (error: PluginSocketError | null) => {
      const current = settle;
      settle = null;
      current?.(error);
    };

    const socket = (this.deps.createSocket ?? this.defaultFactory)(
      { url, headers: request.headers, protocols },
      {
        onOpen: ({ protocol }) => {
          if (meta.state !== "connecting") return;
          meta.state = "open";
          decide(null);
          this.deps.onEvent(pluginId, { type: "open", socketId, protocol });
        },
        onMessage: (data) => {
          if (meta.state === "closed") return;
          const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          if (size > this.maxFrameBytes) {
            // A frame this large is a peer problem, not a slow consumer: the
            // connection goes away instead of the host buffering it.
            this.fail(pluginId, key, "OVERSIZED_FRAME", `frame of ${size} bytes`);
            return;
          }
          meta.framesReceived += 1;
          this.deps.onEvent(pluginId, { type: "message", socketId, data });
        },
        onClose: ({ code, reason, wasClean }) => {
          const wasConnecting = meta.state === "connecting";
          meta.state = "closed";
          this.sockets.delete(key);
          if (wasConnecting) {
            decide(
              new PluginSocketError(
                "CONNECT_FAILED",
                `socket closed before it opened (${code}: ${reason})`,
              ),
            );
          }
          this.deps.onEvent(pluginId, { type: "close", socketId, code, reason, wasClean });
        },
        onError: ({ code, message }) => {
          if (meta.state === "connecting") {
            decide(new PluginSocketError("CONNECT_FAILED", message));
          }
          this.deps.onEvent(pluginId, { type: "error", socketId, code, message });
        },
      },
    );
    this.sockets.set(key, { meta, socket });

    const timeoutMs = request.timeoutMs ?? this.connectTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PluginSocketError("TIMEOUT", `connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // A pending connect must not keep the app alive or leave a live handle.
      timer.unref?.();
    });

    try {
      await Promise.race([opened, expired]);
      return { socketId };
    } catch (error) {
      // A failed connect must not consume the plugin's socket budget.
      this.release(pluginId, socketId);
      throw error instanceof PluginSocketError
        ? error
        : new PluginSocketError("CONNECT_FAILED", String(error));
    } finally {
      clearTimeout(timer);
      settle = null;
    }
  }

  /** Queue one frame. Refuses rather than growing the queue without bound. */
  send(request: { pluginId: string; socketId: string; data: string | Uint8Array }): void {
    const entry = this.require(request.pluginId, request.socketId);
    const { data } = request;
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    if (size > this.maxFrameBytes) {
      throw new PluginSocketError(
        "LIMIT_EXCEEDED",
        `frame of ${size} bytes exceeds the ${this.maxFrameBytes} byte limit`,
      );
    }
    if (entry.socket.bufferedAmount() + size > this.maxBufferedBytes) {
      throw new PluginSocketError(
        "LIMIT_EXCEEDED",
        "send queue is full; wait for the socket to drain",
      );
    }
    entry.socket.send(data);
    entry.meta.framesSent += 1;
  }

  /** Close with a handshake; the close event still arrives from the socket. */
  close(request: { pluginId: string; socketId: string; code?: number; reason?: string }): void {
    const entry = this.require(request.pluginId, request.socketId);
    entry.socket.close(request.code, request.reason);
  }

  /** Drop every socket of one plugin. Safe for an unknown plugin. */
  releasePlugin(pluginId: string): void {
    for (const entry of [...this.sockets.values()]) {
      if (entry.meta.pluginId === pluginId) this.release(pluginId, entry.meta.socketId);
    }
  }

  /** Sockets this plugin currently holds, in creation order. */
  list(pluginId: string): PluginSocketEntry[] {
    return [...this.sockets.values()]
      .filter((entry) => entry.meta.pluginId === pluginId)
      .map((entry) => ({ ...entry.meta }));
  }

  private require(pluginId: string, socketId: string): Entry {
    const entry = this.sockets.get(entryKey(pluginId, socketId));
    if (!entry) {
      throw new PluginSocketError("NOT_FOUND", `no open socket for this plugin: ${socketId}`);
    }
    return entry;
  }

  private release(pluginId: string, socketId: string): void {
    const key = entryKey(pluginId, socketId);
    const entry = this.sockets.get(key);
    if (!entry) return;
    entry.meta.state = "closed";
    this.sockets.delete(key);
    try {
      // Terminate, not close: unload and revocation are not a negotiation.
      entry.socket.terminate();
    } catch {
      // Teardown is best effort; a wedged socket must not block unload.
    }
  }

  private fail(pluginId: string, key: string, code: string, detail: string): void {
    const entry = this.sockets.get(key);
    if (!entry) return;
    const { socketId } = entry.meta;
    this.deps.onEvent(pluginId, {
      type: "error",
      socketId,
      code,
      message: `${detail}; the connection was closed`,
    });
    this.release(pluginId, socketId);
  }

  private countFor(pluginId: string): number {
    let count = 0;
    for (const entry of this.sockets.values()) {
      if (entry.meta.pluginId === pluginId) count += 1;
    }
    return count;
  }

  private readonly defaultFactory: PluginSocketFactory = (init, handlers) => {
    const socket = new WebSocket(init.url, init.protocols, {
      headers: init.headers,
      handshakeTimeout: this.connectTimeoutMs,
      maxPayload: this.maxFrameBytes,
    });
    socket.on("open", () => handlers.onOpen({ protocol: socket.protocol ?? "" }));
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) {
        handlers.onMessage(data.toString());
        return;
      }
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      handlers.onMessage(new Uint8Array(buffer));
    });
    socket.on("close", (code: number, reason: Buffer) =>
      handlers.onClose({ code, reason: reason.toString(), wasClean: code === 1000 }),
    );
    socket.on("error", (error: Error) => {
      handlers.onError({ code: "SOCKET_ERROR", message: error.message });
    });
    return {
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      terminate: () => socket.terminate(),
      bufferedAmount: () => socket.bufferedAmount,
    };
  };
}

function entryKey(pluginId: string, socketId: string): string {
  return `${pluginId}\u0000${socketId}`;
}
