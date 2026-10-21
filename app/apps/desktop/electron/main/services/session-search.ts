import type { SessionSearchPage } from "@pi-desktop/shared";

type RpcClient = {
  call<T>(method: string, input?: unknown): Promise<T>;
};

/** OMP-owned desktop search; never discover or merge ambient Pi sessions. */
export async function searchSessionsAcrossSources(
  host: RpcClient,
  _retiredSidecar: RpcClient | null,
  input: unknown,
): Promise<SessionSearchPage> {
  return host.call<SessionSearchPage>("search.sessions", input);
}
