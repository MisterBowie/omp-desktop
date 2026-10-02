/**
 * Test-double helpers for the turn fence (M5/T20-B1 second repair).
 *
 * Excluded from the package build (see `tsconfig.json`): it exists for
 * `vitest` and for the desktop's own test doubles, so a fake runtime answers
 * the fence's two RPCs exactly the way the shipped gate does without every
 * fixture re-implementing the wire contract.
 */
import type { OmpFrame } from "../protocol.js";
import { encodeTurnAck, OMP_TURN_COMMAND, turnCommandToken } from "./turn-fence.js";

/**
 * Serve the fence when `command` is one of its two RPCs: answer the
 * availability query with the registered command, and acknowledge the
 * handshake through `emit` (the fake's frame fan-out). Returns `null` for
 * every other command, which the fake then handles as before. `observeToken`
 * receives each accepted token, so a test can build genuine and stale refusal
 * descriptors without guessing.
 */
export function serveTurnFenceCommand(
  command: OmpFrame,
  emit: (frame: OmpFrame) => void,
  observeToken?: (token: string) => void,
): { success?: boolean; data?: unknown } | null {
  if (command.type === "get_available_commands") {
    return {
      success: true,
      data: { commands: [{ name: OMP_TURN_COMMAND, description: "internal", source: "extension" }] },
    };
  }
  if (command.type === "prompt") {
    const token = turnCommandToken(command.message);
    if (token) {
      observeToken?.(token);
      emit({
        type: "extension_ui_request",
        id: `fence-ack-${token}`,
        method: "notify",
        message: encodeTurnAck(token),
      });
      return { success: true };
    }
  }
  return null;
}
