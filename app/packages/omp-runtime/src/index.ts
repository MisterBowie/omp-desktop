/**
 * The desktop's boundary to an OMP runtime process.
 *
 * What this package owns: resolving the executable, isolating the child's
 * environment, speaking the rpc-ui NDJSON protocol (framing, request lifecycle,
 * chunk reassembly, typed failures), terminating the process group in the
 * measured-safe order, and reporting what it owns.
 *
 * What it does not own: sessions, transcripts, permissions, or any product UI.
 * An OMP session is executed inside the runtime and the desktop reaches it
 * through the protocol — M2 starts and supervises that process; the conversation
 * surface is M3.
 */
export {
  buildOmpRuntimeEnv,
  defaultPathEntries,
  HOME_DISCOVERY_DIRS,
  CREDENTIAL_VAR_PATTERN,
  PROXY_ENV_KEYS,
  STEER_VARS,
  isPathInside,
  makeRuntimeConfigDirName,
  prepareOmpRuntimeHome,
  removeOwnedRunRoot,
  type OmpRuntimeEnv,
  type OmpRuntimeEnvOptions,
} from "./isolation.js";
export { OmpRuntimeError, isFatalTransportError, type OmpRuntimeErrorCode } from "./errors.js";
export {
  PINNED_LAUNCHER_RELATIVE_PATH,
  PINNED_GATE_RELATIVE_PATH,
  findGateExtension,
  findPinnedLauncher,
  isExecutableAt,
  probeRuntimeVersion,
  resolveOmpLauncher,
  runtimeVersionMismatch,
  type OmpLauncherInput,
  type OmpVersionProbe,
  type OmpVersionProbeOptions,
} from "./launcher.js";
export {
  DEFAULT_MAX_LINE_BYTES,
  NdjsonReader,
  type NdjsonBatch,
  type NdjsonError,
} from "./ndjson.js";
export {
  checkReadyFrame,
  encodeChunkedFrames,
  isOmpFrame,
  RpcChunkDecoder,
  RpcChunkError,
  RPC_CHUNK_MAX_COUNT,
  RPC_CHUNK_PAYLOAD_BYTES,
  supportsProtocolV2,
  type OmpChunkFrame,
  type OmpFrame,
  type OmpReadyFrame,
  type OmpResponseFrame,
  type ReadyEnvelope,
  type ReadyRejection,
  type RpcChunkErrorKind,
  type RpcChunkSequence,
} from "./protocol.js";
export {
  processGroupLiveness,
  signalProcessGroup,
  terminateProcessTree,
  waitForExit,
  waitForGroupEmpty,
  type ProcessGroupLiveness,
  type TerminateTreeOptions,
  type TerminateTreeResult,
} from "./process-group.js";
export {
  DEFAULT_ABORT_SETTLE_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SELF_EXIT_MS,
  OmpRuntimeProcess,
  type OmpRuntimePhase,
  type OmpRuntimeProcessOptions,
  type OmpSpawnOptions,
  type OmpStopOptions,
  type OmpStopResult,
} from "./process.js";
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  OmpTransport,
  STDERR_TAIL_CHARS,
  type OmpTransportOptions,
} from "./transport.js";
export {
  describeRuntimeLauncher,
  ensureSessionStateDir,
  OmpRuntimeSupervisor,
  RUNTIME_STATE_DIR,
  RUN_ROOT_PREFIX,
  SESSION_STATE_DIR,
  type OmpReclaimResult,
  type OmpRunPaths,
  type OmpRuntimeSupervisorOptions,
  type OwnedOmpRuntime,
} from "./supervisor.js";
export {
  CONFIG_OVERLAY_FILE,
  sourceIsolationOverlayYaml,
  writeSourceIsolationOverlay,
} from "./config-overlay.js";

export {
  OmpEventConverter,
  appError,
  type OmpConversionDiagnostics,
  type OmpEventConverterOptions,
} from "./session/events.js";
export {
  OmpUiRequests,
  classifyUiRequest,
  descriptorRisk,
  responseFor,
  type OmpUiDecision,
  type OmpUiRecord,
  type OmpUiRequest,
  type OmpUiResponseFrame,
} from "./session/ui-requests.js";
export {
  OmpSessionRunner,
  type OmpRunState,
  type OmpSessionRunnerOptions,
  type OmpSessionRuntime,
  type OmpStopOutcome,
} from "./session/runner.js";
export {
  SubagentTracker,
  type OmpSubagentOutcome,
  type SubagentDiagnostics,
  type SubagentListEntry,
  type SubagentSynthesis,
} from "./session/subagents.js";
export {
  normalizeFromByte,
  parseSubagentEventFrame,
  parseSubagentLifecycleFrame,
  parseSubagentMessages,
  parseSubagentProgressFrame,
  parseSubagentSnapshots,
  RpcSubagentMessagesResultSchema,
  RpcSubagentSnapshotSchema,
  subagentFrameKind,
  SubagentEventPayloadSchema,
  SubagentLifecyclePayloadSchema,
  SubagentProgressPayloadSchema,
  type SubagentAgentSource,
  type SubagentEventFrame,
  type SubagentEventPayload,
  type SubagentFrame,
  type SubagentLifecycleFrame,
  type SubagentLifecyclePayload,
  type SubagentLifecycleStatus,
  type SubagentMessagesResult,
  type SubagentProgressFrame,
  type SubagentProgressPayload,
  type SubagentProgressStatus,
  type SubagentSnapshot,
  type SubagentTranscriptCursor,
} from "./session/subagent-frames.js";
export {
  OMP_APPROVAL_ALLOW_LABEL,
  OMP_APPROVAL_DENY_LABEL,
  OMP_APPROVAL_KIND,
  OMP_APPROVAL_OPTIONS,
  OMP_APPROVAL_VERSION,
  OMP_NATIVE_APPROVAL_OPTIONS,
  encodeApprovalDescriptor,
  isNativeApprovalOptions,
  parseApprovalDescriptor,
  type OmpApprovalDescriptor,
  type OmpApprovalRisk,
} from "./session/approval-protocol.js";
