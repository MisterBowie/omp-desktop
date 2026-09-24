/**
 * The desktop's single loader for the OMP capability snapshot (M5/T19-C):
 * the live skill catalog (builtin, active plugin, active user — in that
 * order, metadata only) and the bound project's memory, assembled with the
 * exact PI `session-launch.ts` sources, ordering and fallback semantics.
 *
 * The bridge calls `snapshot(projectPath)` once per prompt and writes the
 * result into the run-scoped state file the trusted gate reads; the on-demand
 * `Skill` host tool reads bodies through its own live path at execution.
 * Nothing here touches OMP's native skills, rules or context discovery.
 */
import { builtinSkills } from "../builtin-skills";
import type { RegisteredPluginSkill } from "../plugin-runtime";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { UserSkillRecord } from "@pi-desktop/shared";

/** One catalog entry: id/name/description only — bodies stay on demand. */
export type OmpDesktopSkillMeta = {
  id: string;
  name: string;
  description: string;
};

/** One per-prompt snapshot; `memory` absent means "none read" (PI semantics). */
export type OmpDesktopCapabilitySnapshot = {
  skills: OmpDesktopSkillMeta[];
  memory?: string;
};

export type OmpDesktopCapabilitiesDeps = {
  host(): HostProcess | null;
  /** The plugin registry's skill catalog and loaded-plugin paths. */
  plugins: {
    getSkills(): RegisteredPluginSkill[];
    listLoaded(): Array<{ path: string }>;
  };
  /** PI's activation-scope predicate; the same one `session-launch.ts` uses. */
  pluginActiveInProject(pluginId: string, projectPath: string): boolean;
  /** The user's own skills, scope-filtered by host-core (`skills.active`). */
  activeUserSkills(projectPath: string | undefined): Promise<UserSkillRecord[]>;
  log?: Logger;
};

export type OmpDesktopCapabilities = {
  snapshot(projectPath: string): Promise<OmpDesktopCapabilitySnapshot>;
};

function isHostUnavailable(error: unknown): boolean {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  return code === "HOST_UNAVAILABLE" || code === "NOT_STARTED";
}

/**
 * Assemble the desktop's live capability snapshot for one prompt, mirroring
 * `session-launch.ts` (`resolveAgentRuntimeLaunch`):
 *
 *   - skills: `builtinSkills` first, then the plugin registry's catalog
 *     filtered by activation scope, then the user's own scope-filtered
 *     records — metadata only, the same order the Pi prompt reads;
 *   - memory: `project.group.context` group memory first, falling back to the
 *     legacy `project.memory.get` when the group reports no context — both
 *     best-effort exactly where Pi is best-effort (a failed read contributes
 *     nothing and never fails the prompt).
 *
 * A host read failure drops only what it could not read: memory and user
 * skills are best-effort, the plugin catalog is in-process and always present.
 */
export function createOmpDesktopCapabilities(deps: OmpDesktopCapabilitiesDeps): OmpDesktopCapabilities {
  async function activeUserSkillsSafe(projectPath: string | undefined): Promise<UserSkillRecord[]> {
    const client = deps.host();
    if (!client || (typeof client.isAvailable === "function" && !client.isAvailable())) return [];
    try {
      const result = await client.call<{ skills: UserSkillRecord[] }>("skills.active", {
        projectPath: projectPath ?? null,
      });
      return result.skills ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        deps.log?.app("plugin", "warn", "skills list failed", { data: String(error) });
      }
      return [];
    }
  }

  async function readProjectMemory(projectPath: string): Promise<string | undefined> {
    const client = deps.host();
    if (!client || (typeof client.isAvailable === "function" && !client.isAvailable())) return undefined;
    try {
      const result = await client.call<{
        context?: {
          roots?: Array<{ path?: string }>;
          instructions?: string;
          memory?: { content?: string };
        } | null;
      }>("project.group.context", { path: projectPath });
      const groupMemory = result.context?.memory?.content?.trim();
      if (groupMemory) return groupMemory;
      if (!result.context) {
        const legacy = await client.call<{ memory?: { content?: string } }>("project.memory.get", {
          path: projectPath,
        });
        const content = legacy.memory?.content?.trim();
        if (content) return content;
      }
      return undefined;
    } catch {
      // Group context is best effort; the legacy memory path is too.
      try {
        const legacy = await client.call<{ memory?: { content?: string } }>("project.memory.get", {
          path: projectPath,
        });
        const content = legacy.memory?.content?.trim();
        return content || undefined;
      } catch {
        return undefined;
      }
    }
  }

  return {
    async snapshot(projectPath: string): Promise<OmpDesktopCapabilitySnapshot> {
      const skills: OmpDesktopSkillMeta[] = [
        ...builtinSkills({
          workspacePath: projectPath,
          pluginPaths: deps.plugins.listLoaded().map((loaded) => loaded.path),
        }).map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description ?? "",
        })),
        ...deps.plugins
          .getSkills()
          .filter((skill) => deps.pluginActiveInProject(skill.pluginId, projectPath))
          .map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
          })),
        ...(await activeUserSkillsSafe(projectPath)).map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description ?? "",
        })),
      ];
      const memory = await readProjectMemory(projectPath);
      return { skills, ...(memory !== undefined ? { memory } : {}) };
    },
  };
}
