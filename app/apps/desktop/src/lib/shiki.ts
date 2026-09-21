import type {
  GrammarState,
  HighlighterCore,
  LanguageInput,
  ThemedToken,
} from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/*
 * Singleton Shiki highlighter for chat code blocks.
 *
 * - JavaScript regex engine: no wasm asset, synchronous tokenization once
 *   languages are loaded.
 * - Languages load lazily on first sight of a fence tag; callers render a
 *   plain-text fallback until `subscribeHighlighter` notifies readiness.
 * - `tokenizeIncremental` keeps a per-line token cache chained through
 *   GrammarState so a streaming code block only re-tokenizes the lines that
 *   changed (normally just the tail line) — per-frame cost stays constant
 *   regardless of block size.
 */

export const THEMES = { light: "one-light", dark: "one-dark-pro" } as const;
export type ThemeMode = keyof typeof THEMES;
type Theme = (typeof THEMES)[ThemeMode];

export function themeForMode(mode: ThemeMode): Theme {
  return THEMES[mode];
}

type LanguageDefinition = {
  aliases?: readonly string[];
  load: () => LanguageInput;
};

// Explicit imports keep Vite from emitting Shiki's entire grammar catalog.
const LANGUAGE_DEFINITIONS = {
  astro: { load: () => import("shiki/langs/astro.mjs") },
  bat: { aliases: ["batch"], load: () => import("shiki/langs/bat.mjs") },
  c: { load: () => import("shiki/langs/c.mjs") },
  cpp: { aliases: ["c++"], load: () => import("shiki/langs/cpp.mjs") },
  csharp: {
    aliases: ["c#", "cs"],
    load: () => import("shiki/langs/csharp.mjs"),
  },
  css: { load: () => import("shiki/langs/css.mjs") },
  dart: { load: () => import("shiki/langs/dart.mjs") },
  diff: { load: () => import("shiki/langs/diff.mjs") },
  docker: {
    aliases: ["dockerfile"],
    load: () => import("shiki/langs/docker.mjs"),
  },
  dotenv: { load: () => import("shiki/langs/dotenv.mjs") },
  go: { load: () => import("shiki/langs/go.mjs") },
  graphql: {
    aliases: ["gql"],
    load: () => import("shiki/langs/graphql.mjs"),
  },
  groovy: { load: () => import("shiki/langs/groovy.mjs") },
  hcl: { load: () => import("shiki/langs/hcl.mjs") },
  html: { load: () => import("shiki/langs/html.mjs") },
  ini: { aliases: ["properties"], load: () => import("shiki/langs/ini.mjs") },
  java: { load: () => import("shiki/langs/java.mjs") },
  javascript: {
    aliases: ["js", "cjs", "mjs"],
    load: () => import("shiki/langs/javascript.mjs"),
  },
  json: { load: () => import("shiki/langs/json.mjs") },
  jsonc: { load: () => import("shiki/langs/jsonc.mjs") },
  jsonl: { load: () => import("shiki/langs/jsonl.mjs") },
  jsx: { load: () => import("shiki/langs/jsx.mjs") },
  kotlin: {
    aliases: ["kt", "kts"],
    load: () => import("shiki/langs/kotlin.mjs"),
  },
  lua: { load: () => import("shiki/langs/lua.mjs") },
  make: {
    aliases: ["makefile"],
    load: () => import("shiki/langs/make.mjs"),
  },
  markdown: {
    aliases: ["md"],
    load: () => import("shiki/langs/markdown.mjs"),
  },
  mdx: { load: () => import("shiki/langs/mdx.mjs") },
  mermaid: {
    aliases: ["mmd"],
    load: () => import("shiki/langs/mermaid.mjs"),
  },
  nginx: { load: () => import("shiki/langs/nginx.mjs") },
  php: { load: () => import("shiki/langs/php.mjs") },
  powershell: {
    aliases: ["ps", "ps1"],
    load: () => import("shiki/langs/powershell.mjs"),
  },
  prisma: { load: () => import("shiki/langs/prisma.mjs") },
  proto: {
    aliases: ["protobuf"],
    load: () => import("shiki/langs/proto.mjs"),
  },
  python: { aliases: ["py"], load: () => import("shiki/langs/python.mjs") },
  ruby: { aliases: ["rb"], load: () => import("shiki/langs/ruby.mjs") },
  rust: { aliases: ["rs"], load: () => import("shiki/langs/rust.mjs") },
  scala: { load: () => import("shiki/langs/scala.mjs") },
  shellscript: {
    aliases: ["bash", "sh", "shell", "zsh"],
    load: () => import("shiki/langs/shellscript.mjs"),
  },
  sql: { load: () => import("shiki/langs/sql.mjs") },
  svelte: { load: () => import("shiki/langs/svelte.mjs") },
  swift: { load: () => import("shiki/langs/swift.mjs") },
  terraform: {
    aliases: ["tf", "tfvars"],
    load: () => import("shiki/langs/terraform.mjs"),
  },
  toml: { load: () => import("shiki/langs/toml.mjs") },
  tsx: { load: () => import("shiki/langs/tsx.mjs") },
  typescript: {
    aliases: ["ts", "cts", "mts"],
    load: () => import("shiki/langs/typescript.mjs"),
  },
  vue: { load: () => import("shiki/langs/vue.mjs") },
  xml: { load: () => import("shiki/langs/xml.mjs") },
  yaml: { aliases: ["yml"], load: () => import("shiki/langs/yaml.mjs") },
} as const satisfies Record<string, LanguageDefinition>;

type SupportedLanguage = keyof typeof LANGUAGE_DEFINITIONS;

export const SUPPORTED_LANGUAGES = Object.freeze(
  Object.keys(LANGUAGE_DEFINITIONS) as SupportedLanguage[],
);

const languageIds = new Map<string, SupportedLanguage>();
for (const id of SUPPORTED_LANGUAGES) {
  const definition: LanguageDefinition = LANGUAGE_DEFINITIONS[id];
  languageIds.set(id, id);
  for (const alias of definition.aliases ?? []) {
    languageIds.set(alias, id);
  }
}

let highlighter: HighlighterCore | null = null;
let creating: Promise<HighlighterCore> | null = null;
let version = 0;

const readyLangs = new Set<string>();
const pendingLangs = new Set<string>();
const failedLangs = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeHighlighter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Monotonic readiness counter — snapshot for useSyncExternalStore. */
export function getHighlightVersion(): number {
  return version;
}

const PLAIN_LANGS = new Set(["", "text", "txt", "plain", "plaintext", "ansi"]);

/** Normalize a fence tag to a loadable Shiki language id, or null for plain. */
export function resolveLang(lang: string): SupportedLanguage | null {
  const id = lang.trim().toLowerCase();
  if (PLAIN_LANGS.has(id)) return null;
  return languageIds.get(id) ?? null;
}

function getHighlighterInstance(): Promise<HighlighterCore> {
  creating ??= createHighlighterCore({
    themes: [
      import("shiki/themes/one-light.mjs"),
      import("shiki/themes/one-dark-pro.mjs"),
    ],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((instance) => {
    highlighter = instance;
    return instance;
  });
  return creating;
}

/** Kick off lazy loading for a language; safe to call every render. */
export function ensureLang(lang: string): void {
  const resolved = resolveLang(lang);
  if (
    !resolved ||
    readyLangs.has(resolved) ||
    pendingLangs.has(resolved) ||
    failedLangs.has(resolved)
  ) {
    return;
  }
  pendingLangs.add(resolved);
  void getHighlighterInstance()
    .then((instance) =>
      instance.loadLanguage(LANGUAGE_DEFINITIONS[resolved].load()),
    )
    .then(() => {
      readyLangs.add(resolved);
    })
    .catch(() => {
      // Grammar failed to load/compile — settle on the plain-text fallback.
      failedLangs.add(resolved);
    })
    .finally(() => {
      pendingLangs.delete(resolved);
      notify();
    });
}

export type LineCache = {
  lang: string;
  theme: string;
  /** Source lines already tokenized. */
  lines: string[];
  /** Tokens per line; rows are reused by reference for unchanged lines. */
  tokens: ThemedToken[][];
  /** Grammar state at the end of each line, chaining line i into i+1. */
  states: (GrammarState | undefined)[];
};

/**
 * Incrementally tokenize `code`, reusing every line before the first
 * divergence from `prev`. Returns null while the language is not ready
 * (caller renders plain text). Returns `prev` unchanged when the code is
 * identical, so referential equality can skip re-renders.
 */
export function tokenizeIncremental(
  prev: LineCache | null,
  code: string,
  lang: string,
  theme: string,
): LineCache | null {
  if (!highlighter || !readyLangs.has(lang)) return null;

  const lines = code.split("\n");
  const cache =
    prev && prev.lang === lang && prev.theme === theme ? prev : null;
  const reusable = cache
    ? Math.min(cache.lines.length, lines.length)
    : 0;

  let start = 0;
  while (start < reusable && cache!.lines[start] === lines[start]) start += 1;

  if (cache && start === lines.length && cache.lines.length === lines.length) {
    return cache;
  }

  const outLines = cache ? cache.lines.slice(0, start) : [];
  const outTokens = cache ? cache.tokens.slice(0, start) : [];
  const outStates = cache ? cache.states.slice(0, start) : [];

  for (let i = start; i < lines.length; i += 1) {
    const grammarState = i > 0 ? outStates[i - 1] : undefined;
    const rows = highlighter.codeToTokensBase(lines[i], {
      lang,
      theme,
      grammarState,
      includeExplanation: false,
    });
    outLines.push(lines[i]);
    outTokens.push(rows[0] ?? []);
    outStates.push(highlighter.getLastGrammarState(rows));
  }

  return { lang, theme, lines: outLines, tokens: outTokens, states: outStates };
}
