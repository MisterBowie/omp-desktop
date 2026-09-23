import { useCallback, useEffect, useRef, useState } from "react";
import type { SubagentRun } from "../lib/assistant-turns";
import { api } from "../lib/api";
import { fetchOmpSubagentDetail } from "../lib/omp-subagent-read";
import { useAppStore } from "../stores/app-store";

export type OmpSubagentReadPhase = "idle" | "loading" | "ready" | "empty" | "error";

/**
 * The OMP-only detail read for one child, mapped into the existing
 * `SubagentRun` structure. Pi sessions never enter this path (`omp` is false),
 * so their detail keeps reading the persisted/live transcript untouched.
 *
 * The read is a local projection: rows land only in component state, never in
 * the main transcript persistence or any tool side effect.
 */
export function useOmpSubagentRead(
  sessionId: string,
  delegationId: string,
  opts: { enabled: boolean; running: boolean },
): {
  omp: boolean;
  phase: OmpSubagentReadPhase;
  run: SubagentRun | null;
  errorDetail?: string;
  reload: () => void;
} {
  const engine = useAppStore((state) =>
    state.sessions.find((session) => session.id === sessionId)?.engine,
  );
  const omp = engine === "omp" && opts.enabled;

  const [phase, setPhase] = useState<OmpSubagentReadPhase>("idle");
  const [run, setRun] = useState<SubagentRun | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const cursorRef = useRef<number | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (fromByte?: number) => {
      const seq = ++requestSeq.current;
      setPhase("loading");
      try {
        const result = await fetchOmpSubagentDetail(
          { list: api.listOmpSubagents, read: api.readOmpSubagent },
          sessionId,
          delegationId,
          fromByte,
        );
        if (requestSeq.current !== seq) return;
        if (result.kind === "ready") {
          cursorRef.current = result.cursor.reset ? 0 : result.cursor.nextByte;
          setRun(result.run);
          setErrorDetail(undefined);
          setPhase("ready");
        } else if (result.kind === "empty") {
          setRun(null);
          setErrorDetail(undefined);
          setPhase("empty");
        } else {
          setErrorDetail(result.detail);
          setPhase("error");
        }
      } catch (error) {
        if (requestSeq.current !== seq) return;
        setErrorDetail(error instanceof Error ? error.message : String(error));
        setPhase("error");
      }
    },
    [sessionId, delegationId],
  );

  // Initial read and reopen: reset the cursor and read from the start.
  useEffect(() => {
    if (!omp) return;
    setRun(null);
    setPhase("idle");
    setErrorDetail(undefined);
    cursorRef.current = null;
    void load();
  }, [omp, sessionId, delegationId, load]);

  // Live continuation while the child is running: advance the byte cursor.
  useEffect(() => {
    if (!omp || !opts.running) return;
    const timer = setInterval(() => {
      void load(cursorRef.current ?? undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [omp, opts.running, load]);

  // Unmount or selection change invalidates every in-flight request so an older
  // response cannot populate a newer selection.
  useEffect(() => {
    return () => {
      requestSeq.current += 1;
    };
  }, [sessionId, delegationId]);

  return { omp, phase, run, errorDetail, reload: () => load() };
}
