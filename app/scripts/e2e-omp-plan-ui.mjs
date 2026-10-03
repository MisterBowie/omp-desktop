#!/usr/bin/env node
/**
 * M5/T20-D (D3): the real user path on the OMP engine.
 *
 * This harness drives the *actual* Electron renderer (real preload IPC, real
 * Main, real host-core over a real SQLite database) against the production OMP
 * bridge/gate, the fixed patched runtime and a local FakeProvider. Nothing but
 * the model endpoint is a fixture:
 *
 *   1. the user switches a live OMP session to Plan with the composer mode
 *      chip, types a prompt and sends it;
 *   2. the model (FakeProvider) submits a plan through the real `SubmitPlan`
 *      host tool; the real `PlanApprovalBar` appears with the immutable
 *      artifact the host published;
 *   3. rejecting returns the composer to an editable state; editing and
 *      resubmitting produces a new proposal and a new artifact while the first
 *      artifact's bytes stay untouched;
 *   4. approving with the `ask` permission mode runs the approved plan as an
 *      agent turn: the real `write` tool raises the real `PermissionCard`, and
 *      allowing it once writes the marker file and completes the execution;
 *   5. a second cycle approves with `accept-edits` and writes without a card;
 *   6. restarting the app (not a renderer reload) leaves the pending proposal
 *      interrupted and replays nothing: no new provider request, no second
 *      execution, the completed rows stay completed.
 *
 * The OMP runtime is the patched tree (`preparePatchedTree`), never a global
 * `omp`; the model endpoint is `FakeProvider`, so no paid or remote model is
 * ever contacted. Requires a real display (`DISPLAY`/`XAUTHORITY`).
 *
 * Usage:
 *   DISPLAY=:1 XAUTHORITY=... node scripts/e2e-omp-plan-ui.mjs
 *   PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched node scripts/e2e-omp-plan-ui.mjs
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { FakeProvider } from "../experiments/omp-bridge/lib/provider.mjs";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import { preparePatchedTree } from "./omp-patch.mjs";

const WAIT_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 240_000;
const CDP_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** Markers route the FakeProvider turns; they never collide with each other. */
const M1 = "E2E-PLAN-ONE";
const M2 = "E2E-PLAN-TWO";
const M3 = "E2E-PLAN-THREE";
const M4 = "E2E-PLAN-FOUR";
const EXEC1 = "E2E-EXEC-ONE";
const EXEC2 = "E2E-EXEC-TWO";

const results = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function shortText(value, max = 700) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function jsonText(value, max = 900) {
  return shortText(JSON.stringify(value), max);
}

function record(id, ok, detail = "") {
  results.set(id, { id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} - ${detail}`);
}

async function allocatePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function failPending(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

class CdpClient {
  constructor(onFailure) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.onFailure = onFailure;
    this.closed = false;
  }

  static async connect(url, onFailure) {
    assert(typeof WebSocket === "function", "Node WebSocket global is unavailable");
    const client = new CdpClient(onFailure);
    await new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(url);
      client.socket = socket;
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener(
        "error",
        () => rejectOpen(new Error(`CDP WebSocket connection failed: ${url}`)),
        { once: true },
      );
    });
    client.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        client.fail(new Error(`invalid CDP message: ${errorText(error)}`));
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const entry = client.pending.get(String(message.id));
        if (!entry) return;
        client.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(`CDP ${entry.method} failed: ${message.error.message || jsonText(message.error)}`);
          error.cdp = true;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of client.handlers.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
      }
    });
    client.socket.addEventListener("close", () => {
      if (client.closed) return;
      client.closed = true;
      const error = new Error("CDP WebSocket closed unexpectedly");
      error.cdp = true;
      failPending(client.pending, error);
      client.onFailure?.(error);
    });
    return client;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    error.cdp = true;
    failPending(this.pending, error);
    this.onFailure?.(error);
  }

  on(method, listener) {
    const listeners = this.handlers.get(method) ?? [];
    listeners.push(listener);
    this.handlers.set(method, listeners);
    return () => {
      this.handlers.set(
        method,
        (this.handlers.get(method) ?? []).filter((candidate) => candidate !== listener),
      );
    };
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed || !this.socket) {
      const error = new Error(`CDP is unavailable for ${method}`);
      error.cdp = true;
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(String(id))) return;
        const error = new Error(`CDP timeout ${method} after ${timeoutMs}ms`);
        error.cdp = true;
        rejectResult(error);
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve: resolveResult, reject: rejectResult, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        const cdpError = error instanceof Error ? error : new Error(String(error));
        cdpError.cdp = true;
        rejectResult(cdpError);
      }
    });
  }

  async evaluate(expression, context = "renderer") {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        `${context} evaluation threw`;
      throw new Error(`${context} evaluation failed: ${shortText(description)}`);
    }
    return response?.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    failPending(this.pending, new Error("CDP closed by acceptance harness"));
    try {
      this.socket?.close();
    } catch {
      // Already torn down.
    }
  }
}

function ensureHealthy(state) {
  if (state.cdpError) throw state.cdpError;
}

async function waitFor(predicate, label, state, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    ensureHealthy(state);
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error?.cdp) throw error;
      lastError = error;
    }
    await delay(POLL_MS);
  }
  ensureHealthy(state);
  throw new Error(
    `timeout waiting for ${label}${lastError ? `; last error: ${shortText(errorText(lastError))}` : ""}`,
  );
}

async function fetchJsonList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  return response.json();
}

function startElectron(state) {
  const child = spawn(
    state.electronBinary,
    [
      "--no-sandbox",
      `--remote-debugging-port=${state.cdpPort}`,
      `--user-data-dir=${state.profileDir}`,
      ".",
    ],
    {
      cwd: state.appDir,
      env: {
        ...process.env,
        PI_DESKTOP_DATA_DIR: state.dataDir,
        PI_DESKTOP_HOST_BIN: state.hostBinary,
        // The product must run the patched runtime; a global `omp` is never
        // consulted (launcher resolution refuses PATH).
        OMP_DESKTOP_RUNTIME: state.patchedLauncher,
        ELECTRON_RENDERER_URL: "",
        PI_DESKTOP_START_MAXIMIZED: "0",
        DISPLAY: process.env.DISPLAY,
        XAUTHORITY: process.env.XAUTHORITY,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      detached: process.platform !== "win32",
    },
  );
  state.electron = child;
  child.stdout?.on("data", (chunk) => {
    state.electronOutput += `[stdout] ${chunk}`;
  });
  child.stderr?.on("data", (chunk) => {
    state.electronOutput += `[stderr] ${chunk}`;
  });
  child.once("exit", (code, signal) => {
    if (state.stopping) return;
    state.cdpError = new Error(
      `Electron exited before acceptance completed (code=${code}, signal=${signal || "none"})\n${shortText(state.electronOutput, 3_000)}`,
    );
    state.cdp?.fail(state.cdpError);
  });
}

async function connectRenderer(state) {
  const target = await waitFor(
    async () => {
      try {
        const targets = await fetchJsonList(state.cdpPort);
        // Two file: pages exist in this app (the main shell and a hidden
        // plugin-launcher surface); only the main shell carries the app UI.
        return targets.find(
          (candidate) =>
            candidate.type === "page" &&
            candidate.webSocketDebuggerUrl &&
            candidate.url.includes("/out/renderer/index.html") &&
            !candidate.url.includes("surface="),
        );
      } catch {
        return null;
      }
    },
    "/json/list renderer target",
    state,
  );
  state.cdp = await CdpClient.connect(target.webSocketDebuggerUrl, (error) => {
    if (state.stopping) return;
    state.cdpError = new Error(
      `${errorText(error)}${state.electronOutput ? `\nElectron output:\n${shortText(state.electronOutput, 3_000)}` : ""}`,
    );
  });
  await state.cdp.send("Runtime.enable");
  await state.cdp.send("Page.enable");
  state.cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args ?? [])
      .map((argument) => argument.value ?? argument.description ?? argument.type ?? "")
      .join(" ");
    state.consoleDiagnostics.push({ level: params.type || "log", text });
  });
  state.cdp.on("Runtime.exceptionThrown", (params) => {
    state.consoleDiagnostics.push({
      level: "exception",
      text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "renderer exception",
    });
  });
}

async function inspectUi(state) {
  return state.cdp.evaluate(`(() => {
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = (node) => (node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const modeChip = document.querySelector(".composer-shell button.mode-chip.composer-mode-chip");
    const stop = document.querySelector(".composer-shell .stop-btn");
    const bar = document.querySelector('[data-testid="plan-approval-bar"]');
    const permission = document.querySelector(".permission-card");
    const prompt = document.querySelector(".composer-input");
    const activeRow = [...document.querySelectorAll("[data-sidebar-session-row]")]
      .find((node) => node.getAttribute("aria-current") === "page" || node.classList.contains("active"));
    const approveMenu = document.querySelector(".plan-approval-menu.is-open");
    const send = document.querySelector(".composer-shell .send-btn");
    return {
      ready: Boolean(document.querySelector(".app-shell") && prompt),
      booting: Boolean(document.querySelector(".app-shell.is-booting")),
      lang: document.documentElement.lang || "",
      activeSessionId: activeRow?.getAttribute("data-sidebar-session-row") || null,
      bodyText: document.body?.innerText || "",
      modeChip: modeChip
        ? {
            visible: visible(modeChip),
            dataMode: modeChip.getAttribute("data-mode"),
            label: text(modeChip),
            disabled: Boolean(modeChip.disabled),
          }
        : null,
      approval: bar && visible(bar)
        ? {
            status: bar.getAttribute("data-status") || "",
            kind: bar.getAttribute("data-kind") || "",
            executionState: bar.getAttribute("data-execution-state") || "",
            title: text(bar.querySelector(".plan-approval-title")),
            question: text(bar.querySelector(".plan-approval-question")),
            artifactPath: text(bar.querySelector(".plan-approval-artifact-path")),
            rejectVisible: visible(bar.querySelector(".plan-approval-reject")),
            approveLabel: text(bar.querySelector(".plan-approval-approve-main")),
            menuVisible: Boolean(approveMenu),
          }
        : null,
      permission: permission && visible(permission)
        ? {
            tool: permission.getAttribute("data-tool") || null,
            title: text(permission.querySelector(".permission-card-title")),
            prompt: text(permission.querySelector(".permission-card-prompt")),
            risk: text(permission.querySelector(".permission-risk")),
          }
        : null,
      promptReadOnly:
        prompt?.getAttribute("aria-readonly") === "true" ||
        prompt?.getAttribute("contenteditable") === "false",
      stopVisible: visible(stop),
      sendDisabled: send ? Boolean(send.disabled) : null,
    };
  })()`);
}

async function waitForRendererReady(state) {
  return waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.ready && !snapshot.booting ? snapshot : null;
    },
    "renderer shell ready",
    state,
  );
}

async function reloadRenderer(state) {
  const loadEvent = new Promise((resolveLoad) => {
    const off = state.cdp.on("Page.loadEventFired", () => {
      off();
      resolveLoad();
    });
    setTimeout(() => {
      off();
      resolveLoad();
    }, WAIT_TIMEOUT_MS).unref?.();
  });
  await state.cdp.send("Page.reload", { ignoreCache: false });
  await loadEvent;
  await waitForRendererReady(state);
}

async function clickSelector(state, selector, description) {
  const result = await state.cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { clicked: false };
    if (node instanceof HTMLElement && node.offsetParent === null) return { clicked: false, hidden: true };
    node.click();
    return { clicked: true };
  })()`);
  assert(result?.clicked, `could not click ${description || selector}`);
}

async function selectSession(state, sessionId) {
  const selection = await state.cdp.evaluate(`(async () => {
    const wanted = ${JSON.stringify(sessionId)};
    const findRow = () => [...document.querySelectorAll("[data-sidebar-session-row]")]
      .find((node) => node.getAttribute("data-sidebar-session-row") === wanted);
    let row = findRow();
    if (!row) {
      for (const toggle of document.querySelectorAll('[data-action="toggle-project-collapse"][aria-expanded="false"]')) {
        toggle.click();
      }
      for (const more of document.querySelectorAll(".sidebar-load-more")) more.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      row = findRow();
    }
    if (row) {
      row.querySelector("button.thread-item-main")?.click();
      return { method: "dom", found: true };
    }
    if (typeof window.__PI_DESKTOP__?.selectSession === "function") {
      await window.__PI_DESKTOP__.selectSession(wanted);
      return { method: "renderer-session-api", found: false };
    }
    return { method: "none", found: false };
  })()`);
  assert(selection?.method !== "none", `session row ${sessionId} was not found: ${jsonText(selection)}`);
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.activeSessionId === sessionId && !snapshot.booting;
    },
    `active session ${sessionId}`,
    state,
  );
}

async function fillComposer(state, prompt) {
  const result = await state.cdp.evaluate(`(() => {
    const input = document.querySelector(".composer-input");
    if (!(input instanceof HTMLElement)) return { filled: false, reason: "composer editor missing" };
    if (input.getAttribute("contenteditable") === "false") return { filled: false, reason: "composer editor is read-only" };
    input.focus();
    input.textContent = ${JSON.stringify(prompt)};
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(prompt)},
    }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true };
  })()`);
  assert(result?.filled === true, `real Composer fill failed: ${jsonText(result)}`);
  await waitFor(
    async () => (await inspectUi(state)).sendDisabled === false,
    "filled live Composer Send enabled",
    state,
    WAIT_TIMEOUT_MS,
  );
  await clickSelector(state, ".composer-shell .send-btn", "live Composer Send");
}

async function getPreloadResult(state, channelName, args = []) {
  const result = await state.cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    if (!bridge?.invoke || !bridge.channels?.invoke?.${channelName}) {
      throw new Error("required preload channel is unavailable: ${channelName}");
    }
    return bridge.invoke(bridge.channels.invoke.${channelName}, ...${JSON.stringify(args)});
  })()`);
  assert(result?.ok === true, `preload ${channelName} failed: ${jsonText(result)}`);
  return result.data;
}

async function getSession(state, sessionId) {
  const result = await getPreloadResult(state, "sessionGet", [sessionId]);
  return result?.session ?? null;
}

async function getPendingPlan(state, sessionId) {
  const result = await getPreloadResult(state, "plansPending", [{ sessionId }]);
  return Array.isArray(result?.plans)
    ? result.plans.find((proposal) => proposal?.status === "pending") || null
    : null;
}

function readDatabase(state) {
  return new DatabaseSync(join(state.dataDir, "pi.sqlite"), { readOnly: true });
}

function queryAll(state, sql, ...params) {
  const db = readDatabase(state);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function queryOne(state, sql, ...params) {
  const db = readDatabase(state);
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function captureScreenshot(state, name) {
  const response = await state.cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const path = join(state.artifactDir, `${name}.png`);
  writeFileSync(path, Buffer.from(response.data, "base64"));
  state.screenshots.push(path);
  console.log(`ARTIFACT ${path}`);
  return path;
}

async function terminateElectron(state) {
  state.stopping = true;
  if (state.cdp) await state.cdp.close();
  const child = state.electron;
  if (!child) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(CLEANUP_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      // Best effort after the grace period.
    }
    await Promise.race([exited, delay(CLEANUP_TIMEOUT_MS)]);
  }
  state.electron = null;
  state.cdp = null;
  state.stopping = false;
}

async function launchApp(state) {
  state.cdpPort = await allocatePort();
  startElectron(state);
  await connectRenderer(state);
  await waitForRendererReady(state);
}

/** Create the local provider and one OMP session, then reveal it in the UI. */
async function seedSession(state, { title, marker }) {
  const provider = state.provider;
  const createdProvider = await getPreloadResult(state, "providersCreate", [
    {
      name: `OMP UI fake provider ${marker}`,
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: provider.baseUrl,
      authKind: "api_key_and_base_url",
      defaultModelId: "local-model",
      secretValue: "e2e-fake-key",
      apiStyle: "chat_completions",
    },
  ]);
  const providerId = createdProvider?.provider?.id;
  assert(providerId, `fake provider creation returned no id: ${jsonText(createdProvider)}`);
  const created = await getPreloadResult(state, "sessionCreate", [
    {
      title,
      mode: "agent",
      engine: "omp",
      projectPath: state.workspace,
      providerId,
      modelId: "local-model",
    },
  ]);
  const session = created?.session;
  assert(session?.id, `OMP session creation returned no id: ${jsonText(created)}`);
  assert(session.engine === "omp", `session is not OMP: ${jsonText(session)}`);
  await reloadRenderer(state);
  await selectSession(state, session.id);
  return session;
}

/** Script answers by marker in the first user message. */
function scriptProvider(provider) {
  const writeMarker = (path, content) => ({
    toolCalls: [{ name: "write", args: { path, content } }],
    finish: "tool_calls",
  });
  provider.routeBySession({
    parent: [{ text: "no scripted route", finish: "stop" }],
    subagents: [
      // Exec prompts must be matched before their own submission markers.
      { marker: EXEC2, turns: [writeMarker("marker-two.txt", "two\n"), { text: "execution two done", finish: "stop" }] },
      { marker: EXEC1, turns: [writeMarker("marker-one.txt", "one\n"), { text: "execution one done", finish: "stop" }] },
      {
        marker: M4,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan four",
                  markdown: "# E2E plan four\n\nPending across a restart.\n",
                  question: "Approve plan four?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M3,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan three",
                  markdown: `# E2E plan three\n\nWrite marker two.\n\n${EXEC2}\n`,
                  question: "Approve plan three?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M2,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan two",
                  markdown: `# E2E plan two\n\nWrite marker one.\n\n${EXEC1}\n`,
                  question: "Approve plan two?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M1,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan one",
                  markdown: "# E2E plan one\n\nDraft only; this one is rejected.\n",
                  question: "Approve plan one?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
    ],
  });
}

async function main() {
  const appDirInfo = resolveElectronBinary(repositoryRoot());
  const hostBinary = resolveHostBinary();
  const patchedLauncher = process.env.PI_DESKTOP_E2E_PATCHED_TREE
    ? join(
        resolve(process.env.PI_DESKTOP_E2E_PATCHED_TREE),
        "packages",
        "coding-agent",
        "scripts",
        "omp",
      )
    : null;
  const prepared = patchedLauncher
    ? null
    : await preparePatchedTree({ prepareBuild: true, keep: true });
  const launcher = patchedLauncher ?? join(prepared.tree, "packages", "coding-agent", "scripts", "omp");
  if (!existsSync(launcher)) throw new Error(`patched launcher missing: ${launcher}`);

  const provider = await FakeProvider.start();
  scriptProvider(provider);

  const state = {
    appDir: appDirInfo.appDir,
    electronBinary: appDirInfo.electronBinary,
    hostBinary,
    patchedLauncher: launcher,
    provider,
    tempRoot: realpathSync(mkdtempSync(join(tmpdir(), `omp-plan-ui-${process.pid}-`))),
    dataDir: null,
    profileDir: null,
    workspace: null,
    artifactDir: null,
    cdpPort: null,
    electron: null,
    cdp: null,
    screenshots: [],
    consoleDiagnostics: [],
    electronOutput: "",
    cdpError: null,
    stopping: false,
  };
  state.dataDir = join(state.tempRoot, "data");
  state.profileDir = join(state.tempRoot, "profile");
  state.workspace = join(state.tempRoot, "workspace");
  await Promise.all([
    mkdirSync(state.dataDir, { recursive: true }),
    mkdirSync(state.profileDir, { recursive: true }),
    mkdirSync(state.workspace, { recursive: true }),
  ]);
  const callerArtifactDir = process.env.PI_DESKTOP_E2E_ARTIFACT_DIR?.trim();
  state.artifactDir = callerArtifactDir ? resolve(callerArtifactDir) : join(state.tempRoot, "artifacts");
  mkdirSync(state.artifactDir, { recursive: true });
  console.log(`Temp data ${state.dataDir}`);
  console.log(`Temp profile ${state.profileDir}`);
  console.log(`Temp workspace ${state.workspace}`);
  console.log(`Artifacts ${state.artifactDir}`);
  console.log(`Patched runtime ${launcher}`);

  const cleanup = [];
  let primaryError = null;
  try {
    await launchApp(state);
    const detail = await runAcceptance(state);
    record("E2E-OMP-PLAN-UI", true, detail);
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    console.error(`FATAL ${primaryError.message}`);
    if (state.electronOutput) {
      console.error(`ELECTRON OUTPUT\n${shortText(state.electronOutput, 4_000)}`);
    }
    if (state.cdp && !state.cdp.closed) {
      try {
        await captureScreenshot(state, "omp-plan-ui-failure");
      } catch (screenshotError) {
        console.error(`FAILURE SCREENSHOT unavailable: ${errorText(screenshotError)}`);
      }
    }
    record("E2E-OMP-PLAN-UI", false, primaryError.message);
  } finally {
    try {
      state.stopping = true;
      await terminateElectron(state);
      await provider.close();
      for (const entry of cleanup.reverse()) await entry();
      if (prepared?.cleanup) await prepared.cleanup();
      rmSync(state.tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (cleanupError) {
      const message = `cleanup failed: ${errorText(cleanupError)}`;
      console.error(`FAIL ${message}`);
      primaryError ||= new Error(message);
    }
  }

  if (state.consoleDiagnostics.length > 0) {
    console.log(`CONSOLE ${state.consoleDiagnostics.length} diagnostic(s)`);
    for (const entry of state.consoleDiagnostics.slice(0, 20)) {
      console.log(`  [${entry.level}] ${shortText(entry.text, 300)}`);
    }
  }
  if (state.screenshots.length > 0) {
    console.log("SCREENSHOTS");
    for (const path of state.screenshots) console.log(path);
  }
  const failed = [...results.values()].filter((result) => !result.ok);
  console.log(`SUMMARY ${results.size - failed.length} passed, ${failed.length} failed`);
  if (primaryError || failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FATAL ${errorText(error)}`);
  console.log("SUMMARY 0 passed, 1 failed");
  process.exitCode = 1;
});

export { runAcceptance };

/* ------------------------------------------------------------------------- */
/* Acceptance flow (exported for readability; the harness above owns the env) */
/* ------------------------------------------------------------------------- */

async function runAcceptance(state) {
  const { provider } = state;

  // 1. Real OMP session through the real preload/Main/host boundary.
  const session = await seedSession(state, { title: "OMP plan UI acceptance", marker: M1 });
  const sessionId = session.id;
  // Record every agent event the renderer receives (installed after the seed
  // reload, which would drop a page-global recorder), so the acceptance can
  // reconstruct the terminal sequence without a second fixture.
  await state.cdp.evaluate(`(() => {
    window.__E2E_AGENT_EVENTS__ = [];
    window.__E2E_SESSION__ = ${JSON.stringify(sessionId)};
    const bridge = window.piDesktop;
    const channel = bridge?.channels?.event?.agentMessage;
    if (bridge?.on && channel) {
      bridge.on(channel, (envelope) => {
        try {
          window.__E2E_AGENT_EVENTS__.push({
            sessionId: envelope?.sessionId ?? "",
            type: envelope?.event?.type ?? "",
            ts: envelope?.ts ?? 0,
          });
        } catch {
          // Recording must never affect the app under test.
        }
      });
    }
    return Boolean(channel);
  })()`);
  const providerRequestsAtBoot = provider.requests.length;

  const before = await inspectUi(state);
  assert(before.modeChip?.visible === true, `mode chip is not visible: ${jsonText(before.modeChip)}`);
  assert(before.modeChip.dataMode === "agent", `session did not start in Agent: ${jsonText(before.modeChip)}`);
  assert(before.modeChip.disabled === false, "mode chip is disabled on a live OMP session");

  // 2. Switch to Plan with the real chip.
  await clickSelector(state, ".composer-shell button.mode-chip.composer-mode-chip", "composer mode chip");
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.modeChip?.dataMode === "plan" ? snapshot : null;
    },
    "composer chip shows Plan",
    state,
  );
  const planSession = await getSession(state, sessionId);
  assert(planSession.mode === "plan", `mode chip did not persist Plan: ${jsonText(planSession)}`);
  const planRow = queryOne(state, "SELECT mode FROM sessions WHERE id = ?", sessionId);
  assert(planRow?.mode === "plan", `durable session row is not Plan: ${jsonText(planRow)}`);
  await captureScreenshot(state, "omp-plan-ui-01-plan-mode");

  // 3. First submission: the model produces a real proposal.
  await fillComposer(state, `${M1}: draft the first plan, do not execute anything.`);
  const pendingOne = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.approval?.status === "pending" ? snapshot : null;
    },
    "real pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(pendingOne.approval.kind === "plan", `proposal kind is not plan: ${jsonText(pendingOne.approval)}`);
  assert(
    pendingOne.approval.title.includes("E2E plan one"),
    `approval card title did not come from the model: ${jsonText(pendingOne.approval.title)}`,
  );
  assert(pendingOne.promptReadOnly === true, "composer is editable while an approval is pending");
  await captureScreenshot(state, "omp-plan-ui-02-pending");

  const proposalOne = await getPendingPlan(state, sessionId);
  assert(proposalOne, "no durable pending proposal after the card appeared");
  assert(
    proposalOne.question === "Approve plan one?" && proposalOne.markdown.includes("Draft only"),
    `the durable proposal is not the model's submission: ${jsonText({ question: proposalOne.question, markdown: proposalOne.markdown })}`,
  );
  const artifactOne = join(state.workspace, proposalOne.artifact.relativePath);
  assert(existsSync(artifactOne), `artifact one was not published: ${artifactOne}`);
  const artifactOneBytes = readFileSync(artifactOne);
  const artifactOneSha = createHash("sha256").update(artifactOneBytes).digest("hex");
  assert(artifactOneSha === proposalOne.artifact.sha256, "artifact one sha does not match its durable row");
  assert(artifactOneBytes.length === proposalOne.artifact.sizeBytes, "artifact one size does not match its durable row");

  // The model request really carried the Plan mode block and the contract
  // catalogue (SubmitPlan present, write/edit absent).
  const planRequests = provider.requests.slice(providerRequestsAtBoot);
  assert(planRequests.length > 0, "the plan submission never reached the fake provider");
  const planRequest = planRequests[planRequests.length - 1];
  const planSystem = (planRequest.body?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
  assert(planSystem.includes("Plan mode"), "the plan turn's system prompt has no Plan mode block");
  assert(planRequest.body?.tools?.some?.((tool) => JSON.stringify(tool).includes("SubmitPlan")), "plan turn has no SubmitPlan tool");

  // 4. Reject, edit, resubmit: new proposal, new artifact, old bytes intact.
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-reject', "Plan Reject");
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.approval === null && snapshot.promptReadOnly === false ? snapshot : null;
    },
    "rejected proposal cleared and composer editable",
    state,
  );
  const afterReject = await inspectUi(state);
  // The submit turn really ended in the renderer: its terminal envelope must
  // have arrived, or the composer would treat the session as running and queue
  // the resubmission behind a phantom turn instead of sending it.
  const recordedTypes = JSON.parse(
    await state.cdp.evaluate(
      `JSON.stringify((window.__E2E_AGENT_EVENTS__ ?? [])
        .filter((entry) => entry.sessionId === ${JSON.stringify(sessionId)})
        .map((entry) => entry.type))`,
    ),
  );
  assert(
    recordedTypes.includes("agent_end"),
    `the renderer never saw the submit turn's terminal event: ${jsonText(recordedTypes)}`,
  );
  assert(afterReject.promptReadOnly === false, "composer is not editable after rejection");
  assert(afterReject.stopVisible === false, "the renderer still shows a running turn after rejection");
  const agentStatus = await state.cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.agentGetStatus, ${JSON.stringify(sessionId)});
    return JSON.stringify(result?.data ?? result);
  })()`);
  const agentStatusState = JSON.parse(agentStatus)?.status ?? JSON.parse(agentStatus);
  assert(agentStatusState?.isRunning === false, `main still reports running: ${shortText(agentStatus, 300)}`);
  await fillComposer(state, `${M2}: revised plan, still no execution.`);
  const pendingTwo = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.approval?.status === "pending" ? snapshot : null;
    },
    "second pending Plan approval card",
    state,
    60_000,
  );
  assert(
    pendingTwo.approval.title.includes("E2E plan two"),
    `second approval card title did not come from the model: ${jsonText(pendingTwo.approval.title)}`,
  );
  const proposalTwo = await getPendingPlan(state, sessionId);
  assert(proposalTwo && proposalTwo.id !== proposalOne.id, "resubmission reused the first proposal");
  assert(
    proposalTwo.question === "Approve plan two?" && proposalTwo.markdown.includes("E2E-EXEC-ONE"),
    `the revised durable proposal is not the model's: ${jsonText({ question: proposalTwo.question })}`,
  );
  const artifactTwo = join(state.workspace, proposalTwo.artifact.relativePath);
  assert(artifactTwo !== artifactOne, "resubmission reused the first artifact path");
  assert(existsSync(artifactTwo), "artifact two was not published");
  assert(
    readFileSync(artifactOne).equals(artifactOneBytes),
    "the rejected proposal's artifact bytes changed",
  );
  const rejectedRow = queryOne(
    state,
    "SELECT status, artifact_sha256 FROM plan_approvals WHERE request_id = ?",
    proposalOne.id,
  );
  assert(rejectedRow?.status === "rejected", `first proposal is not rejected: ${jsonText(rejectedRow)}`);

  // The pending approval belongs to this session only: an unrelated session
  // must not inherit the card, and returning to the session restores it.
  const other = await getPreloadResult(state, "sessionCreate", [
    { title: "OMP unrelated session", mode: "agent", engine: "omp", projectPath: state.workspace },
  ]);
  const otherId = other?.session?.id;
  assert(otherId && otherId !== sessionId, `unrelated session creation failed: ${jsonText(other)}`);
  await reloadRenderer(state);
  await selectSession(state, otherId);
  const otherView = await inspectUi(state);
  assert(otherView.approval === null, `pending approval leaked into another session: ${jsonText(otherView.approval)}`);
  assert(otherView.modeChip?.dataMode === "agent", "unrelated session is not in Agent mode");
  await selectSession(state, sessionId);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "pending approval returns when its own session is reselected",
    state,
  );
  const unrelatedRows = queryOne(
    state,
    "SELECT COUNT(*) AS n FROM plan_approvals WHERE session_id = ?",
    otherId,
  );
  assert(unrelatedRows?.n === 0, `unrelated session gained approval rows: ${jsonText(unrelatedRows)}`);
  await captureScreenshot(state, "omp-plan-ui-03-resubmitted");

  // 5. Approve with `ask` and execute: the real write tool raises a real
  // permission card, and allowing it once runs the tool for real.
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-main', "Plan Approve (ask)");
  const permissionCard = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.permission ? snapshot : null;
    },
    "real tool permission card for the approved plan's write",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(
    JSON.stringify(permissionCard.permission).toLowerCase().includes("write") ||
      JSON.stringify(permissionCard.permission).includes("write"),
    `permission card is not for write: ${jsonText(permissionCard.permission)}`,
  );
  await captureScreenshot(state, "omp-plan-ui-04-permission");
  await clickSelector(state, ".permission-card-actions button:last-child", "Allow once");
  const markerOne = join(state.workspace, "marker-one.txt");
  await waitFor(() => existsSync(markerOne), "approved execution wrote marker one", state, TURN_TIMEOUT_MS);
  assert(readFileSync(markerOne, "utf8") === "one\n", "marker one has the wrong content");
  const executionOne = await waitFor(
    async () => {
      const row = queryOne(
        state,
        "SELECT request_id, execution_id, status, execution_state FROM plan_approvals WHERE request_id = ?",
        proposalTwo.id,
      );
      return row?.execution_state === "completed" ? row : null;
    },
    "approved execution completed in the durable row",
    state,
    TURN_TIMEOUT_MS,
  );
  const statusOne = await getPreloadResult(state, "agentGetStatus", [sessionId]);
  const statusOneState = statusOne?.status ?? statusOne;
  assert(statusOneState?.isRunning === false, `session still reports running: ${jsonText(statusOne)}`);
  await waitFor(
    async () => (await inspectUi(state)).approval === null,
    "approval surface cleared after completion",
    state,
  );
  await captureScreenshot(state, "omp-plan-ui-05-executed");

  // 6. Second cycle: approve with `accept-edits`; the write needs no card.
  const afterFirstCycle = provider.requests.length;
  await clickSelector(state, ".composer-shell button.mode-chip.composer-mode-chip", "composer mode chip (Agent→Plan)");
  await waitFor(
    async () => ((await inspectUi(state)).modeChip?.dataMode === "plan" ? true : null),
    "composer chip back to Plan",
    state,
  );
  await fillComposer(state, `${M3}: second plan, accept-edits execution.`);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "third pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  const proposalThree = await getPendingPlan(state, sessionId);
  assert(proposalThree, "third proposal is not pending");
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-menu', "approval mode menu");
  await clickSelector(state, '[data-approval-mode="accept-edits"]', "approve with accept-edits");
  const markerTwo = join(state.workspace, "marker-two.txt");
  await waitFor(() => existsSync(markerTwo), "accept-edits execution wrote marker two", state, TURN_TIMEOUT_MS);
  const duringSecondCycle = await inspectUi(state);
  assert(
    duringSecondCycle.permission === null,
    `accept-edits execution raised a permission card: ${jsonText(duringSecondCycle.permission)}`,
  );
  const executionTwo = await waitFor(
    async () => {
      const row = queryOne(
        state,
        "SELECT execution_state FROM plan_approvals WHERE request_id = ?",
        proposalThree.id,
      );
      return row?.execution_state === "completed" ? row : null;
    },
    "accept-edits execution completed",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(executionTwo.execution_state === "completed", "accept-edits execution did not complete");
  assert(provider.requests.length > afterFirstCycle, "second cycle produced no provider request");
  await captureScreenshot(state, "omp-plan-ui-06-accept-edits");

  // 7. Leave a fourth proposal pending, then restart the application.
  await clickSelector(state, ".composer-shell button.mode-chip.composer-mode-chip", "composer mode chip (Agent→Plan)");
  await waitFor(
    async () => ((await inspectUi(state)).modeChip?.dataMode === "plan" ? true : null),
    "composer chip Plan again",
    state,
  );
  await fillComposer(state, `${M4}: plan four, left pending across a restart.`);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "fourth pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  const proposalFour = await getPendingPlan(state, sessionId);
  assert(proposalFour, "fourth proposal is not pending");
  const requestsBeforeRestart = provider.requests.length;
  await captureScreenshot(state, "omp-plan-ui-07-pending-before-restart");

  // Real application restart: the Electron process tree (Main, host, OMP
  // runtime) is terminated and relaunched on the same data directory.
  await terminateElectron(state);
  await launchApp(state);
  await selectSession(state, sessionId);

  const interrupted = queryOne(
    state,
    "SELECT status, error_code FROM plan_approvals WHERE request_id = ?",
    proposalFour.id,
  );
  assert(interrupted?.status === "interrupted", `pending proposal survived restart: ${jsonText(interrupted)}`);
  assert(
    interrupted.error_code === "PLAN_APPROVAL_INTERRUPTED",
    `restart used the wrong interruption code: ${jsonText(interrupted)}`,
  );
  const restarted = await inspectUi(state);
  assert(
    restarted.approval === null || restarted.approval.status === "interrupted",
    `approval card still offers a decision after restart: ${jsonText(restarted.approval)}`,
  );
  const executionOneAfterRestart = queryOne(
    state,
    "SELECT execution_state FROM plan_approvals WHERE request_id = ?",
    proposalTwo.id,
  );
  assert(
    executionOneAfterRestart?.execution_state === "completed",
    `completed execution was rewritten by restart: ${jsonText(executionOneAfterRestart)}`,
  );
  const requestsAfterRestart = provider.requests.length;
  assert(
    requestsAfterRestart === requestsBeforeRestart,
    `restart replayed provider traffic (${requestsBeforeRestart} -> ${requestsAfterRestart})`,
  );
  await captureScreenshot(state, "omp-plan-ui-08-after-restart");

  return [
    `session ${sessionId}`,
    `artifacts ${proposalOne.artifact.relativePath} -> ${proposalTwo.artifact.relativePath} -> ${proposalThree.artifact.relativePath}`,
    `executions ${executionOne.execution_id} (ask) and ${proposalThree.id} (accept-edits) completed; fourth interrupted after restart`,
    `provider requests ${requestsAfterRestart}, no replay`,
  ].join("; ");
}
