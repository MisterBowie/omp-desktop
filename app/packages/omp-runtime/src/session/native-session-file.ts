/**
 * Direct, read-only reader for the pinned runtime's native session JSONL.
 *
 * The desktop must show a persisted transcript without starting a runtime.
 * Starting one to parse a file means the parser owns a session, and a session
 * owner writes on disposal (`session_exit`) into whatever it has open — so a
 * "read" that goes through a process is one detach failure away from mutating
 * the very file it is browsing. This reader has no writer, no lock and no
 * child process: it opens the file read-only, parses the records the pinned
 * format defines, and answers the same `{ entries, leafId }` shape a freshly
 * opened session's `get_entries` would.
 *
 * Format contract (the pinned runtime's `session-loader` / `session-manager`):
 *
 *   - The file is JSONL. Its first line may be the fixed-width title slot
 *     (`{"type":"title","v":1,...}`): not an entry, skipped exactly like the
 *     native loader folds it into the header before reading entries.
 *   - The first non-title record must be the session header
 *     (`{"type":"session","id":...}`); a file without one is refused, never
 *     rendered as an empty transcript.
 *   - Only version 2 and version 3 journals are readable here. Version 1
 *     predates entry ids — the native loader generates random ids in memory,
 *     which are not stable across reads — and version 4+ is a newer format
 *     this build cannot know; both are refused explicitly rather than guessed.
 *   - Version 2 is read with the same in-memory migration the pinned loader
 *     applies (`hookMessage` -> `custom` on message entries). Nothing is
 *     written back: the direct reader never mutates its input.
 *   - A record that is not valid JSON is refused (`OMP_HISTORY_INVALID`), not
 *     skipped. The native loader is lenient and counts such records in
 *     `malformedRecords`; discarding that signal would turn a damaged journal
 *     into an apparently complete transcript. A record that parses but is
 *     structurally broken is passed through to `projectOmpHistory`, which
 *     refuses the whole read.
 *   - A trailing fragment that is complete JSON is a record: a writer may
 *     commit the record and hold back only its terminating newline, and the
 *     pinned loader reads such a tail. A trailing fragment that is not valid
 *     JSON is an uncommitted write and refuses the whole read
 *     (`OMP_HISTORY_INVALID`) instead of being dropped or read as an empty
 *     transcript; a snapshot taken mid-write may simply be retried once the
 *     writer commits. A blank tail after the last newline is ignored.
 *   - `leafId` is the last entry's id (the native loader reconstructs the
 *     active branch from the last physical journal entry), or `null` for a
 *     header-only file. The projection validates whatever is passed through.
 *
 * Bounds: the file is streamed, never slurped whole; a file larger than
 * {@link MAX_SESSION_FILE_BYTES} bytes, or one record larger than
 * {@link MAX_SESSION_RECORD_BYTES} bytes, is refused instead of being read
 * into memory. The entry objects are retained (the projection needs the whole
 * active branch), exactly as the `get_entries` response would be.
 */
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { OMP_HISTORY_INVALID } from "./history.js";

/** The bridge-level code for a transcript that could not be read at all. */
export const OMP_HISTORY_READ_FAILED = "OMP_HISTORY_READ_FAILED";

/**
 * The bridge-level code for a native reference that does not describe the file
 * it points at (the direct reader re-checks identity after the path validator,
 * so a file swapped in between the two is still refused).
 */
export const OMP_RESTORE_FAILED = "OMP_RESTORE_FAILED";

/** Refuse a journal larger than this instead of buffering it. */
export const MAX_SESSION_FILE_BYTES = 512 * 1024 * 1024;
/** Refuse a single JSONL record larger than this instead of buffering it. */
export const MAX_SESSION_RECORD_BYTES = 64 * 1024 * 1024;

export type NativeSessionEntries = {
  /** Raw entry records, header excluded, in journal order. */
  entries: unknown[];
  /** The last entry's id (the loader's leaf), or null for an empty journal. */
  leafId: unknown;
};

function readFailure(message: string): Error {
  return Object.assign(new Error(message), { errorCode: OMP_HISTORY_READ_FAILED });
}

function invalidTranscript(message: string): Error {
  return Object.assign(new Error(message), { errorCode: OMP_HISTORY_INVALID });
}

/** True when a parsed record is the fixed-width title slot rather than an entry. */
function isTitleSlot(record: unknown): boolean {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
  const slot = record as Record<string, unknown>;
  return (
    slot.type === "title" &&
    slot.v === 1 &&
    typeof slot.title === "string" &&
    typeof slot.updatedAt === "string" &&
    typeof slot.pad === "string"
  );
}

/** The session header's version, or null when it is present but malformed. */
function sessionVersion(header: Record<string, unknown>): number | null {
  if (header.version === undefined) return 1;
  return typeof header.version === "number" && Number.isInteger(header.version) ? header.version : null;
}

/**
 * Apply the pinned loader's v2 -> v3 in-memory migration to one entry.
 *
 * Only the message role rename is involved, and only in memory: the direct
 * reader must never write the file it reads.
 */
function migrateEntry(entry: unknown, version: number): void {
  if (version >= 3) return;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return;
  const candidate = entry as { type?: unknown; message?: unknown };
  if (candidate.type !== "message") return;
  const message = candidate.message;
  if (typeof message !== "object" || message === null) return;
  const record = message as Record<string, unknown>;
  if (record.role === "hookMessage") record.role = "custom";
}

/** Never throws: the last entry's raw `id` field, whatever its shape. */
function rawLeafId(entries: readonly unknown[]): unknown {
  const last = entries[entries.length - 1];
  if (typeof last !== "object" || last === null) return undefined;
  return (last as { id?: unknown }).id;
}

/**
 * Read a journal from disk. Resolves with the raw entries and the loader's
 * leaf; every content or I/O refusal throws instead of answering.
 */
export async function readNativeSessionEntries(
  filePath: string,
  expectedSessionId: string,
  options: { maxBytes?: number; maxRecordBytes?: number } = {},
): Promise<NativeSessionEntries> {
  const maxBytes = options.maxBytes ?? MAX_SESSION_FILE_BYTES;
  const maxRecordBytes = options.maxRecordBytes ?? MAX_SESSION_RECORD_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(maxRecordBytes) || maxRecordBytes <= 0) {
    throw readFailure("the native session read bound is invalid");
  }

  const entries: unknown[] = [];
  let header: Record<string, unknown> | null = null;
  let version = 0;
  let sawFirstRecord = false;
  /** Pieces of the line currently being received (the last line has no end yet). */
  let lineParts: string[] = [];
  let lineBytes = 0;
  let totalBytes = 0;
  const decoder = new StringDecoder("utf8");

  const consumeLine = (line: string, unterminated = false): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: unknown;
    try {
      record = JSON.parse(trimmed) as unknown;
    } catch {
      // Unlike the lenient native loader (which counts these in
      // `malformedRecords`), the desktop read refuses the snapshot: a skipped
      // record would present a damaged journal as a complete transcript.
      throw invalidTranscript(
        unterminated
          ? "the native session file ends with an unterminated record that is not valid JSON; the read was refused so a partial snapshot is never shown as the transcript"
          : "the native session file contains a record that is not valid JSON; the transcript cannot be read",
      );
    }
    if (!sawFirstRecord) {
      sawFirstRecord = true;
      if (isTitleSlot(record)) return;
    }
    if (header === null) {
      if (typeof record !== "object" || record === null || Array.isArray(record)) {
        throw invalidTranscript("the native session file has no readable session header");
      }
      const candidate = record as Record<string, unknown>;
      if (candidate.type !== "session" || typeof candidate.id !== "string" || candidate.id.length === 0) {
        throw invalidTranscript("the native session file has no readable session header");
      }
      const parsedVersion = sessionVersion(candidate);
      if (parsedVersion === null) {
        throw invalidTranscript("the native session file carries a malformed version");
      }
      if (parsedVersion < 2 || parsedVersion > 3) {
        throw invalidTranscript(
          `the native session file is version ${parsedVersion}; this build can only read versions 2 and 3 without rewriting it`,
        );
      }
      if (candidate.id !== expectedSessionId) {
        throw Object.assign(
          new Error("the native session file belongs to a different session than the persisted reference"),
          { errorCode: OMP_RESTORE_FAILED },
        );
      }
      header = candidate;
      version = parsedVersion;
      return;
    }
    entries.push(record);
  };

  /** Feed decoded text; complete lines are consumed, the tail stays pending. */
  const consumeText = (text: string): void => {
    let rest = text;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline === -1) {
        if (rest) {
          lineParts.push(rest);
          lineBytes += Buffer.byteLength(rest, "utf8");
          if (lineBytes > maxRecordBytes) {
            throw readFailure(
              `the native session file contains a record larger than ${maxRecordBytes} bytes`,
            );
          }
        }
        break;
      }
      const head = rest.slice(0, newline);
      const headBytes = Buffer.byteLength(head, "utf8");
      if (lineBytes + headBytes > maxRecordBytes) {
        throw readFailure(
          `the native session file contains a record larger than ${maxRecordBytes} bytes`,
        );
      }
      const line = lineParts.length > 0 ? lineParts.join("") + head : head;
      lineParts = [];
      lineBytes = 0;
      consumeLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      rest = rest.slice(newline + 1);
    }
  };

  try {
    const stream = createReadStream(filePath);
    try {
      for await (const chunk of stream) {
        totalBytes += (chunk as Buffer).byteLength;
        if (totalBytes > maxBytes) {
          throw readFailure(
            `the native session file is larger than the ${maxBytes}-byte read bound`,
          );
        }
        consumeText(decoder.write(chunk as Buffer));
      }
      consumeText(decoder.end());
      // A trailing fragment that is complete JSON is a committed record even
      // when the writer has not appended its newline yet (the pinned loader
      // reads exactly that). Anything else is an uncommitted write and refuses
      // the read instead of dropping the last record or answering an empty
      // page; the caller may retry once the writer commits it.
      if (lineParts.length > 0) {
        const tail = lineParts.join("");
        lineParts = [];
        lineBytes = 0;
        consumeLine(tail, true);
      }
    } finally {
      stream.destroy();
    }
  } catch (error) {
    if (error instanceof Error && "errorCode" in error) throw error;
    throw readFailure(
      `the native session file could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (header === null) {
    throw invalidTranscript("the native session file has no readable session header");
  }
  for (const entry of entries) migrateEntry(entry, version);
  return { entries, leafId: entries.length > 0 ? rawLeafId(entries) : null };
}
