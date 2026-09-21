import assert from "node:assert/strict";
import test from "node:test";
import { collectSessionProjects } from "../src/lib/session-projects.ts";

function session(overrides) {
  return {
    id: "session-1",
    title: "Session",
    projectPath: undefined,
    mode: "agent",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T11:00:00.000Z",
    ...overrides,
  };
}

test("creates one project directory entry per imported session path", () => {
  const projects = collectSessionProjects([
    session({ id: "alpha-old", projectPath: "/work/alpha" }),
    session({
      id: "alpha-new",
      projectPath: "/work/alpha/",
      updatedAt: "2026-07-26T11:00:00.000Z",
    }),
    session({ id: "beta", projectPath: "C:\\work\\beta" }),
    session({ id: "temporary" }),
  ]);

  assert.deepEqual(
    projects.map(({ path, name }) => ({ path, name })),
    [
      { path: "/work/alpha", name: "alpha" },
      { path: "C:\\work\\beta", name: "beta" },
    ],
  );
  assert.equal(projects[0].updatedAt, Date.parse("2026-07-26T11:00:00.000Z"));
});

test("ignores blank project paths", () => {
  assert.deepEqual(
    collectSessionProjects([session({ projectPath: " " }), session({ projectPath: null })]),
    [],
  );
});
