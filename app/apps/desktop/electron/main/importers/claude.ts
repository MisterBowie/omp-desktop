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

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

interface ClaudeLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  uuid?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Array<Record<string, any>>;
  };
}

async function readLines(filePath: string): Promise<ClaudeLine[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const out: ClaudeLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function isConversationLine(line: ClaudeLine): boolean {
  return (
    (line.type === "user" || line.type === "assistant") &&
    line.isSidechain !== true &&
    !!line.message
  );
}

function blockText(content: string | Array<Record<string, any>> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// Claude Code injects synthetic user lines (command caveats, system reminders,
// slash-command transcripts) that all start with an XML-ish tag.
function isSyntheticUserText(text: string): boolean {
  return text.startsWith("<");
}

export const claudeImporter: SessionImporter = {
  source: "claude-code",

  async scan(): Promise<ExternalSessionSummary[]> {
    let projectDirs: string[] = [];
    try {
      projectDirs = await fs.readdir(PROJECTS_DIR);
    } catch {
      return [];
    }
    const summaries: ExternalSessionSummary[] = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(PROJECTS_DIR, dir);
      let files: string[] = [];
      try {
        files = (await fs.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const lines = await readLines(filePath);
          const convo = lines.filter(isConversationLine);
          if (convo.length === 0) continue;
          const firstUser = convo.find((l) => {
            if (l.type !== "user") return false;
            const text = blockText(l.message?.content);
            return !!text && !isSyntheticUserText(text);
          });
          const model =
            convo.find((l) => l.type === "assistant" && l.message?.model)?.message
              ?.model ?? null;
          summaries.push({
            source: "claude-code",
            externalId: path.basename(file, ".jsonl"),
            title:
              truncateTitle(blockText(firstUser?.message?.content) || "") ||
              path.basename(file, ".jsonl"),
            projectPath: convo[0]?.cwd ?? null,
            model,
            createdAt: toIso(convo[0]?.timestamp),
            updatedAt: toIso(convo[convo.length - 1]?.timestamp),
            messageCount: convo.length,
            filePath,
          });
        } catch {
          // unreadable session file — skip
        }
      }
    }
    return summaries;
  },

  async convert(summary: ExternalSessionSummary): Promise<ImportedSession> {
    const lines = (await readLines(summary.filePath)).filter(isConversationLine);
    const messages: ImportedUiMessage[] = [];
    const pendingTools = new Map<
      string,
      { name: string; args: unknown; createdAt: string }
    >();

    for (const line of lines) {
      const createdAt = toIso(line.timestamp);
      const content = line.message?.content;
      const blocks = Array.isArray(content) ? content : null;

      if (line.type === "assistant") {
        const text = blockText(content);
        if (text) {
          messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            content: text,
            createdAt,
            status: "complete",
          });
        }
        for (const b of blocks ?? []) {
          if (b.type === "tool_use" && b.id) {
            pendingTools.set(b.id, { name: b.name, args: b.input, createdAt });
          }
        }
      } else if (line.type === "user") {
        const toolResults = (blocks ?? []).filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          for (const b of toolResults) {
            const pending = pendingTools.get(b.tool_use_id);
            pendingTools.delete(b.tool_use_id);
            const resultText =
              typeof b.content === "string" ? b.content : blockText(b.content);
            messages.push({
              id: crypto.randomUUID(),
              role: "tool",
              content: resultText,
              createdAt,
              toolName: pending?.name,
              toolCallId: b.tool_use_id,
              toolStatus: b.is_error ? "error" : "success",
              toolArgs: pending?.args,
              toolResult: resultText,
              isError: b.is_error === true || undefined,
              status: "complete",
            });
          }
        } else {
          const text = blockText(content);
          if (text && !isSyntheticUserText(text)) {
            messages.push({
              id: crypto.randomUUID(),
              role: "user",
              content: text,
              createdAt,
            });
          }
        }
      }
    }

    return {
      session: {
        id: importedSessionId("claude-code", summary.externalId),
        title: summary.title,
        projectPath: summary.projectPath,
        modelId: summary.model,
        providerId: null,
        mode: "agent",
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      },
      messages,
    };
  },
};
