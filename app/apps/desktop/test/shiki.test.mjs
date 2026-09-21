import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  SUPPORTED_LANGUAGES,
  themeForMode,
  tokenizeIncremental,
} from "../src/lib/shiki.ts";

const EXPECTED_LANGUAGES = [
  "astro",
  "bat",
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "diff",
  "docker",
  "dotenv",
  "go",
  "graphql",
  "groovy",
  "hcl",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "jsonc",
  "jsonl",
  "jsx",
  "kotlin",
  "lua",
  "make",
  "markdown",
  "mdx",
  "mermaid",
  "nginx",
  "php",
  "powershell",
  "prisma",
  "proto",
  "python",
  "ruby",
  "rust",
  "scala",
  "shellscript",
  "sql",
  "svelte",
  "swift",
  "terraform",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
];

const EXPECTED_ALIASES = {
  batch: "bat",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "docker",
  gql: "graphql",
  properties: "ini",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  makefile: "make",
  md: "markdown",
  mmd: "mermaid",
  ps: "powershell",
  ps1: "powershell",
  protobuf: "proto",
  py: "python",
  rb: "ruby",
  rs: "rust",
  bash: "shellscript",
  sh: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  tf: "terraform",
  tfvars: "terraform",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  yml: "yaml",
};

function waitForHighlightChange(version) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Shiki language loading"));
    }, 10_000);
    const unsubscribe = subscribeHighlighter(() => {
      if (getHighlightVersion() <= version) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

async function loadAndTokenize(lang) {
  const before = getHighlightVersion();
  const changed = waitForHighlightChange(before);
  ensureLang(lang);
  await changed;
  return tokenizeIncremental(null, "value", lang, themeForMode("dark"));
}

test("language support is an explicit coding-focused bundle", () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, EXPECTED_LANGUAGES);
  for (const [alias, canonical] of Object.entries(EXPECTED_ALIASES)) {
    assert.equal(resolveLang(` ${alias.toUpperCase()} `), canonical);
  }
  assert.equal(resolveLang("text"), null);
  assert.equal(resolveLang("an-unbundled-language"), null);
});

test(
  "every supported grammar lazy-loads and tokenizes",
  { timeout: 60_000 },
  async () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const cache = await loadAndTokenize(lang);
      assert.ok(cache, `${lang} should load and tokenize`);
      assert.equal(cache.lang, lang);
      assert.equal(cache.tokens.length, 1);

      if (lang === "typescript") {
        const extended = tokenizeIncremental(
          cache,
          "value\nnext",
          lang,
          themeForMode("dark"),
        );
        assert.ok(extended);
        assert.equal(extended.tokens[0], cache.tokens[0]);
        assert.equal(
          tokenizeIncremental(
            extended,
            "value\nnext",
            lang,
            themeForMode("dark"),
          ),
          extended,
        );
      }
    }
  },
);
