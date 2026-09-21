import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const globalStyles = await loadStyles();

test("settings content follows the available window width", () => {
  assert.match(
    globalStyles,
    /\.settings-content\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1;/s,
  );
  assert.match(
    globalStyles,
    /\.settings-content-inner\s*\{[^}]*width:\s*100%;/s,
  );
  assert.doesNotMatch(
    globalStyles,
    /\.settings-content-inner\s*\{[^}]*width:\s*min\(\s*100%\s*,\s*720px\s*\);/s,
  );
});
