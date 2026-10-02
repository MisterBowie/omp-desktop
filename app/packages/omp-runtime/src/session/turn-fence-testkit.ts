/**
 * Test-double helpers for the turn fence (M5/T20-B1 second repair).
 *
 * Excluded from the package build (see `tsconfig.json`): it exists for
 * `vitest` and for the desktop's own test doubles, so a fake runtime answers
 * the fence's two RPCs exactly the way the shipped gate does without every
 * fixture re-implementing the wire contract.
 */
import type { OmpFrame } from "../protocol.js";
import { admissionDigest, decodeTurnAdmission, type OmpTurnAdmission } from "./turn-admission.js";
import { encodeTurnAck, OMP_TURN_COMMAND, parseTurnCommand } from "./turn-fence.js";

/**
 * Serve the fence when `command` is one of its two RPCs: answer the
 * availability query with the registered command, and acknowledge the
 * handshake through `emit` (the fake's frame fan-out), echoing the admission
 * digest exactly the way the shipped gate does. Returns `null` for every
 * other command, which the fake then handles as before. `observeToken`
 * receives each accepted token, so a test can build genuine and stale refusal
 * descriptors without guessing; `observeAdmission` receives the decoded
 * admission when the handshake carried one.
 */
export function serveTurnFenceCommand(
  command: OmpFrame,
  emit: (frame: OmpFrame) => void,
  observeToken?: (token: string) => void,
  observeAdmission?: (admission: OmpTurnAdmission | null) => void,
): { success?: boolean; data?: unknown } | null {
  if (command.type === "get_available_commands") {
    return {
      success: true,
      data: { commands: [{ name: OMP_TURN_COMMAND, description: "internal", source: "extension" }] },
    };
  }
  if (command.type === "prompt") {
    const parsed = parseTurnCommand(command.message);
    if (parsed) {
      observeToken?.(parsed.token);
      if (parsed.admission === null) {
        observeAdmission?.(null);
        emit({
          type: "extension_ui_request",
          id: `fence-ack-${parsed.token}`,
          method: "notify",
          message: encodeTurnAck(parsed.token, null),
        });
        return { success: true };
      }
      const admission = decodeTurnAdmission(parsed.admission);
      observeAdmission?.(admission);
      if (!admission) return { success: true };
      emit({
        type: "extension_ui_request",
        id: `fence-ack-${parsed.token}`,
        method: "notify",
        message: encodeTurnAck(parsed.token, admissionDigest(parsed.admission)),
      });
      return { success: true };
    }
  }
  return null;
}
