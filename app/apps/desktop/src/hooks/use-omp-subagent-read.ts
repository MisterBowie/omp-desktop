import { useCallback, useEffect, useRef, useState } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import type { SubagentRun } from "../lib/assistant-turns";
import { api } from "../lib/api";
import {
  buildSubagentRun,
  fetchOmpSubagentDetail,
  mergeSubagentMessages,
} from "../lib/omp-subagent-read";
import { useAppStore } from "../stores/app-store";

export type OmpSubagentReadPhase = "idle" | "loading" | "ready" | "empty" | "error";

/**
 * The OMP-only detail read for one child, mapped into the existing
 * `SubagentRun` structure. Pi sessions never enter this path (`omp` is false),
 * so their detail keeps reading the persisted/live transcript untouched.
 *
 * The read is a local projection: rows land only in component state, never in
 * the main transcript persistence or any tool side effect.
 *
 * Incremental semantics: the bridge returns only the bytes since `fromByte`, so
 * each read's rows are *merged* into the accumulated set by stable message id.
 * A `reset` response (the cursor was ahead of the file) replaces the set. A
 * read with no new rows preserves the current detail and still advances the
 * cursor to `nextByte`.
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
  const messagesRef = useRef<UiMessage[]>([]);
  const cursorRef = useRef<number | null>(null);
  /** Monotonic request id: a stale response (selection change / unmount) is dropped. */
  const requestSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    // Keep existing rows visible while a continuation is in flight; only a
    // first read (nothing accumulated yet) shows the loading state.
    setPhase((current) => (messagesRef.current.length === 0 ? "loading" : current));
    try {
      const result = await fetchOmpSubagentDetail(
        { list: api.listOmpSubagents, read: api.readOmpSubagent },
        sessionId,
        delegationId,
        cursorRef.current ?? undefined,
      );
      if (requestSeq.current !== seq) return;
      // The cursor always advances to `nextByte`, including on reset (the reset
      // response already re-read from 0 through `nextByte`).
      cursorRef.current = result.cursor.nextByte;
      const messages = result.cursor.reset
        ? result.messages
        : mergeSubagentMessages(messagesRef.current, result.messages);
      messagesRef.current = messages;
      setErrorDetail(undefined);
      if (messages.length === 0) {
        setRun(null);
        setPhase("empty");
      } else {
        setRun(buildSubagentRun(messages));
        setPhase("ready");
      }
    } catch (error) {
      if (requestSeq.current !== seq) return;
      setErrorDetail(error instanceof Error ? error.message : String(error));
      setPhase("error");
    }
  }, [sessionId, delegationId]);

  // Initial read and reopen: reset the accumulated set and cursor, then read
  // from the start.
  useEffect(() => {
    if (!omp) return;
    messagesRef.current = [];
    cursorRef.current = null;
    setRun(null);
    setErrorDetail(undefined);
    setPhase("idle");
    void load();
  }, [omp, sessionId, delegationId, load]);

  // Live continuation while the child is running: schedule the next poll only
  // after the previous read completes (single-flight by construction), so a
  // slow request is never perpetually superseded by an overlapping poll.
  useEffect(() => {
    if (!omp || !opts.running) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      await load();
      if (cancelled) return;
      timer = window.setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [omp, opts.running, load]);

  // Unmount or selection change invalidates every in-flight request so an older
  // response cannot populate a newer selection.
  useEffect(() => {
    return () => {
      requestSeq.current += 1;
    };
  }, [sessionId, delegationId]);

  return { omp, phase, run, errorDetail, reload: () => void load() };
}
