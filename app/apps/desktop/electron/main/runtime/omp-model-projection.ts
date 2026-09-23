/**
 * Project the desktop's provider/model/secret configuration into the minimal
 * `models.yml` an OMP runtime understands (M4/T15).
 *
 * The desktop's provider catalog and secret store are the authority. The child
 * runtime sees exactly one provider and one model — the session's explicit
 * binding — plus the credential that binding needs. Nothing else from the
 * user's configuration is copied, and the runtime's isolated HOME/config roots
 * are never pointed at `~/.omp` or `~/.agents`.
 *
 * The projection is written into the runtime's transient agent directory (the
 * supervisor's `prepareRun` path), which is removed on stop/reclaim, so a key
 * never lingers on disk beyond its run. The secret itself only ever appears in
 * this file; it is not logged, not returned to the renderer, and not copied into
 * any other state.
 */

/** The OMP `Api` values this build knows how to project from a PI `apiStyle`. */
const PI_STYLE_TO_OMP_API: Record<string, string> = {
  chat_completions: "openai-completions",
  "openai-chat": "openai-completions",
  openai_completions: "openai-completions",
  responses: "openai-responses",
  openai_responses: "openai-responses",
  anthropic_messages: "anthropic-messages",
  google_generative_ai: "google-generative-ai",
};

/** PI `apiStyle` values this build refuses to project, with the reason. */
const UNSUPPORTED_STYLES: Record<string, true> = {
  opencode_go: true,
  opencode: true,
};

export type OmpModelProjection = {
  /** models.yml provider key (the desktop provider id). */
  providerId: string;
  modelId: string;
  /** OMP `Api` value after mapping, e.g. `openai-completions`. */
  api: string;
  baseUrl: string;
  /** The credential this binding needs, or null for auth-less endpoints. */
  apiKey: string | null;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
};

export type OmpModelProjectionError = {
  errorCode: "OMP_PROJECTION_UNSUPPORTED" | "OMP_PROJECTION_INVALID";
  message: string;
};

/**
 * Map a PI `apiStyle` to an OMP `Api` value.
 *
 * Returns null for a style this build cannot project; the caller turns that
 * into a prompt-time refusal so an incompatible endpoint is never silently
 * served with the wrong request shape.
 */
export function ompApiForStyle(apiStyle: string | undefined | null): string | null {
  if (!apiStyle) return null;
  const key = apiStyle.trim();
  if (UNSUPPORTED_STYLES[key]) return null;
  return PI_STYLE_TO_OMP_API[key] ?? null;
}

/** Validate a projection and report the first error, or null when usable. */
export function projectionError(
  projection: OmpModelProjection,
): OmpModelProjectionError | null {
  if (!projection.providerId.trim()) {
    return { errorCode: "OMP_PROJECTION_INVALID", message: "the provider id is empty" };
  }
  if (!projection.modelId.trim()) {
    return { errorCode: "OMP_PROJECTION_INVALID", message: "the model id is empty" };
  }
  if (!projection.baseUrl.trim()) {
    return { errorCode: "OMP_PROJECTION_INVALID", message: "the provider base url is empty" };
  }
  if (!projection.api) {
    return {
      errorCode: "OMP_PROJECTION_UNSUPPORTED",
      message: "the provider's api style cannot be projected to an OMP api",
    };
  }
  return null;
}

/** A YAML mapping line for one provider/model field, or null to omit. */
function yamlField(indent: number, key: string, value: string | number | boolean): string {
  const pad = " ".repeat(indent);
  const rendered =
    typeof value === "string" ? JSON.stringify(value) : String(value);
  return `${pad}${key}: ${rendered}`;
}

/**
 * Render the minimal `models.yml` document for one provider/model binding.
 *
 * The document names one provider with one model, its API style, base URL and
 * credential (when one exists). Auth-less local endpoints (`auth: none`) carry
 * no key; every other projected endpoint carries `auth: apiKey` and the key the
 * desktop's secret store supplied.
 */
export function projectModelsYaml(projection: OmpModelProjection): string {
  const error = projectionError(projection);
  if (error) {
    throw Object.assign(new Error(error.message), { errorCode: error.errorCode });
  }
  const provider = projection.providerId;
  const lines: string[] = ["providers:"];
  lines.push(`  ${provider}:`);
  lines.push(yamlField(4, "baseUrl", projection.baseUrl));
  lines.push(yamlField(4, "api", projection.api));
  if (projection.apiKey) {
    lines.push(yamlField(4, "auth", "apiKey"));
    lines.push(yamlField(4, "apiKey", projection.apiKey));
  } else {
    lines.push(yamlField(4, "auth", "none"));
  }
  if (projection.headers && Object.keys(projection.headers).length > 0) {
    lines.push("    headers:");
    for (const [name, value] of Object.entries(projection.headers)) {
      lines.push(`      ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("    models:");
  lines.push(`      - ${yamlField(0, "id", projection.modelId).trim()}`);
  lines.push(`        ${yamlField(0, "api", projection.api).trim()}`);
  if (projection.contextWindow !== undefined && projection.contextWindow > 0) {
    lines.push(`        ${yamlField(0, "contextWindow", projection.contextWindow).trim()}`);
  }
  lines.push("        cost:");
  lines.push("          input: 0");
  lines.push("          output: 0");
  lines.push("          cacheRead: 0");
  lines.push("          cacheWrite: 0");
  return `${lines.join("\n")}\n`;
}

/**
 * The credential-shaped keys a projected `models.yml` must never carry into a
 * fixture, a log, or a test snapshot. Used by the canary scan to prove a
 * synthetic key cannot leak through the projection path.
 */
export const PROJECTED_SECRET_FIELDS = ["apiKey"] as const;
