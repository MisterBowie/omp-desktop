/**
 * The desktop's OMP marketplace service (ADR 0333): what the renderer may ask
 * for, how it reaches the runtime's CLI, and what it answers with. The CLI is
 * the only fixture; validation, serialization and the state read are real.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpMarketplaceService, normalizeMarketplaceSource, OMP_MARKET_COMMAND_FAILED } = await import(
  "../electron/main/runtime/omp-marketplace.ts"
);
const { ErrorCodes } = await import("../../../packages/shared/src/errors.ts");

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-market-service-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A CLI stand-in that records each call and lets the test decide when it ends. */
function fakeCli() {
  const calls = [];
  const pending = [];
  const runCli = (options) => {
    calls.push(options);
    const deferred = Promise.withResolvers();
    pending.push(deferred);
    return deferred.promise;
  };
  const finish = (result = {}) =>
    pending.shift().resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...result });
  return { calls, pending, runCli, finish };
}

const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

test("marketplace sources are normalized and anything flag-like or unauthenticated is refused", () => {
  const home = "/home/tester";
  assert.equal(normalizeMarketplaceSource(" anthropics/claude-plugins-official ", home), "anthropics/claude-plugins-official");
  assert.equal(normalizeMarketplaceSource("https://github.com/o/r.git", home), "https://github.com/o/r.git");
  assert.equal(normalizeMarketplaceSource("https://example.com/marketplace.json", home), "https://example.com/marketplace.json");
  assert.equal(normalizeMarketplaceSource("git@github.com:o/r.git", home), "git@github.com:o/r.git");
  assert.equal(normalizeMarketplaceSource("ssh://git@host/o/r.git", home), "ssh://git@host/o/r.git");
  assert.equal(normalizeMarketplaceSource("~/markets/mine", home), resolve(home, "markets/mine"));
  assert.equal(normalizeMarketplaceSource("/srv/market", home), resolve("/srv/market"));
  for (const bad of ["", "   ", "--scope", "-x", "http://example.com/m.json", "file:///etc", "./relative", "../up", "javascript:alert(1)", "a\nb", "not a source", 42, null, "x".repeat(2049)]) {
    assert.throws(() => normalizeMarketplaceSource(bad, home), (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT, String(bad));
  }
});

test("each request becomes exactly one user-scoped OMP plugin command", async (t) => {
  const dataRoot = scratch(t);
  const cli = fakeCli();
  const service = createOmpMarketplaceService({ dataRoot, launcher: () => ({ path: "/bin/omp", error: null }), runCli: cli.runCli, home: "/home/tester" });
  const cases = [
    [() => service.addSource("o/r"), ["marketplace", "add", "o/r"]],
    [() => service.removeSource("market"), ["marketplace", "remove", "market"]],
    [() => service.updateSources(), ["marketplace", "update"]],
    [() => service.updateSources("market"), ["marketplace", "update", "market"]],
    [() => service.install("demo@market"), ["install", "demo@market", "--scope", "user"]],
    [() => service.uninstall("demo@market"), ["uninstall", "demo@market", "--scope", "user"]],
    [() => service.setEnabled("demo@market", false), ["disable", "demo@market", "--scope", "user"]],
    [() => service.setEnabled("demo@market", true), ["enable", "demo@market", "--scope", "user"]],
    [() => service.upgrade("demo@market"), ["upgrade", "demo@market", "--scope", "user"]],
  ];
  for (const [request, args] of cases) {
    const answer = request();
    await tick();
    assert.deepEqual(cli.calls.at(-1).args, args);
    assert.equal(cli.calls.at(-1).launcher, "/bin/omp");
    assert.equal(cli.calls.at(-1).store.root, join(dataRoot, "omp-marketplace"));
    cli.finish();
    const state = await answer;
    assert.equal(state.available, true);
  }
});

test("invalid arguments are refused before any command runs", async (t) => {
  const cli = fakeCli();
  const service = createOmpMarketplaceService({ dataRoot: scratch(t), launcher: () => ({ path: "/bin/omp", error: null }), runCli: cli.runCli });
  for (const request of [
    () => service.install("--scope"),
    () => service.install("demo"),
    () => service.uninstall("demo@-market"),
    () => service.setEnabled("demo@market", "yes"),
    () => service.removeSource("../escape"),
    () => service.updateSources("bad name"),
    () => service.addSource("-o/r"),
  ]) {
    await assert.rejects(request(), (error) => error.errorCode === ErrorCodes.INVALID_ARGUMENT);
  }
  assert.equal(cli.calls.length, 0);
});

test("commands run one at a time in request order", async (t) => {
  const cli = fakeCli();
  const service = createOmpMarketplaceService({ dataRoot: scratch(t), launcher: () => ({ path: "/bin/omp", error: null }), runCli: cli.runCli });
  const first = service.install("a@m");
  const second = service.install("b@m");
  await tick();
  assert.equal(cli.calls.length, 1, "the second command waits for the first");
  cli.finish({ exitCode: 1, stderr: "✘ Failed to install a@m: Error: boom\n" });
  await assert.rejects(first, (error) => error.errorCode === OMP_MARKET_COMMAND_FAILED && error.message === "Failed to install a@m: boom");
  await tick();
  assert.equal(cli.calls.length, 2, "a failure does not block the queue");
  assert.deepEqual(cli.calls[1].args, ["install", "b@m", "--scope", "user"]);
  cli.finish();
  await second;
});

test("an unavailable runtime is reported in state and refused for commands", async (t) => {
  const cli = fakeCli();
  const service = createOmpMarketplaceService({
    dataRoot: scratch(t),
    launcher: () => ({ path: null, error: "bundled runtime failed verification" }),
    runCli: cli.runCli,
  });
  assert.deepEqual(await service.state(), {
    available: false,
    unavailableReason: "bundled runtime failed verification",
    sources: [],
    plugins: [],
    installed: [],
  });
  await assert.rejects(service.install("a@m"), (error) => error.errorCode === ErrorCodes.AGENT_UNAVAILABLE && /failed verification/.test(error.message));
  assert.equal(cli.calls.length, 0);
});

test("the CLI gets the custom proxy, the resolved system proxy, or none in direct mode", async (t) => {
  const cli = fakeCli();
  let proxy = { mode: "system" };
  let systemList = "PROXY 127.0.0.1:7897; DIRECT";
  const service = createOmpMarketplaceService({
    dataRoot: scratch(t),
    launcher: () => ({ path: "/bin/omp", error: null }),
    runCli: cli.runCli,
    networkProxy: () => proxy,
    systemProxy: async () => systemList,
  });
  const run = async () => {
    const pending = service.updateSources();
    await tick();
    const call = cli.calls.at(-1);
    cli.finish();
    await pending;
    return call.proxy;
  };
  // System mode: git ignores the OS proxy, so the desktop resolves it.
  assert.equal((await run()).url, "http://127.0.0.1:7897");
  systemList = "DIRECT";
  assert.equal(await run(), undefined);
  systemList = "SOCKS5 127.0.0.1:1080";
  assert.equal((await run()).url, "socks5://127.0.0.1:1080");
  // Direct mode never consults the system proxy.
  proxy = { mode: "direct" };
  systemList = "PROXY 127.0.0.1:7897";
  assert.equal(await run(), undefined);
  // A custom proxy wins over the system one.
  proxy = { mode: "custom", url: "http://127.0.0.1:7890" };
  const custom = await run();
  assert.equal(custom.url, "http://127.0.0.1:7890");
  assert.equal(typeof custom.bypass, "string");
});

test("the answer is the state re-read from OMP's registries", async (t) => {
  const dataRoot = scratch(t);
  const cli = fakeCli();
  const service = createOmpMarketplaceService({ dataRoot, launcher: () => ({ path: "/bin/omp", error: null }), runCli: cli.runCli });
  const pending = service.addSource("o/r");
  await tick();
  // What the real CLI would have written by the time it exits.
  const config = join(dataRoot, "omp-marketplace", "home", ".omp");
  json(join(config, "marketplaces.json"), {
    version: 1,
    marketplaces: [{ name: "m", sourceType: "github", sourceUri: "o/r", catalogPath: "x", addedAt: "a", updatedAt: "u" }],
  });
  json(join(config, "plugins", "cache", "marketplaces", "m", "marketplace.json"), {
    name: "m",
    owner: { name: "O" },
    plugins: [{ name: "demo", source: "./demo", version: "1.0.0" }],
  });
  cli.finish();
  const state = await pending;
  assert.deepEqual(state.sources.map((source) => [source.name, source.pluginCount]), [["m", 1]]);
  assert.deepEqual(state.plugins.map((plugin) => [plugin.id, plugin.installable]), [["demo@m", true]]);
});

test("disposing cancels the running command and refuses new ones", async (t) => {
  const cli = fakeCli();
  const service = createOmpMarketplaceService({ dataRoot: scratch(t), launcher: () => ({ path: "/bin/omp", error: null }), runCli: cli.runCli });
  const running = service.install("a@m");
  await tick();
  service.dispose();
  assert.equal(cli.calls[0].signal.aborted, true);
  cli.finish({ exitCode: null, aborted: true });
  await assert.rejects(running, /cancelled/);
  await assert.rejects(service.install("b@m"), (error) => error.errorCode === ErrorCodes.AGENT_UNAVAILABLE);
});
