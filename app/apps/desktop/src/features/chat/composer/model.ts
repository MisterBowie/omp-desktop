import type {
  EngineId,
  ModelInfo,
  Mode,
  PermissionMode,
  ProviderPublic,
  SessionThinkingLevel,
  ThinkingLevel,
} from "@pi-desktop/shared";
import {
  engineSupportsContractMode,
  isSessionThinkingLevel,
  modelIdsMatch,
  PERMISSION_MODES,
  sessionThinkingMenuLevels,
} from "@pi-desktop/shared";
import { providerThinkingLevels } from "../../../lib/session-thinking";

export const COMPOSER_MIN_HEIGHT_PX = 28;
export const COMPOSER_MAX_VISIBLE_ROWS = 7;

export const PLACEHOLDER_KEYS = {
  home: [
    "chat.placeholderHome",
    "chat.placeholderHomeHint",
    "chat.placeholderShortcut",
  ],
  docked: [
    "chat.placeholder",
    "chat.placeholderHint",
    "chat.placeholderShortcut",
  ],
} as const;

export const MODE_CYCLE: readonly Mode[] = ["agent", "plan", "goal"];

export const MODE_LABEL_KEYS: Record<Mode, string> = {
  agent: "settings.modeAgent",
  plan: "settings.modePlan",
  goal: "settings.modeGoal",
};

export const PERMISSION_MODE_I18N_KEYS: Record<PermissionMode, string> = {
  inherit: "chat.permissionInherit",
  ask: "chat.permissionAsk",
  "accept-edits": "chat.permissionAcceptEdits",
  auto: "chat.permissionAuto",
};

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ComposerPrefill = {
  text: string;
  token: number;
};

export type ComposerFileReference = {
  id: string;
  sessionId: string;
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  token?: string;
};

export type ComposerMenuView = "root" | "model" | "thinking";

export type PromptEnhancementError = {
  message: string;
  code: string;
};

/**
 * The next mode in the cycle the caller may offer.
 *
 * `cycle` defaults to the full Agent→Plan→Goal cycle. A caller that knows the
 * session's engine declares fewer contract modes passes the reduced cycle, so
 * the chip can never step into a mode that engine does not carry. A mode that
 * is not in the cycle (a stale record) cycles to the first offered mode.
 */
export function nextMode(mode: Mode, cycle: readonly Mode[] = MODE_CYCLE): Mode {
  if (cycle.length === 0) return mode;
  const index = cycle.indexOf(mode);
  if (index < 0) return cycle[0] ?? mode;
  return cycle[(index + 1) % cycle.length] ?? cycle[0] ?? mode;
}

/**
 * The modes the composer may offer a session running on `engine`.
 *
 * Agent is never gated; Plan and Goal are dropped when the engine's declaration
 * does not carry them. The composer hides what this returns, but the
 * main-process boundary refuses a configure/create/prompt that names a mode the
 * engine does not carry — the affordance and the enforcement read the same
 * declaration table.
 */
export function offeredModes(engine: EngineId): readonly Mode[] {
  return MODE_CYCLE.filter((candidate) => engineSupportsContractMode(engine, candidate));
}

export function isThinkingLevel(value: unknown): value is SessionThinkingLevel {
  return isSessionThinkingLevel(value);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    PERMISSION_MODES.includes(value as PermissionMode)
  );
}

/**
 * Preserve the current level when changing providers, but never carry a
 * reasoning level into a provider that cannot accept it.
 */
export function thinkingLevelForProvider(
  provider: ProviderPublic | null | undefined,
  current: SessionThinkingLevel,
): SessionThinkingLevel {
  const available = providerThinkingLevels(provider);
  if (!provider?.supportsReasoning) return "off";
  if (current === "omit") return "omit";
  if (available.includes(current)) return current;
  const requestedIndex = THINKING_LEVELS.indexOf(current);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  return "off";
}

/**
 * Project the selected catalog model onto a provider for draft sessions.
 *
 * Persisted sessions receive these exact capabilities from Electron main.
 * Before the first message creates a session, the provider row only describes
 * its default model, so use the selected catalog record and exact model
 * binding when one is available.
 */
export function thinkingProviderForModel(
  provider: ProviderPublic | null | undefined,
  modelId: string | undefined,
  modelCatalog: readonly ModelInfo[] | undefined,
): ProviderPublic | null | undefined {
  if (!provider || !modelId) return provider;
  const model = modelCatalog?.find((candidate) => modelIdsMatch(candidate.modelId, modelId));
  if (!model) return provider;

  const binding = provider.models.find((candidate) =>
    modelIdsMatch(candidate.id, model.modelId),
  );
  const configuredLevels = binding
    ? THINKING_LEVELS.filter((level) => binding.thinkingLevels.includes(level))
    : undefined;
  const supportsReasoning = configuredLevels
    ? configuredLevels.some((level) => level !== "off")
    : model.reasoning === true || model.capabilities.includes("reasoning");
  return {
    ...provider,
    supportsReasoning,
    supportedThinkingLevels:
      configuredLevels ?? model.supportedThinkingLevels ?? provider.supportedThinkingLevels,
  };
}

export function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export { sessionThinkingMenuLevels };
