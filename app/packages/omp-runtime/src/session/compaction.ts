import type { AgentEvent } from "@pi-desktop/shared";
import type { OmpSessionRuntime, OmpStopOutcome } from "./runner.js";

type CompactionDeps = {
  emit: (event: AgentEvent) => void;
  reclaim: () => Promise<{ reaped: boolean; cleaned: boolean }>;
  timeoutMs?: number;
};

/** One manual context operation. It owns cancellation even without an agent turn. */
export class OmpManualCompaction {
  private unreclaimed = false;
  private operation: {
    cancelled: boolean;
    runtime: OmpSessionRuntime | null;
    done: Promise<void>;
    release: () => void;
  } | null = null;

  private readonly deps: CompactionDeps;
  constructor(deps: CompactionDeps) { this.deps = deps; }

  get busy(): boolean { return this.operation !== null || this.unreclaimed; }
  get active(): boolean { return this.operation !== null; }

  async run(prepare: () => Promise<OmpSessionRuntime>): Promise<{ accepted: true }> {
    if (this.busy) throw Object.assign(new Error("The session is compacting or awaiting reclamation"), { errorCode: "AGENT_BUSY" });
    let release = () => {};
    const done = new Promise<void>((resolve) => { release = resolve; });
    const operation = { cancelled: false, runtime: null as OmpSessionRuntime | null, done, release };
    this.operation = operation;
    this.deps.emit({ type: "compaction_start", reason: "manual" });
    let ok = false;
    let answered = false;
    try {
      const runtime = await prepare();
      operation.runtime = runtime;
      if (operation.cancelled) throw new Error("Compaction cancelled");
      const response = await runtime.request({ type: "compact" }, { timeoutMs: 120_000 });
      answered = true;
      if (operation.cancelled) throw new Error("Compaction cancelled");
      if (response.success !== true) throw new Error(response.error ?? "The runtime refused compaction");
      ok = true;
      return { accepted: true };
    } catch (cause) {
      if (operation.runtime && !answered) {
        this.unreclaimed = true;
        try {
          const result = await this.deps.reclaim();
          this.unreclaimed = !result.reaped || !result.cleaned;
        } catch { /* The retained obligation is retried by Stop. */ }
      }
      throw Object.assign(new Error(operation.cancelled ? "Compaction cancelled" : "Context compaction failed", { cause }), {
        errorCode: "CONTEXT_COMPACTION_FAILED",
      });
    } finally {
      if (this.operation === operation) this.operation = null;
      operation.release();
      this.deps.emit({ type: "compaction_end", reason: "manual", ok, willRetry: false });
    }
  }

  async stop(): Promise<OmpStopOutcome> {
    const operation = this.operation;
    if (!operation && !this.unreclaimed) return { aborted: false, abortBashSent: false, converged: true, toreDown: false, steps: [], errors: [] };
    if (!operation) {
      const result = await this.deps.reclaim();
      this.unreclaimed = !result.reaped || !result.cleaned;
      return { aborted: false, abortBashSent: false, converged: false, toreDown: result.reaped, steps: ["retry compaction reclamation"], errors: this.unreclaimed ? ["Compaction reclamation is incomplete"] : [] };
    }
    operation.cancelled = true;
    const errors: string[] = [];
    let aborted = false;
    if (operation.runtime) {
      try {
        const result = await operation.runtime.request({ type: "abort" }, { timeoutMs: this.deps.timeoutMs ?? 2_000 });
        aborted = result.success === true;
      } catch { errors.push("The runtime did not acknowledge compaction cancellation"); }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const converged = await Promise.race([
      operation.done.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.deps.timeoutMs ?? 2_000); }),
    ]).finally(() => clearTimeout(timer));
    if (converged) return { aborted, abortBashSent: false, converged: true, toreDown: false, steps: ["abort compaction"], errors };
    const result = await this.deps.reclaim();
    this.unreclaimed = !result.reaped || !result.cleaned;
    if (!result.reaped || !result.cleaned) errors.push("Compaction runtime reclamation is incomplete");
    return { aborted, abortBashSent: false, converged: false, toreDown: result.reaped, steps: ["abort compaction", "reclaim runtime"], errors };
  }
}
