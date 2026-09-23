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

/** Milliseconds from the end of one read to the start of the next poll. */
const POLL_INTERVAL_MS = 2_000;

/**
 * The OMP-only detail read for one child, mapped into the existing
 * `SubagentRun` structure. Pi sessions never enter this path (`omp` is false),
 * so their detail keeps reading the persisted/live transcript untouched.
 *
 * The read is a local projection: rows land only in component state, never in
 * the main transcript persistence or any tool side effect.
 *
 * One read in flight: the initial load, the live poll, and a manual
 * reload/retry all share one coordinator. Concurrent triggers coalesce onto
 * the in-flight read instead of starting parallel list/read chains, and the
 * next poll is scheduled only after a read completes (2s later), including
 * after a manually triggered read. A request slower than the interval can
 * therefore never be overlapped by the next poll.
 *
 * Polling follows `running`: it arms from each read completion while running
 * is true, cancels the moment running becomes false, and *resumes* (on the
 * same selection) when running turns true again — that transition triggers one
 * read through the shared coordinator, preserving the accumulated rows and
 * cursor instead of resetting them.
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
  /** Monotonic request id: a stale response (selection change / disable / unmount) is dropped. */
  const requestSeq = useRef(0);
  /** The single in-flight read; concurrent triggers join it instead of starting another. */
  const inFlightRef = useRef<Promise<void> | null>(null);
  /** The armed continuation poll, cleared whenever polling must stop. */
  const pollTimerRef = useRef<number | null>(null);
  /** Latest `omp`/`running`, readable from the stable read-completion closure. */
  const ompRef = useRef(omp);
  const runningRef = useRef(opts.running);
  /** Previous `opts.running`, to detect the idle/stopped -> running transition. */
  const prevRunningRef = useRef(opts.running);

  const performRead = useCallback(async (sid: string, did: string): Promise<void> => {
    const seq = ++requestSeq.current;
    // Keep existing rows visible while a continuation is in flight; only a
    // first read (nothing accumulated yet) shows the loading state.
    setPhase((current) => (messagesRef.current.length === 0 ? "loading" : current));
    try {
      const result = await fetchOmpSubagentDetail(
        { list: api.listOmpSubagents, read: api.readOmpSubagent },
        sid,
        did,
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
  }, []);

  // The latest `requestRead` for the armed poll to re-enter without holding a
  // stale closure or a useCallback cycle.
  const requestReadRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const requestRead = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const promise = performRead(sessionId, delegationId).finally(() => {
      // Only the read that still owns the slot may clear it and arm the next
      // poll; a stale completion (selection change / disable / unmount) sees a
      // different (or null) in-flight and does nothing.
      if (inFlightRef.current !== promise) return;
      inFlightRef.current = null;
      if (ompRef.current && runningRef.current) {
        if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = window.setTimeout(() => {
          pollTimerRef.current = null;
          if (ompRef.current && runningRef.current) void requestReadRef.current();
        }, POLL_INTERVAL_MS);
      }
    });
    inFlightRef.current = promise;
    return promise;
  }, [sessionId, delegationId, performRead]);

  // Keep the latest props readable from the stable completion closure.
  useEffect(() => {
    ompRef.current = omp;
    runningRef.current = opts.running;
    requestReadRef.current = requestRead;
  });

  // Initial read and reopen: reset the accumulated set and cursor, then read
  // from the start. The poll self-arms from each read's completion, so the
  // live continuation and the initial load share this one entry point.
  useEffect(() => {
    if (!omp) return;
    messagesRef.current = [];
    cursorRef.current = null;
    setRun(null);
    setErrorDetail(undefined);
    setPhase("idle");
    void requestRead();
  }, [omp, sessionId, delegationId, requestRead]);

  // Selection change, disabling OMP, and unmount invalidate every in-flight
  // request and cancel any armed poll, so an older response cannot populate a
  // newer selection or schedule a poll for a dead one.
  useEffect(() => {
    return () => {
      requestSeq.current += 1;
      inFlightRef.current = null;
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [sessionId, delegationId, omp]);

  // Polling stops the moment the child is no longer running (or OMP is off):
  // an armed poll is cancelled outright rather than left to fire once and
  // no-op. An in-flight read is deliberately left to settle its own rows.
  //
  // Polling also resumes on the idle/stopped -> running transition for the
  // *same* selection: `requestRead` coalesces with any pending read (or starts
  // one), and that read's completion re-arms the next poll. The accumulated
  // rows and cursor are preserved; only a selection/disable/unmount change
  // resets them (in the initial-read and invalidation effects above).
  useEffect(() => {
    const resumed = omp && opts.running && !prevRunningRef.current;
    prevRunningRef.current = opts.running;
    if (resumed) void requestRead();
    if (!omp || !opts.running) {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
  }, [omp, opts.running, requestRead]);

  return { omp, phase, run, errorDetail, reload: () => void requestRead() };
}
