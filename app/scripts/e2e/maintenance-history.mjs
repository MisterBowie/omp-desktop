/** Observe only the owned fixture's real OMP history through a read-only DB. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { digest } from "./installed-product.mjs";

export function readMaintenanceHistory(application, sessionId) {
  const database = new DatabaseSync(join(application.data, "pi.sqlite"), { readOnly: true });
  let row;
  try { row = database.prepare("SELECT engine, engine_runtime_version, native_session_id, native_session_path FROM sessions WHERE id = ?").get(sessionId); }
  finally { database.close(); }
  assert.equal(row?.engine, "omp"); assert.equal(row.engine_runtime_version, "18.3.0");
  const part = relative(application.data, row.native_session_path);
  assert(part && !part.startsWith("..") && !isAbsolute(part), "native history escaped owned data");
  const bytes = readFileSync(row.native_session_path);
  const entries = bytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  return { file: row.native_session_path, nativeSessionId: row.native_session_id, sha256: digest(bytes), bytes, entries };
}

export function assertClosedHistory(before, closed) {
  assert(closed.subarray(0, before.length).equals(before), "quit changed existing native history bytes");
  const appended = closed.subarray(before.length).toString("utf8").trim();
  const rows = appended ? appended.split("\n").map(line => JSON.parse(line)) : [];
  assert(rows.every(row => row.type === "custom" && row.customType === "session_exit"), "quit appended unexpected model/tool history");
  return rows.length;
}
