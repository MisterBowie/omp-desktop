/**
 * M5/T20-B1 third repair: a Stop that arrives while the turn fence is being
 * prepared must cancel the admitted prompt instead of letting it be submitted
 * after the abort.
 *
 * The layer is the *real* fixed patched OMP process, the product's bridge,
 * runner and gate, and a local FakeProvider. The only test seam is the
 * supervisor's public `runtimeFactory`: it wraps the real process and invokes
 * the user's `stop` synchronously right after one real command frame is
 * submitted. No RPC frame or response is delayed, forged or reordered, and
 * every backend operation runs normally — so a pass here is production
 * behavior, not a fixture-only ordering.
 *
 * Every strategy ends with the same acceptance: the canceled prompt is refused
 * with `stopping`, its content never reaches the provider, the canceled turn
 * announces exactly one `aborted` end, the session returns to idle, and the
 * next genuine prompt runs normally over the same native session identity.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { preparePatchedTree } = await import("../../../scripts/omp-patch.mjs");
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, OmpRuntimeProcess, ensureSessionStateDir, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { turnCommandToken } = await import("../../../packages/omp-runtime/src/session/turn-fence.ts");

const GATE = findGateExtension(here);
const SESSION = "fence-stop-e2e";

const scratch = [];
function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 60_000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** One recorded RPC command, with the two prompts told apart by their token. */
function describeCommand(command) {
  if (command.type !== "prompt") return { type: command.type };
  const token = turnCommandToken(command.message);
  return token ? { type: "prompt", control: true } : { type: "prompt", control: false };
}

/**
 * Wrap the real runtime process, forwarding everything unchanged, and invoke
 * `onSubmit` synchronously after the frame it selects has been submitted.
 */
function wrapRuntime(actual, onSubmit) {
  return new Proxy(actual, {
    get(target, key) {
      if (key === "request") {
        return (command, options) => {
          const result = target.request(command, options);
          onSubmit(command);
          return result;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const STRATEGIES = [
  { name: "control", trigger: null },
  {
    name: "stop-on-command-discovery",
    trigger: (command) => command.type === "get_available_commands",
  },
  {
    name: "stop-on-fence-handshake",
    trigger: (command) => command.type === "prompt" && turnCommandToken(command.message) !== null,
  },
];

test(
  "M5/T20-B1 third repair: a stop during turn-fence preparation never submits the canceled prompt",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(GATE, "the shipped tool gate must be present");

    const prepared = await preparePatchedTree({ prepareBuild: true, keep: true });
    t.after(() => prepared.cleanup());
    const LAUNCHER = join(prepared.tree, "packages", "coding-agent", "scripts", "omp");

    for (const strategy of STRATEGIES) {
      const root = makeScratch(`omp-fence-stop-${strategy.name}-`);
      const project = join(root, "project");
      const dataRoot = join(root, "data");
      mkdirSync(project);
      const sentinel = join(project, "sentinel.txt");
      writeFileSync(sentinel, "untouched\n");
      const sessionDir = ensureSessionStateDir(dataRoot);
      const canceledContent = `cancelled content ${strategy.name} ${Date.now()}`;
      const recoveredContent = `recovered content ${strategy.name} ${Date.now()}`;

      const provider = await FakeProvider.start({ model: "local-model" });
      provider.script([{ text: "ACTUAL-PROVIDER-TURN", finish: "stop" }]);

      const record = {
        rpc: [],
        providerAtStop: null,
        stateAtStop: null,
        triggered: false,
        stopTask: null,
        ends: [],
        events: [],
        native: null,
        nativeWrites: 0,
      };
      let supervisor;
      let bridge;
      let disposed = null;
      let finalStop = null;
      try {
        bridge = createOmpSessionBridge({
          createSupervisor: () => {
            supervisor = new OmpRuntimeSupervisor({
              dataRoot,
              launcherPath: LAUNCHER,
              expectedRuntimeVersion: "18.3.0",
              sessionDir,
              args: ["--model", "m1fake/local-model", "--trusted-extension", GATE],
              prepareRun: (paths) => writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" }),
              readyTimeoutMs: 60_000,
              runtimeFactory: async (options) => {
                const actual = await OmpRuntimeProcess.start(options);
                return wrapRuntime(actual, (command) => {
                  record.rpc.push(describeCommand(command));
                  if (!strategy.trigger || record.triggered || !strategy.trigger(command)) return;
                  record.triggered = true;
                  record.providerAtStop = provider.requests.filter((entry) => entry.method === "POST").length;
                  record.stopTask = bridge.stop(SESSION);
                  record.stateAtStop = bridge.status(SESSION).state;
                });
              },
            });
            supervisor.setWorkingDirectory(project);
            return supervisor;
          },
          launcher: LAUNCHER,
          isPackaged: false,
          appPath: here,
          sessionDir,
          gateResolver: () => GATE,
          // The production mandatory channel is on (the supervisor default):
          // the bridge writes the owned run-scoped state before every prompt.
          sessionPolicy: { policy: async () => ({ mode: "agent", permissionMode: "ask" }) },
          emitAgentEvent: (envelope) => record.events.push(envelope.event.type),
          onTurnEnd: (info) => record.ends.push(info),
          // The desktop persists the validated native reference and passes it
          // back on the next prompt: that is the persistent identity the
          // canceled prompt must not consume or replace.
          persistNativeSession: (info) => {
            record.native = info;
            record.nativeWrites += 1;
          },
        });

        const canceled = await bridge
          .prompt({ sessionId: SESSION, content: canceledContent, projectPath: project })
          .then(
            (value) => value,
            (error) => ({ refused: true, code: error.code ?? error.errorCode, message: error.message }),
          );
        assert.ok(!canceled.refused || strategy.trigger, `${strategy.name}: ${canceled.message ?? "refused"}`);

        if (!strategy.trigger) {
          // Control: the same layer without the stop must accept the prompt and
          // run a normal provider turn, or the counterexample proves nothing.
          assert.equal(canceled.accepted, true, `${strategy.name}: control prompt accepted`);
          await waitFor(() => bridge.status(SESSION).state === "idle");
          assert.equal(record.providerAtStop, null);
          assert.equal(provider.requests.filter((entry) => entry.method === "POST").length, 1);
          assert.deepEqual(record.ends.map((entry) => entry.reason), ["completed"]);
          assert.ok(record.events.includes("agent_start"), `${strategy.name}: the control turn really ran`);
        } else {
          assert.equal(record.triggered, true, `${strategy.name}: the stop trigger fired`);
          assert.equal(record.stateAtStop, "stopping", `${strategy.name}: stop owns the runner synchronously`);
          assert.equal(record.providerAtStop, 0, `${strategy.name}: no provider request before the stop`);
          assert.equal(canceled.refused, true, `${strategy.name}: the canceled prompt is refused`);
          assert.equal(canceled.code, "stopping", `${strategy.name}: refused with the stop reason`);
          const stop = await record.stopTask;
          assert.equal(stop.aborted, true, `${strategy.name}: the in-protocol abort was acknowledged`);
          assert.equal(stop.converged, true, `${strategy.name}: the canceled generation let the stop converge`);
          assert.equal(stop.toreDown, false, `${strategy.name}: the converged stop keeps the live process`);
          assert.equal(bridge.status(SESSION).state, "idle", `${strategy.name}: the session is idle`);
          assert.equal(bridge.status(SESSION).isRunning, false);
          assert.equal(
            provider.requests.filter((entry) => entry.method === "POST").length,
            0,
            `${strategy.name}: the canceled turn never reached the provider`,
          );
          // The canceled content was never submitted as user content: the only
          // prompt frames are the fence handshake and, later, the recovery.
          assert.deepEqual(
            record.rpc.filter((entry) => entry.type === "prompt" && !entry.control),
            [],
            `${strategy.name}: no user prompt was submitted after the stop`,
          );
          assert.deepEqual(
            record.ends.map((entry) => entry.reason),
            ["aborted"],
            `${strategy.name}: the canceled turn announces exactly one aborted end`,
          );
          assert.deepEqual(record.events, [], `${strategy.name}: no agent event was fabricated for the canceled turn`);

          // Recovery: the next genuine prompt over the same bridge and native
          // session is admitted, reaches the provider exactly once, and completes.
          assert.equal(record.nativeWrites, 1, `${strategy.name}: the native session was persisted exactly once`);
          const recovered = await bridge.prompt({
            sessionId: SESSION,
            content: recoveredContent,
            projectPath: project,
            nativeSessionId: record.native?.nativeSessionId,
            nativeSessionPath: record.native?.nativeSessionPath,
          });
          assert.equal(recovered.accepted, true, `${strategy.name}: the recovery prompt is accepted`);
          assert.equal(
            await waitFor(() => bridge.status(SESSION).state === "idle"),
            true,
            `${strategy.name}: recovery completes`,
          );

          const posts = provider.requests.filter((entry) => entry.method === "POST");
          assert.equal(posts.length, 1, `${strategy.name}: exactly one provider request (the recovered turn)`);
          const body = JSON.stringify(posts[0].body);
          assert.ok(body.includes(recoveredContent), `${strategy.name}: the provider received the recovered prompt`);
          assert.ok(!body.includes(canceledContent), `${strategy.name}: the canceled prompt never reached the provider`);
          assert.deepEqual(
            record.ends.map((entry) => entry.reason),
            ["aborted", "completed"],
            `${strategy.name}: turn ends are exactly one per turn`,
          );

          // Same native session identity: one creation, no replacement and no
          // restore — the canceled prompt left the live identity untouched.
          assert.equal(
            record.rpc.filter((entry) => entry.type === "new_session").length,
            1,
            `${strategy.name}: one native session`,
          );
          assert.equal(
            record.rpc.filter((entry) => entry.type === "switch_session").length,
            0,
            `${strategy.name}: the live native session is reused, not restored`,
          );
          assert.equal(record.nativeWrites, 1, `${strategy.name}: no second native session was persisted`);
          const generations = record.ends.map((entry) => entry.turnId);
          assert.ok(generations[0] !== generations[1], `${strategy.name}: the recovery turn has its own identity`);
          // No host/file side effects: the sentinel is untouched.
          assert.equal(readFileSync(sentinel, "utf8"), "untouched\n");
        }
      } finally {
        if (bridge) disposed = await bridge.dispose("fence stop e2e cleanup").catch((error) => ({ error: String(error) }));
        if (supervisor) finalStop = await supervisor.stop().catch((error) => ({ error: String(error) }));
        await provider.close?.();
        assert.deepEqual(disposed, { ok: true, failures: [] }, `${strategy.name}: dispose reclaimed the session`);
        assert.equal(finalStop.reaped && finalStop.cleaned, true, `${strategy.name}: the supervisor reclaimed the process and run root`);
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
);
