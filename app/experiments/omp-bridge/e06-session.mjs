#!/usr/bin/env node
/**
 * E06 — native session lifecycle: create, name, close, reopen by path, branch.
 *
 * Verifies where OMP keeps the native session, that reopening by path restores
 * history, and that a restore does NOT replay old side effects or re-ask for an
 * approval that was already answered.
 *
 * Usage: node e06-session.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT, sanitizeFrame } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const GATE = join(EXPERIMENT_ROOT, "extensions", "approval-gate.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recursively list files under `dir` (bounded). */
function listFiles(dir, acc = [], depth = 0) {
  if (depth > 4 || !existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, acc, depth + 1);
    else acc.push(path);
  }
  return acc;
}

const evidence = await runExperiment("e06-session", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const { root, runRoot, selector } = experimentRoot(ctx, "e06", { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const target = join(projectDir, "session-write.txt");
  const agentDir = join(runRoot, "agent");

  provider.script([
    { text: "writing once", toolCalls: [{ name: "write", args: { path: target, content: "written-once\n" } }], finish: "tool_calls" },
    { text: "done", finish: "stop" },
    { text: "second turn", finish: "stop" },
  ]);

  let sessionFile = null;
  let sessionId = null;
  let firstRunTurns = 0;

  // --- run A: create, name, produce history ---------------------------------
  {
    let rpc;
    try {
      rpc = await OmpRpc.start({ repoRoot, runRoot, mode: "rpc-ui", args: ["--model", selector, "--approval-mode", "yolo"], cwd: projectDir });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

      const newSession = await rpc.request({ type: "new_session" });
      ctx.check("new_session is accepted (not cancelled)", newSession.success === true && newSession.data?.cancelled !== true, newSession);

      const named = await rpc.request({ type: "set_session_name", name: "m1-e06-session" });
      ctx.check("set_session_name is accepted", named.success === true, named);

      await rpc.request({ type: "prompt", message: "write the marker file" }, { timeoutMs: 45_000 });
      await rpc.waitFor((f) => f.type === "agent_end", 45_000);
      firstRunTurns = rpc.framesOfType("turn_end").length;

      const state = await rpc.request({ type: "get_state" });
      sessionFile = state.data?.sessionFile ?? null;
      sessionId = state.data?.sessionId ?? null;
      ctx.check("get_state exposes a native session file", typeof sessionFile === "string" && sessionFile.length > 0, sessionFile);
      ctx.check("get_state exposes a native session id", typeof sessionId === "string" && sessionId.length > 0, sessionId);
      ctx.check("session name is reflected in state", state.data?.sessionName === "m1-e06-session", state.data?.sessionName);
      ctx.check("side effect happened once in run A", existsSync(target) && readFileSync(target, "utf8") === "written-once\n");

      const messages = await rpc.request({ type: "get_messages" });
      const list = messages.data?.messages ?? [];
      ctx.check("get_messages returns the conversation", list.length >= 2, `${list.length} messages`);
      ctx.note("messageRoles", list.map((m) => m.role));
      ctx.note("sessionState", sanitizeFrame({ sessionFile, sessionId, sessionName: state.data?.sessionName }));

      writeFixture("e06-session-state.json", {
        note: "real capture, sanitized; paths are inside this run's isolated agent dir",
        sessionFileRelativeToAgentDir: sessionFile ? sessionFile.split("/agent/")[1] ?? null : null,
        sessionId,
        sessionName: state.data?.sessionName,
        messageRoles: list.map((m) => m.role),
      });
    } finally {
      if (rpc) ctx.check("run A: process group reaped", (await rpc.stop()) === true);
    }
  }

  // --- native session location ----------------------------------------------
  const sessionFiles = listFiles(join(agentDir, "sessions"));
  ctx.check("native session files live under the isolated agent dir", sessionFiles.length > 0, `${sessionFiles.length} files`);
  ctx.check("no session file leaked outside the isolated agent dir", !sessionFiles.some((p) => p.startsWith("/home/") && !p.includes(runRoot)));
  if (sessionFile) ctx.check("the reported session file exists on disk", existsSync(sessionFile), sessionFile);

  // --- run B: reopen by path, assert no replay ------------------------------
  {
    const beforeContent = existsSync(target) ? readFileSync(target, "utf8") : null;
    const beforeMtime = existsSync(target) ? statSync(target).mtimeMs : null;
    const gateLog = join(root, "reopen-ui.log");

    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", GATE],
        cwd: projectDir,
        extraEnv: { M1_UI_LOG: gateLog },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

      const switched = await rpc.request({ type: "switch_session", sessionPath: sessionFile });
      ctx.check("switch_session by native path is accepted", switched.success === true && switched.data?.cancelled !== true, switched);

      const state = await rpc.request({ type: "get_state" });
      ctx.check("reopened session reports the same native id", state.data?.sessionId === sessionId, state.data?.sessionId);
      ctx.check("reopened session keeps its name", state.data?.sessionName === "m1-e06-session", state.data?.sessionName);

      const messages = await rpc.request({ type: "get_messages" });
      const list = messages.data?.messages ?? [];
      ctx.check("history is restored on reopen", list.length >= 2, `${list.length} messages`);

      // give any (unwanted) replay a chance to happen
      await sleep(1500);
      ctx.check("reopen replays no tool execution", rpc.framesOfType("tool_execution_start").length === 0, `${rpc.framesOfType("tool_execution_start").length} tool starts`);
      ctx.check("reopen asks for no new approval", !existsSync(gateLog), existsSync(gateLog) ? readFileSync(gateLog, "utf8").slice(0, 200) : "no gate log");
      ctx.check("reopen does not rewrite the file", existsSync(target) && readFileSync(target, "utf8") === beforeContent && statSync(target).mtimeMs === beforeMtime);

      // --- branch -----------------------------------------------------------
      const branchSource = await rpc.request({ type: "get_branch_messages" });
      const entries = branchSource.data?.messages ?? [];
      ctx.check(
        "get_branch_messages exposes branchable entry ids",
        entries.length > 0 && typeof entries[0]?.entryId === "string",
        `${entries.length} entries`,
      );
      const entryId = entries[0]?.entryId;
      if (entryId) {
        const branch = await rpc.request({ type: "branch", entryId }, { timeoutMs: 20_000 });
        ctx.check("branch is accepted", branch.success === true, branch);
        ctx.note("branchResult", sanitizeFrame(branch.data ?? {}));
        const after = await rpc.request({ type: "get_state" });
        ctx.check("branch keeps the session usable", after.type === "response");
        ctx.note("branchSessionFile", after.data?.sessionFile ?? null);
        ctx.check("branch produces a distinct native location", after.data?.sessionFile !== sessionFile, after.data?.sessionFile);
      } else {
        ctx.check("branch entry id available for branching", false, JSON.stringify(entries.slice(0, 1)));
      }
    } finally {
      if (rpc) ctx.check("run B: process group reaped", (await rpc.stop()) === true);
    }
  }

  ctx.limit("Session naming/restore are verified over RPC only; desktop-side metadata mapping is M2/M4 work.");
});

process.exit(evidence.ok ? 0 : 1);
