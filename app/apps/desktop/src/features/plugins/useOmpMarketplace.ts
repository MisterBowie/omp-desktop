import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OmpMarketState } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { usePluginBrowseState } from "./browse-state";
import { filterOmpMarketItems, ompMarketCategories, ompMarketItems, type OmpMarketItem } from "./omp-market-model";

/** What is running right now; one marketplace command at a time. */
export type OmpMarketBusy = { action: string; target: string } | null;

/**
 * The OMP marketplace tab (ADR 0333). Every mutation answers with the state
 * the main process re-read from OMP's registries, so the page never guesses
 * the outcome of a command.
 */
export function useOmpMarketplace() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const { query, setQuery, category, setCategory, marketplace, setMarketplace, installedOnly, setInstalledOnly } =
    usePluginBrowseState();
  const [state, setState] = useState<OmpMarketState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<OmpMarketBusy>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceInput, setSourceInput] = useState("");
  const busyRef = useRef<OmpMarketBusy>(null);

  const reload = useCallback(async () => {
    try {
      setState(await api.ompMarketState());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Run one command; a second request while one runs is ignored, not queued. */
  const perform = async (
    action: string,
    target: string,
    command: () => Promise<OmpMarketState>,
    success: string,
  ): Promise<boolean> => {
    if (busyRef.current) return false;
    const next = { action, target };
    busyRef.current = next;
    setBusy(next);
    try {
      setState(await command());
      showToast(success, { variant: "success" });
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      // A failed command can still have changed disk state (a partial update).
      await reload();
      return false;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const items = useMemo(() => ompMarketItems(state), [state]);
  const categories = useMemo(() => ompMarketCategories(items), [items]);
  const visibleItems = useMemo(
    () => filterOmpMarketItems(items, { query, installedOnly, marketplace, category }),
    [items, query, installedOnly, marketplace, category],
  );
  const selected: OmpMarketItem | null = useMemo(
    () => (selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null),
    [items, selectedId],
  );

  // A removed source cannot stay selected as a filter.
  useEffect(() => {
    if (marketplace && state && !state.sources.some((source) => source.name === marketplace)) setMarketplace("");
  }, [marketplace, setMarketplace, state]);

  const closeDetail = useCallback(() => {
    // Escape leaves the opener focused; match pointer dismissal without
    // removing the focus indicator used by subsequent keyboard navigation.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches(".plugins-card-hit")) focused.blur();
    setSelectedId(null);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedId, closeDetail]);

  const addSource = async () => {
    const source = sourceInput.trim();
    if (!source) return;
    const added = await perform("addSource", source, () => api.ompMarketAddSource(source), t("plugins.ompMarket.sourceAdded"));
    if (added) setSourceInput("");
  };

  const removeSource = (name: string) => {
    if (!window.confirm(t("plugins.ompMarket.removeSourceConfirm", { name }))) return;
    void perform("removeSource", name, () => api.ompMarketRemoveSource(name), t("plugins.ompMarket.sourceRemoved"));
  };

  const updateSources = (name?: string) =>
    void perform("updateSources", name ?? "", () => api.ompMarketUpdateSources(name), t("plugins.ompMarket.sourcesUpdated"));

  const install = (item: OmpMarketItem) =>
    void perform("install", item.id, () => api.ompMarketInstall(item.id), t("plugins.ompMarket.installedToast", { name: item.name }));

  const uninstall = (item: OmpMarketItem) => {
    if (!window.confirm(t("plugins.ompMarket.uninstallConfirm", { name: item.name }))) return;
    void perform("uninstall", item.id, () => api.ompMarketUninstall(item.id), t("plugins.ompMarket.uninstalledToast", { name: item.name }));
  };

  const setEnabled = (item: OmpMarketItem, enabled: boolean) =>
    void perform(
      "setEnabled",
      item.id,
      () => api.ompMarketSetEnabled(item.id, enabled),
      t(enabled ? "plugins.ompMarket.enabledToast" : "plugins.ompMarket.disabledToast", { name: item.name }),
    );

  const upgrade = (item: OmpMarketItem) =>
    void perform("upgrade", item.id, () => api.ompMarketUpgrade(item.id), t("plugins.ompMarket.upgradedToast", { name: item.name }));

  return {
    state,
    loading,
    busy,
    items,
    visibleItems,
    categories,
    query,
    setQuery,
    category,
    setCategory,
    marketplace,
    setMarketplace,
    installedOnly,
    setInstalledOnly,
    selected,
    openDetail: setSelectedId,
    closeDetail,
    sourceInput,
    setSourceInput,
    addSource,
    removeSource,
    updateSources,
    install,
    uninstall,
    setEnabled,
    upgrade,
  };
}

export type OmpMarketplaceModel = ReturnType<typeof useOmpMarketplace>;
