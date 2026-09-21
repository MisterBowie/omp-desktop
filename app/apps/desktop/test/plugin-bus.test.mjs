import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const hostSrc = readFileSync(hostProcessEntry, "utf8");
const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");

/** Real host process, forked instead of Electron's utilityProcess. */
function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function createRuntime(t) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits };
}

function writeBusPlugin({ id, permissions = ["bus.publish", "bus.subscribe"], bus, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-bus-plugin-"));
  const manifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: "0.0.1",
    main: "main.js",
    permissions,
    contributes: { bus },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

/** A subscriber that reports every delivery back through toasts. */
function subscriberPlugin({ id, patterns, declare = patterns }) {
  return writeBusPlugin({
    id,
    permissions: ["bus.subscribe"],
    bus: { subscribe: declare },
    main: `
      module.exports = {
        async onLoad() {
          for (const pattern of ${JSON.stringify(patterns)}) {
            await pi.bus.subscribe(pattern, (message) => {
              void pi.ui.showToast(
                pi.plugin.getId() + " " + pattern + " <- " + message.topic +
                  " from " + message.from + " " + JSON.stringify(message.payload ?? null),
              );
            });
          }
        },
      };
    `,
  });
}

/**
 * A publisher driven by a command. `permissions` is separate from the declared
 * topics on purpose: a plugin can declare `contributes.bus` and still be denied
 * the `bus.publish` capability.
 */
function publisherPlugin({ id, publish, calls, permissions = ["bus.publish"] }) {
  return writeBusPlugin({
    id,
    permissions,
    bus: { publish },
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: ${JSON.stringify(`${id}.publish`)},
            title: "Publish",
            run: async () => {
              for (const [topic, payload] of ${JSON.stringify(calls)}) {
                try {
                  await pi.bus.publish(topic, payload);
                } catch (error) {
                  await pi.ui.showToast("refused:" + error.code + ":" + topic);
                }
              }
            },
          });
        },
      };
    `,
  });
}

/** Commands are the simplest way to drive a loaded plugin from a test. */
async function runCommand(runtime, commandId) {
  const command = runtime.getCommands().find((c) => c.id === commandId);
  assert.ok(command, `command not registered: ${commandId}`);
  await command.run();
}

async function settle() {
  // Delivery is fire-and-forget, so give the pushed frame a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("a published message reaches every matching subscriber but not the publisher", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(
    subscriberPlugin({ id: "com.example.watcher", patterns: ["build.*"] }),
  );
  await runtime.loadFromPath(
    subscriberPlugin({ id: "com.example.logger", patterns: ["build.**"] }),
  );
  await runtime.loadFromPath(
    writeBusPlugin({
      id: "com.example.builder",
      bus: { publish: ["build.done"], subscribe: ["build.**"] },
      main: `
        module.exports = {
          async onLoad() {
            await pi.bus.subscribe("build.**", async (message) => {
              await pi.ui.showToast("self " + message.topic);
            });
            await pi.commands.register({
              id: "builder.publish",
              title: "Publish",
              run: () => pi.bus.publish("build.done", { ok: true }),
            });
          },
        };
      `,
    }),
  );

  runtime.drainToasts();
  await runCommand(runtime, "builder.publish");
  await settle();

  assert.deepEqual(runtime.drainToasts().sort(), [
    'com.example.logger build.** <- build.done from com.example.builder {"ok":true}',
    'com.example.watcher build.* <- build.done from com.example.builder {"ok":true}',
  ]);
});

test("publishing needs the permission and a declared topic", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(
    subscriberPlugin({ id: "com.example.watcher", patterns: ["build.**"] }),
  );
  await runtime.loadFromPath(
    publisherPlugin({
      id: "com.example.builder",
      publish: ["build.done"],
      calls: [
        ["build.other", null],
        ["build!bad", null],
        ["build.done", "ok"],
      ],
    }),
  );

  runtime.drainToasts();
  await runCommand(runtime, "com.example.builder.publish");
  await settle();

  assert.deepEqual(runtime.drainToasts(), [
    // Declaring "build.done" does not imply its siblings.
    "refused:PERMISSION_DENIED:build.other",
    "refused:INVALID_ARGUMENT:build!bad",
    'com.example.watcher build.** <- build.done from com.example.builder "ok"',
  ]);
  assert.ok(
    audits.some((a) => a.api === "plugin.bus.publish" && a.errorCode === "TOPIC_NOT_DECLARED"),
  );

  // Declared topic, but the capability was never granted: nothing is delivered.
  await runtime.loadFromPath(
    publisherPlugin({
      id: "com.example.silent",
      publish: ["build.done"],
      calls: [["build.done", 1]],
      permissions: [],
    }),
    [],
  );
  runtime.drainToasts();
  await runCommand(runtime, "com.example.silent.publish");
  await settle();
  assert.deepEqual(runtime.drainToasts(), ["refused:PERMISSION_DENIED:build.done"]);
});

test("subscribing may narrow a declared pattern but never widen it", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(
    writeBusPlugin({
      id: "com.example.watcher",
      permissions: ["bus.subscribe"],
      bus: { subscribe: ["build.*"] },
      main: `
        module.exports = {
          async onLoad() {
            for (const pattern of ["build.done", "build.*", "deploy.*", "**"]) {
              try {
                await pi.bus.subscribe(pattern, () => {});
                await pi.ui.showToast("subscribed:" + pattern);
              } catch (error) {
                await pi.ui.showToast("refused:" + error.code + ":" + pattern);
              }
            }
          },
        };
      `,
    }),
  );

  assert.deepEqual(runtime.drainToasts(), [
    "subscribed:build.done",
    "subscribed:build.*",
    "refused:PERMISSION_DENIED:deploy.*",
    "refused:PERMISSION_DENIED:**",
  ]);
});

test("unsubscribing and unloading both take a subscriber off the bus", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(
    writeBusPlugin({
      id: "com.example.watcher",
      permissions: ["bus.subscribe"],
      bus: { subscribe: ["build.**"] },
      main: `
        let off;
        module.exports = {
          async onLoad() {
            off = await pi.bus.subscribe("build.**", (message) => {
              void pi.ui.showToast("got " + message.topic);
            });
            await pi.commands.register({ id: "watcher.off", title: "Off", run: () => off() });
          },
        };
      `,
    }),
  );
  await runtime.loadFromPath(
    publisherPlugin({
      id: "com.example.builder",
      publish: ["build.done"],
      calls: [["build.done", null]],
    }),
  );

  runtime.drainToasts();
  await runCommand(runtime, "com.example.builder.publish");
  await settle();
  assert.deepEqual(runtime.drainToasts(), ["got build.done"]);

  await runCommand(runtime, "watcher.off");
  await runCommand(runtime, "com.example.builder.publish");
  await settle();
  assert.deepEqual(runtime.drainToasts(), []);

  // Unloading must clear the route too, not leave a dead entry behind.
  await runtime.unload("com.example.watcher");
  await runCommand(runtime, "com.example.builder.publish");
  await settle();
  assert.deepEqual(runtime.drainToasts(), []);
});

test("an oversized payload is refused before it reaches a subscriber", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(
    subscriberPlugin({ id: "com.example.watcher", patterns: ["build.**"] }),
  );
  await runtime.loadFromPath(
    writeBusPlugin({
      id: "com.example.builder",
      permissions: ["bus.publish"],
      bus: { publish: ["build.done"] },
      main: `
        module.exports = {
          async onLoad() {
            await pi.commands.register({
              id: "builder.big",
              title: "Publish",
              run: async () => {
                try {
                  await pi.bus.publish("build.done", "x".repeat(64 * 1024 + 1));
                } catch (error) {
                  await pi.ui.showToast("refused:" + error.code);
                }
              },
            });
          },
        };
      `,
    }),
  );

  runtime.drainToasts();
  await runCommand(runtime, "builder.big");
  await settle();

  assert.deepEqual(runtime.drainToasts(), ["refused:INVALID_ARGUMENT"]);
  assert.ok(
    audits.some((a) => a.api === "plugin.bus.publish" && a.errorCode === "PAYLOAD_TOO_LARGE"),
  );
});

test("a publish flood is rate limited per plugin", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(
    writeBusPlugin({
      id: "com.example.builder",
      permissions: ["bus.publish"],
      bus: { publish: ["build.tick"] },
      main: `
        module.exports = {
          async onLoad() {
            await pi.commands.register({
              id: "builder.flood",
              title: "Flood",
              run: async () => {
                let sent = 0;
                let refused = 0;
                for (let i = 0; i < 130; i += 1) {
                  try {
                    await pi.bus.publish("build.tick", i);
                    sent += 1;
                  } catch (error) {
                    if (error.code === "RATE_LIMITED") refused += 1;
                  }
                }
                await pi.ui.showToast("sent=" + sent + " refused=" + refused);
              },
            });
          },
        };
      `,
    }),
  );

  runtime.drainToasts();
  await runCommand(runtime, "builder.flood");

  assert.deepEqual(runtime.drainToasts(), ["sent=100 refused=30"]);
  assert.ok(audits.some((a) => a.api === "plugin.bus.publish" && a.errorCode === "RATE_LIMITED"));
});

test("bus deliveries also surface on the pi.events stream", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(
    writeBusPlugin({
      id: "com.example.watcher",
      permissions: ["bus.subscribe"],
      bus: { subscribe: ["build.**"] },
      main: `
        module.exports = {
          async onLoad() {
            pi.events.on("bus.message", (message) => {
              void pi.ui.showToast("event " + message.topic);
            });
            await pi.bus.subscribe("build.**", () => {});
          },
        };
      `,
    }),
  );
  await runtime.loadFromPath(
    publisherPlugin({
      id: "com.example.builder",
      publish: ["build.done"],
      calls: [["build.done", null]],
    }),
  );

  runtime.drainToasts();
  await runCommand(runtime, "com.example.builder.publish");
  await settle();

  assert.deepEqual(runtime.drainToasts(), ["event build.done"]);
});

test("the bus is brokered, capped and audited in one place", () => {
  for (const api of ["bus.publish", "bus.subscribe", "bus.unsubscribe"]) {
    assert.match(runtimeSrc, new RegExp(`"${api}"`));
  }
  assert.match(runtimeSrc, /MAX_BUS_PAYLOAD_BYTES = 64 \* 1024/);
  assert.match(runtimeSrc, /MAX_BUS_SUBSCRIPTIONS_PER_PLUGIN = 16/);
  assert.match(runtimeSrc, /MAX_BUS_PUBLISH_PER_WINDOW = 100/);
  const publish = runtimeSrc.slice(
    runtimeSrc.indexOf("private async busPublish"),
    runtimeSrc.indexOf("private async busSubscribe"),
  );
  // Routing lives in the broker: plugins never learn each other's handles.
  assert.match(publish, /subscription\.pluginId === pluginId\) continue/);
  assert.match(publish, /t: "event"/);
  const clear = runtimeSrc.slice(runtimeSrc.indexOf("private clearContributions"));
  assert.match(clear, /this\.busSubscriptions\.delete\(id\)/);
  // The child keeps handlers only; every topic decision is the broker's.
  assert.match(hostSrc, /busHandlers\.set\(id, handler\)/);
  assert.doesNotMatch(hostSrc, /isValidBusTopic|matchesBusTopic/);
});
