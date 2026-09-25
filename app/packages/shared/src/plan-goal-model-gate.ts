/**
 * Plan/Goal × Cursor product gate (M5/T20-R3C).
 *
 * The product decision this module encodes: a session may not combine an active
 * Cursor model/provider with Plan or Goal mode. Cursor's exec channel runs tool
 * calls while a response is still streaming — before the assistant message that
 * carries them exists — so PI's transition-tool contract ("the submit tool owns
 * the whole assistant batch; its siblings produce zero side effects") cannot be
 * honoured for a Cursor-backed session, and its effects cannot be undone
 * afterwards. The measured evidence is in `docs/validation/M5-omp-transition-patch.md`
 * §9/§10; instead of claiming strict compatibility, the combination is refused.
 *
 * Identity is the canonical provider id the runtime uses for Cursor, never a
 * display label, a user-typed vendor hint, or an endpoint URL. There is no
 * upstream `isCursor(model)` helper: the pinned runtime compares the provider id
 * literal itself (`packages/catalog/src/compat/provider-ids.ts` → `"cursor"`,
 * consumed as `model.provider === "cursor"` in `packages/ai/src/providers/cursor.ts`).
 *
 * Both directions of the invariant use this one predicate, so the desktop gate
 * and the renderer affordance cannot drift:
 *   - entering Plan/Goal for a session bound to the Cursor provider;
 *   - selecting the Cursor provider for a session already in Plan/Goal.
 */

import { ErrorCodes } from "./errors.js";
import { PROPOSAL_KINDS, type Mode } from "./types.js";

/** The provider id the pinned runtime uses for Cursor. */
export const CURSOR_PROVIDER_ID = "cursor";

export type PlanGoalCursorRefusal = {
  errorCode: typeof ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED;
  /** The contract mode that was requested or is already active. */
  mode: Mode;
  providerId: string;
  message: string;
};

/**
 * Whether a provider identity is the Cursor provider. Exact match on the
 * canonical id: a lower-cased or trimmed variant is *not* treated as Cursor,
 * because no supported surface produces one and guessing would refuse providers
 * that merely mention the name.
 */
export function isCursorProviderId(providerId: unknown): boolean {
  return providerId === CURSOR_PROVIDER_ID;
}

/**
 * The refusal for a (mode, provider) pair, or `null` when the pair is allowed.
 *
 * `mode` accepts an untrusted value: anything that is not Plan or Goal (Agent,
 * a legacy value, or a missing field) is not a contract mode and never conflicts.
 * The contract kinds come from `PROPOSAL_KINDS`, so a new mode cannot silently
 * become a contract mode here.
 */
export function planGoalCursorRefusal(
  mode: unknown,
  providerId: unknown,
): PlanGoalCursorRefusal | null {
  const kind = PROPOSAL_KINDS.find((candidate) => candidate === mode);
  if (!kind || !isCursorProviderId(providerId)) return null;
  return {
    errorCode: ErrorCodes.PLAN_GOAL_CURSOR_UNSUPPORTED,
    mode: kind,
    providerId: CURSOR_PROVIDER_ID,
    message:
      "Plan and Goal mode are not supported with Cursor models in this build. " +
      "Switch to Agent mode, or select a different model.",
  };
}
