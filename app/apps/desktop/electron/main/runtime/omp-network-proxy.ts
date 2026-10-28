/**
 * The network proxy an OMP child process is launched behind. Sessions and the
 * marketplace CLI share this policy, so the proxy the user configured reaches
 * every request either one makes.
 *
 * - custom: the saved address and its bypass list.
 * - system: the proxy Chromium would use for the target, resolved by the
 *   desktop's own network stack. DIRECT, or no answer, means no proxy.
 * - direct: no proxy variables, even when the parent process has some.
 */
import { proxyEnvAssignments, type NetworkProxySettings } from "@pi-desktop/shared";
import type { OmpProxyPolicy } from "@pi-desktop/omp-runtime";

/** Hosts a system-resolved proxy must never carry. */
const SYSTEM_PROXY_BYPASS = "localhost,127.0.0.1,::1";

/**
 * The first usable entry of a Chromium proxy list (`PROXY h:p; DIRECT`) as a
 * URL the child understands, or null for DIRECT/unsupported.
 */
export function proxyUrlFromChromiumList(list: string): string | null {
  for (const entry of list.split(";")) {
    const [kind, hostPort] = entry.trim().split(/\s+/);
    if (!kind || !hostPort) continue;
    const scheme = { PROXY: "http", HTTP: "http", HTTPS: "https", SOCKS: "socks5", SOCKS5: "socks5" }[kind.toUpperCase()];
    if (scheme) return `${scheme}://${hostPort}`;
  }
  return null;
}

export type OmpProxyPolicyInput = {
  settings: NetworkProxySettings | undefined;
  /** The endpoint the child will reach; system mode asks the OS how to reach it. */
  targetUrl: string;
  systemProxy?: (url: string) => Promise<string>;
  /** Names the caller in the warning logged when system resolution fails. */
  label: string;
  log?: (level: "warn", message: string, data?: string) => void;
};

export async function ompProxyPolicy(input: OmpProxyPolicyInput): Promise<OmpProxyPolicy | undefined> {
  const { settings } = input;
  if (settings?.mode === "custom") {
    const assignments = proxyEnvAssignments(settings);
    const url = assignments.ALL_PROXY;
    return url ? { url, bypass: assignments.NO_PROXY ?? "" } : undefined;
  }
  if (settings?.mode === "direct") return undefined;
  try {
    const list = await input.systemProxy?.(input.targetUrl);
    const url = list ? proxyUrlFromChromiumList(list) : null;
    return url ? { url, bypass: SYSTEM_PROXY_BYPASS } : undefined;
  } catch (error) {
    input.log?.("warn", `${input.label} system proxy unresolved`, (error as Error).message);
    return undefined;
  }
}
