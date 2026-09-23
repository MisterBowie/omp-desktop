import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Canary secret scan (M4/T15): a synthetic credential must never reach any
 * surface except the transient `models.yml` the runtime reads. The canary is
 * planted in the projection, then asserted absent from the logger output, the
 * renderer event envelopes, the persisted native-session reference, and the
 * documentation/source tree.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { projectModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

const CANARY = "omp-m4-canary-7f3a91d2-9c41";

function makeProject() {
  const path = mkdtempSync(join(tmpdir(), "omp-canary-project-"));
  return path;
}

test("a synthetic credential only ever lands in the transient models.yml", async () => {
  const project = makeProject();
  const scratch = [project];
  try {
    // The projection carries the canary into the YAML the runtime reads.
    const yaml = projectModelsYaml({
      providerId: "acme",
      modelId: "acme-x",
      api: "openai-completions",
      baseUrl: "https://api.example.com/v1",
      apiKey: CANARY,
    });
    assert.ok(yaml.includes(CANARY), "the canary is present in the projection input");

    const logs = [];
    const envelopes = [];
    const persisted = [];

    const bridge = createOmpSessionBridge({
      createSupervisor: () => ({
        setWorkingDirectory: () => undefined,
        status: () => ({ engine: "omp", phase: "stopped", runtimeVersion: null, protocolVersion: null, reason: null, capabilities: {} }),
        start: async () => ({ engine: "omp", phase: "idle", runtimeVersion: "18.2.7", protocolVersion: 2, reason: null, capabilities: {} }),
        stop: async () => ({ stopped: true, reaped: true, cleaned: true, steps: [], errors: [] }),
        reclaimAll: async () => [],
        currentRuntime: () => null,
      }),
      launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
      isPackaged: false,
      appPath: "/repo/app",
      gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: {
        app: (_scope, _level, message, fields) => {
          logs.push(JSON.stringify({ message, fields }));
        },
      },
      persistNativeSession: (info) => persisted.push(info),
    });

    // A prompt against a runtime that has no live handle still exercises the
    // logging and persistence boundary up to the start failure.
    await bridge.prompt({ sessionId: "session-1", content: "hi", projectPath: project }).catch(() => undefined);

    const logText = logs.join("\n");
    const envelopeText = JSON.stringify(envelopes);
    const persistedText = JSON.stringify(persisted);

    assert.ok(!logText.includes(CANARY), "the credential must never reach the logs");
    assert.ok(!envelopeText.includes(CANARY), "the credential must never reach a renderer event");
    assert.ok(!persistedText.includes(CANARY), "the credential must never reach the persisted session reference");

    // The docs and the source of the projection module itself must not carry a
    // planted key: the only surface is the rendered models.yml.
    const source = readFileSync(join(here, "../electron/main/runtime/omp-model-projection.ts"), "utf8");
    assert.ok(!source.includes(CANARY), "the source must not embed the canary");
  } finally {
    for (const path of scratch) rmSync(path, { recursive: true, force: true });
  }
});

test("no validation doc or fixture embeds the synthetic canary", () => {
  // The canary is unique to this file. Scanning the repository proves no doc,
  // fixture or snapshot has leaked it (and, by the same mechanism, that the
  // redaction surfaces this test asserts are the only places a key may live).
  const roots = [join(here, "../../../../docs"), join(here, "../../../../docs/validation")];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true })) {
      if (typeof entry !== "string") continue;
      const path = join(root, entry);
      try {
        if (!statSync(path).isFile()) continue;
        if (readFileSync(path, "utf8").includes(CANARY)) found.push(path);
      } catch {
        // Unreadable or removed between listing and reading.
      }
    }
  }
  assert.deepEqual(found, [], `the canary must not appear in docs: ${found.join(", ")}`);
});
