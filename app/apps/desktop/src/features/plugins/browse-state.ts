import { create } from "zustand";
import type { TabId } from "./model";

/** Retain only browsing choices across route unmounts, never dialogs or work. */
export const usePluginBrowseState = create<{
  tab: TabId;
  installedQuery: string;
  query: string;
  category: string;
  marketplace: string;
  installedOnly: boolean;
  setTab: (tab: TabId) => void;
  setInstalledQuery: (installedQuery: string) => void;
  setQuery: (query: string) => void;
  setCategory: (category: string) => void;
  setMarketplace: (marketplace: string) => void;
  setInstalledOnly: (installedOnly: boolean) => void;
}>((set) => ({
  tab: "installed",
  installedQuery: "",
  query: "",
  category: "",
  marketplace: "",
  installedOnly: false,
  setTab: (tab) => set({ tab }),
  setInstalledQuery: (installedQuery) => set({ installedQuery }),
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setMarketplace: (marketplace) => set({ marketplace }),
  setInstalledOnly: (installedOnly) => set({ installedOnly }),
}));
