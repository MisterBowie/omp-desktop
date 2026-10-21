import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Return only allowlisted public source coordinates, never log text. */
export function identifyPublicTestFailures(log, sources) {
  const failures = log.split(/\r?\n/).filter((line) => /(?:not ok\s+\d+\s+-\s+|✖\s+|FAIL\s+)/.test(line));
  const matches = [];
  for (const [path, source] of sources) {
    if (!/^app\/[A-Za-z0-9_./-]+\.test\.(?:mjs|ts)$/.test(path)) continue;
    for (const match of source.matchAll(/\b(?:test|it)\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
      let title;
      try { title = match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1); }
      catch { continue; }
      if (title.length < 10 || !failures.some((line) => line.includes(title))) continue;
      matches.push({ path, line: source.slice(0, match.index).split("\n").length });
      if (matches.length === 30) return matches;
    }
  }
  return matches;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "app/**/*.test.mjs", "app/**/*.test.ts"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const sources = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
  const matches = identifyPublicTestFailures(readFileSync(process.argv[2], "utf8"), sources);
  for (const { path, line } of matches) console.log(`::notice title=Known failing public test source::${path}:${line}`);
  if (!matches.length) console.log("::notice title=Known failing public test source::NO_ALLOWLIST_MATCH");
}
