import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { I18nextProvider, useTranslation } from "react-i18next";
import type { OmpMarketState } from "@pi-desktop/shared";
import { en } from "../../packages/i18n/src/index";
import { api } from "../../apps/desktop/src/lib/api";
import { useOmpMarketplace } from "../../apps/desktop/src/features/plugins/useOmpMarketplace";
import { OmpMarketplacePanel } from "../../apps/desktop/src/features/plugins/OmpMarketplacePanel";
import { OmpPluginDetailSheet } from "../../apps/desktop/src/features/plugins/OmpPluginDetailSheet";
import { usePluginBrowseState } from "../../apps/desktop/src/features/plugins/browse-state";

const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); };
const find = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};
const settle = async (predicate: () => boolean, label = "Marketplace did not settle") => {
  for (let frame = 0; frame < 120; frame++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error(label);
};
const buttonWithText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text) ?? null;

function Probe() {
  const { t } = useTranslation();
  const market = useOmpMarketplace();
  return <><input aria-label="Unrelated input" /><OmpMarketplacePanel market={market} t={t} /><OmpPluginDetailSheet market={market} t={t} locale="en" /></>;
}

const plugin = {
  id: "focus@fixture", name: "focus", marketplace: "fixture", description: "Test marketplace card",
  version: "1.0.0", keywords: [], installable: true, declaresWithheld: ["mcp"],
} as const;
const before: OmpMarketState = {
  available: true,
  sources: [{ name: "fixture", sourceType: "local", sourceUri: "/fixture", updatedAt: "2026-10-27T00:00:00Z", pluginCount: 1 }],
  plugins: [plugin as unknown as OmpMarketState["plugins"][number]],
  installed: [],
};
const after: OmpMarketState = {
  ...before,
  installed: [{
    id: plugin.id, name: plugin.name, marketplace: plugin.marketplace, version: "1.0.0",
    installedAt: "2026-10-27T00:00:00Z", lastUpdated: "2026-10-27T00:00:00Z", enabled: true,
    components: { loaded: { skills: 2 }, withheld: ["mcp"] },
  }],
};

Object.assign(globalThis, { pluginDetailFocusProbe: async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } } });
  // Fixture only the IPC boundary; the hook, card, sheet and actions are real.
  const installs: string[] = [];
  const uninstalls: string[] = [];
  let current = before;
  Object.assign(api, {
    ompMarketState: async () => current,
    ompMarketInstall: async (id: string) => { installs.push(id); current = after; return current; },
    ompMarketUninstall: async (id: string) => { uninstalls.push(id); current = before; return current; },
  });
  usePluginBrowseState.setState({ tab: "market", query: "", category: "", marketplace: "", installedOnly: false });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<I18nextProvider i18n={i18n}><Probe /></I18nextProvider>));
  await settle(() => !!document.querySelector(".plugins-card-hit"));
  check(document.body.textContent?.includes("Not loaded: MCP servers") ?? false, "Card does not flag the withheld MCP server");
  const card = find(".plugins-card-hit");
  const open = async () => {
    card.focus(); card.click();
    await settle(() => !!document.querySelector('[role="dialog"]'));
  };
  const escape = async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle(() => !document.querySelector('[role="dialog"]'));
  };
  for (const theme of ["light", "dark"]) {
    document.documentElement.dataset.theme = theme;
    await open(); await escape();
    check(document.activeElement !== card, `${theme}: Escape left the marketplace opener focused`);
  }
  card.focus();
  check(document.activeElement === card, "Dismissal removed keyboard focusability");
  await open();
  find(".plugins-sheet-scrim").click();
  await settle(() => !document.querySelector('[role="dialog"]'));
  check(document.activeElement !== card, "Pointer dismissal left the opener focused");
  await open();
  const input = find('input[aria-label="Unrelated input"]'); input.focus(); await escape();
  check(document.activeElement === input, "Dismissal stole unrelated focus");

  // User path: install from the card, read the result back, uninstall from the sheet.
  buttonWithText("Install")?.click();
  await settle(() => !!buttonWithText("Installed") || document.body.textContent?.includes("Installed v1.0.0") === true, "Install did not settle");
  check(installs.join() === plugin.id, "Install did not reach the marketplace API exactly once");
  await open();
  check(document.body.textContent?.includes("Skills · 2") ?? false, "Sheet does not list the loaded skills");
  const confirm = window.confirm;
  window.confirm = () => false;
  buttonWithText("Uninstall")?.click();
  check(uninstalls.length === 0, "Uninstall ran without confirmation");
  window.confirm = () => true;
  buttonWithText("Uninstall")?.click();
  window.confirm = confirm;
  await settle(() => uninstalls.length === 1 && !!buttonWithText("Install"), "Uninstall did not settle");
  root.unmount(); container.remove();
  return "PASS: Escape/pointer dismissal clear opener focus; install and confirmed uninstall round-trip through the marketplace API";
} });
