import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_IMPORT_GROUP_BY,
  formatImportDate,
  groupImportCandidates,
  projectNameOf,
} from "../src/lib/import-groups.ts";

const labels = {
  noProject: "No project",
  sources: {
    "claude-code": "Claude Code",
    opencode: "OpenCode",
    codex: "Codex",
    pi: "Pi",
  },
};

function candidate(overrides) {
  return {
    source: "codex",
    externalId: "session-1",
    title: "Session",
    projectPath: "/work/alpha",
    model: null,
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T11:00:00.000Z",
    messageCount: 2,
    ...overrides,
  };
}

test("groups candidates by exact project path with no-project last", () => {
  const groups = groupImportCandidates(
    [
      candidate({ externalId: "none", projectPath: null, updatedAt: "2026-07-26T12:00:00.000Z" }),
      candidate({ externalId: "alpha-old" }),
      candidate({ externalId: "beta", projectPath: "C:\\work\\beta", updatedAt: "2026-07-25T13:00:00.000Z" }),
      candidate({ externalId: "alpha-new", updatedAt: "2026-07-25T14:00:00.000Z" }),
    ],
    "path",
    labels,
  );

  assert.deepEqual(
    groups.map(({ id, name, projectPath }) => ({ id, name, projectPath })),
    [
      { id: "path:/work/alpha", name: "alpha", projectPath: "/work/alpha" },
      { id: "path:C:\\work\\beta", name: "beta", projectPath: "C:\\work\\beta" },
      { id: "path:(none)", name: "No project", projectPath: null },
    ],
  );
  assert.deepEqual(
    groups[0].items.map((item) => item.externalId),
    ["alpha-new", "alpha-old"],
  );
});

test("keeps source grouping as the panel default", () => {
  assert.equal(DEFAULT_IMPORT_GROUP_BY, "source");
});

test("groups candidates by source and orders groups by latest activity", () => {
  const groups = groupImportCandidates(
    [
      candidate({ source: "codex", externalId: "codex" }),
      candidate({ source: "pi", externalId: "pi", updatedAt: "2026-07-25T15:00:00.000Z" }),
    ],
    "source",
    labels,
  );

  assert.deepEqual(
    groups.map(({ id, name }) => ({ id, name })),
    [
      { id: "source:pi", name: "Pi" },
      { id: "source:codex", name: "Codex" },
    ],
  );
});

test("extracts project names from POSIX and Windows paths", () => {
  assert.equal(projectNameOf("/work/alpha/"), "alpha");
  assert.equal(projectNameOf("C:\\work\\beta\\"), "beta");
  assert.equal(projectNameOf(null), "");
});

test("formats import dates with the selected app locale", () => {
  const timestamp = "2026-07-25T12:00:00.000Z";
  assert.match(formatImportDate(timestamp, "en-US"), /Jul/);
  assert.match(formatImportDate(timestamp, "zh-CN"), /2026/);
  assert.equal(formatImportDate("not-a-date", "zh-CN"), "not-a-date");
});
