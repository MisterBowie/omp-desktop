/**
 * NDJSON reader for a byte stream carrying OMP RPC frames.
 *
 * Specifies the behaviour M2/T09's desktop-side reader must guarantee, and is
 * the reference used by the M1 transport experiment:
 *
 *   - UTF-8 sequences split across chunk boundaries decode correctly
 *     (incremental StringDecoder, never per-chunk Buffer.toString).
 *   - A frame split across several chunks yields exactly one frame.
 *   - Several frames inside one chunk yield them in order.
 *   - CRLF and LF are both accepted; a trailing CR is not part of the JSON.
 *   - Invalid JSON is reported as a protocol error and the stream continues.
 *   - A line longer than `maxLineBytes` characters (UTF-16 code units, measured
 *     after UTF-8 decoding) is reported as an explicit `line-too-large` error
 *     and the reader resynchronises on the next LF instead of growing the
 *     buffer without bound.
 *   - Empty lines are ignored (no frame, no error).
 */
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export class NdjsonReader {
  #pending = "";
  #discarding = false;
  #decoder = new StringDecoder("utf8");

  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
  }

  /**
   * Feed one raw chunk.
   * @param {Buffer|string} chunk
   * @returns {{frames: object[], errors: {kind: string, sample?: string, bytes?: number}[]}}
   */
  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? this.#decoder.write(chunk) : chunk;
    const frames = [];
    const errors = [];
    let cursor = 0;

    while (cursor < text.length) {
      const lf = text.indexOf("\n", cursor);
      const isLast = lf === -1;
      const piece = isLast ? text.slice(cursor) : text.slice(cursor, lf);
      cursor = isLast ? text.length : lf + 1;

      if (this.#discarding) {
        // Resynchronise: drop everything up to and including the newline.
        if (!isLast) this.#discarding = false;
        continue;
      }

      this.#pending += piece;
      if (this.#pending.length > this.maxLineBytes) {
        errors.push({ kind: "line-too-large", bytes: this.#pending.length });
        this.#pending = "";
        this.#discarding = !isLast ? false : true;
        continue;
      }
      if (isLast) continue;

      const line = this.#pending.endsWith("\r") ? this.#pending.slice(0, -1) : this.#pending;
      this.#pending = "";
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
  end() {
    const rest = this.#decoder.end() + this.#pending;
    this.#pending = "";
    if (rest.trim() === "") return { frames: [], errors: [] };
    try {
      return { frames: [JSON.parse(rest.trim())], errors: [] };
    } catch {
      return { frames: [], errors: [{ kind: "invalid-json", sample: rest.slice(0, 200) }] };
    }
  }
}
