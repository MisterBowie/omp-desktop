/** Shared real Chromium/Node inspector transport for owned application tests. */
const CDP_TIMEOUT_MS = 15_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function shortText(value, max = 700) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function jsonText(value, max = 900) {
  return shortText(JSON.stringify(value), max);
}


function failPending(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

export class CdpClient {
  constructor(onFailure) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.onFailure = onFailure;
    this.closed = false;
  }

  static async connect(url, onFailure, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
    assert(typeof WebSocket === "function", "Node WebSocket global is unavailable");
    const client = new CdpClient(onFailure);
    await new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(url);
      client.socket = socket;
      const finish = (error) => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        if (error) {
          client.closed = true;
          socket.close();
          rejectOpen(error);
        } else resolveOpen();
      };
      const opened = () => finish();
      const failed = () => finish(new Error(`CDP WebSocket connection failed: ${url}`));
      const timer = setTimeout(() => finish(new Error(`CDP WebSocket connection timed out: ${url}`)), timeoutMs);
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
    });
    client.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        client.fail(new Error(`invalid CDP message: ${errorText(error)}`));
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const entry = client.pending.get(String(message.id));
        if (!entry) return;
        client.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(`CDP ${entry.method} failed: ${message.error.message || jsonText(message.error)}`);
          error.cdp = true;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of client.handlers.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
      }
    });
    client.socket.addEventListener("close", () => {
      if (client.closed) return;
      client.closed = true;
      const error = new Error("CDP WebSocket closed unexpectedly");
      error.cdp = true;
      failPending(client.pending, error);
      client.onFailure?.(error);
    });
    return client;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    error.cdp = true;
    failPending(this.pending, error);
    try { this.socket?.close(); } catch { /* Already torn down. */ }
    this.onFailure?.(error);
  }

  on(method, listener) {
    const listeners = this.handlers.get(method) ?? [];
    listeners.push(listener);
    this.handlers.set(method, listeners);
    return () => {
      this.handlers.set(
        method,
        (this.handlers.get(method) ?? []).filter((candidate) => candidate !== listener),
      );
    };
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed || !this.socket) {
      const error = new Error(`CDP is unavailable for ${method}`);
      error.cdp = true;
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(String(id))) return;
        const error = new Error(`CDP timeout ${method} after ${timeoutMs}ms`);
        error.cdp = true;
        rejectResult(error);
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve: resolveResult, reject: rejectResult, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        const cdpError = error instanceof Error ? error : new Error(String(error));
        cdpError.cdp = true;
        rejectResult(cdpError);
      }
    });
  }

  async evaluate(expression, context = "renderer", { awaitPromise = true } = {}) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        `${context} evaluation threw`;
      throw new Error(`${context} evaluation failed: ${shortText(description)}`);
    }
    return response?.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    failPending(this.pending, new Error("CDP closed by acceptance harness"));
    try {
      this.socket?.close();
    } catch {
      // Already torn down.
    }
  }
}
