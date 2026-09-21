import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const tokens = await readFile(
  new URL("../src/styles/tokens.css", import.meta.url),
  "utf8",
);
const uiKit = await readFile(
  new URL("../src/styles/ui-kit.css", import.meta.url),
  "utf8",
);

test("fixed radii follow the Apple-inspired desktop ladder", () => {
  const expected = [
    ["3xs", 4],
    ["2xs", 6],
    ["xs", 8],
    ["sm", 10],
    ["md", 12],
    ["md-plus", 14],
    ["lg", 16],
    ["lg-plus", 18],
    ["xl", 20],
    ["2xl", 24],
  ];

  for (const [name, value] of expected) {
    assert.match(tokens, new RegExp(`--radius-${name}:\\s*${value}px;`));
  }

  assert.match(tokens, /--radius-full:\s*9999px;/);
  assert.match(tokens, /--radius-round:\s*50%;/);
  assert.match(tokens, /--ds-composer-radius:\s*var\(--radius-xl\);/);
  assert.match(tokens, /--ds-composer-radius-lg:\s*var\(--radius-xl\);/);
});

test("shared compact controls are rounded rectangles while badges stay pills", () => {
  assert.match(
    uiKit,
    /\.field-input,[\s\S]*?\.field-textarea\s*\{[\s\S]*?border-radius:\s*var\(--radius-sm\);/,
  );
  assert.match(uiKit, /\.btn\s*\{[\s\S]*?border-radius:\s*var\(--radius-sm\);/);
  assert.match(uiKit, /\.badge\s*\{[\s\S]*?border-radius:\s*var\(--radius-full\);/);
});
