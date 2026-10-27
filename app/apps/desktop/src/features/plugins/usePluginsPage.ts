import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { usePluginBrowseState } from "./browse-state";
import type {
  PluginPermissionReview,
  PluginServiceStatus,
  PluginSummary,
  ProjectRecord,
  ProjectWorkspace,
} from "@pi-desktop/shared";
import {
  GROUP_ORDER,
  type GroupId,
  TEMPLATE_IDS,
  type TemplateId,
  groupOf,
  matchesQuery,
} from "./model";

export function usePluginsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const plugins = useAppStore((s) => s.plugins);
  const settings = useAppStore((s) => s.settings);
  const refreshPlugins = useAppStore((s) => s.refreshPlugins);
  const showToast = useAppStore((s) => s.showToast);
  const activateProject = useAppStore((s) => s.activateProject);
  /**
   * The folder open in this window. Scoping something to "this project" is only
   * meaningful relative to it, so the control needs it as its default target.
   */
  const currentProjectPath = useAppStore((s) => s.workspace?.path ?? null);

  const { tab, setTab, installedQuery, setInstalledQuery } = usePluginBrowseState();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadingId, setReloadingId] = useState<string | null>(null);
  /**
   * A development plugin whose folder was chosen but not yet granted. Loading a
   * folder is a request: nothing is registered until the user answers, so the
   * declaration waits here the same way an install does.
   */
  const [pendingReview, setPendingReview] = useState<PluginPermissionReview | null>(null);
  const [templatePick, setTemplatePick] = useState<TemplateId | null>(null);
  const [creating, setCreating] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [services, setServices] = useState<PluginServiceStatus[]>([]);
  const [settingsPlugin, setSettingsPlugin] = useState<PluginSummary | null>(null);

  // Every scope control offers the same folder list, so it is fetched once here
  // and handed down rather than re-queried per row.
  useEffect(() => {
    void api
      .listProjects()
      .then((res) => setProjects(res.projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  // The installed list is re-read whenever this surface opens.
  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  // Service state changes arrive as pluginChanged events, so the list stays
  // truthful while the supervisor restarts a crashed worker.
  useEffect(() => {
    const refresh = () => {
      void api
        .listPluginServices()
        .then(setServices)
        .catch(() => setServices([]));
    };
    refresh();
    return api.onPluginChanged(refresh);
  }, []);

  const servicesByPlugin = useMemo(() => {
    const map = new Map<string, PluginServiceStatus[]>();
    for (const status of services) {
      const list = map.get(status.pluginId);
      if (list) list.push(status);
      else map.set(status.pluginId, [status]);
    }
    return map;
  }, [services]);

  const stats = useMemo(() => ({ total: plugins.length }), [plugins]);

  const filteredInstalled = useMemo(
    () =>
      plugins.filter((plugin) =>
        matchesQuery(
          installedQuery,
          plugin.name,
          plugin.id,
          plugin.description,
          plugin.author,
        ),
      ),
    [plugins, installedQuery],
  );

  const installedGroups = useMemo(() => {
    const buckets = new Map<GroupId, PluginSummary[]>();
    for (const plugin of filteredInstalled) {
      const id = groupOf(plugin);
      const bucket = buckets.get(id);
      if (bucket) bucket.push(plugin);
      else buckets.set(id, [plugin]);
    }
    return GROUP_ORDER.flatMap((id) => {
      const rows = buckets.get(id);
      if (!rows?.length) return [];
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return [{ id, rows }];
    });
  }, [filteredInstalled]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const loadDev = () =>
    run(async () => {
      const result = await api.loadDevPlugin();
      // The folder picker reports the declaration; the review is the grant.
      if (result.canceled || !result.review) return;
      setPendingReview(result.review);
    });

  // A pi CLI extension becomes a development plugin holding `agent.extension`
  // (spec 07-plugins/16 §3); the confirm is the trust decision. Declared npm
  // dependencies are installed (scripts disabled) before the first load.
  const importExtension = () =>
    run(async () => {
      if (!window.confirm(t("plugins.agentExtension.importConfirm"))) return;
      const result = await api.importPiExtension();
      if (result.canceled) return;
      await refreshPlugins();
      if (result.dependencies.state === "failed") {
        showToast(
          t("plugins.importExtensionDepsFailed", { id: result.id, error: result.dependencies.error }),
          { variant: "warning" },
        );
        return;
      }
      showToast(t("plugins.importExtensionDone", { id: result.id }), { variant: "success" });
    });

  const reloadPlugin = (id: string) =>
    run(async () => {
      setReloadingId(id);
      try {
        const result = await api.reloadPlugin(id);
        // The manifest asks for more than it is running with: ask first, and
        // load only after the answer.
        if (result.review) {
          setPendingReview(result.review);
          return;
        }
        await refreshPlugins();
        showToast(t("plugins.reloadDone"), { variant: "success" });
      } finally {
        setReloadingId(null);
      }
    });

  const installPackage = () =>
    run(async () => {
      await api.installPluginFromPackage();
      await refreshPlugins();
      showToast(t("plugins.installPackageDone"), { variant: "success" });
    });

  const createFromTemplate = async (template: TemplateId) => {
    setCreating(true);
    try {
      const created = await api.createPluginFromTemplate(template);
      setTemplatePick(null);
      // A canceled folder picker is not a failure: leave the page untouched.
      if (created.canceled) return;
      // Scaffolding writes files; loading waits for the same review a folder
      // picked by hand goes through.
      if (created.review) {
        await activateTemplateProject(created);
        setPendingReview(created.review);
        return;
      }
      await finishTemplate(created);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setCreating(false);
    }
  };

  /** Open the scaffolded folder so the sources land in the workspace. */
  const activateTemplateProject = async (created: { dir?: string }) => {
    try {
      return created.dir ? await activateProject(created.dir) : null;
    } catch (e) {
      // The plugin exists on disk either way; a failed open is reported on its
      // own instead of replacing the result.
      return e;
    }
  };

  const finishTemplate = async (created: { dir?: string; name?: string }) => {
    await refreshPlugins();
    const opened = await activateTemplateProject(created);
    showToast(
      t(
        opened && !(opened instanceof Error)
          ? "plugins.newFromTemplateOpened"
          : "plugins.newFromTemplateDone",
        { name: created.name ?? "" },
      ),
      { variant: "success" },
    );
    if (opened instanceof Error) {
      showToast(opened.message, { variant: "error" });
    }
  };

  /**
   * The answer to a development permission review. The accepted set is what the
   * user just saw, and it becomes the ceiling every later hot reload is measured
   * against — a folder or a manifest edit can never widen it on its own.
   */
  const confirmReview = async () => {
    const review = pendingReview;
    if (!review) return;
    setBusyId(review.id);
    try {
      if (review.kind === "reload") {
        await api.confirmReloadPlugin({
          id: review.id,
          grantedPermissions: review.permissions,
        });
        await refreshPlugins();
        showToast(t("plugins.reloadDone"), { variant: "success" });
      } else {
        await api.confirmLoadDevPlugin({
          path: review.path,
          grantedPermissions: review.permissions,
        });
        await refreshPlugins();
        showToast(t("plugins.loadDevDone"), { variant: "success" });
      }
      setPendingReview(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const overflowActions = [
    { key: "installPackage", run: installPackage },
    { key: "loadDev", run: loadDev },
    { key: "importExtension", run: importExtension },
    {
      key: "newFromTemplate",
      run: async () => {
        setTemplatePick(TEMPLATE_IDS[0]);
      },
    },
  ];

  return {
    t,
    locale,
    plugins,
    settings,
    refreshPlugins,
    showToast,
    activateProject,
    currentProjectPath,
    tab,
    setTab,
    installedQuery,
    setInstalledQuery,
    projects,
    busyId,
    reloadingId,
    templatePick,
    setTemplatePick,
    creating,
    headerMenu,
    setHeaderMenu,
    rowMenu,
    setRowMenu,
    servicesByPlugin,
    settingsPlugin,
    setSettingsPlugin,
    stats,
    filteredInstalled,
    installedGroups,
    run,
    loadDev,
    importExtension,
    reloadPlugin,
    installPackage,
    createFromTemplate,
    overflowActions,
    pendingReview,
    setPendingReview,
    confirmReview,
  };
}

export type PluginsPageModel = ReturnType<typeof usePluginsPage>;
