/**
 * The one gate between a runtime's agent envelopes and the renderer.
 *
 * A terminal event (`agent_end` / `error`) ends a turn. The Pi runtime's turn
 * ownership map (`activeTurns`) is the authority for "does this terminal still
 * own its session" — a late terminal from a superseded turn must not clear the
 * current turn's state in the Agent Host panel or the renderer.
 *
 * That map only knows Pi turns. An engine whose own runtime guards terminal
 * generations — the OMP bridge emits only for the live generation and drops
 * late frames inside its runner — passes `guardPiTurnOwnership: false`:
 * an OMP session never has a Pi `activeTurns` entry, so the guard would drop
 * *every* OMP terminal and leave the renderer stuck on a turn that already
 * ended (M5/T20-D: a rejected plan could not be resubmitted because the send
 * was queued behind a phantom running turn).
 */
import type { AgentEventEnvelope } from "@pi-desktop/shared";

export type AgentEventEmitOptions = {
  /**
   * When false, the Pi turn-ownership guard is skipped. Only an engine that
   * guards terminal generations itself may pass false.
   */
  guardPiTurnOwnership?: boolean;
};

export type AgentEventFanout = (
  envelope: AgentEventEnvelope,
  options?: AgentEventEmitOptions,
) => void;

/** Build the fan-out from the guard and the two sinks it protects. */
export function createAgentEventFanout(dependencies: {
  isStaleTerminalEvent: (envelope: AgentEventEnvelope) => boolean;
  ingest: (envelope: AgentEventEnvelope) => void;
  send: (envelope: AgentEventEnvelope) => void;
}): AgentEventFanout {
  return (envelope, options = {}) => {
    if (options.guardPiTurnOwnership !== false && dependencies.isStaleTerminalEvent(envelope)) {
      return;
    }
    dependencies.ingest(envelope);
    dependencies.send(envelope);
  };
}
