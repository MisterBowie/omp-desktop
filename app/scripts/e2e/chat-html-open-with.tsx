import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { zhCN } from "@pi-desktop/i18n";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { ToolDetailBlocks } from "../../apps/desktop/src/components/ToolDetails";
import { FileRefChip } from "../../apps/desktop/src/features/chat/transcript/shared";
import { ToolRow } from "../../apps/desktop/src/features/chat/transcript/ToolRow";
import { useOpenChatFileRef } from "../../apps/desktop/src/hooks/use-preview-target";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

declare global {
  var htmlOpenWithProbe: (projectRoot: string) => Promise<unknown>;
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** Real React, menu hooks and store; the preload IPC is the external boundary. */
globalThis.htmlOpenWithProbe = async (projectRoot) => {
  const destination = `${projectRoot}/pages/page.html`;
  const external: string[] = [];
  const checks: string[] = [];
  let missing = false;
  Object.defineProperty(window, "piDesktop", {
    configurable: true,
    value: {
      platform: "darwin",
      invoke: async (channel: string, input: { path?: string }) => {
        if (channel === "pi-desktop/fs/resolveRef") {
          return { ok: true, data: { match: missing ? null : {
            root: "workspace", relativePath: "pages/page.html", absolutePath: destination,
            projectRoot: { primary: true }, matchedBy: "suffix",
          } } };
        }
        if (channel === "pi-desktop/plugin/views") {
          return { ok: true, data: useAppStore.getState().pluginViews };
        }
        if (channel === "pi-desktop/fs/open") {
          assert(input.path === destination, "OS handoff received an unresolved path");
          external.push(input.path);
          return { ok: true, data: { ok: true } };
        }
        throw Error(`unexpected IPC: ${channel}`);
      },
    },
  });
  const i18n = createInstance();
  await i18n.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } }, interpolation: { escapeValue: false } });
  useAppStore.setState({
    workspace: { path: projectRoot, name: "HTML menu fixture" }, activeSessionId: "html-menu-session",
    pluginViews: [
      { pluginId: "pi.browser", viewId: "browser", title: "Browser" },
      { pluginId: "pi.file-manager", viewId: "manager", title: "Files" },
    ],
    workPanelTabs: [], activeWorkPanelTabId: null,
  });
  function Chip() {
    const openFile = useOpenChatFileRef();
    return <FileRefChip name="page.html" path="page.html" onOpen={openFile} />;
  }
  const host = document.createElement("div");
  host.style.cssText = "padding:24px;display:grid;gap:16px;max-width:800px";
  document.body.append(host);
  const errors: string[] = [];
  const root = createRoot(host, { onUncaughtError: (error) => errors.push(String(error)) });
  root.render(
    <I18nextProvider i18n={i18n}>
      <h2>HTML 打开方式</h2>
      <div data-fixture="markdown"><Markdown source="[网页文件](page.html) 与 `page.html`" /></div>
      <div data-fixture="chip"><Chip /></div>
      <div data-fixture="tool"><ToolRow message={{ id: "write", role: "tool", content: "", createdAt: "2026-10-21T00:00:00Z", toolName: "Write", toolArgs: { path: "page.html", content: "<!doctype html>" }, toolStatus: "success", toolCallId: "write-call" }} /></div>
      <div data-fixture="files"><ToolDetailBlocks blocks={[{ kind: "files", role: "output", label: "Files", paths: ["page.html"], hidden: 0 }]} /></div>
    </I18nextProvider>,
  );
  await paint();

  const item = (id: string) => document.querySelector<HTMLButtonElement>(`[data-context-menu-item="${id}"]`);
  async function rightClick(selector: string) {
    const target = host.querySelector<HTMLElement>(selector);
    assert(target, `reference did not render: ${selector}`);
    flushSync(() => target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 100,
    })));
    await paint();
    const trigger = item("open-with");
    assert(trigger?.textContent?.includes("打开方式"), `reference lacks HTML menu: ${selector}`);
    return trigger;
  }
  async function choose(selector: string, target: string) {
    const trigger = await rightClick(selector);
    flushSync(() => trigger.click());
    await paint();
    const choice = item(`open-with-${target}`);
    assert(choice, `submenu did not show ${target}`);
    const rect = choice.getBoundingClientRect();
    assert(rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight, "submenu escaped viewport");
    flushSync(() => choice.click());
    await paint();
    assert(!item("open-with"), "destination did not close its menu");
  }

  const entryPoints = [
    '[data-fixture="markdown"] a', '[data-fixture="markdown"] .chat-code-link',
    '[data-fixture="chip"] .chat-file-chip', '[data-fixture="tool"] .tool-row-summary.linked',
    '[data-fixture="files"] .tool-file-item.is-linked',
  ];
  for (const selector of entryPoints) {
    const before = external.length;
    await choose(selector, "default-browser");
    assert(external.length === before + 1, `reference failed OS handoff: ${selector}`);
    checks.push(`external: ${selector}`);
  }
  await choose(entryPoints[0], "built-in-browser");
  assert(useAppStore.getState().workPanelTabs.some((tab) => tab.kind === "plugin" && tab.resource === "pi.browser/browser" && tab.location === destination), "built-in browser opened a different file");
  checks.push("built-in browser uses resolved absolute path");
  await choose(entryPoints[0], "file-manager");
  assert(useAppStore.getState().workPanelTabs.some((tab) => tab.kind === "plugin" && tab.resource === "pi.file-manager/manager" && tab.location === "pages/page.html"), "File Manager opened a different file");
  checks.push("File Manager uses resolved project path");

  const trigger = await rightClick(entryPoints[0]);
  trigger.focus();
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  await paint();
  assert(document.activeElement === item("open-with-file-manager"), "ArrowRight did not focus submenu");
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert(!item("open-with-file-manager") && item("open-with") && document.activeElement === trigger, "Escape did not return to parent menu");
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert(!item("open-with"), "second Escape did not close the root menu");
  checks.push("keyboard submenu navigation and Escape focus restoration");

  missing = true;
  const beforeMissing = external.length;
  await choose(entryPoints[0], "default-browser");
  assert(external.length === beforeMissing, "a missing file opened a lookalike");
  checks.push("missing reference opens nothing");
  missing = false;
  const finalTrigger = await rightClick(entryPoints[0]);
  flushSync(() => finalTrigger.click());
  await paint();
  assert(errors.length === 0, errors.join("; "));
  return { status: "passed", checks, externalHandoffs: external.length, externalBoundary: "preload IPC stub; no OS browser launched" };
};
