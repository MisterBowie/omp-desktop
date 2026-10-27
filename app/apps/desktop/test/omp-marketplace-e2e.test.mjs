/**
 * Real-runtime probe for the OMP marketplace integration (ADR 0333).
 *
 * The verified bundled runtime installs a plugin from a local marketplace
 * through the product's marketplace service, and real runs then show what a
 * session gets from it:
 *
 *   - through the declarative view (the product path), the plugin's command,
 *     skill and agent reach the session, while its MCP server is never spawned
 *     and its custom tool module is never imported;
 *   - through the raw install directory (the control), the same runtime does
 *     spawn and import them — so the markers can fail, and the view is what
 *     keeps them out.
 *
 * Only the model provider is a fixture.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const {
  MARKETPLACE_VIEW_DIR,
  OmpRuntimeSupervisor,
  ensureSessionStateDir,
  findGateExtension,
  projectMarketplacePlugins,
  verifyBundledRuntime,
} = await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpMarketplaceService } = await import("../electron/main/runtime/omp-marketplace.ts");

const CANARY = `MARKET-CANARY-${process.pid}`;

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A local marketplace whose one plugin carries every component kind. */
function writeFixtureMarketplace(root, markers) {
  const market = join(root, "fixture-market");
  write(
    join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: "fixture-market",
      owner: { name: "Fixture" },
      plugins: [{ name: "demo", source: "./plugins/demo", version: "1.0.0", description: "Probe plugin" }],
    }),
  );
  const plugin = join(market, "plugins", "demo");
  write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "1.0.0", description: "Probe plugin" }));
  write(
    join(plugin, "skills", "market-canary", "SKILL.md"),
    `---\nname: market-canary\ndescription: Use when asked about ${CANARY}-SKILL\n---\nReply with ${CANARY}.\n`,
  );
  write(join(plugin, "commands", "hello.md"), `---\ndescription: ${CANARY}-COMMAND\n---\nSay hello.\n`);
  write(
    join(plugin, "agents", "market-agent.md"),
    `---\nname: market-agent\ndescription: ${CANARY}-AGENT\n---\nYou are a probe agent.\n`,
  );
  write(join(plugin, "rules", "canary.md"), `---\ndescription: ${CANARY}-RULE\nalwaysApply: true\n---\nMention ${CANARY}-RULE-BODY.\n`);
  const spawnMarker = `require("node:fs").writeFileSync(${JSON.stringify(markers.mcp)}, "spawned")`;
  write(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { canary: { command: process.execPath, args: ["-e", spawnMarker] } } }),
  );
  write(
    join(plugin, "tools", "canary.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markers.tool)}, "imported");\nexport default function () { return []; }\n`,
  );
  write(join(plugin, "hooks", "pre", "bash.sh"), `echo hook > ${JSON.stringify(markers.hook)}\n`);
  return market;
}

function systemText(request) {
  return (request.body.messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
}

/** One real run; `project` decides how the run's config root gets its plugins. */
async function runSession(t, resources, project) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-market-run-")));
  const provider = await FakeProvider.start();
  provider.script([{ text: "Done.", finish: "stop" }]);
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: root,
    cwd: root,
    launcherPath: resources.path,
    sessionDir: ensureSessionStateDir(root),
    desktopStateRequired: false,
    args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: async (paths) => {
      writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl });
      project(paths);
    },
  });
  t.after(async () => {
    const stopped = await supervisor.stop({ abortBash: false });
    await provider.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(stopped.reaped, true);
    assert.equal(stopped.cleaned, true);
  });
  await supervisor.start();
  const runtime = supervisor.currentRuntime();
  const commands = await runtime.request({ type: "get_available_commands" });
  assert.equal(commands.success, true);
  const ended = Promise.withResolvers();
  t.after(runtime.onFrame((frame) => {
    if (frame.type === "agent_end" && frame.isTerminal !== false) ended.resolve();
  }));
  assert.equal((await runtime.request({ type: "prompt", message: "Say done." })).success, true);
  await ended.promise;
  const request = provider.requests.find((entry) => entry.url.endsWith("/chat/completions"));
  return {
    commandNames: (commands.data?.commands ?? commands.data ?? []).map((command) => command.name),
    system: systemText(request),
    tools: JSON.stringify(request.body.tools ?? []),
  };
}

test("an installed marketplace plugin reaches sessions as declarative content only", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 240_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-market-e2e-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markers = { mcp: join(root, "mcp-spawned"), tool: join(root, "tool-imported"), hook: join(root, "hook-ran") };
  const market = writeFixtureMarketplace(root, markers);

  // The product path: the marketplace service drives the runtime's own CLI.
  const service = createOmpMarketplaceService({
    dataRoot: join(root, "data"),
    launcher: () => ({ path: resources.path, error: null }),
    home: root,
  });
  t.after(() => service.dispose());
  const added = await service.addSource(market);
  assert.deepEqual(added.sources.map((source) => [source.name, source.sourceType, source.pluginCount]), [["fixture-market", "local", 1]]);
  assert.deepEqual(added.plugins.map((plugin) => [plugin.id, plugin.installable]), [["demo@fixture-market", true]]);
  const installed = await service.install("demo@fixture-market");
  assert.equal(installed.installed.length, 1);
  assert.deepEqual(installed.installed[0].components, {
    loaded: { skills: 1, commands: 1, agents: 1, rules: 1 },
    withheld: ["mcp", "hooks", "tools"],
  });
  await assert.rejects(service.install("demo@fixture-market"), /already installed/);
  const snapshot = service.runSnapshot();
  assert.equal(snapshot.plugins.length, 1);

  // Product projection: the same call the session wiring makes in prepareRun.
  const viewed = await runSession(t, resources, (paths) => {
    const projected = projectMarketplacePlugins({
      snapshot: service.runSnapshot(),
      configRoot: paths.configRoot,
      viewRoot: join(paths.runRoot, MARKETPLACE_VIEW_DIR),
    });
    assert.deepEqual(projected, { projected: ["demo@fixture-market"], diagnostics: [] });
  });
  assert.ok(viewed.commandNames.includes("demo:hello"), `plugin command listed: ${viewed.commandNames.join(", ")}`);
  assert.ok(`${viewed.system}\n${viewed.tools}`.includes(`${CANARY}-SKILL`), "plugin skill reaches the model");
  assert.ok(`${viewed.system}\n${viewed.tools}`.includes(`${CANARY}-AGENT`), "plugin agent reaches the task tool");
  assert.ok(viewed.system.includes(`${CANARY}-RULE-BODY`), "an always-apply plugin rule reaches the system prompt");
  assert.equal(existsSync(markers.mcp), false, "the plugin's MCP server is never spawned");
  assert.equal(existsSync(markers.tool), false, "the plugin's tool module is never imported");
  assert.equal(viewed.tools.includes("canary"), false, "no MCP or custom tool named canary is offered");

  // Control: the raw install directory, as OMP would read it without the view.
  const raw = await runSession(t, resources, (paths) => {
    mkdirSync(join(paths.configRoot, "plugins"), { recursive: true });
    writeFileSync(
      join(paths.configRoot, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "demo@fixture-market": [{ scope: "user", installPath: snapshot.plugins[0].installPath, version: "1.0.0" }] } }),
    );
  });
  assert.ok(raw.commandNames.includes("demo:hello"));
  assert.equal(existsSync(markers.mcp), true, "control: the raw plugin's MCP server is spawned, so the probe can fail");
  assert.equal(existsSync(markers.tool), true, "control: the raw plugin's tool module is imported, so the probe can fail");

  // Uninstalling empties what the next run loads.
  const removed = await service.uninstall("demo@fixture-market");
  assert.deepEqual(removed.installed, []);
  assert.deepEqual(service.runSnapshot().plugins, []);
  assert.notEqual(service.runSnapshot().fingerprint, snapshot.fingerprint);
});
