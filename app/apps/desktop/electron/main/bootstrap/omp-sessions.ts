/** Product composition for OMP sessions; the application entry only supplies services. */
import { createDesktopEngineRuntimeForApp } from "../runtime/engine-runtime";
import { wireOmpSessions, type OmpSessionWiringDeps } from "../runtime/omp-session-wiring";
import { createOmpHostToolAdapter, createHostPlansEndpoints, type OmpHostToolAdapterDeps } from "../runtime/omp-host-tools";
import { createOmpDesktopCapabilities, type OmpDesktopCapabilitiesDeps } from "../runtime/omp-desktop-capabilities";
import { loadBuiltinSkillBody } from "../builtin-skills";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentEventEnvelope } from "@pi-desktop/shared";

type App = Parameters<typeof createDesktopEngineRuntimeForApp>[0]["app"];
type OmpSessionServicesDeps = {
  dataRoot: string;
  app: App;
  host: OmpSessionWiringDeps["host"];
  piRuntimeLive: () => boolean;
  logger: NonNullable<OmpSessionWiringDeps["logger"]>;
  plugins: OmpHostToolAdapterDeps["plugins"] & OmpDesktopCapabilitiesDeps["plugins"] & { drainToasts(): string[] };
  userMcp: OmpHostToolAdapterDeps["userMcp"];
  pluginActiveInProject: OmpHostToolAdapterDeps["pluginActiveInProject"];
  loadUserSkillBody: OmpHostToolAdapterDeps["loadUserSkillBody"];
  activeUserSkills: OmpDesktopCapabilitiesDeps["activeUserSkills"];
  emitAgentEvent: (event: AgentEventEnvelope, options?: { guardPiTurnOwnership?: boolean }) => void;
  emitToast: (message: string) => void;
  getAgentHostBridge: () => AgentHostBridge | null;
  announceTurnEnded: NonNullable<OmpSessionWiringDeps["onTurnEnd"]>;
  settleOmpTurnEnd: NonNullable<OmpSessionWiringDeps["onTurnEnd"]>;
};

export function createOmpSessionServices(deps: OmpSessionServicesDeps) {
  const engineRuntime = createDesktopEngineRuntimeForApp({
    dataRoot: deps.dataRoot, app: deps.app, getHost: deps.host, piRuntimeLive: deps.piRuntimeLive,
  });
  const { bridge: ompSessions } = wireOmpSessions({
    dataRoot: deps.dataRoot,
    host: deps.host,
    engineRuntime,
    logger: deps.logger,
    isPackaged: deps.app.isPackaged,
    resourcesPath: process.resourcesPath ?? null,
    appPath: deps.app.getAppPath(),
    // The OMP runner owns its turn fence. Pi's active-turn map cannot validate it.
    emitAgentEvent: (event) => deps.emitAgentEvent(event, { guardPiTurnOwnership: false }),
    hostTools: createOmpHostToolAdapter({
      plugins: deps.plugins,
      userMcp: deps.userMcp,
      pluginActiveInProject: deps.pluginActiveInProject,
      // Host submit/entry endpoints consume the owning run's durable identity.
      plans: createHostPlansEndpoints(deps.host),
      loadBuiltinSkillBody,
      loadUserSkillBody: deps.loadUserSkillBody,
      activeUserSkills: deps.activeUserSkills,
      drainToasts: () => deps.plugins.drainToasts(),
      emitToast: deps.emitToast,
      log: (level, message, data) => deps.logger.app("runtime", level, message, { data }),
    }),
    capabilities: createOmpDesktopCapabilities({
      host: deps.host,
      plugins: deps.plugins,
      pluginActiveInProject: deps.pluginActiveInProject,
      activeUserSkills: deps.activeUserSkills,
      log: deps.logger,
    }),
    onIdle: (sessionId) => deps.getAgentHostBridge()?.agentHost.kick(sessionId),
    onTurnEnd: (info) => {
      deps.announceTurnEnded(info);
      deps.getAgentHostBridge()?.endTurn(info.sessionId, info.turnId,
        info.reason === "completed" ? "completed" : info.reason === "aborted" ? "interrupted" : "failed");
      // OMP owns its native transcript, so Pi's persistence pass cannot settle it.
      deps.settleOmpTurnEnd(info);
    },
  });
  return { engineRuntime, ompSessions };
}
