/**
 * Desktop-owned global instructions (R10).
 *
 * The file lives in the app's own data directory, so editing it never writes
 * into the user's real Pi or OMP folders. Each OMP run receives it as the
 * runtime's user-level `AGENTS.md`, which the pinned runtime loads natively
 * from `<HOME>/.agents/AGENTS.md` under the run's synthetic HOME, before the
 * project's own instruction files.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Same budget the previous desktop runtime gave the global file. */
export const MAX_GLOBAL_INSTRUCTIONS_BYTES = 32 * 1024;

export function globalInstructionsPath(dataDir: string): string {
  return join(dataDir, "AGENTS.md");
}

/** The trimmed, bounded instructions a run should load, or null when there are none. */
export async function readGlobalInstructions(dataDir: string): Promise<string | null> {
  let content: string;
  try {
    content = (await readFile(globalInstructionsPath(dataDir), "utf8")).trim();
  } catch {
    // A missing file is the expected first-run state.
    return null;
  }
  return content ? boundInstructions(content) : null;
}

function boundInstructions(content: string): string {
  const totalBytes = Buffer.byteLength(content, "utf8");
  if (totalBytes <= MAX_GLOBAL_INSTRUCTIONS_BYTES) return content;
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > MAX_GLOBAL_INSTRUCTIONS_BYTES) break;
    bytes += charBytes;
    end += char.length;
  }
  const notice = `[OMP Desktop truncated the global instructions: loaded the first ${bytes} of ${totalBytes} bytes; the rest is not in context.]`;
  const kept = content.slice(0, end).trimEnd();
  return kept ? `${kept}\n\n${notice}` : notice;
}

/**
 * Project the instructions as the run's user-level `AGENTS.md`, or remove a
 * stale copy. The entry is removed before the exclusive write, so an alias
 * planted at the path is replaced rather than followed.
 */
export async function writeOmpGlobalInstructions(home: string, instructions: string | null): Promise<void> {
  const dir = join(home, ".agents");
  const target = join(dir, "AGENTS.md");
  await rm(target, { force: true });
  if (!instructions) return;
  await mkdir(dir, { recursive: true });
  await writeFile(target, `${instructions}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
