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

const STORAGE_DIR = path.join(os.homedir(), ".local", "share", "opencode", "storage");

interface OpenCodeSession {
  id: string;
  title?: string;
  directory?: string;
  projectID?: string;
  time?: { created?: number; updated?: number };
}

interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  time?: { created?: number; completed?: number };
}

interface OpenCodePart {
  id: string;
  type?: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: { input?: unknown; output?: unknown; status?: string };
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function loadMessages(sessionId: string): Promise<OpenCodeMessage[]> {
  const dir = path.join(STORAGE_DIR, "message", sessionId);
  const out: OpenCodeMessage[] = [];
  for (const file of await listJsonFiles(dir)) {
    const msg = await readJson<OpenCodeMessage>(path.join(dir, file));
    if (msg) out.push(msg);
  }
  out.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return out;
}

export const opencodeImporter: SessionImporter = {
  source: "opencode",

  async scan(): Promise<ExternalSessionSummary[]> {
    const sessionRoot = path.join(STORAGE_DIR, "session");
    let projectDirs: string[] = [];
    try {
      projectDirs = await fs.readdir(sessionRoot);
    } catch {
      return [];
    }
    const summaries: ExternalSessionSummary[] = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(sessionRoot, dir);
      let stat;
      try {
        stat = await fs.stat(dirPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const file of await listJsonFiles(dirPath)) {
        const session = await readJson<OpenCodeSession>(path.join(dirPath, file));
        if (!session?.id) continue;
        let messageCount = 0;
        try {
          messageCount = (
            await fs.readdir(path.join(STORAGE_DIR, "message", session.id))
          ).filter((f) => f.endsWith(".json")).length;
        } catch {
          continue;
        }
        if (messageCount === 0) continue;
        summaries.push({
          source: "opencode",
          externalId: session.id,
          title: truncateTitle(session.title ?? "") || session.id,
          projectPath: session.directory ?? null,
          model: null,
          createdAt: toIso(session.time?.created),
          updatedAt: toIso(session.time?.updated, toIso(session.time?.created)),
          messageCount,
          filePath: path.join(dirPath, file),
        });
      }
    }
    return summaries;
  },

  async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
    const ocMessages = await loadMessages(summary.externalId);
    const messages: ImportedUiMessage[] = [];
    let modelId: string | null = null;
    let providerId: string | null = null;

    for (const msg of ocMessages) {
      if (msg.role === "assistant") {
        modelId = msg.modelID ?? modelId;
        providerId = msg.providerID ?? providerId;
      }
      const createdAt = toIso(msg.time?.created);
      const partDir = path.join(STORAGE_DIR, "part", msg.id);
      const texts: string[] = [];
      const toolMessages: ImportedUiMessage[] = [];
      for (const file of await listJsonFiles(partDir)) {
        const part = await readJson<OpenCodePart>(path.join(partDir, file));
        if (!part) continue;
        if (part.type === "text" && part.text && part.synthetic !== true) {
          texts.push(part.text);
        } else if (part.type === "tool") {
          const output = part.state?.output;
          const outputText =
            typeof output === "string" ? output : output ? JSON.stringify(output) : "";
          toolMessages.push({
            id: crypto.randomUUID(),
            role: "tool",
            content: outputText,
            createdAt,
            toolName: part.tool,
            toolCallId: part.callID,
            toolStatus: part.state?.status === "error" ? "error" : "success",
            toolArgs: part.state?.input,
            toolResult: outputText,
            isError: part.state?.status === "error" || undefined,
            status: "complete",
          });
        }
      }
      const text = texts.join("\n").trim();
      if (text) {
        messages.push({
          id: crypto.randomUUID(),
          role: msg.role === "user" ? "user" : "assistant",
          content: text,
          createdAt,
          status: msg.role === "assistant" ? "complete" : undefined,
        });
      }
      messages.push(...toolMessages);
    }

    return {
      session: {
        id: importedSessionId("opencode", summary.externalId),
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
