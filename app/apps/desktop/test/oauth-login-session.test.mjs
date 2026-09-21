import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The module imports shared types the bundler way.
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { beginOAuthLogin } = await import("../src/lib/oauth-login-session.ts");

/**
 * The preload API, with the start call held open so a test can emit events
 * while the renderer still does not know the login id — the window in which
 * OpenAI Codex asks its browser-or-device-code question.
 */
function fakeApi({ loginId = "login-1" } = {}) {
  const listeners = new Set();
  const calls = [];
  let settle;
  const started = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return {
    calls,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    /** Let `startOauthLogin` resolve, as the IPC reply eventually would. */
    finishStart: async () => {
      settle.resolve({ loginId });
      await started.catch(() => undefined);
      // Give the `.then` continuation that flushes held events a turn to run.
      await Promise.resolve();
      await Promise.resolve();
    },
    failStart: async (error) => {
      settle.reject(error);
      await started.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    },
    listenerCount: () => listeners.size,
    api: {
      onOauthLogin: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      startOauthLogin: (vendorId) => {
        calls.push({ method: "start", vendorId });
        return started;
      },
      respondOauthLogin: async (input) => {
        calls.push({ method: "respond", ...input });
        return { ok: true };
      },
      cancelOauthLogin: async (id) => {
        calls.push({ method: "cancel", loginId: id });
        return { ok: true };
      },
    },
  };
}

/** Collect a subscriber's view of the login, the way the dialog does. */
function watch(session) {
  const events = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  return { events, unsubscribe };
}

test("a prompt raised before the login id is known still reaches the dialog", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });
  const seen = watch(session);

  // pi-ai's Codex flow asks its first question in the same tick the login
  // begins, long before the start reply carries the id back.
  fake.emit({
    kind: "prompt",
    loginId: "login-1",
    request: { promptId: "p1", type: "select", message: "How do you want to sign in?" },
  });
  assert.deepEqual(seen.events, [], "held until the id is known");

  await fake.finishStart();

  assert.equal(seen.events.length, 1);
  assert.equal(seen.events[0].kind, "prompt");
  assert.equal(seen.events[0].request.promptId, "p1");
  session.dispose();
});

test("held events are released in order, and later ones flow straight through", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });
  const seen = watch(session);

  fake.emit({ kind: "info", loginId: "login-1", message: "one" });
  fake.emit({ kind: "progress", loginId: "login-1", message: "two" });
  await fake.finishStart();
  fake.emit({ kind: "progress", loginId: "login-1", message: "three" });

  assert.deepEqual(
    seen.events.map((event) => event.message),
    ["one", "two", "three"],
  );
  session.dispose();
});

test("a dialog that remounts is replayed the conversation, and starts nothing", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });

  // StrictMode: subscribe, tear down, subscribe again on the same session.
  const first = watch(session);
  await fake.finishStart();
  fake.emit({ kind: "info", loginId: "login-1", message: "opening browser" });
  first.unsubscribe();
  const second = watch(session);
  fake.emit({ kind: "progress", loginId: "login-1", message: "waiting" });

  assert.deepEqual(
    second.events.map((event) => event.message),
    ["opening browser", "waiting"],
    "the second mount sees what the first one did, then keeps up",
  );
  assert.deepEqual(
    first.events.map((event) => event.message),
    ["opening browser"],
    "an unsubscribed listener stops being called",
  );
  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ["start"],
    "one login per session, however many times a dialog mounts",
  );
  session.dispose();
});

test("another attempt's events are dropped, held or live", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });
  const seen = watch(session);

  fake.emit({ kind: "info", loginId: "other", message: "held-stranger" });
  await fake.finishStart();
  fake.emit({ kind: "info", loginId: "other", message: "live-stranger" });
  fake.emit({ kind: "info", loginId: "login-1", message: "mine" });

  assert.deepEqual(
    seen.events.map((event) => event.message),
    ["mine"],
  );
  session.dispose();
});

test("respond and cancel wait for the id rather than racing it", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });

  const responded = session.respond("p1", "browser");
  const cancelled = session.cancel();
  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ["start"],
    "nothing is sent before the id arrives",
  );

  await fake.finishStart();
  await responded;
  assert.equal(await cancelled, true);
  assert.deepEqual(fake.calls, [
    { method: "start", vendorId: "openai-codex" },
    { method: "respond", loginId: "login-1", promptId: "p1", value: "browser" },
    { method: "cancel", loginId: "login-1" },
  ]);
  session.dispose();
});

test("a start that fails reports down the stream and answers nothing after", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });
  const seen = watch(session);

  await fake.failStart(new Error("no flow registered"));

  assert.deepEqual(seen.events, [
    {
      loginId: "",
      vendorId: "openai-codex",
      kind: "error",
      message: "no flow registered",
    },
  ]);
  // A dialog mounting after the failure is told about it too.
  assert.deepEqual(watch(session).events, seen.events);

  await session.respond("p1", "browser");
  assert.equal(await session.cancel(), false, "cancel closes the dialog directly");
  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ["start"],
  );
  session.dispose();
});

test("disposing stops delivery and unsubscribes", async () => {
  const fake = fakeApi();
  const session = beginOAuthLogin({ api: fake.api, vendorId: "openai-codex" });
  const seen = watch(session);

  fake.emit({ kind: "info", loginId: "login-1", message: "held" });
  session.dispose();
  assert.equal(fake.listenerCount(), 0);

  await fake.finishStart();
  fake.emit({ kind: "info", loginId: "login-1", message: "live" });
  assert.deepEqual(seen.events, [], "a closed dialog never sees state updates");
  assert.deepEqual(watch(session).events, [], "and nothing replays after it");
});
