import type { UiMessage } from "@pi-desktop/shared";
import {
  delegationLifecycleKind,
  getToolAction,
  getToolSummaryKey,
  type ToolAction,
} from "./tool-display";
import { reviewChangeFromMessage } from "./workspace-review";

/*
 * Structured presentation of one tool call (D192).
 *
 * Tool payloads are well-shaped — Read returns file content, Bash returns
 * stdout/stderr/exitCode, Grep returns path/line hits — so the transcript
 * renders them as content, terminal output, diffs and match lists instead of
 * dumping `JSON.stringify` into a <pre>. Everything here is pure and
 * label-free: blocks carry a semantic `role` and the React layer maps roles to
 * translated headings.
 *
 * Only genuinely unknown nested values (plugin tools returning objects) still
 * fall back to pretty-printed JSON.
 */

/** Beyond this, syntax highlighting costs more than it is worth on expand. */
const MAX_HIGHLIGHT_BYTES = 100_000;
const MAX_HIGHLIGHT_LINES = 800;
/** Rendered list caps; the remainder is reported, never silently dropped. */
const MAX_LIST_ITEMS = 200;
const MAX_DIFF_LINES = 400;
const DIFF_CONTEXT_LINES = 2;
/** Longer single-line strings become their own block instead of a field row. */
const MAX_FIELD_VALUE = 120;
/** Internal review snapshots are rendered by ReviewChangeCard, not as fields. */
const HIDDEN_KEYS = new Set(["review"]);

export type ToolPresentationMessage = {
  role?: string;
  content?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolStatus?: string;
};

export type ToolChip =
  | { role: "exit" | "matches" | "files" | "replacements"; count: number }
  | { role: "truncated" | "scratch" }
  | { role: "lines"; text: string }
  | { role: "size"; text: string };

export type ToolBlockRole =
  | "content"
  | "written"
  | "command"
  | "stdout"
  | "stderr"
  | "diff"
  | "files"
  | "matches"
  | "details"
  | "output"
  | "input"
  | "notice"
  | "error";

export type ToolDiffLine = { type: "add" | "del" | "context"; text: string };
export type ToolMatchGroup = {
  path: string;
  lines: { line: number; text: string }[];
};
export type ToolFieldRow = { label: string; value: string };

type BlockBase = {
  role: ToolBlockRole;
  /** Raw key for generic payload entries; overrides the role heading. */
  label?: string;
};

export type ToolBlock =
  | (BlockBase & {
      kind: "code";
      text: string;
      lang: string;
      highlight: boolean;
      tone?: "error";
    })
  | (BlockBase & {
      kind: "diff";
      lines: ToolDiffLine[];
      hidden: number;
      copy: string;
    })
  | (BlockBase & { kind: "files"; paths: string[]; hidden: number })
  | (BlockBase & { kind: "matches"; groups: ToolMatchGroup[]; hidden: number })
  | (BlockBase & { kind: "fields"; rows: ToolFieldRow[] })
  | (BlockBase & { kind: "note"; text: string; code?: string });

export type ToolPresentationOptions = {
  /** Drop the argument the collapsed row already shows as its summary. */
  hideSummaryArg?: boolean;
  /**
   * Drop a delegate's report from a `Task` body. The transcript nests the
   * delegate's own rows under the call, and its last answer row already is the
   * report, so showing both would print it twice (ADR 0062).
   */
  hideDelegateReport?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function numberAt(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Text blocks of a pi-ai tool result envelope, joined. */
function envelopeText(envelope: Record<string, unknown>): string | null {
  if (!Array.isArray(envelope.content)) return null;
  const parts = envelope.content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string"
      ? [record.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Unwrap `{ content, details }` down to the single payload worth showing.
 * `details` holds the structured host result; the content blocks repeat it as
 * text for the model, so showing both would duplicate every byte.
 */
export function toolResultPayload(message: ToolPresentationMessage): unknown {
  const raw = message.toolResult;
  if (raw === undefined || raw === null || raw === "") {
    return message.content ? message.content : undefined;
  }
  if (typeof raw === "string") return raw;
  const envelope = asRecord(raw);
  if (!envelope) return raw;
  if (envelope.details !== undefined && envelope.details !== null) {
    return envelope.details;
  }
  return envelopeText(envelope) ?? envelope;
}

/**
 * A delegate's report. `toolResultPayload` prefers the `details` object, which
 * for `Task` holds only counters, so the report has to be read from the text
 * blocks of the raw envelope.
 */
function delegateReport(message: ToolPresentationMessage): string | null {
  const raw = message.toolResult;
  if (typeof raw === "string") return raw.trim() ? raw : null;
  const envelope = asRecord(raw);
  const text = envelope ? envelopeText(envelope) : null;
  return text && text.trim() ? text : null;
}

/** The envelope's own text, used for a lifecycle row's one-line summary. */
function envelopeTextOf(message: ToolPresentationMessage): string | null {
  const raw = message.toolResult;
  if (typeof raw === "string") return raw.trim() ? raw.trim() : null;
  const envelope = asRecord(raw);
  const text = envelope ? envelopeText(envelope) : null;
  return text && text.trim() ? text.trim() : null;
}

/**
 * The text an OMP tool result wrote, from either projection the converter
 * produces. A structured result keeps its text in the envelope's `content`
 * blocks; a text-only result (a thrown ToolError, a no-session terminate) has
 * an empty `toolResult` and is projected onto the row's `content` field. Read
 * both so the text survives the live, durable/restore and child paths.
 */
function ompResultText(message: ToolPresentationMessage): string | null {
  const envelope = envelopeTextOf(message);
  if (envelope) return envelope;
  const content = message.content;
  return typeof content === "string" && content.trim() ? content : null;
}

/**
 * A lifecycle row's roster as field rows: one line per subagent, named, with
 * its status and runtime. Without this the row falls back to a JSON dump of
 * `delegations[]`, which is the least readable part of a delegation (D268).
 */
function rosterRows(
  details: Record<string, unknown> | null,
): ToolBlock | null {
  if (!details) return null;
  const entries = [
    ...(Array.isArray(details.delegations) ? details.delegations : []),
    ...(Array.isArray(details.stopped) ? details.stopped : []),
  ];
  const rows: ToolFieldRow[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (!record) continue;
    const agent = typeof record.agent === "string" ? record.agent : "";
    const id = typeof record.delegationId === "string" ? record.delegationId : "";
    // An entry that names neither an agent nor a delegation would render as a
    // blank table row, which reads as a rendering fault rather than as data.
    if (!agent && !id) continue;
    const status = typeof record.status === "string" ? record.status : "";
    const startedAt = numberAt(record, "startedAt");
    const completedAt = numberAt(record, "completedAt");
    const seconds =
      startedAt !== null && completedAt !== null
        ? Math.max(0, Math.round((completedAt - startedAt) / 1000))
        : null;
    const turns = numberAt(record, "turns");
    const parts = [
      status,
      seconds !== null ? `${seconds}s` : null,
      turns !== null ? `${turns} turns` : null,
    ].filter((part): part is string => Boolean(part));
    rows.push({ label: agent || id, value: parts.join(" · ") });
  }
  return rows.length > 0 ? { kind: "fields", role: "details", rows } : null;
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/** Extension-derived Shiki tag; `resolveLang` normalizes it at render time. */
export function langForPath(path: string | null): string {
  if (!path) return "";
  const base = path.split(/[/\\]/).pop() ?? "";
  if (/^dockerfile/i.test(base)) return "dockerfile";
  if (/^makefile$/i.test(base)) return "makefile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = base.slice(dot + 1).toLowerCase();
  return ext.length <= 10 ? ext : "";
}

function codeBlock(
  role: ToolBlockRole,
  text: string,
  lang = "",
  extra?: { tone?: "error"; label?: string },
): ToolBlock {
  return {
    kind: "code",
    role,
    text,
    lang,
    highlight:
      lang !== "" &&
      text.length <= MAX_HIGHLIGHT_BYTES &&
      countLines(text) <= MAX_HIGHLIGHT_LINES,
    ...(extra?.tone ? { tone: extra.tone } : {}),
    ...(extra?.label ? { label: extra.label } : {}),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatReadLineRange(details: Record<string, unknown>): string | null {
  const offset = numberAt(details, "offset");
  const lineCount = numberAt(details, "lineCount");
  if (
    offset === null ||
    lineCount === null ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(lineCount) ||
    offset < 0 ||
    lineCount <= 0
  ) {
    return null;
  }
  const end = offset + lineCount;
  return Number.isSafeInteger(end)
    ? `${lineCount},L${offset + 1}-L${end}`
    : null;
}

/**
 * Minimal line diff used by review hunks and tests. Both sides are localized
 * snippets, so trimming the shared head/tail to a little context is enough to
 * make the actual replacement obvious.
 */
export function buildDiffLines(
  oldText: string,
  newText: string,
): ToolDiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const lines: ToolDiffLine[] = [];
  for (let i = Math.max(0, head - DIFF_CONTEXT_LINES); i < head; i += 1) {
    lines.push({ type: "context", text: oldLines[i] });
  }
  for (let i = head; i < oldLines.length - tail; i += 1) {
    lines.push({ type: "del", text: oldLines[i] });
  }
  for (let i = head; i < newLines.length - tail; i += 1) {
    lines.push({ type: "add", text: newLines[i] });
  }
  const tailStart = oldLines.length - tail;
  const tailEnd = Math.min(oldLines.length, tailStart + DIFF_CONTEXT_LINES);
  for (let i = tailStart; i < tailEnd; i += 1) {
    lines.push({ type: "context", text: oldLines[i] });
  }
  return lines;
}

function diffBlock(oldText: string, newText: string): ToolBlock | null {
  const lines = buildDiffLines(oldText, newText);
  if (!lines.some((line) => line.type !== "context")) return null;
  const sign = (line: ToolDiffLine) =>
    line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return {
    kind: "diff",
    role: "diff",
    lines: lines.slice(0, MAX_DIFF_LINES),
    hidden: Math.max(0, lines.length - MAX_DIFF_LINES),
    copy: lines.map((line) => `${sign(line)}${line.text}`).join("\n"),
  };
}

function filesBlock(paths: string[], label?: string): ToolBlock | null {
  if (paths.length === 0) return null;
  return {
    kind: "files",
    role: "files",
    paths: paths.slice(0, MAX_LIST_ITEMS),
    hidden: Math.max(0, paths.length - MAX_LIST_ITEMS),
    ...(label ? { label } : {}),
  };
}

/** Group Grep hits by file so repeated paths collapse into one heading. */
function matchesBlock(hits: unknown[]): ToolBlock | null {
  const groups: ToolMatchGroup[] = [];
  let total = 0;
  let hidden = 0;
  for (const hit of hits) {
    const record = asRecord(hit);
    const path = stringAt(record, "path", "file");
    const line = numberAt(record, "line");
    if (!path || line === null) continue;
    if (total >= MAX_LIST_ITEMS) {
      hidden += 1;
      continue;
    }
    total += 1;
    const text = typeof record?.text === "string" ? record.text : "";
    const last = groups[groups.length - 1];
    if (last && last.path === path) last.lines.push({ line, text });
    else groups.push({ path, lines: [{ line, text }] });
  }
  return groups.length > 0
    ? { kind: "matches", role: "matches", groups, hidden }
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : null;
}

/** Grep's `count` output mode: one row per file, `path` → number of hits. */
function countsBlock(value: unknown): ToolBlock | null {
  if (!Array.isArray(value)) return null;
  const rows: ToolFieldRow[] = [];
  for (const entry of value.slice(0, MAX_LIST_ITEMS)) {
    const record = asRecord(entry);
    const path = stringAt(record, "path", "file");
    const count = numberAt(record, "count");
    if (!path || count === null) continue;
    rows.push({ label: path, value: String(count) });
  }
  return rows.length > 0 ? { kind: "fields", role: "matches", rows } : null;
}

/**
 * Readable rendering for payloads with no per-tool mapping (plugin tools, MCP
 * results): scalars become field rows, long or multi-line strings become their
 * own labeled block, and only nested objects keep a JSON body.
 */
function recordBlocks(
  record: Record<string, unknown>,
  role: ToolBlockRole,
): ToolBlock[] {
  const rows: ToolFieldRow[] = [];
  const extra: ToolBlock[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || HIDDEN_KEYS.has(key)) continue;
    if (typeof value === "string") {
      if (value === "") continue;
      if (value.includes("\n") || value.length > MAX_FIELD_VALUE) {
        extra.push(codeBlock(role, value, langForPath(key), { label: key }));
      } else {
        rows.push({ label: key, value });
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      rows.push({ label: key, value: String(value) });
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const strings = stringArray(value);
      if (strings) {
        const block = filesBlock(strings, key);
        if (block) extra.push(block);
        continue;
      }
      const grouped = matchesBlock(value);
      if (grouped) {
        extra.push(grouped);
        continue;
      }
    }
    extra.push(codeBlock(role, safeJson(value), "json", { label: key }));
  }
  return rows.length > 0 ? [{ kind: "fields", role, rows }, ...extra] : extra;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * What actually happened to a command, read from what the shell returned rather
 * than from the status of the call that carried it: a command that exits
 * non-zero has failed even when the tool call around it succeeded, and a shell
 * that was killed reports no code at all (D227). `unknown` means the row has
 * nothing to claim — an imported or half-written message — so it says nothing.
 */
export function runOutcome(
  message: ToolPresentationMessage,
): "running" | "denied" | "failed" | "ok" | "unknown" {
  if (message.toolStatus === "running") return "running";
  if (message.toolStatus === "denied") return "denied";
  const details = asRecord(toolResultPayload(message));
  if (details && "exitCode" in details) {
    return numberAt(details, "exitCode") === 0 ? "ok" : "failed";
  }
  if (message.toolStatus === "error") return "failed";
  if (message.toolStatus === "success") return "ok";
  return "unknown";
}

/** Cheap outcome badges for the collapsed row: no stringify, property reads. */
export function toolResultChips(message: ToolPresentationMessage): ToolChip[] {
  const details = asRecord(toolResultPayload(message));
  const chips: ToolChip[] = [];
  // A whole omitted `details` field leaves the adapter's truncation flag on the
  // envelope itself; `toolResultPayload` then unwraps to the envelope's text
  // blocks, so the record read above misses the flag. Honor it before bailing
  // on a non-record payload — the retained content body stays visible.
  const envelope = asRecord(message.toolResult);
  if (details === null && envelope?.truncated === true) {
    chips.push({ role: "truncated" });
  }
  if (!details) return chips;
  const action = getToolAction(message.toolName);
  const exitCode = numberAt(details, "exitCode");
  // A successful exit is already implied by the row status; only failures earn
  // a badge.
  if (exitCode !== null && exitCode !== 0) {
    chips.push({ role: "exit", count: exitCode });
  }
  const count = numberAt(details, "count");
  const counted =
    Array.isArray(details.matches) ||
    Array.isArray(details.files) ||
    Array.isArray(details.counts);
  if (count !== null && counted) {
    chips.push({ role: action === "list" ? "files" : "matches", count });
  }
  const replacements = numberAt(details, "replacements");
  if (replacements !== null && replacements > 0) {
    chips.push({ role: "replacements", count: replacements });
  }
  if (action === "read") {
    const lineRange = formatReadLineRange(details);
    if (lineRange !== null) chips.push({ role: "lines", text: lineRange });
  } else {
    const bytes = numberAt(details, "bytes") ?? numberAt(details, "fileBytes");
    if (bytes !== null) chips.push({ role: "size", text: formatBytes(bytes) });
  }
  if (details.truncated === true) chips.push({ role: "truncated" });
  if (details.root === "scratch") chips.push({ role: "scratch" });
  return chips;
}

/**
 * Whether the row has anything to expand. Kept property-read cheap: streaming
 * replaces the message object on every tick, and collapsed rows only need to
 * know whether the caret should show.
 */
export function hasToolDetails(message: ToolPresentationMessage): boolean {
  const payload = toolResultPayload(message);
  if (typeof payload === "string") {
    if (payload !== "") return true;
  } else if (payload !== undefined) {
    const record = asRecord(payload);
    if (!record || Object.keys(record).length > 0) return true;
  }
  const args = asRecord(message.toolArgs);
  if (args) return Object.keys(args).length > 0;
  return message.toolArgs !== undefined;
}

/**
 * The bare producer tool name, without a plugin/MCP namespace. Native OMP
 * tools are registered as `lsp`, `debug` and `edit`, so a plugin named
 * `plugin_publisher_edit` (or a namespaced `mcp.edit`) must not match.
 */
function ompToolBareName(toolName?: string): string {
  return (toolName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * OMP native tools whose result shapes have no PI mapping. `lsp` and `debug`
 * resolve to the generic `use` action, and their meaning lives in
 * producer-specific shapes plus the envelope text, so they are recognised by
 * name at this adapter boundary. `edit` shares its action with PI's Edit tool
 * and is told apart by its result shape (see `resultBlocks`).
 */
function ompToolKind(toolName?: string): "lsp" | "debug" | null {
  const bare = ompToolBareName(toolName);
  if (bare === "lsp") return "lsp";
  if (bare === "debug") return "debug";
  return null;
}

/**
 * An LSP tool result. The producer carries the diagnostics (or the
 * all-servers-failed text) in the envelope's text blocks and only
 * `action`/`serverName`/`success` in `details`, so the generic
 * details-preferred unwrap would drop the diagnostics. `success` reports
 * whether a language server answered: a diagnostics result full of
 * error-severity findings still has `success: true`, so the row is never
 * marked failed from the findings themselves.
 */
function ompLspBlocks(
  message: ToolPresentationMessage,
  details: Record<string, unknown> | null,
): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  const text = ompResultText(message);
  if (text) {
    // A text-only ToolError (read-only/timeout) has no `details` to carry
    // `success`; the row status is the only failure signal.
    const failed = details?.success === false || message.toolStatus === "error";
    blocks.push(
      codeBlock(failed ? "error" : "output", text, "", failed ? { tone: "error" } : {}),
    );
  }
  const rows: ToolFieldRow[] = [];
  for (const key of ["serverName", "action"] as const) {
    const value = stringAt(details, key);
    if (value) rows.push({ label: key, value });
  }
  if (rows.length > 0) blocks.push({ kind: "fields", role: "details", rows });
  // `request` records what the model asked for on status/request/other actions;
  // its scalars read as rows. `success` is already the error tone above.
  const request = asRecord(details?.request);
  if (request) blocks.push(...recordBlocks(request, "details"));
  // A field is dropped from the fallback only once its value was actually
  // rendered: a scalar `request` (or a malformed scalar field) stays readable
  // instead of vanishing from the consumed list.
  const consumed: Record<string, true> = {};
  if (rows.some((row) => row.label === "serverName")) consumed.serverName = true;
  if (rows.some((row) => row.label === "action")) consumed.action = true;
  if (typeof details?.success === "boolean") consumed.success = true;
  if (request) consumed.request = true;
  const remainder = Object.fromEntries(
    Object.entries(details ?? {}).filter(([key]) => !consumed[key]),
  );
  if (Object.keys(remainder).length > 0) {
    blocks.push(...recordBlocks(remainder, "details"));
  }
  return blocks;
}

/** The debugger's stop location, `source.path[:line[:column]]`. */
function ompDebugLocation(snapshot: Record<string, unknown>): string | null {
  const source = asRecord(snapshot.source);
  const path = stringAt(source, "path");
  if (!path) return null;
  const line = numberAt(snapshot, "line");
  if (line === null) return path;
  const column = numberAt(snapshot, "column");
  return column === null ? `${path}:${line}` : `${path}:${line}:${column}`;
}

/**
 * The session summary (`details.snapshot`) as field rows plus a generic
 * remainder for any field this version does not know yet. A known field is
 * removed from the fallback only once its value is actually represented, so a
 * future snapshot field (or `id`/`instructionPointerReference`) still renders.
 */
function ompDebugSnapshotBlocks(snapshot: Record<string, unknown>): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  const rows: ToolFieldRow[] = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === "string" && value !== "") {
      rows.push({ label, value });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      rows.push({ label, value: String(value) });
    }
  };
  push("id", snapshot.id);
  push("adapter", snapshot.adapter);
  push("status", snapshot.status);
  push("cwd", snapshot.cwd);
  push("program", snapshot.program);
  push("stopReason", snapshot.stopReason);
  push("frameName", snapshot.frameName);
  const location = ompDebugLocation(snapshot);
  if (location) rows.push({ label: "location", value: location });
  push("instructionPointerReference", snapshot.instructionPointerReference);
  push("exitCode", snapshot.exitCode);
  if (snapshot.needsConfigurationDone === true) {
    rows.push({ label: "configuration", value: "pending configurationDone" });
  }
  if (rows.length > 0) blocks.push({ kind: "fields", role: "details", rows });

  // The location row shows `source.path[:line[:column]]`. A source object with
  // any other field (a future `name`, `origin`, …) keeps that remainder, and a
  // field is consumed only once its value was actually rendered.
  const source = asRecord(snapshot.source);
  const consumed: Record<string, true> = {
    id: true,
    adapter: true,
    status: true,
    cwd: true,
    program: true,
    stopReason: true,
    frameName: true,
    instructionPointerReference: true,
    exitCode: true,
    needsConfigurationDone: true,
  };
  let sourceRemainder: Record<string, unknown> | null = null;
  if (source) {
    consumed.source = true;
    if (location) {
      consumed.line = true;
      consumed.column = true;
    }
    const rest = Object.fromEntries(
      Object.entries(source).filter(([key]) => key !== "path"),
    );
    if (Object.keys(rest).length > 0) sourceRemainder = rest;
  }
  const remainder = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !consumed[key]),
  );
  if (sourceRemainder) remainder.source = sourceRemainder;
  if (Object.keys(remainder).length > 0) {
    blocks.push(...recordBlocks(remainder, "details"));
  }
  return blocks;
}

/** Breakpoint listings read better as rows than as a JSON blob of records. */
function ompDebugBreakpointRows(
  value: unknown,
): { rows: ToolFieldRow[]; remainder: unknown[] } {
  if (!Array.isArray(value)) return { rows: [], remainder: [] };
  const rows: ToolFieldRow[] = [];
  const remainder: unknown[] = [];
  // Fields the row renders; anything else on an item (a real `id`, a future
  // producer field) stays readable instead of vanishing.
  const KNOWN: Record<string, true> = {
    id: true,
    name: true,
    line: true,
    verified: true,
    message: true,
    condition: true,
  };
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) {
      remainder.push(entry);
      continue;
    }
    const line = numberAt(record, "line");
    const id = numberAt(record, "id");
    const target =
      stringAt(record, "name") ?? (line !== null ? `line ${line}` : null);
    if (!target) {
      remainder.push(entry);
      continue;
    }
    const verified =
      record.verified === true ? "verified" : record.verified === false ? "pending" : "";
    // `message` is why a breakpoint is pending (e.g. "No executable code at
    // the breakpoint location."); it is the only field that explains it.
    const message = stringAt(record, "message");
    const condition = stringAt(record, "condition");
    const parts = [
      id !== null ? `#${id}` : null,
      target,
      verified,
      message,
      condition ? `if ${condition}` : null,
    ].filter((part): part is string => Boolean(part));
    rows.push({ label: "breakpoint", value: parts.join(" · ") });
    const rest = Object.fromEntries(
      Object.entries(record).filter(([key]) => !Object.hasOwn(KNOWN, key)),
    );
    if (Object.keys(rest).length > 0) remainder.push(rest);
  }
  return { rows, remainder };
}

/**
 * A debugger tool result. The producer stores a session summary in
 * `details.snapshot` and the action's payload (`evaluation`, `output`,
 * breakpoint/stack/thread/scope listings…) beside it; the generic
 * details-preferred unwrap would dump `snapshot` and `evaluation` as JSON
 * blobs. Flatten the summary and the common payloads into readable rows, and
 * keep every other field through the generic record renderer. The producer's
 * text is shown only when no structured field carried the result — a
 * no-session terminate or an empty console read have no snapshot/output, so
 * their message lives in the envelope text alone.
 */
function ompDebugBlocks(
  message: ToolPresentationMessage,
  details: Record<string, unknown> | null,
): ToolBlock[] | null {
  if (!details) return null;
  const blocks: ToolBlock[] = [];
  // The producer's text repeats the action's result (console output, an
  // evaluation, a breakpoint listing); it is suppressed only when that result
  // was actually rendered. The session snapshot is metadata, never the result,
  // so a present snapshot must not hide an empty output's `(no output captured)`.
  let carried = false;

  const snapshot = asRecord(details.snapshot);
  if (snapshot) {
    const snapshotBlocks = ompDebugSnapshotBlocks(snapshot);
    if (snapshotBlocks.length > 0) blocks.push(...snapshotBlocks);
  }

  const output = stringAt(details, "output");
  if (output) {
    blocks.push(codeBlock("output", output));
    carried = true;
  }

  const evaluation = asRecord(details.evaluation);
  if (evaluation) {
    const evaluationBlocks = recordBlocks(evaluation, "details");
    if (evaluationBlocks.length > 0) {
      blocks.push(...evaluationBlocks);
      carried = true;
    }
  }

  for (const key of ["breakpoints", "functionBreakpoints"] as const) {
    const value = details[key];
    if (!Array.isArray(value)) continue;
    const { rows, remainder: breakpointRemainder } = ompDebugBreakpointRows(value);
    if (rows.length > 0) {
      blocks.push({ kind: "fields", role: "details", rows });
      carried = true;
    }
    if (breakpointRemainder.length > 0) {
      blocks.push(...recordBlocks({ [key]: breakpointRemainder }, "details"));
    }
  }

  // A field is consumed only once its value was rendered: a non-string
  // `output`, a non-record `evaluation`, or an unrecognized listing stays in
  // the generic remainder instead of being dropped.
  const consumed: Record<string, true> = {};
  if (snapshot) consumed.snapshot = true;
  if (output) consumed.output = true;
  if (evaluation) consumed.evaluation = true;
  if (Array.isArray(details.breakpoints)) consumed.breakpoints = true;
  if (Array.isArray(details.functionBreakpoints)) consumed.functionBreakpoints = true;
  const remainder = Object.fromEntries(
    Object.entries(details).filter(([key]) => !consumed[key]),
  );
  if (Object.keys(remainder).length > 0) {
    blocks.push(...recordBlocks(remainder, "details"));
  }

  if (!carried) {
    const text = ompResultText(message);
    if (text) blocks.push(codeBlock("output", text));
  }

  return blocks.length > 0 ? blocks : null;
}

/** Patch/per-file diagnostics: each message is a note, the summary/server and
 * any unknown diagnostic field keep the generic renderer. */
function ompEditDiagnosticBlocks(
  diagnostics: Record<string, unknown> | null,
): ToolBlock[] {
  if (!diagnostics) return [];
  const blocks: ToolBlock[] = [];
  const errored = diagnostics.errored === true;
  const messages = Array.isArray(diagnostics.messages)
    ? diagnostics.messages.filter(
        (message): message is string => typeof message === "string" && message !== "",
      )
    : [];
  for (const message of messages) {
    blocks.push({ kind: "note", role: errored ? "error" : "notice", text: message });
  }
  // A non-array `messages` is malformed producer data, not an empty list: it
  // stays in the fallback rather than being discarded by the filter above.
  const consumed: Record<string, true> = {};
  if (Array.isArray(diagnostics.messages)) consumed.messages = true;
  const remainder = Object.fromEntries(
    Object.entries(diagnostics).filter(([key]) => !consumed[key]),
  );
  if (Object.keys(remainder).length > 0) {
    blocks.push(...recordBlocks(remainder, "details"));
  }
  return blocks;
}

/** One edited file: an openable path list, a read-only diff, diagnostics,
 * per-file errors, and a generic remainder for unknown fields. */
function ompEditFileBlocks(file: Record<string, unknown>): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  const path = stringAt(file, "path");
  const op = stringAt(file, "op");
  const move = stringAt(file, "move");
  const sourcePath = stringAt(file, "sourcePath");
  const isError = file.isError === true;
  const errorText = stringAt(file, "displayErrorText") ?? stringAt(file, "errorText");
  const snapshotsPruned = file.snapshotsPruned === true;
  const truncated = file.truncated === true;
  const oldText = typeof file.oldText === "string" ? file.oldText : null;
  const newText = typeof file.newText === "string" ? file.newText : null;
  const diffText = typeof file.diff === "string" && file.diff !== "" ? file.diff : null;
  const rename = Boolean(sourcePath && move);

  // Identity: the edited path (and the rename source) as an openable file
  // list, so a restored or child row without `toolArgs` can still open the
  // file it names. The host resolves the reference; nothing here trusts tool
  // text as a filesystem path.
  const paths: string[] = [];
  if (sourcePath && move) {
    paths.push(sourcePath, move);
  } else if (path) {
    paths.push(path);
  }
  const identity = filesBlock(paths);
  if (identity) blocks.push(identity);

  // The rename relationship stays readable next to the clickable paths: a flat
  // `[a.ts, b.ts]` list alone reads as "two files edited", not "a.ts moved to
  // b.ts".
  if (rename) {
    blocks.push({
      kind: "fields",
      role: "details",
      rows: [{ label: "move", value: `${sourcePath} → ${move}` }],
    });
  } else if (op === "create") {
    blocks.push({ kind: "fields", role: "details", rows: [{ label: "operation", value: "create" }] });
  } else if (op === "delete") {
    blocks.push({ kind: "fields", role: "details", rows: [{ label: "operation", value: "delete" }] });
  }

  if (op === "create") {
    if (newText !== null) blocks.push(codeBlock("written", newText, langForPath(path)));
    else if (diffText) blocks.push(codeBlock("written", diffText, ""));
  } else if (op === "delete") {
    if (oldText !== null) {
      blocks.push(codeBlock("content", oldText, langForPath(path), { label: "deleted" }));
    } else if (diffText) {
      blocks.push(codeBlock("content", diffText, "", { label: "deleted" }));
    }
  } else if (oldText !== null && newText !== null) {
    // Source-of-truth snapshots render a clean colored diff; the hashline-format
    // `diff` string repeats them, so it is shown only when the snapshots were
    // pruned away.
    const diff = diffBlock(oldText, newText);
    if (diff) {
      blocks.push(diff);
    } else if (!rename) {
      blocks.push({
        kind: "note",
        role: "notice",
        text: path ? `no changes were made to ${path}` : "no changes were made",
      });
    }
  } else if (diffText) {
    blocks.push(codeBlock("diff", diffText, ""));
  } else if (!rename && !snapshotsPruned && !truncated && !isError) {
    // A genuine no-op has its own complete result: no diff, no snapshots, no
    // rename, no omission marker. A pruned/truncated/failed file is missing
    // its diff, not unchanged, and must not borrow the no-change preview.
    blocks.push({
      kind: "note",
      role: "notice",
      text: path ? `no changes were made to ${path}` : "no changes were made",
    });
  }

  const firstChangedLine = numberAt(file, "firstChangedLine");
  if (firstChangedLine !== null) {
    blocks.push({
      kind: "fields",
      role: "details",
      rows: [{ label: "firstChangedLine", value: String(firstChangedLine) }],
    });
  }

  const diagnostics = asRecord(file.diagnostics);
  if (diagnostics) blocks.push(...ompEditDiagnosticBlocks(diagnostics));

  const meta = asRecord(file.meta);
  if (meta) blocks.push(...recordBlocks(meta, "details"));

  if (isError) {
    blocks.push({ kind: "note", role: "error", text: errorText || "the edit failed" });
  }
  if (snapshotsPruned) {
    blocks.push({
      kind: "note",
      role: "notice",
      text: "file snapshots were pruned from the result",
    });
  }
  if (truncated) {
    blocks.push({
      kind: "note",
      role: "notice",
      text: "file content was truncated",
    });
  }

  // Any field this version does not know — future per-file metadata — stays
  // readable through the generic renderer instead of vanishing.
  const consumed: Record<string, true> = {
    path: true,
    op: true,
    move: true,
    sourcePath: true,
    isError: true,
    errorText: true,
    displayErrorText: true,
    snapshotsPruned: true,
    truncated: true,
    oldText: true,
    newText: true,
    diff: true,
    firstChangedLine: true,
    meta: true,
  };
  if (diagnostics) consumed.diagnostics = true;
  const remainder = Object.fromEntries(
    Object.entries(file).filter(([key]) => !consumed[key]),
  );
  if (Object.keys(remainder).length > 0) {
    blocks.push(...recordBlocks(remainder, "details"));
  }
  return blocks;
}

/** An OMP edit result: per-file diffs, or the single-file aggregate shape. */
function ompEditBlocks(details: Record<string, unknown>): ToolBlock[] {
  const perFile = Array.isArray(details.perFileResults) ? details.perFileResults : null;
  if (perFile && perFile.length > 0) {
    const blocks: ToolBlock[] = [];
    for (const entry of perFile) {
      const file = asRecord(entry);
      if (file) blocks.push(...ompEditFileBlocks(file));
    }
    // The aggregate `diff`/`firstChangedLine` repeat what each per-file block
    // already rendered; a top-level `diagnostics`, `meta`, or unknown field is
    // not per-file data and must stay readable rather than vanish with the
    // early return.
    const diagnostics = asRecord(details.diagnostics);
    if (diagnostics) blocks.push(...ompEditDiagnosticBlocks(diagnostics));
    const consumed: Record<string, true> = {
      perFileResults: true,
      diff: true,
      firstChangedLine: true,
    };
    if (diagnostics) consumed.diagnostics = true;
    const remainder = Object.fromEntries(
      Object.entries(details).filter(([key]) => !consumed[key]),
    );
    if (Object.keys(remainder).length > 0) {
      blocks.push(...recordBlocks(remainder, "details"));
    }
    return blocks;
  }
  return ompEditFileBlocks(details);
}

function resultBlocks(
  action: ToolAction,
  message: ToolPresentationMessage,
  args: Record<string, unknown> | null,
  payload: unknown,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const details = asRecord(payload);
  const blocks: ToolBlock[] = [];
  /**
   * Set once a mapping has said everything there is to say about the result, so
   * an empty body is read as "it printed nothing" rather than as a payload the
   * generic fallback still has to render (D226).
   */
  let mapped = false;
  const error = stringAt(details, "error");
  if (error) {
    const code = stringAt(details, "code");
    blocks.push({
      kind: "note",
      role: "error",
      text: error,
      ...(code ? { code } : {}),
    });
  }

  // OMP native LSP/debug results are resolved here, before the PI switch: their
  // meaning is producer-specific and lives partly outside `details`, so the
  // generic details-preferred fallback would drop it.
  const ompKind = ompToolKind(message.toolName);
  if (ompKind === "lsp") {
    return ompLspBlocks(message, details);
  }
  if (ompKind === "debug") {
    const debug = ompDebugBlocks(message, details);
    // A debug failure is text-only (no `details`), so fall through to the
    // generic string fallback rather than returning an empty body.
    if (debug) return debug;
  }

  switch (action) {
    case "read": {
      const content = stringAt(details, "content");
      if (content !== null) {
        const path = stringAt(details, "path") ?? stringAt(args, "path");
        blocks.push(codeBlock("content", content, langForPath(path)));
      }
      break;
    }
    case "write": {
      const content = stringAt(args, "content");
      if (content !== null) {
        const path = stringAt(args, "path") ?? stringAt(details, "path");
        blocks.push(codeBlock("written", content, langForPath(path)));
      }
      break;
    }
    case "edit": {
      // OMP's Edit tool carries a `diff` string (single-file) or `perFileResults`
      // (multi-file); PI's Edit tool never has either. The bare name narrows it
      // further: `getToolAction` maps any plugin name ending in `edit` here too,
      // and such a plugin's own `diff`/`revision` metadata must keep its generic
      // fallback instead of being read as native edit result blocks.
      if (
        ompToolBareName(message.toolName) === "edit" &&
        (typeof details?.diff === "string" || Array.isArray(details?.perFileResults))
      ) {
        blocks.push(...ompEditBlocks(details));
        mapped = true;
        break;
      }
      const ops = stringAt(args, "ops");
      // Workspace edits already own a ReviewChangeCard with the real diff;
      // only scratch edits and imported sessions need the model's stated ops.
      const reviewed =
        reviewChangeFromMessage(message as unknown as UiMessage) !== null;
      if (ops !== null && !reviewed) {
        blocks.push(codeBlock("input", ops));
      }
      const warnings = stringArray(details?.warnings);
      if (warnings) {
        for (const warning of warnings) {
          blocks.push({ kind: "note", role: "notice", text: warning });
        }
      }
      break;
    }
    case "run": {
      const command = stringAt(args, "command", "cmd");
      // The head already prints the command and copies it, so repeating it here
      // would open a body that says the same thing twice before reaching the
      // output the reader expanded for (D226). A permission card has no head of
      // its own, so it still shows the command it is asking about.
      if (command !== null && !options.hideSummaryArg) {
        blocks.push(codeBlock("command", command, "bash"));
      }
      // Bash progress updates use `details.output`; the completed result uses
      // `details.stdout`. A present empty stdout is meaningful too: it must
      // suppress a stale progress snapshot rather than fall back to output.
      const stdout =
        typeof details?.stdout === "string"
          ? details.stdout
          : stringAt(details, "output");
      if (stdout) blocks.push(codeBlock("stdout", stdout));
      const stderr = stringAt(details, "stderr");
      if (stderr !== null) {
        blocks.push(codeBlock("stderr", stderr, "", { tone: "error" }));
      }
      mapped = command !== null;
      break;
    }
    case "list": {
      const paths = stringArray(details?.matches) ?? stringArray(details?.files);
      const block = paths ? filesBlock(paths) : null;
      if (block) blocks.push(block);
      break;
    }
    case "search": {
      const hits = details?.matches;
      // `outputMode` decides the shape: content → path/line hits,
      // filesWithMatches → a path list, count → hits per file.
      const block = Array.isArray(hits) ? matchesBlock(hits) : null;
      const paths = block ? null : stringArray(details?.files);
      const grouped = block ?? (paths ? filesBlock(paths) : null);
      const resolved = grouped ?? countsBlock(details?.counts);
      if (resolved) blocks.push(resolved);
      break;
    }
    case "delegate": {
      // A lifecycle row (ADR 0089) has no brief and no report of its own: it
      // reports on subagents. Its body is the roster the runtime returned, as
      // a named table rather than the raw `delegations[]` JSON (D268).
      if (delegationLifecycleKind(message.toolName)) {
        // The joined reports are bounded at 50k chars by the runtime, which is
        // far too much for a `note`: an output block scrolls within a fixed
        // height and carries a copy button (D271).
        const text = envelopeTextOf(message);
        if (text) blocks.push(codeBlock("output", text, "markdown"));
        const roster = rosterRows(details);
        if (roster) blocks.push(roster);
        break;
      }
      // A delegation reads as brief in, report out. The counters that pi hands
      // back (`turns`, `toolCalls`, `usage`) are a footer, and `agent` already
      // labels the row, so neither repeats here.
      const brief = stringAt(args, "task");
      if (brief !== null) {
        blocks.push(codeBlock("input", brief, "markdown", { label: "task" }));
      }
      const report = options.hideDelegateReport
        ? null
        : delegateReport(message);
      if (report !== null) blocks.push(codeBlock("output", report, "markdown"));
      const counters = details
        ? Object.fromEntries(
            Object.entries(details).filter(
              ([key]) =>
                key !== "agent" &&
                key !== "error" &&
                key !== "modelId" &&
                key !== "thinkingLevel",
            ),
          )
        : {};
      if (Object.keys(counters).length > 0) {
        blocks.push(...recordBlocks(counters, "details"));
      }
      break;
    }
    default:
      break;
  }

  // Host-side scoping notes ("results are truncated…", "N long lines were cut")
  // explain a short result, so they ride along with the blocks they qualify.
  const notice = stringAt(details, "notice");
  if (notice && blocks.length > 0) {
    blocks.push({ kind: "note", role: "notice", text: notice });
  }

  if (blocks.length > 0 || mapped) return blocks;
  // No per-tool mapping matched: render the payload itself readably.
  if (typeof payload === "string" && payload.trim()) {
    return [codeBlock("output", payload)];
  }
  if (details) return recordBlocks(details, "details");
  if (payload !== undefined && payload !== null) {
    return [codeBlock("output", safeJson(payload), "json")];
  }
  return [];
}

/**
 * Build the expanded body of a tool row. Called only while the row is open —
 * the work here is proportional to the payload, not to the render frequency.
 */
export function buildToolPresentation(
  message: ToolPresentationMessage,
  options: ToolPresentationOptions = {},
): ToolBlock[] {
  const action = getToolAction(message.toolName);
  const args = asRecord(message.toolArgs);
  const payload = toolResultPayload(message);
  const blocks = resultBlocks(action, message, args, payload, options);
  if (!args) return blocks;

  // Arguments are worth showing when the result blocks did not already carry
  // them (Read content, Bash command) and for opaque tools whose arguments are
  // the interesting part. A delegation places its own brief, so it opts out.
  // A run row's command was withheld above because the head shows it, so the
  // body must not print it back as an argument the moment a command prints
  // nothing (D226).
  const headHasCommand =
    action === "run" &&
    options.hideSummaryArg === true &&
    getToolSummaryKey(message.toolName, args) !== null;
  const wantArgs =
    action !== "delegate" &&
    !headHasCommand &&
    (blocks.length === 0 ||
      blocks.every(
        (block) => block.role === "error" || block.role === "notice",
      ) ||
      action === "use" ||
      action === "fork" ||
      action === "fetch");
  if (!wantArgs) return blocks;
  const summaryKey = options.hideSummaryArg
    ? getToolSummaryKey(message.toolName, args)
    : null;
  const remaining = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== summaryKey),
  );
  if (Object.keys(remaining).length === 0) return blocks;
  return [...blocks, ...recordBlocks(remaining, "input")];
}
