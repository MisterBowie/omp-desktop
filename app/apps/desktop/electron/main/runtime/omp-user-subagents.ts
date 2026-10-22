/** Desktop-owned definitions projected into OMP's isolated native task catalog. */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  mergeSubagentDefinitions,
  parseSubagentDefinition,
  SUBAGENT_INHERIT_DENY_TOOLS,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "@pi-desktop/shared";
import { findSubagentProviderSource } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import {
  resolveProviderProjection,
  type OmpModelProjection,
  type ProviderProjectionSource,
} from "./omp-model-projection";
import type { OmpSessionRuntimeSpec } from "./omp-session";

// Native tool names, including deferred tools. OMP still filters unavailable
// tools when it constructs the child. Explicit grants use the desktop spelling.
const INHERIT_NATIVE_TOOLS = [
  "read", "bash", "edit", "eval", "glob", "grep", "find", "wait", "todo", "web_search", "write",
  "ast_grep", "ast_edit", "lsp", "debug", "checkpoint", "rewind", "context_notes", "security_scan",
  "memory_edit", "retain", "recall", "reflect", "learn", "manage_skill",
];
const TOOL_NAMES: Record<string, string> = {
  Read: "read", Glob: "glob", Grep: "grep", Bash: "bash", Edit: "edit", Write: "write", BrowserPreview: "BrowserPreview",
};
const DENIED = new Set([...SUBAGENT_INHERIT_DENY_TOOLS.map(name => name.toLowerCase()), "task", "ask", "submitplan", "submitgoal"]);

export function ompSubagentTools(definition: SubagentDefinition, hostTools: readonly string[]): string[] {
  return [...new Set([
    ...(definition.inheritTools ? [...INHERIT_NATIVE_TOOLS, ...hostTools] : []),
    ...definition.tools.map(name => TOOL_NAMES[name]).filter((name): name is string => Boolean(name)),
  ])].filter(name => !DENIED.has(name.toLowerCase()));
}

type Source = ProviderProjectionSource & { name: string; vendorKey?: string; updatedAt?: string };
type Binding = { sourceId: string; needsKey: boolean; projection: OmpModelProjection };
type Agent = { definition: SubagentDefinition; tools: string[]; bindings: Binding[] };
export type OmpUserSubagentSnapshot = { fingerprint: string; agents: Agent[]; diagnostics: string[] };

/** OMP gives the nearest project agents directory priority over user agents. */
async function projectAgentNames(cwd: string): Promise<Set<string>> {
  for (let current = cwd; ; current = dirname(current)) {
    const dir = join(current, ".omp", "agents");
    let entries: Dirent[] | undefined;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { /* Native discovery also walks past missing directories. */ }
    if (entries) {
      const names = new Set<string>();
      for (const entry of entries) {
        if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
        try {
          const document = await readFile(join(dir, entry.name), "utf8");
          const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document)?.[1];
          const fields: unknown = front ? parseYaml(front) : null;
          if (fields && typeof fields === "object" && !Array.isArray(fields)) {
            const name = Reflect.get(fields, "name");
            const description = Reflect.get(fields, "description");
            if (typeof name === "string" && typeof description === "string" && description) names.add(name);
          }
        } catch { /* Native discovery ignores unreadable or malformed definitions. */ }
      }
      return names;
    }
    if (dirname(current) === current) return new Set();
  }
}

/** Host activation remains authoritative; the runtime never reads the real HOME. */
export async function loadOmpUserSubagents(
  host: HostProcess,
  spec: OmpSessionRuntimeSpec,
  hostTools: readonly string[] = [],
): Promise<OmpUserSubagentSnapshot> {
  const { subagents = [] } = await host.call<{ subagents: UserSubagentRecord[] }>("agents.active", { projectPath: spec.projectDirectory });
  const diagnostics: string[] = [];
  const definitions: SubagentDefinition[] = [];
  for (const record of subagents) {
    try {
      const parsed = parseSubagentDefinition(await readFile(record.path, "utf8"), {
        source: "user", fallbackName: record.id, filePath: record.path,
      });
      if (parsed.ok) definitions.push(parsed.definition);
      else diagnostics.push(`subagent ${record.id}: invalid definition`);
    } catch {
      diagnostics.push(`subagent ${record.id}: document unavailable`);
    }
  }
  const catalog = mergeSubagentDefinitions(definitions).definitions.sort((a, b) => a.name.localeCompare(b.name));
  if (catalog.length) {
    const projectNames = await projectAgentNames(spec.executionDirectory ?? spec.projectDirectory);
    const collision = catalog.find(definition => projectNames.has(definition.name));
    if (collision) throw Object.assign(new Error(`subagent ${collision.name}: a project .omp/agents definition would override the Settings definition; rename one before continuing`), { errorCode: "OMP_SUBAGENT_CONFLICT" });
  }
  const sources = catalog.length
    ? (await host.call<{ providers: Source[] }>("providers.list", {})).providers ?? []
    : [];
  const agents: Agent[] = [];
  for (const definition of catalog) {
    try {
      // OMP children use the existing parent policy gate. A per-child policy
      // cannot be represented by this runtime and must never silently widen it.
      if (definition.permission && definition.permission !== "inherit") throw new Error("OMP requires inherited permissions");
      const pins = [definition.model ?? { providerId: spec.providerId ?? "", modelId: spec.modelId ?? "" }, ...(definition.fallbackModels ?? [])];
      const bindings = pins.map((pin, index): Binding => {
        const identity = findSubagentProviderSource(pin.providerId, sources.map(source => ({ id: source.id, name: source.name, vendorKey: source.vendorKey })));
        const source = sources.find(candidate => candidate.id === identity?.id);
        if (!source) throw new Error("model provider is missing or ambiguous");
        const resolved = resolveProviderProjection(source, pin.modelId, definition.thinkingLevel === "omit" ? null : definition.thinkingLevel ?? null);
        if (!resolved.ok) throw new Error(resolved.error.message);
        return {
          sourceId: source.id,
          needsKey: resolved.needsKey,
          projection: { ...resolved.projection,
            // Definition-local aliases keep token caps and fallback chains
            // independent, even when several agents use the same real model.
            providerId: `desktop-agent-${definition.name}-${index}`,
            ...(definition.maxTokens ? { maxTokens: Math.min(definition.maxTokens, resolved.projection.maxTokens ?? definition.maxTokens) } : {}),
          },
        };
      });
      agents.push({ definition, bindings, tools: ompSubagentTools(definition, hostTools) });
    } catch (error) {
      diagnostics.push(`subagent ${definition.name}: ${error instanceof Error ? error.message : "model unavailable"}`);
    }
  }
  // This digest contains public binding metadata only, never secret-store data.
  const usedSources = new Set(agents.flatMap(agent => agent.bindings.map(binding => binding.sourceId)));
  const revisions = sources.filter(source => usedSources.has(source.id))
    .map(source => ({ id: source.id, updatedAt: source.updatedAt, hasSecret: source.hasSecret }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = createHash("sha256").update(JSON.stringify({ agents, revisions, diagnostics })).digest("hex");
  return { fingerprint, agents, diagnostics };
}

/** Credentials go only into the run-owned models.yml, never agent documents. */
export async function ompSubagentModels(host: HostProcess, snapshot: OmpUserSubagentSnapshot): Promise<OmpModelProjection[]> {
  const secrets = new Map<string, string>();
  const models: OmpModelProjection[] = [];
  for (const agent of snapshot.agents) {
    for (const binding of agent.bindings) {
      let apiKey: string | null = null;
      if (binding.needsKey) {
        if (!secrets.has(binding.sourceId)) {
          const result = await host.call<{ value?: string | null }>("providers.getSecret", { id: binding.sourceId });
          const value = typeof result.value === "string" ? result.value.trim() : "";
          if (!value) throw Object.assign(new Error(`subagent ${agent.definition.name}: the pinned provider has no API key`), { errorCode: "OMP_PROJECTION_INVALID" });
          secrets.set(binding.sourceId, value);
        }
        apiKey = secrets.get(binding.sourceId) ?? null;
      }
      models.push({ ...binding.projection, apiKey });
    }
  }
  return models;
}

export async function writeOmpUserSubagents(agentDir: string, snapshot: OmpUserSubagentSnapshot): Promise<void> {
  const dir = join(agentDir, "agents");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const { definition, tools, bindings } of snapshot.agents) {
    const models = bindings.map(({ projection }) => `${projection.providerId}/${projection.modelId}`);
    const document = ["---", `name: ${JSON.stringify(definition.name)}`, `description: ${JSON.stringify(definition.description)}`,
      `tools: ${JSON.stringify(tools)}`, `model: ${JSON.stringify(models)}`,
      ...(definition.thinkingLevel && definition.thinkingLevel !== "omit" ? [`thinkingLevel: ${JSON.stringify(definition.thinkingLevel)}`] : []),
      "---", definition.prompt, ""].join("\n");
    await writeFile(join(dir, `${definition.name}.md`), document, { mode: 0o600, flag: "wx" });
  }
}
