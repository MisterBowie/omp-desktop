import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// Only tracked test paths, bounded line numbers and fixed categories may leave
// the runner. Never copy messages, assertion values, stack text or raw logs.
export function summarizeSourceTests(input, tracked) {
  const allowed = new Set(tracked);
  const locations = new Map();
  const text = String(input).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  for (const row of text.split("\n")) {
    const owner = row.match(/\b((?:packages|apps)\/[a-z0-9-]+|docs) test:/)?.[1];
    if (!owner) continue;
    for (const match of row.matchAll(/\b((?:src|test)\/[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::(\d+))?/g)) {
      const path = `app/${owner}/${match[1]}`;
      if (!allowed.has(path)) continue;
      const line = Math.min(1_000_000, Number(match[2] ?? 0));
      if (!/FAIL|✖|❯|test at|\bat\s+/.test(row)) continue;
      const previous = locations.get(path) ?? new Set();
      previous.add(line);
      locations.set(path, previous);
    }
  }
  const categories = [
    ["ASSERTION", /AssertionError|ERR_ASSERTION/],
    ["MODULE_MISSING", /ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/],
    ["VERSION_UNREADABLE", /unreadable version/],
    ["TIMEOUT", /TimeoutError|timed out|ready-timeout/],
    ["PROCESS_EXIT", /exited before ready|process exited/],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { schemaVersion: 1, categories, locations: [...locations].map(([path, lines]) => ({ path, lines: [...lines].sort((a, b) => a - b) })) };
}

if (process.argv[2] && process.argv[3]) {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
  writeFileSync(process.argv[3], JSON.stringify(summarizeSourceTests(readFileSync(process.argv[2], "utf8"), tracked), null, 2) + "\n");
}
