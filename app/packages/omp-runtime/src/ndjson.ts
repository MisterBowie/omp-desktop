/**
 * NDJSON reader for a byte stream carrying OMP RPC frames.
 *
 * The desktop cannot use `readline` here: it has no line-length limit, and a
 * runtime that writes a half-open 100 MB line would grow the buffer until the
 * process dies. This reader enforces an explicit cap and resynchronises on the
 * next LF instead of accumulating.
 *
 * Guarantees (each one is a case the transport experiment measured):
 *   - UTF-8 sequences split across chunk boundaries decode correctly
 *     (incremental `StringDecoder`, never per-chunk `Buffer.toString`).
 *   - A frame split across several chunks yields exactly one frame.
 *   - Several frames inside one chunk yield them in order.
 *   - CRLF and LF are both accepted; a trailing CR is not part of the JSON.
 *   - Invalid JSON is reported and the stream continues.
 *   - A line longer than `maxLineBytes` (UTF-16 code units after UTF-8
 *     decoding) is reported as `line-too-large` and discarded to the next LF.
 *   - Empty lines are ignored.
 */
import { StringDecoder } from "node:string_decoder";

/**
 * Cap on one decoded line. The runtime's own frames are limited to 1 MiB by the
 * protocol and chunked above that, so 4 MiB leaves room for a runtime that
 * answers with a single oversized line without letting the buffer grow without
 * bound.
 */
export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export type NdjsonError =
  | { kind: "line-too-large"; bytes: number }
  | { kind: "invalid-json"; sample: string };

export type NdjsonBatch = {
  frames: unknown[];
  errors: NdjsonError[];
};

export class NdjsonReader {
  private pending = "";
  private discarding = false;
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLineBytes: number;

  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
  }

  /** Feed one raw chunk; returns the complete lines and the parse failures. */
  push(chunk: Buffer | string): NdjsonBatch {
    const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : chunk;
    const frames: unknown[] = [];
    const errors: NdjsonError[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const lf = text.indexOf("\n", cursor);
      const isLast = lf === -1;
      const piece = isLast ? text.slice(cursor) : text.slice(cursor, lf);
      cursor = isLast ? text.length : lf + 1;

      if (this.discarding) {
        // Resynchronise: drop everything up to and including the newline.
        if (!isLast) this.discarding = false;
        continue;
      }

      this.pending += piece;
      if (this.pending.length > this.maxLineBytes) {
        errors.push({ kind: "line-too-large", bytes: this.pending.length });
        this.pending = "";
        this.discarding = isLast;
        continue;
      }
      if (isLast) continue;

      const line = this.pending.endsWith("\r")
        ? this.pending.slice(0, -1)
        : this.pending;
      this.pending = "";
      if (line.trim() === "") continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        errors.push({ kind: "invalid-json", sample: line.slice(0, 200) });
      }
    }

    return { frames, errors };
  }

  /** Flush a trailing partial line at stream end (no newline). */
  end(): NdjsonBatch {
    const rest = this.decoder.end() + this.pending;
    this.pending = "";
    if (rest.trim() === "") return { frames: [], errors: [] };
    try {
      return { frames: [JSON.parse(rest.trim())], errors: [] };
    } catch {
      return { frames: [], errors: [{ kind: "invalid-json", sample: rest.slice(0, 200) }] };
    }
  }
}
