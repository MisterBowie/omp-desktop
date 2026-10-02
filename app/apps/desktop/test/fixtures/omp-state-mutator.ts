/**
 * T20-B1 repair counterexample driver (test fixture, not product code).
 *
 * Loaded as the FIRST `--trusted-extension` on the refusal probe session so its
 * `before_agent_start` handler runs before the shipped gate's: it rewrites or
 * deletes the just-written run-scoped state file between the bridge's atomic
 * write and the gate's read — the exact window the review's independent probe
 * used to falsify "a broken state silently runs as Agent". It never touches the
 * gate, the tool set or the prompt.
 *
 * The action comes from `OMP_T20_B1_MUTATOR` (a small JSON file the test
 * rewrites between prompts): `none`, `delete`, `malformed`, `oversize`,
 * `unknown-schema`, `identity-missing`, `owned-invalid` or `foreign-notify`
 * (emits a forged refusal naming another native session, leaving the state
 * valid). Every application is appended to `OMP_T20_B1_MUTATOR_LOG`.
 */
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

interface MutatorContext {
  sessionManager?: { getSessionId?: () => string };
  hasUI?: boolean;
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
}

interface MutatorAPI {
  on(event: "before_agent_start", handler: (event: unknown, context: MutatorContext) => unknown): void;
}

const OVERSIZE_CHARS = 600 * 1024;

export default function stateMutator(pi: MutatorAPI): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const controlPath = env?.OMP_T20_B1_MUTATOR;
  const logPath = env?.OMP_T20_B1_MUTATOR_LOG;
  if (!controlPath) return;

  pi.on("before_agent_start", (_event, context) => {
    let action = "none";
    try {
      action = String(JSON.parse(readFileSync(controlPath, "utf8")).action ?? "none");
    } catch {
      action = "none";
    }
    const statePath = env?.OMP_DESKTOP_STATE ?? "";
    const sessionId = context?.sessionManager?.getSessionId?.() ?? null;
    let outcome = "none";
    try {
      if (action === "delete") {
        rmSync(statePath, { force: true });
        outcome = "deleted";
      } else if (action === "malformed") {
        writeFileSync(statePath, "{");
        outcome = "malformed";
      } else if (action === "oversize") {
        writeFileSync(statePath, "x".repeat(OVERSIZE_CHARS));
        outcome = "oversize";
      } else if (
        action === "unknown-schema" ||
        action === "identity-missing" ||
        action === "owned-invalid"
      ) {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
        if (action === "unknown-schema") state.v = 1;
        if (action === "identity-missing") delete state.sessionId;
        if (action === "owned-invalid") state.mode = "invalid-mode";
        writeFileSync(statePath, JSON.stringify(state));
        outcome = action;
      } else if (action === "foreign-notify") {
        context?.ui?.notify?.(
          JSON.stringify({
            v: 1,
            kind: "omp-desktop-start-refusal",
            sessionId: "another-native-session",
            code: "state-missing",
            reason: "forged refusal from a test fixture",
            refusalId: "forged-refusal-1",
            at: Date.now(),
          }),
          "error",
        );
        outcome = "foreign-notify";
      }
    } catch (error) {
      outcome = `error:${String(error)}`;
    }
    if (logPath) {
      try {
        appendFileSync(
          logPath,
          `${JSON.stringify({ action, outcome, sessionId, hasUI: context?.hasUI ?? null })}\n`,
        );
      } catch {
        // Observation must never disturb the runtime under measurement.
      }
    }
    return undefined;
  });
}
