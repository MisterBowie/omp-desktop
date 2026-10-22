import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } =
  await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { resolveProviderProjection, projectModelsYaml } = await import("../electron/main/runtime/omp-model-projection.ts");
const { ENGINE_ADAPTER_VERSION } = await import("../../../packages/shared/src/engine.ts");
const { ensureAttachmentBlob } = await import("../electron/main/prompt-attachments.ts");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=",
  "base64",
);

test("native OMP sends an inline image to a vision model and keeps it on the live and restored user row", {
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources",
  timeout: 60_000,
}, async (t) => {
  const resources = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-image-prompt-")));
  const ended = Promise.withResolvers();
  let provider;
  let supervisor;
  let bridge;
  t.after(async () => {
    const disposed = await bridge?.dispose();
    const stopped = await supervisor?.stop();
    await provider?.close();
    rmSync(root, { recursive: true, force: true });
    if (disposed) assert.equal(disposed.ok, true);
    if (stopped) {
      assert.equal(stopped.reaped, true);
      assert.equal(stopped.cleaned, true);
    }
  });
  provider = await FakeProvider.start({ model: "vision-model" });
  provider.script([{ text: "A single pixel.", finish: "stop" }]);
  const resolved = resolveProviderProjection({
    id: "fixture", apiStyle: "chat_completions", authKind: "none", baseUrl: provider.baseUrl,
    models: [{ id: "vision-model", supportsImages: true }],
  }, "vision-model", null);
  assert.equal(resolved.ok, true);
  const sessionDir = ensureSessionStateDir(root);
  supervisor = new OmpRuntimeSupervisor({
    dataRoot: root, launcherPath: resources.path, sessionDir,
    desktopStateRequired: false,
    args: ["--model", "fixture/vision-model", "--trusted-extension", findGateExtension(here)],
    extraEnv: { OMP_DESKTOP_GATE_TOOLS: "read", OMP_DESKTOP_GATE_MODE: "allow" },
    prepareRun: (paths) => writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(resolved.projection)),
  });
  let nativeRef;
  const events = [];
  const dataDir = join(root, "data");
  bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor, launcher: resources.path, isPackaged: false, appPath: here,
    sessionDir, gateResolver: () => findGateExtension(here),
    persistNativeSession: (value) => { nativeRef = value; },
    storeImage: (bytes) => ensureAttachmentBlob(dataDir, bytes),
    emitAgentEvent: ({ event }) => {
      events.push(event);
      if (event.type === "agent_end") ended.resolve();
    },
  });
  const sessionId = "image-prompt";
  const started = await bridge.prompt({
    sessionId, content: "Describe the image.", projectPath: root,
    userMessageId: "11111111-2222-4333-8444-555555555555",
    images: [{ data: PNG.toString("base64"), mimeType: "image/png" }],
  });
  assert.equal(started.accepted, true);
  await ended.promise;

  const request = provider.requests.find((entry) => entry.url.endsWith("/chat/completions"));
  assert.ok(request, "the model was called");
  const user = request.body.messages.findLast((message) => message.role === "user");
  assert.ok(Array.isArray(user.content), "a user message with an image is sent as content parts");
  assert.ok(user.content.some((part) => part.type === "text" && part.text.includes("Describe the image.")));
  const sent = user.content.find((part) => part.type === "image_url");
  assert.match(sent?.image_url?.url ?? "", /^data:image\/[a-z]+;base64,[A-Za-z0-9+/]+=*$/, "the image reaches the provider as image content");

  // OMP may re-encode the image it receives, so the row names the bytes the
  // runtime kept, written to the desktop's content-addressed store.
  const persisted = events.find((event) => event.type === "user_message_persisted");
  const live = persisted?.message.attachments;
  assert.equal(live?.length, 1, "the live row that replaces the optimistic one keeps the image");
  assert.equal(live[0].kind, "image");
  assert.match(live[0].ref, /^attachments\/[0-9a-f]{64}$/);
  const kept = readFileSync(join(dataDir, live[0].ref));
  assert.equal(live[0].ref, `attachments/${createHash("sha256").update(kept).digest("hex")}`);
  assert.equal(`data:${live[0].mimeType};base64,${kept.toString("base64")}`, sent.image_url.url, "the stored image is the one the model received");

  assert.ok(nativeRef, "the native session identity was persisted");
  const history = await bridge.readHistory({
    sessionId, projectPath: root,
    nativeSessionId: nativeRef.nativeSessionId, nativeSessionPath: nativeRef.nativeSessionPath,
    adapterVersion: ENGINE_ADAPTER_VERSION, runtimeVersion: nativeRef.runtimeVersion,
  });
  const restored = history.messages.find((message) => message.role === "user");
  assert.deepEqual(restored?.attachments, live, "a restored history shows the same image");
});
