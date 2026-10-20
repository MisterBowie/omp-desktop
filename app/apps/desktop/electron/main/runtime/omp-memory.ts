/** Settings live in host-core; every memory operation runs in the native OMP process. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseOmpMemorySettings, type OmpMemorySettings, type OmpMemoryPage } from "@pi-desktop/shared";
import {
  ompMemoryDirectory,
  type OmpMemoryLaunchConfig,
  type OmpRuntimeSupervisor,
  type OmpRunPaths,
} from "@pi-desktop/omp-runtime";
import type { HostProcess } from "../host-process";
import type { OmpSessionBridge } from "./omp-session";

export type MemorySupervisor = Pick<OmpRuntimeSupervisor, "start" | "stop" | "currentRuntime" | "reclaimAll">;
export type OmpMemoryDependencies = {
  dataRoot: string;
  host: () => Pick<HostProcess, "call"> | null;
  sessions: Pick<OmpSessionBridge, "withIdleRuntimes">;
  createSupervisor: (options: {
    memory: () => Promise<OmpMemoryLaunchConfig>;
    desktopStateRequired: boolean;
    modelSelector: string;
    prepareRun: (paths: OmpRunPaths) => void;
  }) => MemorySupervisor;
};
function failure(message: string, errorCode = "INVALID_PARAMS"): Error {
  return Object.assign(new Error(message), { errorCode });
}
export function createOmpMemoryService(deps: OmpMemoryDependencies) {
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  const supervisors = new Set<MemorySupervisor>();
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(() => {
      if (closed) throw failure("Memory service is shutting down", "CONFLICT");
      return operation();
    });
    queue = result.catch(() => undefined);
    return result;
  }
  function host() {
    const client = deps.host();
    if (!client) throw failure("Host unavailable", "HOST_UNAVAILABLE");
    return client;
  }
  function directory(projectPath: unknown): string {
    if (typeof projectPath !== "string" || !isAbsolute(projectPath) || /[\r\n\0]/.test(projectPath))
      throw failure("Absolute project path required");
    return ompMemoryDirectory(deps.dataRoot, resolve(projectPath));
  }
  async function scopeDirectory(input: { projectPath?: unknown; sessionId?: unknown }): Promise<string> {
    if (input.sessionId !== undefined) {
      if (input.projectPath !== undefined || typeof input.sessionId !== "string" || !input.sessionId.trim())
        throw failure("Invalid memory scope");
      const result = await host().call<{ path?: string }>("session.executionRoot", {
        sessionId: input.sessionId,
      });
      return directory(result.path);
    }
    return directory(input.projectPath);
  }
  async function finish(supervisor: MemorySupervisor): Promise<void> {
    let stopped = await supervisor.stop({ abortBash: false });
    if (!stopped.reaped || !stopped.cleaned) {
      await supervisor.reclaimAll();
      stopped = await supervisor.stop({ abortBash: false });
    }
    if (!stopped.reaped || !stopped.cleaned) throw failure("Memory runtime cleanup incomplete", "CONFLICT");
    supervisors.delete(supervisor);
  }
  async function native(directory: string, command: Record<string, unknown>): Promise<unknown> {
    if (closed) throw failure("Memory service is shutting down", "CONFLICT");
    for (const owned of supervisors) await finish(owned);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const supervisor = deps.createSupervisor({
      desktopStateRequired: true,
      modelSelector: "memory-admin/local-model",
      // RPC still needs a model catalog to boot. This closed local port has no
      // credential and cannot bill; management never submits a model prompt.
      prepareRun: (paths) =>
        writeFileSync(
          join(paths.agentDir, "models.yml"),
          [
            "providers:",
            "  memory-admin:",
            "    baseUrl: http://127.0.0.1:9/v1",
            "    api: openai-completions",
            "    auth: none",
            "    models:",
            "      - id: local-model",
            "        api: openai-completions",
            "        contextWindow: 200000",
            "        maxTokens: 1024",
            "        supportsTools: true",
            "        cost:",
            "          input: 0",
            "          output: 0",
            "          cacheRead: 0",
            "          cacheWrite: 0",
            "",
          ].join("\n"),
          { mode: 0o600 },
        ),
      memory: async () => ({
        dbPath: join(directory, "memory.db"),
        autoSave: false,
        autoRead: false,
        management: true,
      }),
    });
    supervisors.add(supervisor);
    try {
      const status = await supervisor.start();
      if (closed) throw failure("Memory service is shutting down", "CONFLICT");
      const runtime = supervisor.currentRuntime();
      if (!runtime || status.phase !== "idle")
        throw failure("OMP memory runtime unavailable", "ENGINE_UNAVAILABLE");
      const result = await runtime.request({ type: "memory", ...command });
      if (!result.success)
        throw failure(
          "Native memory operation failed; rebuild the OMP memory runtime",
          "OMP_MEMORY_UNAVAILABLE",
        );
      return result.data;
    } finally {
      await finish(supervisor);
    }
  }
  return {
    getSettings: async (): Promise<OmpMemorySettings> =>
      parseOmpMemorySettings(await host().call("memory.settings.get")),
    setSettings: (input: unknown): Promise<OmpMemorySettings> => {
      const settings = parseOmpMemorySettings(input);
      return serialized(() =>
        deps.sessions.withIdleRuntimes(async () => {
          if (settings.autoSave || settings.autoRead) {
            const status = await native(join(deps.dataRoot, "omp-memory", "compatibility"), {
              action: "status",
            });
            if (!status || typeof status !== "object" || Reflect.get(status, "active") !== true)
              throw failure("Mnemopi is not available", "OMP_MEMORY_UNAVAILABLE");
          }
          await host().call("memory.settings.set", settings);
          return settings;
        }),
      );
    },
    query: (input: {
      projectPath?: unknown;
      sessionId?: unknown;
      query?: unknown;
      offset?: unknown;
    }): Promise<OmpMemoryPage> => {
      if (input.sessionId === undefined) directory(input.projectPath);
      if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 2000))
        throw failure("Invalid memory query");
      const query = typeof input.query === "string" ? input.query.trim() : "";
      const offset = input.offset ?? 0;
      if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 100000)
        throw failure("Invalid memory offset");
      return serialized(async () => {
        const root = await scopeDirectory(input);
        if (!existsSync(join(root, "memory.db"))) return { items: [], total: 0, offset };
        const raw = await native(root, {
          action: query ? "search" : "list",
          ...(query ? { query } : { offset }),
          limit: 50,
        });
        if (!raw || typeof raw !== "object" || !Array.isArray(Reflect.get(raw, "items")))
          throw failure("Invalid native memory page", "OMP_MEMORY_UNAVAILABLE");
        const items = Reflect.get(raw, "items") as unknown[];
        if (
          items.length > 50 ||
          items.some(
            (item) => !item || typeof item !== "object" || typeof Reflect.get(item, "content") !== "string",
          )
        )
          throw failure("Invalid native memory items", "OMP_MEMORY_UNAVAILABLE");
        const total = query ? items.length : Reflect.get(raw, "total");
        if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)
          throw failure("Invalid native memory count", "OMP_MEMORY_UNAVAILABLE");
        return {
          items: items.map((item, index) => ({
            id: String(Reflect.get(item as object, "id") ?? index),
            content: String(Reflect.get(item as object, "content")).slice(0, 16000),
          })),
          total,
          offset,
        };
      });
    },
    clear: (input: {
      projectPath?: unknown;
      sessionId?: unknown;
      confirmed?: unknown;
    }): Promise<{ cleared: true }> => {
      if (input.sessionId === undefined) directory(input.projectPath);
      if (input.confirmed !== true) throw failure("Memory clear confirmation required");
      return serialized(() =>
        deps.sessions.withIdleRuntimes(async () => {
          const root = await scopeDirectory(input);
          if (existsSync(join(root, "memory.db"))) await native(root, { action: "clear" });
          return { cleared: true };
        }),
      );
    },
    dispose: async () => {
      closed = true;
      // Stop active management children before draining queued callers.
      for (const supervisor of supervisors) await finish(supervisor);
      await queue;
      for (const supervisor of supervisors) await finish(supervisor);
    },
  };
}
export type OmpMemoryService = ReturnType<typeof createOmpMemoryService>;
