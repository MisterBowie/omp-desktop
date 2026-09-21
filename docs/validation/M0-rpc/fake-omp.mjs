#!/usr/bin/env node
/**
 * Controlled fake OMP RPC server for testing docs/validation/M0-rpc/verify-rpc.mjs.
 * Behavior is selected by FAKE_SCENARIO:
 *   normal         emit ready, answer negotiate_protocol + get_available_models
 *   split          same, but frames split across writes and merged into one write,
 *                  with a multi-byte UTF-8 label cut across chunk boundaries
 *   error-response respond to negotiate_protocol with success:false
 *   silent         emit nothing and stay alive (timeout path)
 *   crash          exit 1 immediately (start-failure path)
 *   ignore-sigterm emit ready, ignore SIGTERM, never exit on its own
 *   malformed-models answer get_available_models with data.models as an object
 *   stubborn-grandchild  handle the protocol, spawn a same-group grandchild that
 *                        ignores SIGTERM, and exit on SIGTERM (grandchild lingers)
 */
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync, closeSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.FAKE_SCENARIO || "normal";
const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864,
  label: "假就绪·中文跨块测试",
};

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

function writeSplit(obj) {
  const b = Buffer.from(JSON.stringify(obj) + "\n", "utf8");
  const i1 = Math.max(1, Math.floor(b.length / 3));
  const i2 = Math.max(i1 + 1, Math.floor((2 * b.length) / 3));
  const chunks = [b.subarray(0, i1), b.subarray(i1, i2), b.subarray(i2)];
  let d = 0;
  for (const c of chunks) {
    d += 15;
    setTimeout(() => process.stdout.write(c), d);
  }
}

function writeMerged(objs) {
  process.stdout.write(objs.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

function answer(msg) {
  if (msg.type === "negotiate_protocol") {
    if (scenario === "error-response") {
      write({ id: msg.id, type: "response", command: "negotiate_protocol", success: false, error: "mock refusal" });
    } else if (scenario === "split") {
      writeMerged([
        { id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } },
        { type: "extension_ui_request", id: "noise", method: "setWidget", widgetKey: "noise" },
      ]);
    } else {
      write({ id: msg.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
    }
  } else if (msg.type === "get_available_models") {
    if (scenario === "malformed-models") {
      // success:true but data.models is an object, not an array.
      write({ id: msg.id, type: "response", command: "get_available_models", success: true, data: { models: {} } });
      return;
    }
    const data = { models: [{ id: "local-model", name: "本地模型", api: "openai-completions", provider: "m0mock", baseUrl: "http://127.0.0.1:9" }] };
    const resp = { id: msg.id, type: "response", command: "get_available_models", success: true, data };
    if (scenario === "split") writeSplit(resp);
    else write(resp);
  }
}

if (scenario === "crash") {
  process.stderr.write("fake: crash\n");
  process.exit(1);
} else if (scenario === "silent") {
  setInterval(() => {}, 1000);
} else if (scenario === "ignore-sigterm") {
  process.on("SIGTERM", () => process.stderr.write("ignoring SIGTERM\n"));
  write(READY);
  setInterval(() => {}, 1000);
} else if (scenario === "stubborn-grandchild") {
  // A same-group grandchild that ignores SIGTERM; the parent exits on SIGTERM.
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"], { stdio: "ignore" });
  try { writeFileSync(join(process.cwd(), "grandchild.pid"), String(grandchild.pid)); } catch {}
  write(READY);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    answer(msg);
  });
} else if (scenario === "closed-stdin") {
  // Close our stdin, announce ready, then stay alive: the harness's next write
  // to child.stdin must surface as a stream error, not an unhandled EPIPE.
  try { closeSync(0); } catch {}
  try { writeFileSync(join(process.cwd(), "self.pid"), String(process.pid)); } catch {}
  write(READY);
  setInterval(() => {}, 1000);
} else {
  if (scenario === "split") writeSplit(READY);
  else write(READY);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    answer(msg);
  });
}
