#!/usr/bin/env node
/**
 * Packaged-runtime acceptance entry (M6/T21-A, ADR 0307).
 *
 * The build entry (`omp-sidecar.mjs`) produces the sidecar and its provenance
 * manifest; a packaged application admits them only through the runtime
 * package's own `verifyBundledRuntime`. This entry is the acceptance step in
 * between: it takes the **electron-builder output** — a packaged application's
 * `Resources` directory — and proves that the resources inside it are not only
 * declared correct but actually runnable through the same production code paths
 * a packaged application uses:
 *
 *   1. `verifyBundledRuntime` checks the fixed locations, the manifest pins and
 *      every digest (the acceptance never inspects the tree itself);
 *   2. the verified binary and the verified tool gate are started through
 *      `OmpRuntimeSupervisor` with the same argument chain the desktop builds
 *      (`--trusted-extension <Resources>/omp-runtime/extensions/…`), the child's
 *      PATH reduced to one empty directory, and a synthetic HOME inside the
 *      run root;
 *   3. the run must reach `idle` at the version this build pins, negotiate
 *      protocol v2, answer a provider-free `get_state`, and stop with its
 *      process group reaped and its run root cleaned.
 *
 * What this entry is not: a GUI launch. It starts no Electron process and no
 * window, sends no prompt, and contacts no provider — the model catalog written
 * into the run root points at a closed local port and is never used. It is the
 * runtime boundary of a packaged build, verified headlessly; the macOS/Windows
 * installer acceptance inside the real application remains T22/T23 work.
 *
 * Usage:
 *   node scripts/verify-packaged-runtime.mjs --resources <dir> [--verify-only] [--json]
 *
 * `--resources` is the directory that plays `process.resourcesPath` of the
 * packaged application (the parent of `omp-runtime/`). `--verify-only` stops
 * after the verifier and is the fast path for tamper/mismatch checks.
 *
 * Exit codes: 2 when the command line or the resources tree is not usable as
 * packaged Resources; 1 when verification, startup, the protocol round trip or
 * reclamation fails. Both are non-zero: a missing path never reports success.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePackageRoot = join(appRoot, "packages", "omp-runtime");

/** Where a packaged application keeps the sidecar; mirrored from the verifier. */
const RUNTIME_DIR = "omp-runtime";

/** The tool gate's path inside the runtime directory; mirrored from the verifier. */
const GATE_RELATIVE_PATH = join("extensions", "omp-desktop-gate.js");

/** A refusal the entry raises with its own exit code. */
class AcceptanceError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function refuse(message, exitCode = 2) {
  throw new AcceptanceError(message, exitCode);
}

export function parseArgs(argv) {
  const options = { resources: null, verifyOnly: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--resources") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) refuse("--resources requires a directory");
      index += 1;
      options.resources = value;
    } else if (arg === "--verify-only") {
      options.verifyOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      refuse(`unknown argument: ${arg}`);
    }
  }
  if (!options.help && options.resources === null) {
    refuse("--resources <packaged Resources directory> is required; this entry never verifies an implicit path");
  }
  return options;
}

/**
 * Accept only a directory that looks like a packaged `Resources` tree.
 *
 * This is the entry's own input contract, not a second verification: it keeps
 * `--resources /wrong/path` an argument refusal (exit 2) instead of letting it
 * surface as a runtime failure. Every assertion about the runtime itself still
 * comes from `verifyBundledRuntime`.
 */
function resolveResources(input) {
  const dir = resolve(input);
  if (!existsSync(dir)) refuse(`the resources directory does not exist: ${dir}`);
  if (!lstatSync(dir).isDirectory()) refuse(`the resources path is not a directory: ${dir}`);
  const runtimeDir = join(dir, RUNTIME_DIR);
  if (!existsSync(runtimeDir) || !lstatSync(runtimeDir).isDirectory()) {
    refuse(`the resources directory has no ${RUNTIME_DIR}/: ${dir} (is this an electron-builder output?)`);
  }
  return dir;
}

/**
 * Load the production modules the desktop itself loads.
 *
 * They come from the workspace build output rather than a second
 * implementation, so a missing build is a hard failure instead of a skipped
 * check (same contract as `omp-sidecar.mjs --preflight`).
 */
async function loadRuntimeModules() {
  const dist = join(runtimePackageRoot, "dist");
  for (const file of ["bundled.js", "supervisor.js"]) {
    if (!existsSync(join(dist, file))) {
      refuse(`the runtime package is not built (${join(dist, file)}); run \`pnpm run build:deps\` first`, 1);
    }
  }
  const bundled = await import(pathToFileURL(join(dist, "bundled.js")).href);
  const supervisor = await import(pathToFileURL(join(dist, "supervisor.js")).href);
  return { bundled, supervisor };
}

/** A model catalog for the child that cannot reach a provider. */
function writeModelCatalog(agentDir) {
  writeFileSync(
    join(agentDir, "models.yml"),
    `providers:
  acceptance:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        api: openai-completions
        contextWindow: 200000
        supportsTools: true
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`,
    "utf8",
  );
}

/**
 * The child's environment as the operating system sees it, or `null` where the
 * host does not expose one (`/proc` is Linux-only; macOS has no equivalent
 * readable without extra privileges). The live evidence for "no global fallback"
 * is strongest where it is readable, and is simply absent elsewhere rather than
 * replaced by an inference.
 */
function readChildEnvironment(pid) {
  if (!pid) return null;
  const environ = `/proc/${pid}/environ`;
  if (!existsSync(environ)) return null;
  try {
    const raw = readFileSync(environ, "utf8");
    return Object.fromEntries(
      raw
        .split("\0")
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const eq = entry.indexOf("=");
          return [entry.slice(0, eq), entry.slice(eq + 1)];
        }),
    );
  } catch {
    return null;
  }
}

/** Leftover `run-*` directories under a data root's runtime state dir. */
function leftoverRuns(dataRoot, runRootPrefix) {
  const stateDir = join(dataRoot, "omp-runtime");
  return existsSync(stateDir)
    ? readdirSync(stateDir).filter((entry) => entry.startsWith(`${runRootPrefix}-`))
    : [];
}

function expect(condition, message) {
  if (!condition) refuse(message, 1);
}

/**
 * Prove the gate argument is load-bearing before trusting the positive run.
 *
 * The compiled runtime refuses a `--trusted-extension` path that is not an
 * existing module file (it exits with "Trusted extension must be an existing
 * module file: <path>") instead of starting unguarded. Requiring that refusal
 * is what makes "the packaged runtime reached idle with the gate argument" a
 * statement about a loaded gate rather than about an ignored argument.
 */
async function expectGateRefusal(OmpRuntimeSupervisor, options) {
  const control = new OmpRuntimeSupervisor({
    dataRoot: options.dataRoot,
    launcherPath: options.launcherPath,
    expectedRuntimeVersion: options.expectedRuntimeVersion,
    args: ["--trusted-extension", options.missingGatePath],
    pathEntries: [options.emptyPathDir],
    readyTimeoutMs: 15_000,
    requestTimeoutMs: 15_000,
    selfExitMs: 5_000,
    terminationGraceMs: 10_000,
    prepareRun: (paths) => writeModelCatalog(paths.agentDir),
  });
  let refused = false;
  try {
    await control.start();
  } catch {
    refused = true;
  } finally {
    await control.reclaimAll().catch(() => undefined);
  }
  expect(
    refused,
    `the runtime accepted the non-existent trusted extension ${options.missingGatePath}; the gate argument is not load-bearing`,
  );
}

/**
 * Verify the packaged resources, without starting anything.
 *
 * Returns the verified identity plus the gate the manifest declares; throws
 * `AcceptanceError` with exit code 1 on every refusal.
 */
export async function verifyResources(resources) {
  const { bundled } = await loadRuntimeModules();
  let verified;
  try {
    verified = bundled.verifyBundledRuntime({ resourcesPath: resources });
  } catch (error) {
    const detail = typeof error?.detail === "string" && error.detail.length > 0 ? `: ${error.detail}` : "";
    refuse(`the packaged OMP runtime is not usable${detail}`, 1);
  }
  const gatePath = GATE_RELATIVE_PATH.split(sep).join("/");
  const gate = verified.extensions.find((extension) => extension.path === gatePath);
  if (!gate) refuse(`the verified provenance manifest does not declare the tool gate (${gatePath})`, 1);
  return { verified, gate, pin: bundled.BUNDLED_EXPECTATION };
}

/**
 * Start the verified runtime through the production supervisor and prove the
 * packaged boundary: pinned version, protocol v2, a provider-free RPC, the
 * isolated child environment and a clean stop.
 */
export async function runAcceptance(resources) {
  const { supervisor: supervisorModule } = await loadRuntimeModules();
  const { verified, gate, pin } = await verifyResources(resources);
  const { OmpRuntimeSupervisor, RUN_ROOT_PREFIX } = supervisorModule;

  const acceptRoot = mkdtempSync(join(tmpdir(), "omp-packaged-accept-"));
  const dataRoot = join(acceptRoot, "data");
  mkdirSync(dataRoot, { recursive: true });
  const emptyPathDir = join(acceptRoot, "empty-path");
  mkdirSync(emptyPathDir, { recursive: true });
  // Decoys at the paths a child would reach if the isolation variables were
  // forwarded instead of dropped: nothing here may be created or written.
  const decoys = join(acceptRoot, "decoy-user");
  const xdgDecoy = join(decoys, "xdg");
  const profileDecoy = join(decoys, "omp-profile");
  const dataRootDecoy = join(decoys, "pi-desktop");
  const nodePathDecoy = join(decoys, "node_modules");
  for (const dir of [xdgDecoy, profileDecoy, dataRootDecoy, nodePathDecoy]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(profileDecoy, "canary"), "must not be touched\n");

  // The launching environment this acceptance simulates: a NODE_PATH, the
  // discovery-redirecting variables and a credential, exactly as a developer
  // shell or CI job could have them. The isolation policy is what must keep
  // them out of the child; the decoy directories plus the child's own
  // environment (read from /proc where the host exposes it) are the evidence.
  const inheritedDecoys = {
    NODE_PATH: nodePathDecoy,
    XDG_CONFIG_HOME: xdgDecoy,
    XDG_DATA_HOME: xdgDecoy,
    OMP_PROFILE: profileDecoy,
    PI_DESKTOP_DATA_DIR: dataRootDecoy,
    ANTHROPIC_API_KEY: "must-not-reach-the-child",
  };
  const savedEnv = new Map();
  for (const [key, value] of Object.entries(inheritedDecoys)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  const seen = { home: null, configRoot: null };
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot,
    launcherPath: verified.path,
    expectedRuntimeVersion: pin.ompVersion,
    args: ["--trusted-extension", gate.absolutePath],
    pathEntries: [emptyPathDir],
    readyTimeoutMs: 120_000,
    requestTimeoutMs: 30_000,
    selfExitMs: 5_000,
    terminationGraceMs: 10_000,
    prepareRun: (paths) => {
      seen.home = paths.home;
      seen.configRoot = paths.configRoot;
      writeModelCatalog(paths.agentDir);
    },
  });

  try {
    const status = await supervisor.start();
    expect(status.phase === "idle", `the packaged runtime did not reach idle (phase ${status.phase})`);
    expect(
      status.runtimeVersion === pin.ompVersion,
      `the packaged runtime reports omp/${status.runtimeVersion ?? "unknown"}, this build pins omp/${pin.ompVersion}`,
    );
    expect(status.protocolVersion === 2, `the packaged runtime negotiated protocol v${status.protocolVersion}, expected v2`);

    const runtime = supervisor.currentRuntime();
    expect(runtime !== null, "the supervisor reported idle but exposes no drivable runtime");
    const childEnv = readChildEnvironment(runtime.pid);
    const response = await runtime.request({ type: "get_state" }, { timeoutMs: 20_000 });
    expect(response.success !== false, `get_state was refused: ${response.error ?? "unknown error"}`);

    const stop = await supervisor.stop();
    expect(stop.stopped === true, "the packaged runtime was not stopped");
    expect(stop.reaped === true, `the packaged runtime's process group survived (${stop.errors.join("; ")})`);
    expect(stop.cleaned === true, `the packaged run root survived (${stop.errors.join("; ")})`);
    const leftovers = leftoverRuns(dataRoot, RUN_ROOT_PREFIX);
    expect(leftovers.length === 0, `leftover run directories: ${leftovers.join(", ")}`);

    // The gate's load is real, not assumed: a `--trusted-extension` path the
    // runtime cannot load must keep it from becoming usable, so the positive
    // run above can only have reached `idle` with the verified gate loaded.
    await expectGateRefusal(OmpRuntimeSupervisor, {
      dataRoot: join(acceptRoot, "gate-control"),
      launcherPath: verified.path,
      expectedRuntimeVersion: pin.ompVersion,
      missingGatePath: join(dirname(gate.absolutePath), "does-not-exist.js"),
      emptyPathDir,
    });

    expect(
      typeof seen.home === "string" && seen.home.startsWith(join(dataRoot, "omp-runtime") + sep),
      `the child HOME was not the owned run root: ${seen.home}`,
    );
    expect(
      typeof seen.configRoot === "string" && seen.configRoot.startsWith(`${seen.home}${sep}`),
      `the child config root was not inside its HOME: ${seen.configRoot}`,
    );
    expect(readdirSync(xdgDecoy).length === 0, "the child wrote into the XDG decoy");
    expect(readdirSync(profileDecoy).length === 1, "the child wrote into the OMP profile decoy");
    expect(readdirSync(dataRootDecoy).length === 0, "the child wrote into the PI Desktop data-root decoy");
    expect(readdirSync(nodePathDecoy).length === 0, "the child wrote into the NODE_PATH decoy");

    const child = childEnv
      ? {
          readable: true,
          path: childEnv.PATH ?? null,
          home: childEnv.HOME ?? null,
          runsFromPackagedPath: runtime.launcher === verified.path,
          inheritsNodePath: Object.hasOwn(childEnv, "NODE_PATH"),
          inheritsRedirects:
            Object.hasOwn(childEnv, "XDG_CONFIG_HOME") ||
            Object.hasOwn(childEnv, "XDG_DATA_HOME") ||
            Object.hasOwn(childEnv, "OMP_PROFILE") ||
            Object.hasOwn(childEnv, "PI_DESKTOP_DATA_DIR"),
          inheritsCredentials: Object.hasOwn(childEnv, "ANTHROPIC_API_KEY"),
        }
      : { readable: false, note: "the child environment is not readable on this host (no /proc/PID/environ)" };
    if (childEnv) {
      expect(child.path === emptyPathDir, `the child PATH is ${child.path}, expected only ${emptyPathDir}`);
      expect(child.home === seen.home, `the child HOME is ${child.home}, expected ${seen.home}`);
      expect(child.runsFromPackagedPath === true, "the runtime is not the verified packaged binary");
      expect(child.inheritsNodePath === false, "the child inherited NODE_PATH");
      expect(child.inheritsRedirects === false, "the child inherited a discovery-redirecting variable");
      expect(child.inheritsCredentials === false, "the child inherited a credential-shaped variable");
    }

    return {
      mode: "run",
      resources,
      binary: {
        path: verified.path,
        bytes: verified.provenance.binary.bytes,
        sha256: verified.provenance.binary.sha256,
      },
      gate: { path: gate.absolutePath, bytes: gate.bytes, sha256: gate.sha256 },
      provenance: {
        ompVersion: verified.provenance.ompVersion,
        patchLevel: verified.provenance.patchLevel,
        forkCommit: verified.provenance.fork.commit,
        platform: verified.provenance.platform,
        arch: verified.provenance.arch,
      },
      run: {
        runtimeVersion: status.runtimeVersion,
        protocolVersion: status.protocolVersion,
        getState: true,
        gateLoadControl: "refused",
        stop: { stopped: stop.stopped, reaped: stop.reaped, cleaned: stop.cleaned },
        leftoverRuns: leftovers.length,
        child,
      },
    };
  } finally {
    await supervisor.reclaimAll().catch(() => undefined);
    rmSync(acceptRoot, { recursive: true, force: true });
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function formatReport(report) {
  const lines = [
    `PACKAGED-RUNTIME-OK ${report.mode === "run" ? "run" : "verify"} omp/${report.provenance.ompVersion} ${report.provenance.platform}/${report.provenance.arch}`,
    `  resources  : ${report.resources}`,
    `  binary     : ${report.binary.path} (${report.binary.bytes} B, sha256 ${report.binary.sha256})`,
    `  gate       : ${report.gate.path} (${report.gate.bytes} B, sha256 ${report.gate.sha256})`,
    `  provenance : patchLevel ${report.provenance.patchLevel}, fork ${report.provenance.forkCommit}`,
  ];
  if (report.run) {
    lines.push(
      `  runtime    : v${report.run.protocolVersion} negotiated, get_state ok, gate load control ${report.run.gateLoadControl}`,
      `  child env  : ${
        report.run.child.readable
          ? `PATH=${report.run.child.path}, HOME=${report.run.child.home}, NODE_PATH/redirects/credentials absent`
          : report.run.child.note
      }`,
      `  stop       : stopped=${report.run.stop.stopped} reaped=${report.run.stop.reaped} cleaned=${report.run.stop.cleaned}, leftover runs ${report.run.leftoverRuns}`,
    );
  }
  return lines.join("\n");
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`PACKAGED-RUNTIME-FAIL ${error.message}`);
    return error.exitCode ?? 2;
  }
  if (options.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30).join("\n"));
    return 0;
  }
  try {
    const resources = resolveResources(options.resources);
    if (options.verifyOnly) {
      const { verified, gate } = await verifyResources(resources);
      const result = {
        mode: "verify",
        resources,
        binary: {
          path: verified.path,
          bytes: verified.provenance.binary.bytes,
          sha256: verified.provenance.binary.sha256,
        },
        gate: { path: gate.absolutePath, bytes: gate.bytes, sha256: gate.sha256 },
        provenance: {
          ompVersion: verified.provenance.ompVersion,
          patchLevel: verified.provenance.patchLevel,
          forkCommit: verified.provenance.fork.commit,
          platform: verified.provenance.platform,
          arch: verified.provenance.arch,
        },
      };
      console.log(options.json ? JSON.stringify(result) : formatReport(result));
      return 0;
    }
    const result = await runAcceptance(resources);
    console.log(options.json ? JSON.stringify(result) : formatReport(result));
    return 0;
  } catch (error) {
    console.error(`PACKAGED-RUNTIME-FAIL ${error?.message ?? error}`);
    return error?.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`PACKAGED-RUNTIME-FAIL ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}
