/**
 * One vendor-account login attempt, seen from the renderer (ADR 0098).
 *
 * Two orderings matter here, and getting either wrong costs a real login.
 *
 * A flow can ask its first question before `providersOauthStart` has even
 * returned — OpenAI Codex opens with a browser-or-device-code choice, and pi-ai
 * raises it in the same tick the login begins — so this subscribes to the event
 * stream first and starts second, holding what arrives until the login id is
 * known and releasing it in order.
 *
 * And the attempt must begin exactly once, so it is started from a click
 * handler rather than from a React effect: StrictMode runs an effect twice on
 * mount, and the second start would open a second browser and fight the first
 * one for the local callback port. The session therefore keeps every event it
 * has delivered and replays it to whoever subscribes, so a dialog that mounts,
 * unmounts and mounts again still sees the whole conversation.
 */
import type {
  OAuthLoginEvent,
  OAuthRespondInput,
  OAuthStartResult,
} from "@pi-desktop/shared";

/** The slice of the preload API a login needs; injected so it can be tested. */
export type OAuthLoginApi = {
  onOauthLogin: (listener: (event: OAuthLoginEvent) => void) => () => void;
  startOauthLogin: (vendorId: string) => Promise<OAuthStartResult>;
  respondOauthLogin: (input: OAuthRespondInput) => Promise<{ ok: boolean }>;
  cancelOauthLogin: (loginId: string) => Promise<{ ok: boolean }>;
};

export type OAuthLoginSession = {
  /** Watch the login. A late subscriber is replayed everything so far. */
  subscribe: (listener: (event: OAuthLoginEvent) => void) => () => void;
  /** Answer a prompt the flow raised. */
  respond: (promptId: string, value: string) => Promise<void>;
  /**
   * Abort the login, stopping the local callback server or device-code poll.
   * Resolves false when main no longer knows the attempt — it already ended.
   */
  cancel: () => Promise<boolean>;
  /** Stop listening. Does not cancel the login. */
  dispose: () => void;
};

export function beginOAuthLogin({
  api,
  vendorId,
}: {
  api: OAuthLoginApi;
  vendorId: string;
}): OAuthLoginSession {
  let loginId: string | null = null;
  let disposed = false;
  let pending: OAuthLoginEvent[] = [];
  const delivered: OAuthLoginEvent[] = [];
  const listeners = new Set<(event: OAuthLoginEvent) => void>();

  const deliver = (event: OAuthLoginEvent) => {
    if (disposed) return;
    delivered.push(event);
    for (const listener of [...listeners]) listener(event);
  };

  const unsubscribe = api.onOauthLogin((event) => {
    if (disposed) return;
    if (loginId === null) {
      // The id is still in flight; keep the event until it can be matched.
      pending.push(event);
      return;
    }
    if (event.loginId === loginId) deliver(event);
  });

  const started = api.startOauthLogin(vendorId).then(
    (result) => {
      loginId = result.loginId;
      const held = pending;
      pending = [];
      for (const event of held) {
        if (event.loginId === loginId) deliver(event);
      }
      return result.loginId;
    },
    (error: unknown) => {
      pending = [];
      // No login exists, so main will never report this; it travels the same
      // stream as any other outcome and replays to a later subscriber.
      deliver({
        loginId: "",
        vendorId,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    },
  );

  return {
    subscribe: (listener) => {
      if (disposed) return () => {};
      for (const event of [...delivered]) listener(event);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    respond: async (promptId, value) => {
      const id = await started;
      if (id === null) return;
      await api.respondOauthLogin({ loginId: id, promptId, value });
    },
    cancel: async () => {
      const id = await started;
      if (id === null) return false;
      const result = await api.cancelOauthLogin(id);
      return result?.ok === true;
    },
    dispose: () => {
      disposed = true;
      pending = [];
      listeners.clear();
      unsubscribe();
    },
  };
}
