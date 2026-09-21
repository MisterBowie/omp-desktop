import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExternalSessionSummary,
  ImportedSession,
  ImportedUiMessage,
  SessionImporter,
} from "./types";
import { importedSessionId, toIso, truncateTitle } from "./types";

const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

interface PiEntry {
  type?: string;
  timestamp?: string;
  name?: string;
  message?: {
    role?: string;
    content?: string | Array<Record<string, any>>;
    provider?: string;
    model?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    timestamp?: number;
  };
  // session header fields
  id?: string;
  cwd?: string;
}

interface ParsedPiFile {
  header: PiEntry;
  entries: PiEntry[];
}

function contentText(content: string | Array<Record<string, any>> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function parseFile(filePath: string): Promise<ParsedPiFile | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  let header: PiEntry;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header.type !== "session" || !header.id) return null;
  const entries: PiEntry[] = [];
  for (const line of lines.slice(1)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return { header, entries };
}

export const piImporter: SessionImporter = {
  source: "pi",

  async scan(): Promise<ExternalSessionSummary[]> {
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(SESSIONS_DIR);
    } catch {
      return [];
    }
    const summaries: ExternalSessionSummary[] = [];
    for (const dir of dirs) {
      const dirPath = path.join(SESSIONS_DIR, dir);
      let files: string[] = [];
      try {
        files = (await fs.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const parsed = await parseFile(filePath);
        if (!parsed) continue;
        const messageEntries = parsed.entries.filter((e) => e.type === "message");
        if (messageEntries.length === 0) continue;
        const sessionName = parsed.entries
          .filter((e) => e.type === "session_info" && e.name)
          .map((e) => e.name!)
          .pop();
        const firstUser = messageEntries.find(
          (e) => e.message?.role === "user" && contentText(e.message.content),
        );
        const lastTs =
          messageEntries[messageEntries.length - 1]?.timestamp ?? parsed.header.timestamp;
        summaries.push({
          source: "pi",
          externalId: parsed.header.id!,
          title:
            truncateTitle(sessionName ?? contentText(firstUser?.message?.content) ?? "") ||
            parsed.header.id!,
          projectPath: parsed.header.cwd ?? null,
          model:
            messageEntries.find((e) => e.message?.role === "assistant")?.message?.model ??
            null,
          createdAt: toIso(parsed.header.timestamp),
          updatedAt: toIso(lastTs, toIso(parsed.header.timestamp)),
          messageCount: messageEntries.length,
          filePath,
        });
      }
    }
    return summaries;
  },

  async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
    const parsed = await parseFile(summary.filePath);
    const messages: ImportedUiMessage[] = [];
    const pendingCalls = new Map<string, { name: string; args: unknown }>();
    let providerId: string | null = null;
    let modelId: string | null = null;

    for (const entry of parsed?.entries ?? []) {
      if (entry.type !== "message" || !entry.message) continue;
      const msg = entry.message;
      const createdAt = toIso(msg.timestamp ?? entry.timestamp, summary.createdAt);

      if (msg.role === "user") {
        const text = contentText(msg.content);
        if (text) {
          messages.push({ id: crypto.randomUUID(), role: "user", content: text, createdAt });
        }
      } else if (msg.role === "assistant") {
        providerId = msg.provider ?? providerId;
        modelId = msg.model ?? modelId;
        const text = contentText(msg.content);
        if (text) {
          messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: text,
            createdAt,
            status: "complete",
          });
        }
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b.type === "toolCall" && b.id) {
            pendingCalls.set(b.id, { name: b.name, args: b.arguments });
          }
        }
      } else if (msg.role === "toolResult" && msg.toolCallId) {
        const pending = pendingCalls.get(msg.toolCallId);
        pendingCalls.delete(msg.toolCallId);
        const resultText = contentText(msg.content);
        messages.push({
          id: crypto.randomUUID(),
          role: "tool",
          content: resultText,
          createdAt,
          toolName: msg.toolName ?? pending?.name,
          toolCallId: msg.toolCallId,
          toolStatus: msg.isError ? "error" : "success",
          toolArgs: pending?.args,
          toolResult: resultText,
          isError: msg.isError === true || undefined,
          status: "complete",
        });
      }
    }

    return {
      session: {
        id: importedSessionId("pi", summary.externalId),
        title: summary.title,
        projectPath: summary.projectPath,
        modelId,
        providerId,
        mode: "agent",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
      messages,
    };
  },
};
