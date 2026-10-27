import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { mockPathEntries } from "../test-harness.js";
import {
  ensureOmpMarketplaceStore,
  inspectPluginComponents,
  isNewerCatalogVersion,
  marketplaceRunSnapshot,
  ompMarketplaceStore,
  ompPluginCliFailure,
  parseOmpPluginId,
  projectMarketplacePlugins,
  pruneStaleNatives,
  readOmpMarketState,
  readStoreCatalog,
  readStoreInstalled,
  readStoreMarketplaces,
  runOmpPluginCli,
  storeCatalogPath,
  type OmpMarketplaceStore,
} from "./index.js";

const created: string[] = [];

function scratch(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `omp-market-${label}-`)));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function json(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

/** A plugin carrying every component kind OMP can discover. */
function writeFullPlugin(dir: string): void {
  json(join(dir, ".claude-plugin", "plugin.json"), {
    name: "demo",
    version: "1.0.0",
    description: "Demo",
    author: { name: "A", email: "a@example.invalid", token: "x" },
    mcpServers: { inline: { command: "echo" } },
    hooks: { PreToolUse: [] },
    lspServers: { x: { command: "echo" } },
    skills: ["./custom-skills", "./hooks/pre", "../outside", "./.hidden", "/abs"],
    commands: "./extra/run.md",
  });
  write(join(dir, "skills", "demo-skill", "SKILL.md"), "---\nname: demo-skill\ndescription: d\n---\nbody\n");
  write(join(dir, "custom-skills", "more", "SKILL.md"), "---\nname: more\ndescription: d\n---\nbody\n");
  write(join(dir, "commands", "hello.md"), "hello");
  write(join(dir, "extra", "run.md"), "run");
  write(join(dir, "extra", "secret.sh"), "echo no");
  write(join(dir, "agents", "helper.md"), "---\nname: helper\ndescription: d\n---\n");
  write(join(dir, "rules", "nice.md"), "be nice");
  write(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { file: { command: "echo" } } }));
  write(join(dir, "hooks", "pre", "bash.sh"), "echo hook");
  write(join(dir, "tools", "evil.ts"), "throw new Error('loaded')");
  write(join(dir, ".lsp.json"), "{}");
  write(join(dir, ".dap.yaml"), "x: 1");
  json(join(dir, "package.json"), { name: "demo", omp: { extensions: ["./ext.ts"] } });
}

function makeStore(): OmpMarketplaceStore {
  const store = ompMarketplaceStore(scratch("store"));
  ensureOmpMarketplaceStore(store);
  mkdirSync(store.pluginsCacheDir, { recursive: true });
  return store;
}

describe("marketplace store layout", () => {
  it("keeps the CLI working directory inside the store's HOME", () => {
    const store = makeStore();
    expect(dirname(store.launchDir)).toBe(store.home);
    expect(store.configRoot).toBe(join(store.home, ".omp"));
    for (const dir of [store.home, store.configRoot, store.agentDir, store.launchDir]) {
      expect(lstatSync(dir).isDirectory()).toBe(true);
    }
  });

  it("parses plugin ids with OMP's name rule", () => {
    expect(parseOmpPluginId("code-review@claude-plugins-official")).toEqual({
      name: "code-review",
      marketplace: "claude-plugins-official",
    });
    for (const bad of ["", "x", "@m", "x@", "-x@m", "x@m-", "a b@m", `${"a".repeat(65)}@m`, "x@--scope"]) {
      expect(parseOmpPluginId(bad)).toBeNull();
    }
  });
});

describe("registry readers", () => {
  it("reads marketplaces and drops malformed entries", () => {
    const store = makeStore();
    json(store.marketplacesRegistry, {
      version: 1,
      marketplaces: [
        { name: "good", sourceType: "github", sourceUri: "o/r", catalogPath: "/etc/passwd", addedAt: "a", updatedAt: "u" },
        { name: "-bad", sourceType: "github", sourceUri: "o/r" },
        { name: "nosource", sourceType: "github" },
        { name: "weird", sourceType: "ftp", sourceUri: "x" },
      ],
    });
    const read = readStoreMarketplaces(store);
    expect(read.marketplaces.map((m) => m.name)).toEqual(["good"]);
    expect(read.diagnostics).toHaveLength(3);
  });

  it("reads only the store's fixed catalog location", () => {
    const store = makeStore();
    json(storeCatalogPath(store, "good"), {
      name: "good",
      owner: { name: "Owner" },
      metadata: { description: "Desc" },
      plugins: [
        { name: "rel", source: "./p", version: "1.0.0", author: { name: "A" }, keywords: ["k"], tags: ["t"], mcpServers: { s: {} } },
        { name: "gh", source: { source: "github", repo: "o/r" }, hooks: "./hooks.json" },
        { name: "npm", source: { source: "npm", package: "x" } },
        { name: "odd", source: "plugins/x" },
        { name: "rel", source: "./dup" },
        { name: "_bad", source: "./x" },
      ],
    });
    const catalog = readStoreCatalog(store, "good");
    expect(catalog.ownerName).toBe("Owner");
    expect(catalog.plugins.map((p) => [p.name, p.sourceKind])).toEqual([
      ["rel", "relative"],
      ["gh", "github"],
      ["npm", "npm"],
      ["odd", "unknown"],
    ]);
    expect(catalog.plugins[0]?.keywords).toEqual(["k", "t"]);
    expect(catalog.plugins[0]?.declares.mcp).toBe(true);
    expect(catalog.plugins[1]?.declares.hooks).toBe(true);
    expect(() => readStoreCatalog(store, "missing")).toThrow(/missing/);
  });

  it("refuses a registry that is a symlink", () => {
    const store = makeStore();
    const elsewhere = join(scratch("elsewhere"), "marketplaces.json");
    json(elsewhere, { version: 1, marketplaces: [] });
    symlinkSync(elsewhere, store.marketplacesRegistry);
    expect(() => readStoreMarketplaces(store)).toThrow(/not a regular file/);
  });

  it("keeps user installs only and never trusts a path outside the cache", () => {
    const store = makeStore();
    const inside = join(store.pluginsCacheDir, "m___a___1.0.0");
    mkdirSync(inside);
    const outside = scratch("outside");
    json(store.installedRegistry, {
      version: 2,
      plugins: {
        "a@m": [{ scope: "user", installPath: inside, version: "1.0.0", installedAt: "i", lastUpdated: "l" }],
        "b@m": [{ scope: "user", installPath: outside, version: "1.0.0", enabled: false }],
        "c@m": [{ scope: "project", installPath: inside, version: "1.0.0" }],
        "bad id": [{ scope: "user", installPath: inside }],
      },
    });
    const read = readStoreInstalled(store);
    expect(read.installed.map((p) => [p.id, p.installPath, p.enabled])).toEqual([
      ["a@m", inside, true],
      ["b@m", null, false],
    ]);
    expect(read.diagnostics.join("\n")).toMatch(/b@m: install path/);
  });
});

describe("plugin components", () => {
  it("reports loaded and executable components", () => {
    const plugin = join(scratch("inspect"), "plugin");
    writeFullPlugin(plugin);
    expect(inspectPluginComponents(plugin)).toEqual({
      loaded: { skills: 1, commands: 1, agents: 1, rules: 1 },
      executable: ["mcp", "hooks", "tools", "lsp", "dap", "extensions"],
    });
  });
});

describe("run projection", () => {
  function installed(store: OmpMarketplaceStore, plugins: Record<string, { version: string; enabled?: boolean }>): void {
    const registry: Record<string, unknown[]> = {};
    for (const [id, entry] of Object.entries(plugins)) {
      const name = id.split("@")[0] as string;
      const dir = join(store.pluginsCacheDir, `m___${name}___${entry.version}`);
      writeFullPlugin(dir);
      registry[id] = [{ scope: "user", installPath: dir, version: entry.version, installedAt: "i", lastUpdated: entry.version, ...(entry.enabled === false ? { enabled: false } : {}) }];
    }
    json(store.installedRegistry, { version: 2, plugins: registry });
  }

  it("projects enabled installs at their store directories and nothing else", () => {
    const store = makeStore();
    installed(store, { "a@m": { version: "1.0.0" }, "b@m": { version: "1.0.0", enabled: false } });
    const snapshot = marketplaceRunSnapshot(store);
    expect(snapshot.plugins.map((p) => p.id)).toEqual(["a@m"]);
    const run = scratch("run");
    const configRoot = join(run, "home", ".omp-runtime-x");
    const result = projectMarketplacePlugins({ snapshot, configRoot });
    expect(result).toEqual({ projected: ["a@m"] });
    const registry = JSON.parse(readFileSync(join(configRoot, "plugins", "installed_plugins.json"), "utf8"));
    expect(registry.version).toBe(2);
    expect(registry.plugins["a@m"][0].installPath).toBe(snapshot.plugins[0]?.installPath);
    // The run never receives the store's lockfile or node_modules tree.
    expect(readdirSync(join(configRoot, "plugins"))).toEqual(["installed_plugins.json"]);
  });

  it("writes nothing when no plugin is enabled", () => {
    const store = makeStore();
    const run = scratch("empty");
    const result = projectMarketplacePlugins({ snapshot: marketplaceRunSnapshot(store), configRoot: join(run, "cfg") });
    expect(result.projected).toEqual([]);
    expect(existsSync(join(run, "cfg"))).toBe(false);
  });

  it("changes the fingerprint when the loadable set changes", () => {
    const store = makeStore();
    installed(store, { "a@m": { version: "1.0.0" } });
    const first = marketplaceRunSnapshot(store).fingerprint;
    installed(store, { "a@m": { version: "1.1.0" } });
    const second = marketplaceRunSnapshot(store).fingerprint;
    installed(store, { "a@m": { version: "1.1.0", enabled: false } });
    const third = marketplaceRunSnapshot(store).fingerprint;
    expect(new Set([first, second, third]).size).toBe(3);
    expect(marketplaceRunSnapshot(store).fingerprint).toBe(third);
  });
});

describe("market state", () => {
  it("assembles sources, catalog plugins and installed plugins", () => {
    const store = makeStore();
    json(store.marketplacesRegistry, {
      version: 1,
      marketplaces: [
        { name: "gitm", sourceType: "github", sourceUri: "o/r", addedAt: "a", updatedAt: "u" },
        { name: "urlm", sourceType: "url", sourceUri: "https://x/m.json", addedAt: "a", updatedAt: "u" },
        { name: "gone", sourceType: "local", sourceUri: "/nowhere", addedAt: "a", updatedAt: "u" },
      ],
    });
    json(storeCatalogPath(store, "gitm"), {
      name: "gitm",
      owner: { name: "O" },
      plugins: [
        { name: "a", source: "./a", version: "1.2.0", homepage: "javascript:alert(1)", repository: "https://github.com/o/r" },
        { name: "n", source: { source: "npm", package: "n" } },
      ],
    });
    json(storeCatalogPath(store, "urlm"), { name: "urlm", owner: { name: "O" }, plugins: [{ name: "r", source: "./r" }] });
    const dir = join(store.pluginsCacheDir, "gitm___a___1.0.0");
    writeFullPlugin(dir);
    json(store.installedRegistry, {
      version: 2,
      plugins: { "a@gitm": [{ scope: "user", installPath: dir, version: "1.0.0", installedAt: "i", lastUpdated: "l" }] },
    });
    const diagnostics: string[] = [];
    const state = readOmpMarketState(store, { available: true, onDiagnostic: (m) => diagnostics.push(m) });
    expect(state.sources.map((s) => [s.name, s.pluginCount, s.error === undefined])).toEqual([
      ["gitm", 2, true],
      ["urlm", 1, true],
      ["gone", 0, false],
    ]);
    const byId = Object.fromEntries(state.plugins.map((p) => [p.id, p]));
    expect(byId["a@gitm"]?.homepage).toBeUndefined();
    expect(byId["a@gitm"]?.repository).toBe("https://github.com/o/r");
    expect(byId["n@gitm"]).toMatchObject({ installable: false, unavailableReason: "npm-source" });
    expect(byId["r@urlm"]).toMatchObject({ installable: false, unavailableReason: "relative-source-in-url-catalog" });
    expect(state.installed).toEqual([
      expect.objectContaining({ id: "a@gitm", updateVersion: "1.2.0", enabled: true, components: expect.objectContaining({ executable: expect.arrayContaining(["mcp", "tools"]) }) }),
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("degrades instead of throwing on a damaged registry", () => {
    const store = makeStore();
    write(store.marketplacesRegistry, "{oops");
    const diagnostics: string[] = [];
    const state = readOmpMarketState(store, { available: false, unavailableReason: "no runtime", onDiagnostic: (m) => diagnostics.push(m) });
    expect(state).toEqual({ available: false, unavailableReason: "no runtime", sources: [], plugins: [], installed: [] });
    expect(diagnostics[0]).toMatch(/marketplaces registry unreadable/);
  });

  it("compares catalog versions like OMP's upgrade check", () => {
    expect(isNewerCatalogVersion("1.0.0", "1.0.1")).toBe(true);
    expect(isNewerCatalogVersion("1.2.0", "1.10.0")).toBe(true);
    expect(isNewerCatalogVersion("1.0.1", "1.0.0")).toBe(false);
    expect(isNewerCatalogVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerCatalogVersion("1.0.0", undefined)).toBe(false);
    expect(isNewerCatalogVersion("1.0.0-beta.1", "1.0.0")).toBe(true);
    expect(isNewerCatalogVersion("1.0.0", "1.0.0-beta.1")).toBe(false);
    expect(isNewerCatalogVersion("abc123", "def456")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("plugin CLI runner", () => {
  /** A stand-in launcher that records what it was given into its cwd. */
  function fakeLauncher(behavior: "ok" | "fail" | "hang"): string {
    const dir = scratch("launcher");
    const path = join(dir, "omp");
    write(
      path,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync('evidence.json', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));",
        behavior === "fail"
          ? "process.stderr.write('\\u001b[31m✘ Failed to install x@m: Error: Plugin \"x\" not found in marketplace \"m\"\\u001b[0m\\n'); process.exit(1);"
          : behavior === "hang"
            ? "setInterval(() => {}, 1000);"
            : "process.stdout.write('done\\n');",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
    return path;
  }

  it("runs `plugin …` inside the store with the isolated environment", async () => {
    const store = makeStore();
    const result = await runOmpPluginCli({
      launcher: fakeLauncher("ok"),
      store,
      args: ["install", "x@m", "--scope", "user"],
      pathEntries: mockPathEntries(),
      baseEnv: { PATH: process.env.PATH, OPENAI_API_KEY: "sk-test", XDG_DATA_HOME: "/tmp/elsewhere", LANG: "en_US.UTF-8" },
      proxy: { url: "http://127.0.0.1:7890", bypass: "localhost" },
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, aborted: false });
    const evidence = JSON.parse(readFileSync(join(store.launchDir, "evidence.json"), "utf8"));
    expect(evidence.argv).toEqual(["plugin", "install", "x@m", "--scope", "user"]);
    expect(realpathSync(evidence.cwd)).toBe(realpathSync(store.launchDir));
    expect(evidence.env.HOME).toBe(store.home);
    expect(evidence.env.PI_CONFIG_DIR).toBe(".omp");
    expect(evidence.env.PI_CODING_AGENT_DIR).toBe(store.agentDir);
    expect(evidence.env.NO_COLOR).toBe("1");
    expect(evidence.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(evidence.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(evidence.env.OPENAI_API_KEY).toBeUndefined();
    expect(evidence.env.XDG_DATA_HOME).toBeUndefined();
  });

  it("lifts OMP's failure line without terminal escapes", async () => {
    const store = makeStore();
    const result = await runOmpPluginCli({ launcher: fakeLauncher("fail"), store, args: ["install", "x@m"], pathEntries: mockPathEntries() });
    expect(result.exitCode).toBe(1);
    expect(ompPluginCliFailure(result)).toBe('Failed to install x@m: Plugin "x" not found in marketplace "m"');
  });

  it("stops a command that outlives its timeout", async () => {
    const store = makeStore();
    const result = await runOmpPluginCli({ launcher: fakeLauncher("hang"), store, args: ["list"], pathEntries: mockPathEntries(), timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(ompPluginCliFailure(result)).toBe("the OMP plugin command timed out");
  });

  it("does not start when already cancelled", async () => {
    const store = makeStore();
    const controller = new AbortController();
    controller.abort();
    const result = await runOmpPluginCli({ launcher: fakeLauncher("ok"), store, args: ["list"], signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(existsSync(join(store.launchDir, "evidence.json"))).toBe(false);
  });
});

describe("native addon pruning", () => {
  it("keeps only the current runtime version", () => {
    const store = makeStore();
    for (const version of ["18.2.7", "18.3.0"]) write(join(store.nativesDir, version, "addon.node"), "x");
    pruneStaleNatives(store, "18.3.0");
    expect(readdirSync(store.nativesDir)).toEqual(["18.3.0"]);
  });
});
