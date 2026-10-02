/**
 * T20-B1 witness extension (test fixture, not product code).
 *
 * Loaded as a second `--trusted-extension` after the product gate so the
 * real product path runs unchanged while this observer records, for every
 * `before_agent_start` handler invocation:
 *
 *   - the attempt sequence per prompt (one line per invocation; the runtime
 *     re-runs handlers on a policy retry, so grouping by `prompt` yields the
 *     real attempt count);
 *   - the session id the firing session reports (parent vs subagent);
 *   - the byte lengths of the system-prompt parts and their hash (the parts
 *     the gate already produced remain observable);
 *   - the live active-tool selection after any earlier handler's clamp.
 *
 * It returns `undefined` from the handler: it never modifies policy, prompt or
 * tools. Output path comes from `OMP_T20_B1_WITNESS`; without it the
 * extension is inert.
 */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

interface BeforeAgentStartEvent {
  type?: string;
  prompt?: string;
  systemPrompt?: unknown;
}

interface WitnessContext {
  sessionManager?: { getSessionId?: () => string };
}

interface ExtensionAPI {
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: WitnessContext) => unknown): void;
  getActiveTools?: () => string[];
}

export default function runtimeStateWitness(pi: ExtensionAPI): void {
  const path = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.OMP_T20_B1_WITNESS;
  if (!path) return;
  let attempt = 0;
  pi.on("before_agent_start", (event, context) => {
    attempt += 1;
    try {
      const parts = Array.isArray(event?.systemPrompt) ? event.systemPrompt.map((part) => String(part)) : [];
      const joined = parts.join("\n\n");
      appendFileSync(
        path,
        `${JSON.stringify({
          attempt,
          prompt: typeof event?.prompt === "string" ? event.prompt : null,
          sessionId: context?.sessionManager?.getSessionId?.() ?? null,
          partBytes: parts.map((part) => Buffer.byteLength(part, "utf8")),
          sha256: createHash("sha256").update(joined).digest("hex"),
          activeTools: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : null,
        })}\n`,
      );
    } catch {
      // Observation must never disturb the runtime under measurement.
    }
    return undefined;
  });
}
