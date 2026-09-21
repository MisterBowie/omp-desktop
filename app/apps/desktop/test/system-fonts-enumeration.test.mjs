import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../electron/main/system-fonts.ts", import.meta.url),
  "utf8",
);

test("macOS enumeration uses the fast CoreText query via osascript", () => {
  assert.match(source, /CTFontManagerCopyAvailableFontFamilyNames/);
  assert.match(source, /osascript/);
  assert.match(source, /"-l", "JavaScript"/);
});

test("system_profiler remains only as the macOS fallback", () => {
  assert.match(source, /system_profiler/);
  assert.match(source, /SPFontsDataType/);
  assert.match(source, /Fall through to the system_profiler fallback/);
});

test("shared post-processing still filters hidden and empty families", () => {
  assert.match(source, /!family\.startsWith\("\."\)/);
  assert.match(source, /family\.length > 0/);
  assert.match(source, /\.sort\(\(a, b\) => a\.localeCompare\(b\)\)/);
});
