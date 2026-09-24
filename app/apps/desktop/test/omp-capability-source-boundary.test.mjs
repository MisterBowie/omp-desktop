/**
 * Probes for the production capability-source boundary (M5/T19-A).
 *
 * These reproduce the wiring-level risks through the real production
 * constructors, not source text:
 *
 *   - the production launcher currently loads the desktop approval gate with
 *     `--extension`, which leaves OMP's ambient extension discovery enabled:
 *     an extension dropped into the agent dir's `extensions/`, a hook factory,
 *     a plugin extension entry point, or a `settings.json` extension list would
 *     load and execute alongside the gate. The trusted launch boundary
 *     (`--trusted-extension`) is an exact file allowlist that disables that
 *     discovery, so the gate is the only module that runs.
 *   - the run-scoped config overlay must come from the supervisor's run paths,
 *     never from a static constructor argument, so each run owns its boundary
 *     file and the cleanup lifecycle removes it.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import test from "node:test";

import { closedEngineCapabilities } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createDesktopEngineRuntime } = await import("../electron/main/runtime/engine-runtime.ts");
const { createOmpRuntimeAdapter } = await import("../electron/main/runtime/omp-runtime.ts");

/** Minimal stand-in for the OMP adapter; only construction inputs matter here. */
function fakeOmpRuntime() {
  return {
    launcher: "/nonexistent/omp",
    status: () => ({ engine: "omp", phase: "stopped", reason: "not-started", capabilities: closedEngineCapabilities() }),
    reclaim: async () => [],
  };
}

test("the production gate load uses the trusted-extension boundary, not ambient discovery", () => {
  let captured = null;
  const runtime = createDesktopEngineRuntime({
    dataRoot: "/tmp/engine-runtime-boundary-test",
    isPackaged: false,
    appPath: here,
    piRuntimeLive: () => true,
    ompAdapterFactory: (options) => {
      captured = options;
      return fakeOmpRuntime();
    },
  });

  assert.ok(captured, "the adapter must be constructed");
  const args = captured.args ?? [];
  // The gate must never ride `--extension`: that flag keeps OMP's ambient
  // extension discovery enabled, so anything discoverable would run beside it.
  assert.ok(!args.includes("--extension"), `--extension leaves ambient discovery on: ${args.join(" ")}`);
  const index = args.indexOf("--trusted-extension");
  assert.notEqual(index, -1, `the gate must be loaded through --trusted-extension: ${args.join(" ")}`);
  assert.equal(args.length, 2, "the gate is the only launch argument the wiring adds");
  assert.ok(runtime.gateExtension, "the gate must resolve from this checkout");
  assert.equal(args[index + 1], runtime.gateExtension, "the trusted path must be the gate this build ships");
});

test("per-session supervisors keep the gate trusted and never carry a static config path", () => {
  const captured = [];
  const adapter = createOmpRuntimeAdapter({
    env: { OMP_DESKTOP_RUNTIME: process.execPath },
    isPackaged: false,
    appPath: here,
    dataRoot: "/tmp/omp-adapter-boundary-test",
    expectedRuntimeVersion: null,
    args: ["--trusted-extension", "/opt/gate.ts"],
    supervisorFactory: (options) => {
      captured.push(options);
      return {};
    },
  });

  // The per-session supervisor is what the session bridge starts; the gate flag
  // must survive the composition and the overlay must not appear as a static
  // constructor argument (it is a per-run file the supervisor creates).
  adapter.createSupervisor({ modelSelector: "m1fake/local-model" });
  const options = captured[captured.length - 1];
  const args = options.args ?? [];
  assert.ok(!args.includes("--extension"), `--extension leaves ambient discovery on: ${args.join(" ")}`);
  assert.deepEqual(args, ["--trusted-extension", "/opt/gate.ts", "--model", "m1fake/local-model"]);
  assert.ok(!args.includes("--config"), "the config overlay must be run-scoped, not a static argument");
});
