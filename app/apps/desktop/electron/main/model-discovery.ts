/**
 * Provider model discovery: query the provider's own model-list endpoint so
 * users pick real model IDs instead of typing them (settings dialog and the
 * composer model menu both consume this).
 *
 * Per apiStyle:
 *  - chat_completions / responses → GET {base}/models        (Bearer auth)
 *  - anthropic_messages           → GET {base}/v1/models     (x-api-key)
 *  - google_generative_ai        → GET {base}/models?key=…
 */

import { THINKING_LEVELS, MODEL_MODALITIES, providerCapabilitiesFromUnknown, type ThinkingLevel, type ModelModality, type ProviderModelCapabilities } from "@pi-desktop/shared";

export type DiscoveredModel = {
  modelId: string;
  displayName: string;
  contextWindow?: number;
  maxTokens?: number;
  providerCapabilities?: ProviderModelCapabilities;
};

const DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_MODELS = 500;
const OPENCODE_GO_API_STYLE = "opencode_go";
const RESERVED_DISCOVERY_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "host",
  "content-type",
  "content-length",
  "cookie",
  "set-cookie",
  "connection",
  "x-api-key",
  "api-key",
  "chatgpt-account-id",
]);

function withCustomHeaders(
  base: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  if (!extra) return base;
  const next = { ...base };
  for (const [rawKey, rawValue] of Object.entries(extra)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) continue;
    if (key.includes("\r") || key.includes("\n") || value.includes("\r") || value.includes("\n")) {
      continue;
    }
    const lower = key.toLowerCase();
    if (RESERVED_DISCOVERY_HEADERS.has(lower)) continue;
    for (const existing of Object.keys(next)) {
      if (existing.toLowerCase() === lower) delete next[existing];
    }
    next[key] = value;
  }
  return next;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only whole positive token counts that the host can persist are usable. */
function tokenLimit(...values: unknown[]): number | undefined {
  return values.find((value): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff,
  );
}

function modelLimits(item: Record<string, unknown> | null): Pick<DiscoveredModel, "contextWindow" | "maxTokens"> {
  const contextWindow = tokenLimit(item?.context_window, item?.context_length, item?.max_input_tokens, item?.inputTokenLimit);
  const maxTokens = tokenLimit(item?.max_output_tokens, item?.outputTokenLimit);
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function publishedModalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = MODEL_MODALITIES.filter((modality) => value.includes(modality));
  return result.length || value.length === 0 ? result : undefined;
}

/** Normalize endpoint facts without treating local opt-ins as capabilities. */
function modelCapabilities(item: Record<string, unknown> | null): Pick<DiscoveredModel, "providerCapabilities"> {
  if (!item) return {};
  const capabilities: ProviderModelCapabilities = {};
  if (typeof item.reasoning === "boolean") capabilities.reasoning = item.reasoning;
  const rawLevels = [item.reasoning_levels, item.supported_reasoning_levels].flatMap((value) => Array.isArray(value) ? value : []);
  const levels = new Set<ThinkingLevel>();
  const unsupported = new Set<string>();
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const raw of rawLevels.slice(0, 64)) {
    const value = typeof raw === "string" ? raw : asRecord(raw)?.effort;
    if (typeof value !== "string" || !value.trim() || value.length > 64) continue;
    const wire = value.trim().toLowerCase();
    const level = wire === "none" ? "off" : wire;
    if ((THINKING_LEVELS as readonly string[]).includes(level)) {
      levels.add(level as ThinkingLevel);
      map[level as ThinkingLevel] = wire;
    } else unsupported.add(wire);
  }
  if (rawLevels.length) {
    capabilities.thinkingLevels = capabilities.reasoning === false ? [] : THINKING_LEVELS.filter((level) => levels.has(level));
    if (capabilities.reasoning === undefined && levels.size) capabilities.reasoning = [...levels].some((level) => level !== "off");
    if (Object.keys(map).length) capabilities.thinkingLevelMap = map;
  }
  if (capabilities.reasoning === false) capabilities.thinkingLevels = [];
  if (unsupported.size) capabilities.unsupportedThinkingLevels = [...unsupported];
  const modalities = asRecord(item.modalities);
  const input = publishedModalities(modalities?.input ?? item.input_modalities);
  const output = publishedModalities(modalities?.output ?? item.output_modalities);
  if (input !== undefined) capabilities.inputModalities = input;
  if (output !== undefined) capabilities.outputModalities = output;
  if (typeof item.supports_images === "boolean") capabilities.supportsImages = item.supports_images;
  if (typeof item.supports_pdf === "boolean") capabilities.supportsDocuments = item.supports_pdf;
  const webSearch = [item.supports_web_search, item.web_search, item.native_web_search].find((value) => typeof value === "boolean");
  if (typeof webSearch === "boolean") capabilities.webSearch = webSearch;
  const normalized = providerCapabilitiesFromUnknown(capabilities);
  return normalized ? { providerCapabilities: normalized } : {};
}

function dedupeSort(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Map<string, DiscoveredModel>();
  for (const model of models) {
    if (model.modelId && !seen.has(model.modelId)) seen.set(model.modelId, model);
  }
  return [...seen.values()]
    .sort((a, b) => a.modelId.localeCompare(b.modelId))
    .slice(0, MAX_MODELS);
}

/** Normalize a model-list response body for the given apiStyle. Pure. */
export function normalizeModelList(
  apiStyle: string | undefined,
  body: unknown,
): DiscoveredModel[] {
  const record = asRecord(body);
  if (apiStyle === "google_generative_ai") {
    const models = Array.isArray(record?.models) ? record.models : [];
    return dedupeSort(
      models.flatMap((entry) => {
        const item = asRecord(entry);
        const rawName = typeof item?.name === "string" ? item.name : "";
        const modelId = rawName.replace(/^models\//, "");
        if (!modelId) return [];
        const displayName =
          typeof item?.displayName === "string" && item.displayName
            ? item.displayName
            : modelId;
        return [{ modelId, displayName, ...modelLimits(item), ...modelCapabilities(item) }];
      }),
    );
  }
  // OpenAI-style and Anthropic both use { data: [...] }; some gateways return
  // the bare array.
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(body)
      ? (body as unknown[])
      : [];
  return dedupeSort(
    data.flatMap((entry) => {
      const item = asRecord(entry);
      const modelId = typeof item?.id === "string" ? item.id : "";
      if (!modelId) return [];
      const displayName =
        typeof item?.display_name === "string" && item.display_name
          ? item.display_name
          : modelId;
      return [{ modelId, displayName, ...modelLimits(item), ...modelCapabilities(item) }];
    }),
  );
}

/** Build the request for a provider's model-list endpoint. Pure. */
export function modelListRequest(opts: {
  baseUrl: string;
  apiKey?: string;
  apiStyle?: string;
  headers?: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = opts.apiKey ?? "";
  const withHeaders = (headers: Record<string, string>): Record<string, string> =>
    withCustomHeaders(headers, opts.headers);
  if (opts.apiStyle === "google_generative_ai") {
    const params = new URLSearchParams({ pageSize: "1000" });
    if (apiKey) params.set("key", apiKey);
    return { url: `${base}/models?${params}`, headers: withHeaders({}) };
  }
  if (opts.apiStyle === "anthropic_messages") {
    // Anthropic base URLs conventionally exclude /v1 (runtime appends it).
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    return {
      url: `${root}/models?limit=1000`,
      headers: withHeaders({
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      }),
    };
  }
  // OpenCode Go exposes the same authenticated OpenAI-compatible /models
  // endpoint as generic Chat Completions, but keeps a distinct UI style.
  if (opts.apiStyle === OPENCODE_GO_API_STYLE) {
    return {
      url: `${base}/models`,
      headers: withHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }
  return {
    url: `${base}/models`,
    headers: withHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** Fetch and normalize the provider's model list. Throws on HTTP/network errors. */
export async function discoverProviderModels(opts: {
  baseUrl: string;
  apiKey?: string;
  apiStyle?: string;
  headers?: Record<string, string>;
}): Promise<DiscoveredModel[]> {
  const { url, headers } = modelListRequest(opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw Object.assign(new Error(`model list request failed (${res.status})`), {
        status: res.status,
      });
    }
    return normalizeModelList(opts.apiStyle, await res.json());
  } finally {
    clearTimeout(timer);
  }
}
