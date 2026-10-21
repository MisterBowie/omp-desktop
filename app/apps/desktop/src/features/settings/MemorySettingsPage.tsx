import { DEFAULT_OMP_MEMORY, type OmpMemoryPage, type OmpMemorySettings } from "@pi-desktop/shared";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAgentProjects } from "../../components/settings/AgentCapabilityLayout";
import { Button, Input, Select } from "../../components/ui";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard, SettingsRow } from "./primitives";
import "./memory-settings.css";

export function MemorySettingsPage() {
  const { t } = useTranslation();
  const sessions = useAppStore((state) => state.sessions);
  const sessionOptions = useMemo(() => sessions
    .filter((session) => session.engine === "omp" && (session.worktree || !session.projectPath))
    .map((session) => ({
      path: `session:${session.id}`,
      name: `${session.title ?? session.id} · ${session.worktree?.branch ?? t("memory.temporary")}`,
    })), [sessions, t]);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects(sessionOptions);
  const scope = (path: string) =>
    path.startsWith("session:") ? { sessionId: path.slice(8) } : { projectPath: path };
  const [settings, setSettings] = useState<OmpMemorySettings>(DEFAULT_OMP_MEMORY);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [page, setPage] = useState<OmpMemoryPage>({ items: [], total: 0, offset: 0 });
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const clearArmed = armed !== null && armed === selectedProjectPath;
  const saveOperation = useRef(false);
  const request = useRef(0);
  const mounted = useRef(true);
  const message = (error: unknown) => {
    const code = error && typeof error === "object" ? Reflect.get(error, "errorCode") : undefined;
    return t(code === "CONFLICT" ? "memory.waitForIdle" : "memory.operationFailed");
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    let current = true;
    void api
      .getOmpMemorySettings()
      .then((value) => {
        if (current) {
          setSettings(value);
          setReady(true);
        }
      })
      .catch(() => {
        if (current) setError(t("memory.operationFailed"));
      });
    return () => {
      current = false;
    };
  }, [t]);
  async function load(path: string, search = "", offset = 0) {
    const id = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.queryOmpMemory({ ...scope(path), query: search, offset });
      if (id === request.current && mounted.current) {
        setPage(result);
        setAppliedQuery(search);
      }
    } catch (error) {
      if (id === request.current && mounted.current) setError(message(error));
    } finally {
      if (id === request.current && mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    setArmed(null);
    setQuery("");
    setAppliedQuery("");
    setPage({ items: [], total: 0, offset: 0 });
    request.current++;
    if (selectedProjectPath) void load(selectedProjectPath);
    else setBusy(false);
  }, [selectedProjectPath]);
  async function toggle(key: keyof OmpMemorySettings) {
    if (saveOperation.current) return;
    saveOperation.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await api.setOmpMemorySettings({ ...settings, [key]: !settings[key] });
      if (mounted.current) setSettings(result);
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      saveOperation.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function clear() {
    if (!selectedProjectPath) return;
    if (!clearArmed) {
      setArmed(selectedProjectPath);
      return;
    }
    const id = ++request.current;
    setBusy(true);
    setError(null);
    try {
      await api.clearOmpMemory(scope(selectedProjectPath));
      if (mounted.current && id === request.current) {
        setPage({ items: [], total: 0, offset: 0 });
        setArmed(null);
      }
    } catch (error) {
      if (mounted.current && id === request.current) setError(message(error));
    } finally {
      if (mounted.current && id === request.current) setBusy(false);
    }
  }
  function search(event: FormEvent) {
    event.preventDefault();
    if (selectedProjectPath) void load(selectedProjectPath, query.trim());
  }
  return (
    <div className="memory-settings-page">
      <SettingsCard>
        <p className="memory-settings-description">{t("memory.description")}</p>
        {(["autoSave", "autoRead"] as const).map((key) => (
          <SettingsRow key={key} title={t(`memory.${key}`)} description={t(`memory.${key}Description`)}>
            <button
              type="button"
              role="switch"
              aria-checked={settings[key]}
              aria-label={t(`memory.${key}`)}
              className={`settings-toggle${settings[key] ? " on" : ""}`}
              disabled={!ready || saving || busy}
              onClick={() => void toggle(key)}
            >
              <span className="settings-toggle-thumb" />
            </button>
          </SettingsRow>
        ))}
        <div className="memory-settings-notes">
          <p>{t("memory.costHint")}</p>
          <p>{t("memory.scopeHint")}</p>
        </div>
      </SettingsCard>
      <SettingsCard title={t("memory.browse")}>
        <div className="memory-settings-browser">
          <p className="memory-settings-description">{t("memory.browseHint")}</p>
          <label className="memory-settings-project">
            <span>{t("memory.project")}</span>
            <Select
              aria-label={t("memory.project")}
              value={selectedProjectPath ?? ""}
              disabled={saving}
              onChange={(event) => setSelectedProjectPath(event.target.value || null)}
            >
              <option value="">{t("memory.chooseProject")}</option>
              {options
                .filter((option) => option.path)
                .map((option) => (
                  <option key={option.path} value={option.path ?? ""}>
                    {option.name}
                  </option>
                ))}
            </Select>
          </label>
          <form className="memory-settings-search" onSubmit={search}>
            <Input
              aria-label={t("memory.search")}
              placeholder={t("memory.search")}
              value={query}
              maxLength={2000}
              onChange={(event) => setQuery(event.target.value)}
              disabled={!selectedProjectPath || busy}
            />
            <Button type="submit" disabled={!selectedProjectPath || busy}>
              {t("memory.search")}
            </Button>
            <Button
              disabled={!selectedProjectPath || busy}
              onClick={() => {
                setQuery("");
                if (selectedProjectPath) void load(selectedProjectPath);
              }}
            >
              {t("memory.refresh")}
            </Button>
          </form>
          <div className="memory-settings-count" aria-live="polite">
            {busy ? t("memory.loading") : t("memory.count", { count: page.total })}
          </div>
          {!busy && !page.items.length && <p className="memory-settings-empty">{t("memory.empty")}</p>}
          <div className="memory-settings-results" aria-label={t("memory.browse")}>
            {page.items.map((item) => (
              <article key={item.id} className="memory-settings-item">
                <p className="memory-settings-content">{item.content}</p>
              </article>
            ))}
          </div>
          <div className="memory-settings-footer">
            {!appliedQuery && (
              <div className="memory-settings-pagination">
                <Button
                  disabled={busy || page.offset === 0}
                  onClick={() =>
                    selectedProjectPath && void load(selectedProjectPath, "", Math.max(0, page.offset - 50))
                  }
                >
                  {t("memory.previous")}
                </Button>
                <Button
                  disabled={busy || page.offset + page.items.length >= page.total}
                  onClick={() => selectedProjectPath && void load(selectedProjectPath, "", page.offset + 50)}
                >
                  {t("memory.next")}
                </Button>
              </div>
            )}
            <div className="memory-settings-clear-actions">
              <Button
                className="memory-settings-clear"
                disabled={!selectedProjectPath || busy || saving}
                onClick={() => void clear()}
              >
                {t(clearArmed ? "memory.confirmClear" : "memory.clear")}
              </Button>
              {clearArmed && <Button onClick={() => setArmed(null)}>{t("memory.cancel")}</Button>}
            </div>
          </div>
          {clearArmed && <p className="memory-settings-description">{t("memory.clearHint")}</p>}
        </div>
      </SettingsCard>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
