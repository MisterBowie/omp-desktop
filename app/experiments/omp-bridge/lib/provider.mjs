/**
 * Local OpenAI-compatible fake provider for the M1 experiments.
 *
 * Serves `POST /v1/chat/completions` (SSE) with scripted turns so real OMP can
 * be driven end to end without touching a paid provider. Every request body is
 * recorded for assertions; responses are deterministic.
 *
 * Scripted turn shape:
 *   { text?, thinking?, toolCalls?: [{ id, name, args }], finish?: "stop"|"tool_calls", delayMs? }
 * Turns are consumed in order; the last one repeats.
 */
import { createServer } from "node:http";

const now = () => Math.floor(Date.now() / 1000);

export class FakeProvider {
  /** Requests received (body + headers subset), newest last. */
  requests = [];
  /** Scripted turns, consumed in order (last repeats). */
  turns = [{ text: "ok", finish: "stop" }];
  /** Tool call ids handed out, for assertions. */
  toolCallSeq = 0;

  static async start({ model = "local-model" } = {}) {
    const provider = new FakeProvider();
    provider.model = model;
    await provider.#listen();
    return provider;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  script(turns) {
    this.turns = turns;
    this.routes = null;
    return this;
  }

  /**
   * Route model turns by *session identity* instead of arrival order.
   *
   * A sequential queue cannot serve a parent session and its subagent: the
   * subagent is started asynchronously, so whichever session asks next steals
   * the turn that was meant for the other one. Routing on a marker that only
   * exists in the child's session (its assignment text is the first user
   * message) makes the assignment deterministic without adding delays.
   *
   * @param {{parent?: object[], subagents?: Array<{marker: string, turns: object[]}>}} config
   */
  routeBySession(config) {
    this.routes = {
      parent: config.parent ?? [{ text: "ok", finish: "stop" }],
      subagents: config.subagents ?? [],
    };
    this.turns = null;
    return this;
  }

  /** Which session a request belongs to, from its own content. */
  classifyRequest(body) {
    const messages = body?.messages ?? [];
    const firstUser = messages.find((m) => m.role === "user");
    const firstUserText = typeof firstUser?.content === "string"
      ? firstUser.content
      : JSON.stringify(firstUser?.content ?? "");
    for (const [index, sub] of (this.routes?.subagents ?? []).entries()) {
      if (sub.marker && firstUserText.includes(sub.marker)) return { kind: "subagent", index, marker: sub.marker };
    }
    return { kind: "parent" };
  }

  get lastRequest() {
    return this.requests[this.requests.length - 1];
  }

  /** Messages from the most recent request (for asserting what OMP sent). */
  lastMessages() {
    return this.lastRequest?.body?.messages ?? [];
  }

  async #listen() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => {
        raw += d.toString();
        if (raw.length > 4_000_000) req.destroy();
      });
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* keep null */ }
        this.requests.push({ method: req.method, url: req.url, body, at: Date.now() });

        if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: this.model, object: "model" }] }));
          return;
        }
        if (req.method === "POST" && /\/chat\/completions$/.test(req.url ?? "")) {
          this.#streamCompletion(res, body);
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `fake provider: unexpected ${req.method} ${req.url}` } }));
      });
    });
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = this.server.address().port;
  }

  #nextTurn(body) {
    if (this.routes) {
      const where = this.classifyRequest(body);
      const queue = where.kind === "subagent"
        ? this.routes.subagents[where.index].turns
        : this.routes.parent;
      if (!Array.isArray(queue) || queue.length === 0) return { text: "ok", finish: "stop" };
      // Last turn repeats, so an unexpectedly long session never runs dry.
      const turn = queue.length > 1 ? queue.shift() : queue[0];
      this.lastClassifiedAs = where.kind === "subagent" ? `subagent:${where.marker}` : "parent";
      return turn ?? { text: "ok", finish: "stop" };
    }
    const turn = this.turns.length > 1 ? this.turns.shift() : this.turns[0];
    return turn ?? { text: "ok", finish: "stop" };
  }

  async #streamCompletion(res, body) {
    const turn = this.#nextTurn(body);
    const id = `chatcmpl-fake-${++this.toolCallSeq}`;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (delta, finishReason = null) => {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: now(),
        model: this.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    const emit = async () => {
      if (turn.thinking) send({ reasoning_content: turn.thinking });
      if (turn.text) send({ content: turn.text });
      if (turn.toolCalls?.length) {
        send({
          tool_calls: turn.toolCalls.map((call, index) => ({
            index,
            id: call.id ?? `call_fake_${this.toolCallSeq}_${index}`,
            type: "function",
            function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}) },
          })),
        });
      }
      if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
      const finish = turn.finish ?? (turn.toolCalls?.length ? "tool_calls" : "stop");
      send({}, finish);
      res.write("data: [DONE]\n\n");
      res.end();
    };
    emit().catch(() => { try { res.end(); } catch {} });
  }

  async close() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }
}
