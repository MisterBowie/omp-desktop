/**
 * The request/response half of the OMP RPC transport.
 *
 * Responsibilities, and the failure classification each one owes its caller:
 *
 *   - **Framing.** stdout is NDJSON; a frame larger than one line arrives as an
 *     ordered `rpc_chunk` sequence that must be decoded *before* response
 *     matching, or a large response never reaches the caller waiting for it.
 *   - **Matching.** A request is matched by id; a response for an unknown id is
 *     an event, not an error.
 *   - **Settling.** Every pending request is settled exactly once — success,
 *     typed timeout, or the *actual* error when the stream breaks, the write
 *     fails, or the process exits. "Timeout" is reported only when the timeout
 *     itself elapsed; a broken stream is never laundered into a timeout.
 *   - **Decoding failures are fatal.** The pinned decoder cannot resynchronise:
 *     once a sequence is corrupted every later frame is rejected against the
 *     stuck state, so the transport fails and the runtime must be rebuilt.
 *   - **`rpc_chunk` is outbound only.** Writing one is refused here rather than
 *     sent, because the runtime answers it with `Unknown command`.
 */
import { randomBytes } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { OmpRuntimeError } from "./errors.js";
import { NdjsonReader, type NdjsonError } from "./ndjson.js";
import {
  RpcChunkDecoder,
  RpcChunkError,
  isOmpFrame,
  isOmpResponseFrame,
  type OmpFrame,
  type OmpResponseFrame,
} from "./protocol.js";

/** Default per-request deadline; the runtime answers local commands in ms. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** stderr kept for diagnostics; the runtime's own logs are unbounded. */
export const STDERR_TAIL_CHARS = 8_000;

export type OmpTransportOptions = {
  child: ChildProcessWithoutNullStreams;
  maxLineBytes?: number;
  onFrame?: (frame: OmpFrame) => void;
  onProtocolError?: (error: NdjsonError | RpcChunkError) => void;
};

type Pending = {
  command: string;
  resolve: (frame: OmpResponseFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

export class OmpTransport {
  readonly pid: number | null;
  /** Physical `rpc_chunk` lines seen (protocol v2 framing). */
  chunkFramesSeen = 0;
  /** Logical frames that only became available after reassembly. */
  chunksAssembled = 0;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new RpcChunkDecoder();
  private readonly reader: NdjsonReader;
  private readonly pending = new Map<string, Pending>();
  private readonly frameHandlers = new Set<(frame: OmpFrame) => void>();
  private readonly protocolErrorSink:
    | ((error: NdjsonError | RpcChunkError) => void)
    | undefined;
  private readonly protocolErrorLog: string[] = [];
  private readonly failureHandlers = new Set<(error: OmpRuntimeError) => void>();
  private stderr = "";
  private failure: OmpRuntimeError | null = null;
  private disposed = false;

  constructor(options: OmpTransportOptions) {
    this.child = options.child;
    this.pid = this.child.pid ?? null;
    this.reader = new NdjsonReader({ maxLineBytes: options.maxLineBytes });
    this.protocolErrorSink = options.onProtocolError;
    if (options.onFrame) this.frameHandlers.add(options.onFrame);

    // Read and error handlers are installed before anything is written: an
    // asynchronous stream error is not catchable by the writer's try/catch.
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stdout.on("error", (error: Error) => this.fail("stdout", error));
    this.child.stderr.on("error", (error: Error) => this.fail("stderr", error));
    this.child.stdin.on("error", (error: Error) => this.fail("stdin", error));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (text: string) => {
      this.stderr = (this.stderr + text).slice(-STDERR_TAIL_CHARS);
    });
    this.child.on("exit", (code, signal) => {
      this.fail(
        "exit",
        new OmpRuntimeError(
          "not-started",
          `OMP runtime exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
          this.stderrTail(),
        ),
      );
    });
    this.child.on("error", (error: Error) => this.fail("child", error));
  }

  /** The failure that made this transport unusable, if any. */
  get transportFailure(): OmpRuntimeError | null {
    return this.failure;
  }

  get usable(): boolean {
    return !this.disposed && this.failure === null;
  }

  /** Bounded stderr tail: the runtime's own diagnostics, for logs only. */
  stderrTail(): string {
    return this.stderr.slice(-1000);
  }

  /**
   * Observe the failure that makes this transport unusable.
   *
   * A request's own promise settles too, but a caller waiting on something else
   * (readiness, an event) needs the cause without polling.
   */
  onFailure(handler: (error: OmpRuntimeError) => void): () => void {
    this.failureHandlers.add(handler);
    return () => this.failureHandlers.delete(handler);
  }

  onFrame(handler: (frame: OmpFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  /** Protocol-level problems observed while reading (bounded, newest last). */
  protocolErrors(): readonly string[] {
    return this.protocolErrorLog;
  }

  /**
   * Send one command and resolve with its response frame.
   *
   * Never rejects for a runtime-level failure: a `success: false` response is
   * the caller's to interpret. It rejects only for transport conditions the
   * caller cannot see otherwise — those carry the real cause.
   */
  request(
    command: OmpFrame,
    options: { timeoutMs?: number; id?: string } = {},
  ): Promise<OmpResponseFrame> {
    const id = options.id ?? `req-${randomBytes(4).toString("hex")}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const payload: OmpFrame = { ...command, id };
    const protocolErrorsBefore = this.protocolErrorLog.length;

    return new Promise<OmpResponseFrame>((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (!this.write(payload)) return reject(this.failure ?? this.disposedError());
      const timer: NodeJS.Timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // Only a real elapsed deadline is reported as a timeout; anything the
        // stream reported first would have settled this request already.
        const since = this.protocolErrorLog.slice(protocolErrorsBefore);
        reject(
          new OmpRuntimeError(
            "request-timeout",
            `no response to ${String(command.type)} within ${timeoutMs} ms`,
            since.length > 0 ? `protocol errors while waiting: ${since.join("; ")}` : undefined,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        command: String(command.type),
        resolve,
        reject,
        timer,
      });
    });
  }

  /**
   * Write one frame.
   *
   * Returns false when the transport is unusable (the caller's request then
   * fails with the recorded cause). Throws for a frame this client must never
   * send: the runtime treats an inbound `rpc_chunk` as `Unknown command`, so
   * silently writing one would produce a protocol error on the far side.
   */
  write(frame: OmpFrame): boolean {
    if (frame.type === "rpc_chunk") {
      throw new OmpRuntimeError(
        "transport-failed",
        "refusing to send an rpc_chunk frame: chunking is outbound-only",
      );
    }
    if (this.failure || this.disposed) return false;
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.fail("stdin", new OmpRuntimeError("transport-failed", "runtime stdin is not writable"));
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) this.fail("stdin", error);
      });
      return true;
    } catch (error) {
      this.fail("stdin", error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** Close the transport and settle every pending request with `reason`. */
  dispose(reason?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    const failure =
      reason instanceof OmpRuntimeError
        ? reason
        : reason
          ? new OmpRuntimeError("transport-failed", reason.message, this.stderrTail())
          : this.disposedError();
    for (const handler of this.failureHandlers) handler(failure);
    this.failureHandlers.clear();
    this.settleAll(failure);
    this.frameHandlers.clear();
  }

  // -------------------------------------------------------------------------

  private disposedError(): OmpRuntimeError {
    return new OmpRuntimeError("stopping", "the runtime transport is closed");
  }

  private onStdout(chunk: Buffer): void {
    if (this.disposed) return;
    const { frames, errors } = this.reader.push(chunk);
    for (const error of errors) this.recordProtocolError(error);
    for (const raw of frames) this.onRawFrame(raw);
  }

  private onRawFrame(raw: unknown): void {
    if (!isOmpFrame(raw)) {
      this.recordProtocolError({
        kind: "invalid-json",
        sample: JSON.stringify(raw)?.slice(0, 200) ?? String(raw),
      } as NdjsonError);
      return;
    }
    let frame: OmpFrame | undefined;
    try {
      frame = this.decoder.push(raw);
    } catch (error) {
      const chunkError =
        error instanceof RpcChunkError
          ? error
          : new RpcChunkError(String((error as Error)?.message ?? error), "not-an-object");
      this.recordProtocolError(chunkError);
      // Fatal by design: the pinned decoder has no resynchronisation path, so
      // every later frame would be rejected against the stuck pending state.
      this.fail(
        "stream",
        new OmpRuntimeError(
          "transport-failed",
          `chunk decode failed: ${chunkError.message}`,
          chunkError.kind,
        ),
      );
      return;
    }
    if (frame === undefined) {
      this.chunkFramesSeen += 1;
      return;
    }
    if (raw.type === "rpc_chunk") this.chunksAssembled += 1;

    if (isOmpResponseFrame(frame) && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        this.pending.delete(frame.id);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
    }
    for (const handler of this.frameHandlers) handler(frame);
  }

  private recordProtocolError(error: NdjsonError | RpcChunkError): void {
    const message =
      error instanceof RpcChunkError
        ? `chunk:${error.kind}: ${error.message}`
        : error.kind === "line-too-large"
          ? `line-too-large: dropped a ${error.bytes}-character line`
          : `invalid-json: ${error.sample}`;
    this.protocolErrorLog.push(message);
    if (this.protocolErrorLog.length > 50) this.protocolErrorLog.shift();
    this.protocolErrorSink?.(error);
  }

  private fail(where: string, error: Error): void {
    if (this.failure || this.disposed) return;
    const failure =
      error instanceof OmpRuntimeError
        ? error
        : new OmpRuntimeError(
            "transport-failed",
            `${where}: ${error.message}`,
            this.stderrTail(),
          );
    this.failure = failure;
    for (const handler of this.failureHandlers) handler(failure);
    this.failureHandlers.clear();
    this.settleAll(failure);
  }

  private settleAll(error: OmpRuntimeError): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}
