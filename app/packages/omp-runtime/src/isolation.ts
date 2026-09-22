/**
 * Environment and directory isolation for a child OMP runtime.
 *
 * The runtime discovers configuration, credentials, sessions, rules and MCP
 * servers from the environment and the home directory. Running it with the
 * desktop's own environment would let it read — and write — the user's real
 * `~/.omp`, `~/.agents` and provider keys, which this product must never touch
 * (it is a separate application with its own data root).
 *
 * What isolation is, stated exactly: the child gets a synthetic HOME inside the
 * desktop's run directory, every variable that could steer discovery elsewhere
 * is deleted, and credentials are stripped rather than forwarded. This is a
 * process-environment policy, not an OS-level sandbox: a child that ignores the
 * environment could still reach the real home. The measured evidence for the
 * variables that matter is M1/E07 and the fifth-review proxy finding.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/**
 * Variables that would point discovery at a profile other than this run's
 * config root (M0 baseline plus the redirections M1/E07 measured).
 */
export const STEER_VARS = [
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_SESSION_DIR",
  "CLAUDE_CONFIG_DIR",
  "COPILOT_HOME",
  "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
  "GH_CONFIG_DIR",
  "MISE_DATA_DIR",
  "OMP_AUTORESEARCH_DB_DIR",
  "OMP_WORKTREE_DIR",
  "PI_CONFIG_FILES",
  "PI_PACKAGE_DIR",
  // The desktop's own variables: a child runtime must not be able to read the
  // host application's data root or agent directory back out of its environment.
  "PI_DESKTOP_DATA_DIR",
  "PI_DESKTOP_DEV",
  "PI_DESKTOP_AGENTS_DIR",
] as const;

/**
 * Credential-shaped variables that must never reach the child.
 *
 * The runtime is launched with the desktop's own configuration; forwarding the
 * operator's provider keys would both leak them into a process whose logs we do
 * not fully control and let the runtime bypass the desktop's credential model.
 */
export const CREDENTIAL_VAR_PATTERN =
  /(API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL|_AUTH|AWS_ACCESS|AWS_SECRET|AWS_SESSION|BEDROCK_|GEMINI_|GOOGLE_|OPENAI_|ANTHROPIC_|AZURE_|COHERE_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_|COPILOT_|CODEX_)/i;

/**
 * Proxy variables, both cases plus the Node switch.
 *
 * Copied from the pinned desktop's `PROXY_ENV_KEYS` (`network-proxy.ts`), which
 * is the list the original product strips before launching a child with its own
 * proxy policy. Overriding only the uppercase names is not enough: a client that
 * reads the lowercase ones still uses the inherited proxy (measured — an
 * inherited lowercase proxy carried a real HTTP request and a CONNECT).
 */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
] as const;

/** Home-relative directories the runtime discovers; created empty in our HOME. */
export const HOME_DISCOVERY_DIRS = [".agent", ".agents", ".omp", ".claude", ".config"] as const;

/** A run-unique config root name, never the user's own. */
export function makeRuntimeConfigDirName(): string {
  return `.omp-runtime-${randomBytes(4).toString("hex")}`;
}

export type OmpRuntimeEnvOptions = {
  /** Synthetic home for the child (inside this run's owned directory). */
  home: string;
  /** Home-relative config root name; defaults to a fresh unique one. */
  configDirName?: string;
  /** Coding-agent state directory (absolute, inside the run root). */
  codingAgentDir: string;
  /** Working directory the launcher itself starts from. */
  launchDir: string;
  /** PATH entries to publish; the launcher needs its runtime (`bun`) on PATH. */
  pathEntries?: readonly string[];
  /** Base environment; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Explicit proxy policy. Omitted means "no proxy variables at all". */
  proxy?: { url: string; bypass: string };
  /**
   * Extra variables for this child (build settings, test seams).
   *
   * Applied last, but the keys this function owns always win: a caller cannot
   * use this to point the child at a different HOME, config root or proxy, and
   * credential-shaped names are dropped rather than forwarded.
   */
  extraEnv?: NodeJS.ProcessEnv;
};

export type OmpRuntimeEnv = {
  env: NodeJS.ProcessEnv;
  configDirName: string;
  configRoot: string;
  home: string;
};

/** Default PATH: the launcher's own runtime first, then the system. */
export function defaultPathEntries(home: string = homedir()): string[] {
  return [
    join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
}

/**
 * Build the child environment.
 *
 * The result is a copy of nothing: only variables that are safe and useful are
 * carried over (PATH, locale, terminal, temp dir), then this run's own roots are
 * applied. Everything else is dropped rather than filtered, so a newly
 * discovered credential variable is excluded by default.
 */
export function buildOmpRuntimeEnv(options: OmpRuntimeEnvOptions): OmpRuntimeEnv {
  const base = options.baseEnv ?? process.env;
  const configDirName = options.configDirName ?? makeRuntimeConfigDirName();
  const env: NodeJS.ProcessEnv = {};

  const keep = ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "TMPDIR", "TEMP", "TMP", "USER", "SHELL"];
  for (const key of keep) {
    const value = base[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  env.HOME = options.home;
  env.PATH = (options.pathEntries ?? defaultPathEntries()).join(":");
  env.PI_CONFIG_DIR = configDirName;
  env.PI_CODING_AGENT_DIR = options.codingAgentDir;
  env.OMP_DEV_LAUNCH_DIR = options.launchDir;

  // Strip every proxy variable first, then apply this process's own policy —
  // a merged value would otherwise survive as an inherited proxy.
  for (const key of PROXY_ENV_KEYS) delete env[key];
  if (options.proxy) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const) {
      env[key] = options.proxy.url;
    }
    for (const key of ["NO_PROXY", "no_proxy"] as const) env[key] = options.proxy.bypass;
  }

  if (options.extraEnv) {
    const reserved = new Set<string>([
      ...PROXY_ENV_KEYS,
      ...STEER_VARS,
      "HOME",
      "PATH",
      "PI_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
      "OMP_DEV_LAUNCH_DIR",
    ]);
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (value === undefined) continue;
      if (reserved.has(key)) continue;
      if (CREDENTIAL_VAR_PATTERN.test(key)) continue;
      env[key] = value;
    }
  }

  return { env, configDirName, configRoot: join(options.home, configDirName), home: options.home };
}

/** Create the synthetic home and the discovery directories the runtime walks. */
export function prepareOmpRuntimeHome(home: string): void {
  mkdirSync(home, { recursive: true });
  for (const dir of HOME_DISCOVERY_DIRS) mkdirSync(join(home, dir), { recursive: true });
}

/** True when `child` is `parent` or below it, after resolving both. */
export function isPathInside(child: string, parent: string): boolean {
  const absChild = resolve(child);
  const absParent = resolve(parent);
  if (absChild === absParent) return true;
  return absChild.startsWith(absParent.endsWith(sep) ? absParent : absParent + sep);
}

/**
 * Remove a directory this run created, and refuse to touch anything else.
 *
 * Ownership is enforced structurally: the path must be a direct child of the
 * run root and must carry the run's own name prefix. A caller that passes a
 * user directory gets `false`, never a delete.
 */
export function removeOwnedRunRoot(candidate: string, runRoot: string, label: string): boolean {
  if (!candidate || !runRoot) return false;
  const absCandidate = resolve(candidate);
  const absRunRoot = resolve(runRoot);
  if (absCandidate === absRunRoot) return false;
  if (!isPathInside(absCandidate, absRunRoot)) return false;
  if (!basename(absCandidate).startsWith(`${label}-`)) return false;
  rmSync(absCandidate, { recursive: true, force: true });
  return true;
}
