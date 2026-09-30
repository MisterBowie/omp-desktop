// @bun
// ../../../../home/vv/person/code/omp-desktop-m5-r4b/app/packages/omp-runtime/src/session/approval-protocol.ts
var OMP_APPROVAL_OPTIONS = [
  "Allow once",
  "Allow for this session",
  "Deny"
];
var OMP_APPROVAL_ALLOW_LABEL = OMP_APPROVAL_OPTIONS[0];
var OMP_APPROVAL_DENY_LABEL = OMP_APPROVAL_OPTIONS[2];
function encodeApprovalDescriptor(descriptor) {
  return JSON.stringify(descriptor);
}

// ../../../../home/vv/person/code/omp-desktop-m5-r4b/app/packages/omp-runtime/src/desktop-state.ts
import { lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
var DESKTOP_STATE_VERSION = 1;
var MAX_DESKTOP_STATE_BYTES = 512 * 1024;
var MAX_DESKTOP_STATE_AGE_MS = 10 * 60000;
var MAX_DESKTOP_STATE_SKILLS = 1024;
var MAX_SKILL_ID_CHARS = 256;
var MAX_SKILL_NAME_CHARS = 512;
var MAX_SKILL_DESCRIPTION_CHARS = 512;
var MAX_MEMORY_CHARS = 64 * 1024;
function readDesktopCapabilityState(path, now) {
  if (!path)
    return null;
  let stats;
  try {
    if (lstatSync(path).isSymbolicLink())
      return null;
    stats = statSync(path);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_DESKTOP_STATE_BYTES)
    return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const state = parsed;
  if (state.v !== DESKTOP_STATE_VERSION)
    return null;
  if (typeof state.sessionId !== "string" || state.sessionId.length === 0 || state.sessionId.length > 512) {
    return null;
  }
  if (typeof state.writtenAt !== "number" || !Number.isFinite(state.writtenAt))
    return null;
  if (state.writtenAt > now)
    return null;
  if (now - state.writtenAt > MAX_DESKTOP_STATE_AGE_MS)
    return null;
  if (state.memory !== null && (typeof state.memory !== "string" || state.memory.length > MAX_MEMORY_CHARS)) {
    return null;
  }
  if (!Array.isArray(state.skills) || state.skills.length > MAX_DESKTOP_STATE_SKILLS)
    return null;
  const skills = [];
  for (const entry of state.skills) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const skill = entry;
    if (typeof skill.id !== "string" || skill.id.length === 0 || skill.id.length > MAX_SKILL_ID_CHARS) {
      return null;
    }
    if (typeof skill.name !== "string" || skill.name.length === 0 || skill.name.length > MAX_SKILL_NAME_CHARS) {
      return null;
    }
    if (typeof skill.description !== "string" || skill.description.length > MAX_SKILL_DESCRIPTION_CHARS) {
      return null;
    }
    skills.push({ id: skill.id, name: skill.name, description: skill.description });
  }
  return {
    v: DESKTOP_STATE_VERSION,
    sessionId: state.sessionId,
    writtenAt: state.writtenAt,
    memory: state.memory,
    skills
  };
}
function desktopSkillsPrompt(skills) {
  if (!skills.length)
    return;
  return [
    "# Skills",
    "",
    "Plugins have taught you the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.",
    "",
    ...skills.map((skill) => {
      const description = skill.description?.trim();
      return `- \`${skill.id}\` \u2014 ${skill.name}${description ? `: ${description}` : ""}`;
    })
  ].join(`
`);
}
function desktopMemoryPrompt(content) {
  const memory = content?.trim();
  if (!memory)
    return;
  return [
    "# Project memory",
    "",
    "The following notes are durable context for this project. Use them when relevant, but treat them as user-provided context rather than higher-priority instructions.",
    "",
    memory
  ].join(`
`);
}
function desktopCapabilityPrompt(state) {
  const parts = [desktopSkillsPrompt(state.skills), desktopMemoryPrompt(state.memory)].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(`

`) : undefined;
}

// ../../../../home/vv/person/code/omp-desktop-m5-r4b/app/packages/omp-runtime/extensions/omp-desktop-gate.ts
var DEFAULT_GATED_TOOLS = "write,edit,apply_patch,bash,eval";
function riskForTool(toolName) {
  if (toolName.startsWith("plugin_"))
    return "high";
  if (toolName.startsWith("mcp_"))
    return "medium";
  switch (toolName) {
    case "write":
    case "edit":
    case "apply_patch":
    case "bash":
    case "eval":
    case "browser":
    case "computer":
      return "high";
    case "read":
    case "grep":
    case "glob":
      return "low";
    default:
      return "medium";
  }
}
function isHostToolName(toolName) {
  return toolName.startsWith("plugin_") || toolName.startsWith("mcp_");
}
var DEFAULT_TIMEOUT_MS = 120000;
function approvalTitle(event) {
  const input = event.input ?? {};
  const first = (...keys) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim().length > 0)
        return value.trim();
    }
    return;
  };
  switch (event.toolName) {
    case "write":
    case "edit":
    case "apply_patch": {
      const target = first("path", "file", "file_path", "paths");
      return target ? `${event.toolName}: ${target}` : event.toolName;
    }
    case "bash": {
      const command = first("command", "cmd");
      return command ? `bash: ${command.slice(0, 200)}` : "bash";
    }
    default: {
      const detail = first("path", "command", "query", "url");
      return detail ? `${event.toolName}: ${detail.slice(0, 200)}` : event.toolName;
    }
  }
}
function buildApprovalDialog(event, context, timeoutMs) {
  const descriptor = {
    v: 1,
    kind: "omp-desktop-approval",
    ...sessionIdOf(context) ? { sessionId: sessionIdOf(context) } : {},
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    risk: riskForTool(event.toolName),
    reason: approvalTitle(event),
    argsPreview: event.input,
    ...cwdOf(context) ? { cwd: cwdOf(context) } : {}
  };
  const items = [
    { label: OMP_APPROVAL_OPTIONS[0], description: encodeApprovalDescriptor(descriptor) },
    { label: OMP_APPROVAL_OPTIONS[1] },
    { label: OMP_APPROVAL_OPTIONS[2] }
  ];
  return {
    title: approvalTitle(event),
    items,
    options: items.map((item) => item.label),
    dialogOptions: { timeout: timeoutMs }
  };
}
function sessionIdOf(context) {
  try {
    return context.sessionManager?.getSessionId?.();
  } catch {
    return;
  }
}
function cwdOf(context) {
  try {
    return context.cwd ?? context.sessionManager?.getCwd?.();
  } catch {
    return;
  }
}
function hasUi(context) {
  const flag = context.hasUI;
  if (typeof flag === "function") {
    try {
      return flag() === true;
    } catch {
      return false;
    }
  }
  if (typeof flag === "boolean")
    return flag;
  return typeof context.ui?.select === "function";
}
async function decideToolCall(event, context, policy) {
  if (!policy.gated.has(event.toolName) && !isHostToolName(event.toolName)) {
    return { block: false, route: "not-gated" };
  }
  if (policy.mode === "allow")
    return { block: false, route: "mode-allow" };
  if (policy.mode === "deny") {
    return { block: true, reason: "tool calls are denied in this run", route: "mode-deny" };
  }
  if (policy.sessionAllowed.has(event.toolName))
    return { block: false, route: "session-allow" };
  if (!hasUi(context) || !context.ui?.select) {
    return {
      block: true,
      reason: "tool requires approval but this session has no interactive UI",
      route: "no-ui"
    };
  }
  const dialog = buildApprovalDialog(event, context, policy.timeoutMs);
  let choice;
  try {
    choice = await context.ui.select(dialog.title, dialog.items, dialog.dialogOptions);
  } catch (error) {
    return {
      block: true,
      reason: `approval dialog failed: ${error instanceof Error ? error.message : String(error)}`,
      route: "dialog-error"
    };
  }
  if (choice === OMP_APPROVAL_OPTIONS[0])
    return { block: false, route: "allow-once" };
  if (choice === OMP_APPROVAL_OPTIONS[1]) {
    policy.sessionAllowed.add(event.toolName);
    return { block: false, route: "allow-session" };
  }
  return {
    block: true,
    reason: choice === undefined ? "denied by user (no answer)" : `denied by user (${choice})`,
    route: "deny"
  };
}
function parseGatedTools(value) {
  const raw = value ?? DEFAULT_GATED_TOOLS;
  return new Set(raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}
function beforeAgentStartInjection(event, context, statePath, now) {
  const state = readDesktopCapabilityState(statePath, now);
  if (!state)
    return;
  let sessionId;
  try {
    sessionId = context.sessionManager?.getSessionId?.();
  } catch {
    return;
  }
  if (!sessionId || sessionId !== state.sessionId)
    return;
  const block = desktopCapabilityPrompt(state);
  if (!block)
    return;
  return { systemPrompt: [...event.systemPrompt, block] };
}
function ompDesktopGate(pi) {
  const env = globalThis.process?.env;
  const gated = parseGatedTools(env?.OMP_DESKTOP_GATE_TOOLS);
  const mode = (env?.OMP_DESKTOP_GATE_MODE ?? "ask").trim();
  const timeoutMs = Number(env?.OMP_DESKTOP_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const sessionAllowed = new Set;
  pi.on("tool_call", async (event, context) => {
    const verdict = await decideToolCall(event, context, {
      gated,
      mode: mode === "deny" || mode === "allow" ? mode : "ask",
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      sessionAllowed
    });
    if (!verdict.block)
      return;
    return { block: true, reason: verdict.reason ?? "denied" };
  });
  pi.on("before_agent_start", async (event, context) => {
    try {
      return beforeAgentStartInjection(event, context, env?.OMP_DESKTOP_STATE, Date.now());
    } catch {
      return;
    }
  });
}
export {
  approvalTitle,
  beforeAgentStartInjection,
  buildApprovalDialog,
  decideToolCall,
  ompDesktopGate as default,
  isHostToolName,
  parseGatedTools,
  riskForTool
};
