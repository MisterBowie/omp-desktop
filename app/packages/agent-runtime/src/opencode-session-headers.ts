/**
 * OpenCode Go (and OpenCode Zen) require a stable conversation header so the
 * gateway can pin a chat to one backend. pi-ai does not emit
 * `x-opencode-session`; the official Pi coding-agent injects it in the agent
 * layer, and this runtime does the same.
 */

import { randomUUID } from "node:crypto";
import type { Api, Model, ProviderHeaders, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  APP_VERSION,
  OPENCODE_GO_API_STYLE,
} from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "./provider-binding.js";

export const OPENCODE_SESSION_HEADER = "x-opencode-session";
export const OPENCODE_CLIENT_HEADER = "x-opencode-client";
export const OPENCODE_CLIENT_VALUE = "pi-desktop";
export const OPENCODE_USER_AGENT = `pi-desktop/${APP_VERSION}`;

export type OpenCodeEndpointInput = {
  apiStyle?: string;
  vendorKey?: string;
  baseUrl?: string;
  model?: Model<Api>;
};

function hostnameOf(url: string | undefined): string | undefined {
  if (!url?.trim()) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isOpenCodeHost(url: string | undefined): boolean {
  const host = hostnameOf(url);
  return host === "opencode.ai" || (host?.endsWith(".opencode.ai") ?? false);
}

function headerValue(
  headers: ProviderHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  if (!found) return undefined;
  const value = found[1];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isOpenCodeEndpoint(input: OpenCodeEndpointInput): boolean {
  if (input.apiStyle === OPENCODE_GO_API_STYLE) return true;
  const vendor = (input.vendorKey ?? "").trim().toLowerCase();
  if (vendor === "opencode" || vendor === "opencode-go") return true;
  const providerId = (input.model?.provider ?? "").trim().toLowerCase();
  if (providerId === "opencode" || providerId === "opencode-go") return true;
  return isOpenCodeHost(input.baseUrl) || isOpenCodeHost(input.model?.baseUrl);
}

export function openCodeEndpointFromProvider(
  provider: RuntimeProviderConfig,
  model?: Model<Api>,
): OpenCodeEndpointInput {
  return {
    apiStyle: provider.apiStyle,
    vendorKey: provider.vendorKey,
    baseUrl: provider.baseUrl,
    model,
  };
}

/** Merge OpenCode routing headers. An explicit caller header wins, except an
 * empty/null `x-opencode-session` is replaced so the gateway cannot 400. */
export function mergeOpenCodeSessionHeaders(
  input: OpenCodeEndpointInput & {
    sessionId?: string;
    headers?: ProviderHeaders;
  },
): ProviderHeaders | undefined {
  const sessionId = input.sessionId?.trim() || undefined;
  if (!sessionId || !isOpenCodeEndpoint(input)) {
    return input.headers;
  }

  const injected: ProviderHeaders = {
    [OPENCODE_SESSION_HEADER]: sessionId,
    [OPENCODE_CLIENT_HEADER]: OPENCODE_CLIENT_VALUE,
    "User-Agent": OPENCODE_USER_AGENT,
  };
  const merged: ProviderHeaders = {
    ...injected,
    ...input.headers,
  };
  if (!headerValue(merged, OPENCODE_SESSION_HEADER)) {
    merged[OPENCODE_SESSION_HEADER] = sessionId;
  }
  if (!headerValue(merged, OPENCODE_CLIENT_HEADER)) {
    merged[OPENCODE_CLIENT_HEADER] = OPENCODE_CLIENT_VALUE;
  }
  if (!headerValue(merged, "user-agent")) {
    merged["User-Agent"] = OPENCODE_USER_AGENT;
  }
  return merged;
}

/** Attach OpenCode routing headers to a pi-ai stream options object.
 * OpenCode requests without a caller session id get a per-call UUID so the
 * gateway still accepts the request; retries reuse the same options object. */
export function withOpenCodeSessionHeaders(
  options: SimpleStreamOptions | undefined,
  input: OpenCodeEndpointInput & { sessionId?: string },
): SimpleStreamOptions {
  const preferred =
    (options?.sessionId ?? input.sessionId)?.trim() || undefined;
  const sessionId =
    preferred ?? (isOpenCodeEndpoint(input) ? randomUUID() : undefined);
  const headers = mergeOpenCodeSessionHeaders({
    ...input,
    sessionId,
    headers: options?.headers,
  });
  return {
    ...(options ?? {}),
    ...(sessionId ? { sessionId } : {}),
    ...(headers ? { headers } : {}),
  };
}
