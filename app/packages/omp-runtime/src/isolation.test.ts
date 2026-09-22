import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOmpRuntimeEnv,
  CREDENTIAL_VAR_PATTERN,
  HOME_DISCOVERY_DIRS,
  PROXY_ENV_KEYS,
  STEER_VARS,
  isPathInside,
  makeRuntimeConfigDirName,
  prepareOmpRuntimeHome,
  removeOwnedRunRoot,
} from "./isolation.js";

const created: string[] = [];

function scratch(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `omp-iso-${label}-`));
  created.push(root);
  return root;
}

afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime environment isolation", () => {
  it("points HOME, the config root and the agent directory inside this run", () => {
    const root = scratch("env");
    const { env, configRoot, configDirName } = buildOmpRuntimeEnv({
      home: join(root, "home"),
      codingAgentDir: join(root, "agent"),
      launchDir: join(root, "cwd"),
      baseEnv: {},
    });
    expect(env.HOME).toBe(join(root, "home"));
    expect(env.PI_CONFIG_DIR).toBe(configDirName);
    expect(configRoot).toBe(join(root, "home", configDirName));
    expect(env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
    expect(env.OMP_DEV_LAUNCH_DIR).toBe(join(root, "cwd"));
  });

  it("drops credentials, discovery redirections and desktop variables", () => {
    const root = scratch("strip");
    const { env } = buildOmpRuntimeEnv({
      home: join(root, "home"),
      codingAgentDir: join(root, "agent"),
      launchDir: join(root, "cwd"),
      baseEnv: {
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_AUTH_TOKEN: "token",
        AWS_SECRET_ACCESS_KEY: "aws",
        GOOGLE_APPLICATION_CREDENTIALS: "/home/user/creds.json",
        XDG_CONFIG_HOME: "/home/user/.config",
        OMP_PROFILE: "work",
        CLAUDE_CONFIG_DIR: "/home/user/.claude",
        PI_DESKTOP_DATA_DIR: "/home/user/.pi-desktop",
        PI_DESKTOP_AGENTS_DIR: "/home/user/.agents",
        LANG: "en_US.UTF-8",
        TMPDIR: "/tmp",
      },
    });
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "XDG_CONFIG_HOME",
      "OMP_PROFILE",
      "CLAUDE_CONFIG_DIR",
      "PI_DESKTOP_DATA_DIR",
      "PI_DESKTOP_AGENTS_DIR",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
    // Useful, non-steering variables survive.
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TMPDIR).toBe("/tmp");
  });

  it("keeps the environment free of credentials it was never given", () => {
    const root = scratch("defaults");
    const { env } = buildOmpRuntimeEnv({
      home: join(root, "home"),
      codingAgentDir: join(root, "agent"),
      launchDir: join(root, "cwd"),
      baseEnv: process.env,
    });
    const leaked = Object.keys(env).filter(
      (key) => CREDENTIAL_VAR_PATTERN.test(key) && env[key] !== undefined,
    );
    expect(leaked).toEqual([]);
  });

  it("strips both proxy cases and only then applies its own policy", () => {
    const root = scratch("proxy");
    const { env } = buildOmpRuntimeEnv({
      home: join(root, "home"),
      codingAgentDir: join(root, "agent"),
      launchDir: join(root, "cwd"),
      baseEnv: {
        HTTP_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        all_proxy: "http://127.0.0.1:9",
        no_proxy: "*",
        NODE_USE_ENV_PROXY: "1",
      },
    });
    for (const key of PROXY_ENV_KEYS) {
      expect(env[key], key).toBeUndefined();
    }
    const withPolicy = buildOmpRuntimeEnv({
      home: join(root, "home2"),
      codingAgentDir: join(root, "agent"),
      launchDir: join(root, "cwd"),
      baseEnv: { http_proxy: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9" },
      proxy: { url: "http://127.0.0.1:9", bypass: "127.0.0.1,localhost,::1" },
    }).env;
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      expect(withPolicy[key], key).toBe("http://127.0.0.1:9");
    }
    expect(withPolicy.no_proxy).toBe("127.0.0.1,localhost,::1");
    expect(withPolicy.NODE_USE_ENV_PROXY).toBeUndefined();
  });

  it("names a unique config root and pre-creates the discovery directories", () => {
    const root = scratch("dirs");
    const home = join(root, "home");
    prepareOmpRuntimeHome(home);
    const a = makeRuntimeConfigDirName();
    const b = makeRuntimeConfigDirName();
    expect(a).not.toBe(b);
    expect(a.startsWith(".omp-runtime-")).toBe(true);
    for (const dir of HOME_DISCOVERY_DIRS) {
      expect(isPathInside(join(home, dir), home)).toBe(true);
    }
  });

  it("removes only run roots it owns", () => {
    const root = scratch("owned");
    const runRoot = join(root, "run");
    mkdirSync(runRoot, { recursive: true });
    const owned = join(runRoot, "run-abc123");
    mkdirSync(owned, { recursive: true });
    writeFileSync(join(owned, "marker"), "x");

    const outside = join(root, "not-ours");
    mkdirSync(outside, { recursive: true });

    expect(removeOwnedRunRoot(owned, runRoot, "run")).toBe(true);
    expect(removeOwnedRunRoot(outside, runRoot, "run")).toBe(false);
    expect(removeOwnedRunRoot(runRoot, runRoot, "run")).toBe(false);
    // A plain `../` escape must not delete a sibling directory.
    const escape = join(runRoot, "..", "not-ours");
    expect(removeOwnedRunRoot(escape, runRoot, "run")).toBe(false);
    expect(() => rmSync(outside, { recursive: true })).not.toThrow();
  });

  it("treats a prefix sibling as outside", () => {
    expect(isPathInside("/home/user/.omp-desktop-x", "/home/user/.omp-desktop")).toBe(false);
    expect(isPathInside("/home/user/.omp-desktop/x", "/home/user/.omp-desktop")).toBe(true);
    expect(isPathInside("/home/user/.omp-desktop", "/home/user/.omp-desktop")).toBe(true);
  });
});
