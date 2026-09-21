import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

const ENTRY = new URL("../../src/styles/globals.css", import.meta.url);
const IMPORT_RE = /^@import "\.\/([A-Za-z0-9-]+\.css)";$/gm;

/**
 * The renderer stylesheet is split into partials under src/styles, sequenced by
 * globals.css. Style assertions care about the whole cascade, so inline every
 * local @import in declaration order and return the effective stylesheet.
 *
 * Import order is the cascade, so this must preserve it: a test that checks
 * which of two competing rules comes last depends on it.
 */
export async function loadStyles() {
  const entry = await readFile(ENTRY, "utf8");
  const names = [...entry.matchAll(IMPORT_RE)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error("globals.css declared no local @import — check the split");
  }
  const parts = new Map(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(new URL(`../../src/styles/${name}`, import.meta.url), "utf8"),
      ]),
    ),
  );
  return entry.replace(IMPORT_RE, (_line, name) => parts.get(name));
}

/** Synchronous {@link loadStyles}, for tests that read inside a test body. */
export function loadStylesSync() {
  const entry = readFileSync(ENTRY, "utf8");
  return entry.replace(IMPORT_RE, (_line, name) =>
    readFileSync(new URL(`../../src/styles/${name}`, import.meta.url), "utf8"),
  );
}
