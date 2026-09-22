#!/usr/bin/env node
/**
 * Mock OMP runtime for the desktop's runtime-boundary tests.
 *
 * It speaks the same rpc-ui NDJSON surface as the pinned runtime and can be
 * told to misbehave in exactly the ways the real one was observed to: refuse
 * protocol v2, advertise different framing limits, never become ready, corrupt
 * a chunk sequence, answer with a frame larger than one line, stop responding,
 * ignore SIGTERM, or leave a descendant behind.
 *
 * Everything it writes is evidence, not decoration:
 *   - stdout is protocol only;
 *   - `MOCK_OMP_LOG` receives one line per lifecycle fact (`ready`, `abort`,
 *     `eof`, `sigterm`), which is how the tests prove the stop order;
 *   - `MOCK_OMP_PID_FILE` receives this process's pid and, when one is spawned,
 *     its descendant's pid.
 *
 * It never touches a path it was not given: the tests run it with an isolated
 * HOME/config root and this script only writes to `MOCK_OMP_*` paths.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const mode = process.env.MOCK_OMP_MODE ?? "normal";
const version = process.env.MOCK_OMP_VERSION ?? "omp/18.2.7";
const logPath = process.env.MOCK_OMP_LOG ?? null;
const pidFile = process.env.MOCK_OMP_PID_FILE ?? null;

const envFile = process.env.MOCK_OMP_ENV_FILE ?? null;
if (envFile) {
  // Evidence for the isolation tests: which of the variables that could steer
  // discovery or leak credentials are actually present in this child.
  const probe = {
    HOME: process.env.HOME ?? null,
    PI_CONFIG_DIR: process.env.PI_CONFIG_DIR ?? null,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
    OMP_DEV_LAUNCH_DIR: process.env.OMP_DEV_LAUNCH_DIR ?? null,
    PATH: process.env.PATH ?? null,
    credentialKeys: Object.keys(process.env).filter((key) =>
      /(API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|_AUTH|AWS_|GEMINI_|OPENAI_|ANTHROPIC_)/i.test(key),
    ),
    proxyKeys: Object.keys(process.env).filter((key) => /proxy/i.test(key)),
    desktopKeys: Object.keys(process.env).filter((key) => key.startsWith("PI_DESKTOP_")),
  };
  writeFileSync(envFile, JSON.stringify(probe, null, 2));
}

const log = (line) => {
  if (logPath) {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      /* evidence only */
    }
  }
};

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (pidFile) {
  try {
    writeFileSync(pidFile, `${process.pid}\n`);
  } catch {
    /* evidence only */
  }
}

const send = (frame) => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const chunkFrames = (frame, chunkId) => {
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, "utf8");
  const payload = 256 * 1024;
  const count = Math.ceil(bytes.byteLength / payload);
  const out = [];
  for (let index = 0; index < count; index += 1) {
    out.push({
      type: "rpc_chunk",
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * payload, (index + 1) * payload).toString("base64"),
    });
  }
  return out;
};

const readyLimits =
  mode === "framing-mismatch"
    ? { maxFrameBytes: 4096, maxReassembledFrameBytes: 8192 }
    : { maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 };
const supportedVersions = mode === "refuse-v2" ? [1] : [1, 2];

if (mode === "exit-immediately") {
  log("exit-immediately");
  process.exit(3);
}

if (mode !== "never-ready") {
  send({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: supportedVersions,
    ...readyLimits,
  });
  log("ready");
}

if (mode === "detached-descendant") {
  // A command runs in its own process group: here the leader exits and leaves
  // one behind, which is the case a leader-exit check would wrongly call clean.
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: "ignore" },
  );
  if (pidFile) {
    try {
      appendFileSync(pidFile, `${child.pid}\n`);
    } catch {
      /* evidence only */
    }
  }
  log("leader-exiting-with-descendant");
  setTimeout(() => process.exit(0), 50);
}

if (mode === "crash-after-ready") {
  log("crashing");
  process.exit(7);
}

if (mode === "bad-json") {
  process.stdout.write("this is not json\n");
  log("bad-json");
}

if (mode === "oversized-line") {
  process.stdout.write(`${"x".repeat(9 * 1024 * 1024)}\n`);
  log("oversized-line");
}

if (mode === "unresponsive" || mode === "deaf") {
  // Ignores SIGTERM on purpose: the supervisor must escalate to SIGKILL.
  process.on("SIGTERM", () => log("sigterm-ignored"));
} else {
  process.on("SIGTERM", () => {
    log("sigterm");
    process.exit(0);
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
  buffer += text;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => {
  log("eof");
  // `deaf` ignores EOF as well, so only a signal can end it: that is the case
  // where the desktop must escalate past a graceful stop.
  if (mode === "ignore-eof" || mode === "deaf") {
    // A Node process with nothing pending exits on its own once stdin ends, so
    // keeping the peer alive has to be explicit.
    setInterval(() => {}, 1000);
    return;
  }
  setTimeout(() => process.exit(0), 20);
});

function handle(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    send({ type: "response", id: null, command: "unknown", success: false, error: "invalid json" });
    return;
  }
  const id = typeof frame.id === "string" ? frame.id : undefined;
  const reply = (payload) => send({ type: "response", id, command: frame.type, ...payload });

  switch (frame.type) {
    case "negotiate_protocol": {
      if (frame.protocolVersion === 2) {
        reply({ success: true, data: { protocolVersion: 2 } });
      } else {
        reply({ success: false, error: `unsupported protocol version ${String(frame.protocolVersion)}` });
      }
      return;
    }
    case "abort":
      log("abort");
      reply({ success: true, data: { aborted: true } });
      return;
    case "abort_bash":
      log("abort_bash");
      reply({ success: true, data: { aborted: true } });
      return;
    case "mock_never_respond":
      log("mock_never_respond");
      return;
    case "mock_event":
      send({ type: "mock_event", payload: { at: Date.now() } });
      reply({ success: true });
      return;
    case "mock_large": {
      const payload = "y".repeat(1_200_000);
      for (const chunk of chunkFrames(
        { type: "response", id, command: "mock_large", success: true, data: { payload } },
        `chunk-${randomBytes(3).toString("hex")}`,
      )) {
        send(chunk);
      }
      log("mock_large");
      return;
    }
    case "mock_corrupt_chunk": {
      const frames = chunkFrames(
        { type: "response", id, command: "mock_corrupt_chunk", success: true, data: { ok: true } },
        "corrupt",
      );
      // Drop the middle chunk: the decoder must fail closed, not resynchronise.
      send(frames[0]);
      send(frames[2] ?? frames[1]);
      log("mock_corrupt_chunk");
      return;
    }
    case "stderr_noise":
      process.stderr.write("mock: diagnostic line\n");
      reply({ success: true });
      return;
    default:
      reply({ success: false, error: `Unknown command: ${String(frame.type)}` });
  }
}
