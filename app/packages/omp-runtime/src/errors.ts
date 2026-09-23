/**
 * Failures the OMP runtime boundary reports to its embedder.
 *
 * Every code is a distinct condition the desktop must treat differently: a
 * missing launcher is a configuration error, a version mismatch is a build
 * mismatch, an unusable transport needs the runtime rebuilt, and a request
 * timeout is the only one that means "the runtime is still there but slow".
 */
export type OmpRuntimeErrorCode =
  /** The configured executable does not exist or is not executable. */
  | "launcher-missing"
  /** `spawn` failed (permissions, no such file, resource limits). */
  | "spawn-failed"
  /** No `ready` frame arrived inside the readiness budget. */
  | "ready-timeout"
  /** The runtime refused protocol v2, or advertised a framing contract we do not implement. */
  | "protocol-unsupported"
  /** The runtime reports a different version than the one this build pins. */
  | "version-mismatch"
  /** The stream is unusable (chunk decode failure, EPIPE, malformed frames beyond recovery). */
  | "transport-failed"
  /** A request's own deadline elapsed with the stream still healthy. */
  | "request-timeout"
  /** The runtime has exited or was never started. */
  | "not-started"
  /** A request was issued while the runtime was shutting down. */
  | "stopping"
  /** A feature this build could not enable (e.g. the subagent subscription). */
  | "capability-unavailable";

export class OmpRuntimeError extends Error {
  readonly code: OmpRuntimeErrorCode;
  /** Extra context for logs and fixtures; never carries credentials. */
  readonly detail?: string;

  constructor(code: OmpRuntimeErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "OmpRuntimeError";
    this.code = code;
    this.detail = detail;
  }
}

/** True when the error means the runtime cannot be reused and must be rebuilt. */
export function isFatalTransportError(error: unknown): boolean {
  return (
    error instanceof OmpRuntimeError &&
    (error.code === "transport-failed" ||
      error.code === "protocol-unsupported" ||
      error.code === "not-started" ||
      error.code === "stopping")
  );
}
