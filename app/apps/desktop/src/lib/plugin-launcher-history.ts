export type PluginLaunchRecord = {
  id: string;
  usedAt: number;
};

const KEY = "pi.desktop.pluginLaunchHistory";
const MAX = 24;

function historyStorage(): Storage | null {
  try {
    return typeof globalThis !== "undefined" && "localStorage" in globalThis
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

export function loadPluginLaunchHistory(): PluginLaunchRecord[] {
  const storage = historyStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (record): record is PluginLaunchRecord =>
          Boolean(record) &&
          typeof (record as PluginLaunchRecord).id === "string" &&
          typeof (record as PluginLaunchRecord).usedAt === "number",
      )
      .sort((left, right) => right.usedAt - left.usedAt)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function rememberPluginLaunch(id: string): PluginLaunchRecord[] {
  const next = [
    { id, usedAt: Date.now() },
    ...loadPluginLaunchHistory().filter((record) => record.id !== id),
  ].slice(0, MAX);
  const storage = historyStorage();
  if (storage) {
    try {
      storage.setItem(KEY, JSON.stringify(next));
    } catch {
      // History is best-effort; a blocked storage must not break launching.
    }
  }
  return next;
}
