#!/usr/bin/env node
/**
 * E07 — configuration, credential, and session-directory isolation.
 *
 * Proves that a bridge-launched OMP reads only this run's isolated config:
 *   - the model list contains exactly the run's mock model (the user's real
 *     model config is not consulted);
 *   - steering env inputs (OMP_PROFILE/PI_PROFILE/XDG_*) and credential vars
 *     present in the parent are stripped from the child's actual environment;
 *   - agent data, sessions, and logs land under this run's isolated dirs.
 *
 * Usage: node e07-isolation.mjs [--keep-artifacts]
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const SYNTHETIC_KEY = "m0-synthetic-not-a-real-key";
const SYNTHETIC_ENV = {
  OPENAI_API_KEY: SYNTHETIC_KEY,
  OMP_PROFILE: "m0-review-profile",
  PI_PROFILE: "m0-review-profile-2",
  XDG_DATA_HOME: "/tmp/m0-review-xdg-data",
  XDG_CACHE_HOME: "/tmp/m0-review-xdg-cache",
};

/** Read a live process's actual environment (Linux). */
function childEnv(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    return Object.fromEntries(raw.split("\0").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i), kv.slice(i + 1)];
    }));
  } catch {
    return null;
  }
}

const evidence = await runExperiment("e07-isolation", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  const { root, runRoot, selector, agentDir, launchDir } = experimentRoot(ctx, "e07", { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".omp", "rules"), { recursive: true });

  // --- isolation controls ---------------------------------------------------
  // (a) allowed: config under this run's synthetic home, which is what the
  //     child's HOME points at;
  // (b) forbidden: an identically-shaped config tree in a decoy home that is
  //     NOT the child's HOME — it stands in for the real user's global config
  //     without ever reading or writing the real one.
  const HOME_RULE = "M1-HOME-RULE-MARKER-3b41";
  const DECOY_RULE = "M1-DECOY-RULE-MARKER-9d02";
  const syntheticHome = join(runRoot, "home");
  const decoyHome = join(root, "decoy-home");
  mkdirSync(join(syntheticHome, ".agent", "rules"), { recursive: true });
  mkdirSync(join(syntheticHome, ".agents", "skills", "m1-skill"), { recursive: true });
  mkdirSync(join(decoyHome, ".agent", "rules"), { recursive: true });
  mkdirSync(join(decoyHome, ".agents", "skills", "decoy-skill"), { recursive: true });
  writeFileSync(join(syntheticHome, ".agent", "rules", "home-rule.md"),
    `---\ndescription: synthetic home rule\nalwaysApply: true\n---\n# synthetic home rule\n\nAlways mention ${HOME_RULE} in every reply.\n`);
  writeFileSync(join(decoyHome, ".agent", "rules", "decoy-rule.md"),
    `---\ndescription: decoy home rule\nalwaysApply: true\n---\n# decoy home rule\n\nAlways mention ${DECOY_RULE} in every reply.\n`);
  writeFileSync(join(syntheticHome, ".agents", "skills", "m1-skill", "SKILL.md"),
    "---\nname: m1-skill\ndescription: Marker skill proving skill discovery is scoped to this run.\n---\n\n# M1 skill\n");
  writeFileSync(join(decoyHome, ".agents", "skills", "decoy-skill", "SKILL.md"),
    "---\nname: decoy-skill\ndescription: DECOY-SKILL-MARKER-7c88 must never be discoverable.\n---\n\n# decoy skill\n");

  // Rules: one user-level rule in the isolated agent dir, one project-level
  // rule in the isolated cwd. Both must be picked up, which proves discovery
  // reads this run's roots rather than the user's own config.
  const USER_RULE = "M1-USER-RULE-MARKER-8f2a";
  const PROJECT_RULE = "M1-PROJECT-RULE-MARKER-51c7";
  // A rule only reaches the prompt when it is bucketed: `alwaysApply: true`
  // (rule-buckets.ts) or a `description` (rulebook). Bare markdown is read but
  // never injected, which is why the frontmatter is part of the fixture.
  mkdirSync(join(agentDir, "rules"), { recursive: true });
  writeFileSync(join(agentDir, "rules", "m1-user.md"), `---\ndescription: M1 isolation user rule\nalwaysApply: true\n---\n# M1 user rule\n\nAlways mention ${USER_RULE} in every reply.\n`);
  writeFileSync(join(projectDir, ".omp", "rules", "m1-project.md"), `---\ndescription: M1 isolation project rule\nalwaysApply: true\n---\n# M1 project rule\n\nAlways mention ${PROJECT_RULE} in every reply.\n`);

  // MCP: a stdio server declared only in this run's project config. It records
  // that it was started and answers the handshake, so discovery is observable.
  const mcpMarker = join(root, "mcp-started.txt");
  const mcpStub = join(root, "mcp-stub.mjs");
  writeFileSync(mcpStub, `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from "node:fs";
writeFileSync(process.env.M1_MCP_MARKER, "started\\n");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    appendFileSync(process.env.M1_MCP_MARKER, msg.method + "\\n");
    if (msg.id === undefined) continue;
    const result =
      msg.method === "initialize"
        ? { protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "m1-stub", version: "0.0.1" } }
        : msg.method === "tools/list"
          ? { tools: [{ name: "m1_mcp_echo", description: "M1 MCP stub echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
process.stdin.resume();
`, { mode: 0o755 });
  writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({
    mcpServers: { m1stub: { command: process.execPath, args: [mcpStub], env: { M1_MCP_MARKER: mcpMarker } } },
  }, null, 2) + "\n");

  // Positive control: a second model defined only inside this run's config.
  writeFileSync(join(agentDir, "models.yml"), readFileSync(join(agentDir, "models.yml"), "utf8") + `  m1control:
    baseUrl: http://127.0.0.1:9
    api: openai-completions
    auth: none
    models:
      - id: control-model
        api: openai-completions
        contextWindow: 32000
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`);

  const userOmp = join(homedir(), ".omp");
  ctx.note("ambientHomeIsNotUsedByChild", true);
  // Note: the real user's config is deliberately NOT read, not even to build a
  // comparison list. Isolation is asserted via the child's own environment and
  // the decoy-home controls instead.

  // Inject synthetic credentials/steering vars into the parent for this run.
  const savedEnv = {};
  for (const [k, v] of Object.entries(SYNTHETIC_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  ctx.onCleanup(() => {
    for (const k of Object.keys(SYNTHETIC_ENV)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  let rpc;
  try {
    rpc = await OmpRpc.start({
      repoRoot, runRoot, mode: "rpc-ui",
      args: ["--model", selector, "--approval-mode", "yolo"],
      cwd: projectDir,
    });
    await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

    // --- child environment --------------------------------------------------
    const env = childEnv(rpc.pid);
    ctx.check("child environment is readable for verification", env !== null, rpc.pid);
    if (env) {
      ctx.check("injected API key is not present in the child env", env.OPENAI_API_KEY === undefined, env.OPENAI_API_KEY ? "<present>" : "absent");
      for (const key of ["OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
        ctx.check(`${key} is stripped from the child env`, env[key] === undefined, env[key] ?? "absent");
      }
      ctx.check("child config root points at this run's isolated root", String(env.PI_CONFIG_DIR).startsWith(".omp-m0-"), env.PI_CONFIG_DIR);
      ctx.check("child agent dir points at this run's isolated agent dir", env.PI_CODING_AGENT_DIR === agentDir, env.PI_CODING_AGENT_DIR);
      ctx.check("child launch dir points at this run's isolated launch dir", env.OMP_DEV_LAUNCH_DIR === launchDir, env.OMP_DEV_LAUNCH_DIR);
      ctx.check("synthetic credential value never appears in the child env", !Object.values(env).includes(SYNTHETIC_KEY));

      // HOME isolation: every home-relative discovery path must resolve inside
      // this run, otherwise `~/.agent` and `~/.agents` still reach the real user.
      const ambientHome = homedir();
      ctx.check("child HOME is redirected into the run root", env.HOME === syntheticHome, env.HOME);
      ctx.check("child HOME is not the ambient user home", env.HOME !== ambientHome, `${env.HOME} vs ${ambientHome}`);
      ctx.check("resolved config root lives under the synthetic home", rpc.configRoot.startsWith(join(syntheticHome, ".omp-m0-")), rpc.configRoot);
      for (const key of ["CLAUDE_CONFIG_DIR", "COPILOT_HOME", "GH_CONFIG_DIR", "MISE_DATA_DIR", "OMP_WORKTREE_DIR", "PI_CONFIG_FILES"]) {
        ctx.check(`${key} is stripped from the child env`, env[key] === undefined, env[key] ?? "absent");
      }
    }

    // --- model visibility ---------------------------------------------------
    const models = await rpc.request({ type: "get_available_models" });
    const ids = (models.data?.models ?? []).map((m) => m.id).sort();
    ctx.check("only this run's models are visible", ids.join(",") === "control-model,local-model", ids);
    ctx.check("no ambient model leaks in: exactly this run's models are visible",
      ids.length === 2 && ids.includes("local-model") && ids.includes("control-model"), ids);
    ctx.note("visibleModelIds", ids);

    // --- a turn writes only into the isolated dirs --------------------------
    provider.script([{ text: "ok", finish: "stop" }]);
    await rpc.request({ type: "prompt", message: "hello" }, { timeoutMs: 30_000 });
    await rpc.waitFor((f) => f.type === "agent_end", 30_000);

    // --- rules discovered from this run's roots ----------------------------
    const promptBody = JSON.stringify(provider.requests.find((r) => r.url?.includes("/chat/completions"))?.body ?? {});
    ctx.check("user-level rule from the isolated agent dir reaches the model", promptBody.includes(USER_RULE));
    ctx.check("project-level rule from the isolated cwd reaches the model", promptBody.includes(PROJECT_RULE));
    // Positive control for the synthetic HOME: a global rule there is the
    // "user's own" config in the isolated world and must take effect.
    ctx.check("rule from the synthetic HOME is discovered", promptBody.includes(HOME_RULE));
    // Negative control: an identically-shaped config tree outside the child's
    // HOME must never be consulted (this is the real-user-home stand-in).
    ctx.check("rule from the decoy HOME never reaches the model", !promptBody.includes(DECOY_RULE));
    ctx.check("skill from the decoy HOME is never discovered", !promptBody.includes("DECOY-SKILL-MARKER-7c88"));
    ctx.limit("Rules are only injected when bucketed by frontmatter (`alwaysApply: true`, or a `description` for the rulebook); a bare markdown file in rules/ is read but never reaches the prompt. Relevant to T19.");
    // Real user config must not be touched by these runs.
    ctx.check("no isolated config root was created in the real user home",
      readdirSync(homedir()).filter((n) => n.startsWith(".omp-m0-")).length === 0,
      readdirSync(homedir()).filter((n) => n.startsWith(".omp-m0-")).slice(0, 3));

    // --- MCP declared only in this run's project config --------------------
    const mcpLog = existsSync(mcpMarker) ? readFileSync(mcpMarker, "utf8").trim().split("\n") : [];
    ctx.check("MCP server from the isolated project config was started", mcpLog[0] === "started", mcpLog[0] ?? "not started");
    ctx.check("MCP client completed the handshake", mcpLog.includes("initialize"), mcpLog);
    ctx.check("MCP server was queried for tools", mcpLog.includes("tools/list"), mcpLog);
    const advertised = provider.requests
      .flatMap((r) => r.body?.tools ?? [])
      .map((t) => t?.function?.name ?? t?.name)
      .filter((n) => typeof n === "string");
    ctx.note("advertisedTools", [...new Set(advertised)]);
    ctx.note("mcpToolAdvertised", advertised.includes("m1_mcp_echo"));
    // Isolation is what this experiment must prove: the server declared only in
    // this run's project config is discovered and driven. Whether/how an MCP
    // tool reaches the model's tool list is a surfacing question owned by T19.
    ctx.limit(
      advertised.includes("m1_mcp_echo")
        ? "MCP tools from the isolated server are advertised to the model."
        : "The MCP server from the isolated project config is discovered, spawned, and handshaken, but its tool is NOT in the model's tool list in this configuration (OMP advertises a curated 12-tool subset); MCP tool surfacing is T19/M5 work.",
    );

    ctx.check("agent database was created inside the isolated agent dir", existsSync(join(agentDir, "agent.db")), join(agentDir, "agent.db"));
    ctx.check("sessions directory exists inside the isolated agent dir", existsSync(join(agentDir, "sessions")));
    const configRoot = rpc.configRoot;
    ctx.check("config root is this run's isolated root, not ~/.omp", configRoot !== userOmp && configRoot.includes(".omp-m0-"), configRoot);
    ctx.check("run logs land in the isolated config root or agent dir", existsSync(join(configRoot, "logs")) || existsSync(join(agentDir, "logs")), configRoot);
    ctx.check("launch dir is isolated", existsSync(launchDir), launchDir);

    writeFixture("e07-isolation-env.json", {
      note: "names only; no values from the ambient environment",
      strippedKeysVerified: ["OPENAI_API_KEY", "OMP_PROFILE", "PI_PROFILE", "XDG_DATA_HOME", "XDG_CACHE_HOME"],
      configDirNamePrefix: ".omp-m0-",
      visibleModelIds: ids,
    });
  } finally {
    if (rpc) ctx.check("process group reaped", (await rpc.stop()) === true);
  }

  ctx.limit("Credential isolation is proven for environment variables; OS keychain/system-store naming is deferred to M4 packaging.");
  ctx.limit("The real user's config is never read by these runs: the child's HOME is a synthetic directory inside the run root, and isolation is asserted against a decoy home instead of the user's.");
});

process.exit(evidence.ok ? 0 : 1);
