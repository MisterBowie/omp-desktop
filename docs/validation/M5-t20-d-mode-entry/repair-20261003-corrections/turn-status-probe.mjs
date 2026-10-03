/**
 * Reviewer-correction probe: which terminal statuses the real host-core accepts
 * for a durable turn row.
 *
 * The T20-D failure-boundary review expects `turns.status = 'failed'` after a
 * committed-but-unpreparable Enter. This probe drives the real `session.endTurn`
 * RPC on the real host-core binary and reads the row straight from SQLite, so
 * the actual vocabulary (`running | completed | aborted | error`) is observable
 * rather than argued: `"failed"` is not a value the host can store — it coerces
 * silently to `completed`, which is exactly the status the review rejects —
 * while `"error"` is the host's terminal for a failed turn.
 *
 * Run: node turn-status-probe.mjs     (host binary from PI_DESKTOP_HOST_BIN, or
 *                                      the repo's dev build)
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const app = join(repo, "app");
register(pathToFileURL(join(app, "apps/desktop/test/helpers/ts-import-hooks.mjs")));

const { HostProcess } = await import(pathToFileURL(join(app, "packages/host-runtime/dist/index.js")).href);

const binaryPath =
  process.env.PI_DESKTOP_HOST_BIN ?? join(app, "target/debug/pi-desktop-host-core");
if (!existsSync(binaryPath)) {
  console.error(`host binary not found: ${binaryPath}`);
  process.exitCode = 1;
} else {
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), "turn-status-probe-")));
  const host = new HostProcess({ binaryPath, dataDir: dataRoot, onStderr: () => undefined });
  try {
    await host.handshake();
    const created = await host.call("session.create", {
      title: "turn-status probe",
      engine: "omp",
      mode: "agent",
      projectPath: dataRoot,
      providerId: "m1fake",
      modelId: "local-model",
    });
    const sessionId = created.session.id;
    const outcomes = [];
    for (const status of ["failed", "error"]) {
      const begun = await host.call("session.beginTurn", {
        sessionId,
        providerId: "m1fake",
        modelId: "local-model",
      });
      const end = await host.call("session.endTurn", {
        turnId: begun.turnId,
        status,
        recoverInflight: false,
        createNotification: false,
      });
      outcomes.push({ requestedStatus: status, rpc: end });
    }
    const db = new DatabaseSync(join(dataRoot, "pi.sqlite"), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT status FROM turns ORDER BY rowid")
        .all()
        .map((row) => row.status);
      console.log(JSON.stringify({ binaryPath, outcomes, storedStatuses: rows }, null, 2));
      const failedRow = rows[0];
      const errorRow = rows[1];
      if (failedRow !== "completed" || errorRow !== "error") {
        console.error("unexpected host vocabulary; probe assumptions need review");
        process.exitCode = 1;
      }
    } finally {
      db.close();
    }
  } finally {
    await host.dispose();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}
