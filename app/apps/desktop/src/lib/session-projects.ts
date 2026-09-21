import type { SessionSummary } from "@pi-desktop/shared";

export type SessionProject = {
  path: string;
  name: string;
  updatedAt: number;
};

function projectName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function normalizedProjectKey(projectPath?: string | null): string | null {
  const value = projectPath?.trim();
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function collectSessionProjects(sessions: SessionSummary[]): SessionProject[] {
  const projects = new Map<string, SessionProject>();

  for (const session of sessions) {
    const normalizedPath = normalizedProjectKey(session.projectPath);
    if (!normalizedPath || !session.projectPath) continue;

    const updatedAt = Date.parse(session.updatedAt);
    const existing = projects.get(normalizedPath);
    if (!existing) {
      projects.set(normalizedPath, {
        path: session.projectPath,
        name: projectName(session.projectPath),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
      continue;
    }
    if (Number.isFinite(updatedAt) && updatedAt > existing.updatedAt) {
      existing.updatedAt = updatedAt;
    }
  }

  return [...projects.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
  );
}
