/**
 * The bundled-sidecar build entry's refusals, and the desktop pins it must
 * agree with.
 *
 * The build entry decides which OMP source tree may become the shipped runtime.
 * These tests hold it to that: a checkout from the wrong remote, at the wrong
 * commit, with a dirty tree, with a version or file set that disagrees with the
 * controlled patch manifest, or whose patch is not the applied one, must be
 * refused before any compiler runs. The synthetic fixtures are tiny git
 * repositories, so nothing here needs the real fork checkout; the one test that
 * runs a build uses the fixture's tiny stand-in binary and bundles the real
 * tool gate with the real Bun.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  OMP_RUNTIME_BASE_SHA,
  OMP_RUNTIME_FORK_COMMIT,
  OMP_RUNTIME_FORK_REPOSITORY,
  OMP_RUNTIME_PATCH_LEVEL,
  OMP_RUNTIME_VERSION,
} from "@pi-desktop/shared";

import {
  FIXTURE_VERSION,
  cleanupScratch,
  fixtureRepo,
  git,
  scratch,
  writeFixtureManifest,
} from "./helpers/omp-fork-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..", "..");
const sidecarScript = join(appRoot, "scripts", "omp-sidecar.mjs");
const patchScript = join(appRoot, "scripts", "omp-patch.mjs");
const manifestPath = join(appRoot, "patches", "oh-my-pi", "manifest.json");

register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { validateForkCheckout, normalizeRepositoryUrl: scriptNormalize, buildBinaryArgs, SIDECAR_BYTECODE } =
  await import(pathToFileURL(sidecarScript));
const { bunBinary, loadManifest } = await import(pathToFileURL(patchScript));
const { normalizeRepositoryUrl: packageNormalize } = await import(
  "../../../packages/omp-runtime/src/bundled.ts"
);
const { OMP_APPROVAL_OPTIONS } = await import(
  "../../../packages/omp-runtime/src/session/approval-protocol.ts"
);

process.on("exit", cleanupScratch);

test("the build entry passes an explicit bytecode mode the fork accepts", () => {
  // The release contract, not an incidental default: the sidecar build names the
  // compile mode instead of inheriting one, and `build.bytecode` in the
  // provenance states it, so the two can never disagree silently. The fork's
  // build entry rejects every other spelling (see its own test), which is what
  // makes a drift here a build failure rather than a different artifact.
  assert.deepEqual(buildBinaryArgs(true), ["scripts/build-binary.ts", "--bytecode"]);
  assert.deepEqual(buildBinaryArgs(false), ["scripts/build-binary.ts", "--no-bytecode"]);
  assert.equal(SIDECAR_BYTECODE, true);
});

test("the desktop pins agree with the controlled patch manifest", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(OMP_RUNTIME_BASE_SHA, manifest.base.sha);
  assert.equal(OMP_RUNTIME_VERSION, manifest.base.version);
  assert.equal(OMP_RUNTIME_PATCH_LEVEL, manifest.patchLevel);
  assert.equal(OMP_RUNTIME_FORK_REPOSITORY, manifest.fork.repository);
  assert.equal(OMP_RUNTIME_FORK_COMMIT, manifest.fork.commit);
  assert.match(manifest.fork.commit, /^[0-9a-f]{40}$/);
});

test("the build entry and the runtime package normalize remotes identically", () => {
  const spellings = [
    "https://github.com/MisterBowie/oh-my-pi",
    "https://github.com/MisterBowie/oh-my-pi.git",
    "git@github.com:MisterBowie/oh-my-pi.git",
    "ssh://git@github.com/MisterBowie/oh-my-pi.git",
    "https://github.com/can1357/oh-my-pi",
    "not a url",
  ];
  for (const spelling of spellings) {
    assert.equal(scriptNormalize(spelling), packageNormalize(spelling), spelling);
  }
  assert.equal(scriptNormalize("git@github.com:MisterBowie/oh-my-pi.git"), "github.com/misterbowie/oh-my-pi");
});

test("a checkout whose HEAD is the manifest's fork commit and patch verifies", () => {
  const { root, manifest, patchPath, headSha } = fixtureRepo();
  const info = validateForkCheckout(root, manifest, patchPath);
  assert.equal(info.head, headSha);
  assert.equal(info.version, FIXTURE_VERSION);
  assert.equal(info.remote, "github.com/misterbowie/oh-my-pi");
});

test("an SSH remote is accepted for an HTTPS manifest entry", () => {
  const { root, manifest, patchPath } = fixtureRepo({ remote: "git@github.com:MisterBowie/oh-my-pi.git" });
  assert.doesNotThrow(() => validateForkCheckout(root, manifest, patchPath));
});

test("the wrong remote, commit, cleanliness, version, file set, or patch is refused", () => {
  const cases = [
    {
      name: "remote",
      build: () => fixtureRepo({ remote: "https://github.com/can1357/oh-my-pi.git" }),
      expect: /origin is github\.com\/can1357\/oh-my-pi/,
    },
    {
      name: "commit",
      build: () => {
        const fixture = fixtureRepo();
        git(["checkout", "-q", fixture.baseSha], fixture.root);
        return fixture;
      },
      expect: /HEAD is .*, the manifest pins fork commit/,
    },
    {
      name: "dirty tree",
      build: () => {
        const fixture = fixtureRepo();
        writeFileSync(join(fixture.root, "src", "tool.ts"), "export const value = 'dirty';\n");
        return fixture;
      },
      expect: /uncommitted changes/,
    },
    {
      name: "version",
      build: () => fixtureRepo(),
      mutate: (fixture) => {
        fixture.manifest.base.version = "1.0.0";
      },
      expect: /source version is 9\.9\.9/,
    },
    {
      name: "file set",
      build: () => fixtureRepo(),
      mutate: (fixture) => {
        fixture.manifest.files = [];
      },
      expect: /differs from base .* in 1 file\(s\), the manifest declares 0/,
    },
    {
      name: "patch",
      build: () => fixtureRepo(),
      mutate: (fixture) => {
        writeFileSync(fixture.patchPath, "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
      },
      expect: /git apply --check --reverse/,
    },
  ];
  for (const scenario of cases) {
    const fixture = scenario.build();
    scenario.mutate?.(fixture);
    assert.throws(
      () => validateForkCheckout(fixture.root, fixture.manifest, fixture.patchPath),
      scenario.expect,
      `expected ${scenario.name} to be refused`,
    );
  }
});

test("--check runs the same gate as a process, exiting non-zero on refusal", () => {
  const good = fixtureRepo();
  const goodManifest = writeFixtureManifest(good);
  const goodRun = spawnSync(
    process.execPath,
    [sidecarScript, "--check", "--source", good.root, "--manifest", goodManifest, "--json"],
    { encoding: "utf8" },
  );
  assert.equal(goodRun.status, 0, goodRun.stderr);
  assert.equal(JSON.parse(goodRun.stdout).forkCommit, good.headSha);

  const wrongRemote = fixtureRepo({ remote: "https://github.com/can1357/oh-my-pi.git" });
  const wrongRemoteManifest = writeFixtureManifest(wrongRemote);
  const refused = spawnSync(
    process.execPath,
    [sidecarScript, "--check", "--source", wrongRemote.root, "--manifest", wrongRemoteManifest],
    { encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /OMP-SIDECAR-FAIL .*origin is github\.com\/can1357/);

  // The same gate rejects a checkout whose HEAD is not the manifest's commit.
  const wrongCommit = spawnSync(
    process.execPath,
    [
      sidecarScript,
      "--check",
      "--source",
      good.root,
      "--manifest",
      writeFixtureManifest(good, (m) => {
        m.fork.commit = "f".repeat(40);
      }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stderr, /the manifest pins fork commit f{40}/);
});

test("the patch manifest refuses a malformed fork block", () => {
  const fixture = fixtureRepo();
  assert.doesNotThrow(() => loadManifest(writeFixtureManifest(fixture)));
  assert.throws(
    () => loadManifest(writeFixtureManifest(fixture, (m) => delete m.fork)),
    /manifest field fork\.repository is missing/,
  );
  assert.throws(
    () => loadManifest(writeFixtureManifest(fixture, (m) => (m.fork.commit = "not-a-sha"))),
    /fork\.commit is not a full commit id/,
  );
  assert.throws(
    () => loadManifest(writeFixtureManifest(fixture, (m) => (m.fork.tree = "short"))),
    /fork\.tree is not a full tree id/,
  );
});

/**
 * Outcome determinism for the one compile in this build that goes through a
 * bundler: Bun writes each module's path comment relative to the build cwd, so
 * the gate's bytes — and its provenance digest — must not depend on the
 * transient `mkdtemp` run root, whose depth follows `TMPDIR`. Two real builds
 * under run roots of different depth must land on identical gate bytes and an
 * identical provenance manifest; the heavy binary is the fixture's stand-in,
 * the gate bundle is the real one.
 *
 * Scope: the fixture's stand-in binary is a `#!/bin/sh` script that the build
 * path executes, so this regression currently covers POSIX hosts only. Windows
 * needs a native equivalent, which is deferred to T23 — the win32 skip below is
 * a scope boundary, not evidence of Windows support.
 */
const bunProbe = spawnSync(bunBinary(), ["--version"], { encoding: "utf8" });

// Two independent reasons this regression cannot execute here. Either one
// skips the case with its own reason; both are reported when both hold.
const gateDepthSkips = [
  process.platform === "win32" &&
    "the fixture's build entry writes a POSIX /bin/sh stand-in binary; native Windows verification is deferred to T23",
  bunProbe.status !== 0 &&
    `Bun is required to bundle the tool gate (install Bun 1.4.2 or set BUN_BINARY): ${(bunProbe.error?.message ?? bunProbe.stderr ?? "").trim()}`,
].filter(Boolean);

test(
  "the tool gate bundle is identical under temporary roots of different depth",
  {
    skip: gateDepthSkips.length > 0 ? gateDepthSkips.join(" | ") : false,
    timeout: 180_000,
  },
  () => {
    const fixture = fixtureRepo();
    const manifestPath = writeFixtureManifest(fixture);
    const root = scratch("depth");
    const shallowTmp = join(root, "shallow");
    const deepTmp = join(root, "deep", "one", "two", "three");
    mkdirSync(shallowTmp, { recursive: true });
    mkdirSync(deepTmp, { recursive: true });

    const buildUnder = (tmp, label) => {
      const out = join(root, label);
      const run = spawnSync(
        process.execPath,
        [sidecarScript, "--build", "--source", fixture.root, "--manifest", manifestPath, "--out", out, "--json"],
        { encoding: "utf8", env: { ...process.env, TMPDIR: tmp } },
      );
      assert.equal(run.status, 0, `${label}: ${run.stderr}`);
      return {
        provenance: JSON.parse(run.stdout),
        gate: readFileSync(join(out, "extensions", "omp-desktop-gate.js")),
      };
    };

    const shallow = buildUnder(shallowTmp, "shallow");
    const deep = buildUnder(deepTmp, "deep");
    assert.deepEqual(deep.gate, shallow.gate, "the gate bundle must not depend on the run root");
    assert.deepEqual(
      deep.provenance,
      shallow.provenance,
      "the provenance manifest must not depend on the run root",
    );
    // The gate is loaded from Resources, where nothing can resolve a relative
    // import beside it: the bundle must stay self-contained.
    assert.doesNotMatch(shallow.gate.toString("utf8"), /(?:from|import)\s*\(?\s*["'][.]{1,2}\//);
  },
);

/**
 * The shipped artifact, not the TS source: bundle the real gate with the real
 * Bun and drive its `tool_call` handler in a child process, exactly as the
 * runtime loads it from Resources. This proves the execution-time decision
 * table (M5/T20-C) survives bundling — the unit tests alone cannot show that
 * the compiled artifact carries it.
 */
test(
  "the bundled tool gate carries the execution-time decision table",
  {
    skip: gateDepthSkips.length > 0 ? gateDepthSkips.join(" | ") : false,
    timeout: 180_000,
  },
  () => {
    const fixture = fixtureRepo();
    const fixtureManifest = writeFixtureManifest(fixture);
    const root = scratch("gate-behavior");
    const out = join(root, "out");
    const build = spawnSync(
      process.execPath,
      [sidecarScript, "--build", "--source", fixture.root, "--manifest", fixtureManifest, "--out", out, "--json"],
      { encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(build.status, 0, `the gate build must succeed: ${build.stderr}`);
    const gatePath = join(out, "extensions", "omp-desktop-gate.js");
    assert.ok(readFileSync(gatePath, "utf8").length > 0, "the bundle must exist");

    const probePath = join(root, "gate-probe.mjs");
    writeFileSync(
      probePath,
      [
        'import { readFileSync } from "node:fs";',
        "const [gatePath, statePath, eventJson, contextJson, answer, mode] = process.argv.slice(2);",
        'if (statePath !== "-") process.env.OMP_DESKTOP_STATE = statePath;',
        'process.env.OMP_DESKTOP_STATE_REQUIRED = "1";',
        "const gate = await import(gatePath);",
        "const handlers = new Map();",
        "const commands = new Map();",
        "const cards = [];",
        "gate.default({",
        "  on: (event, handler) => handlers.set(event, handler),",
        "  registerCommand: (name, definition) => commands.set(name, definition.handler),",
        "  getActiveTools: () => [],",
        "  setActiveTools: async () => undefined,",
        "  logger: { warn: () => undefined },",
        "});",
        "const raw = JSON.parse(contextJson);",
        "const context = {",
        "  cwd: raw.cwd,",
        "  hasUI: raw.hasUI,",
        "  sessionManager: { getSessionId: () => raw.sessionId, getCwd: () => raw.cwd },",
        "  abort: () => undefined,",
        "  ui: {",
        "    notify: () => undefined,",
        "    select: async (_title, items) => {",
        "      cards.push(items[0]?.description ? JSON.parse(items[0].description) : null);",
        "      return answer;",
        "    },",
        "  },",
        "};",
        // The product shape (M5/T20-C review repair): the turn admission is
        // installed through the fence before the start, and every call decides
        // from it. The compiled bundle must carry the admission codec, the
        // start handlers and the decision table; a state path of \"-\" leaves
        // the process without an admission (the mandatory-channel refusal).
        "if (statePath !== \"-\") {",
        "  const state = JSON.parse(readFileSync(statePath, \"utf8\"));",
        "  const admission = Buffer.from(JSON.stringify({",
        "    v: 1,",
        "    nativeSessionId: state.sessionId,",
        "    mode: state.mode,",
        "    permissionMode: state.permissionMode,",
        "    hostTools: state.hostTools,",
        "    grants: [],",
        "  }), \"utf8\").toString(\"base64url\");",
        "  const token = \"a\".repeat(32);",
        "  commands.get(\"omp-desktop-turn\")(`${token} ${admission}`, context);",
        "  await handlers.get(\"before_agent_start\")({ type: \"before_agent_start\", systemPrompt: [\"native\"] }, context);",
        "  handlers.get(\"agent_start\")({ type: \"agent_start\" }, context);",
        "}",
        "const verdict = await handlers.get(\"tool_call\")(JSON.parse(eventJson), context);",
        'process.stdout.write(JSON.stringify({ verdict: verdict ?? null, cards }));',
      ].join("\n"),
      "utf8",
    );

    const statePath = join(root, "desktop-state.json");
    const writeState = (mode, permissionMode, hostTools) =>
      writeFileSync(
        statePath,
        JSON.stringify({
          v: 2,
          sessionId: "omp-sidecar-session",
          writtenAt: Date.now(),
          mode,
          modeBlock: `block:${mode}`,
          permissionMode,
          memory: null,
          skills: [],
          hostTools,
        }),
        "utf8",
      );
    const context = JSON.stringify({
      cwd: root,
      sessionId: "omp-sidecar-session",
      hasUI: true,
    });
    const probe = (state, event, answer) => {
      const args = [probePath, gatePath, state, JSON.stringify(event), context, answer];
      const run = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(run.status, 0, `the probe must exit 0: ${run.stderr}`);
      return JSON.parse(run.stdout);
    };

    // Plan hard deny: the shipped gate blocks Write before any card.
    writeState("plan", "ask", []);
    const denied = probe(
      statePath,
      { type: "tool_call", toolCallId: "c1", toolName: "write", input: { path: join(root, "x.txt"), content: "x" } },
      OMP_APPROVAL_OPTIONS[0],
    );
    assert.equal(denied.verdict?.block, true);
    assert.match(denied.verdict?.reason ?? "", /WRITE_DISABLED_IN_PLAN/);
    assert.equal(denied.cards.length, 0, "the contract deny must precede the card");

    // Plan + ask + allowed Bash: a card whose policy values come from the
    // shipped state snapshot.
    const bash = probe(
      statePath,
      { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "true" } },
      OMP_APPROVAL_OPTIONS[0],
    );
    assert.equal(bash.verdict, null);
    assert.equal(bash.cards.length, 1);
    assert.equal(bash.cards[0].risk, "high");
    assert.equal(bash.cards[0].mode, "plan");
    assert.equal(bash.cards[0].permissionMode, "ask");

    // Agent + Low user MCP: no card in the shipped artifact either.
    writeState("agent", "ask", [
      { name: "mcp_alpha_lookup", risk: "low", planSafeActions: [], origin: "user-mcp" },
    ]);
    const mcp = probe(
      statePath,
      { type: "tool_call", toolCallId: "c3", toolName: "mcp_alpha_lookup", input: {} },
      OMP_APPROVAL_OPTIONS[2],
    );
    assert.equal(mcp.verdict, null);
    assert.equal(mcp.cards.length, 0);

    // The mandatory channel without a readable state: every call fails closed.
    const missing = probe(
      "-",
      { type: "tool_call", toolCallId: "c4", toolName: "read", input: {} },
      OMP_APPROVAL_OPTIONS[0],
    );
    assert.equal(missing.verdict?.block, true);
    assert.match(missing.verdict?.reason ?? "", /policy is unavailable/);
  },
);
