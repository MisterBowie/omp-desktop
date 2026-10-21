import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

function loadModule(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
      return imports[id];
    }, module.exports, module,
  );
  return module.exports;
}

const calls = { files: [], urls: [], tabs: [], external: [], toasts: [], lookups: [], enabled: [] };
const views = [
  { pluginId: "pi.file-manager", viewId: "manager" },
  { pluginId: "pi.browser", viewId: "browser" },
];
const state = {
  workspace: { path: "/project" }, activeSessionId: "session-1", pluginViews: views,
  openFileInWorkPanel: (...args) => calls.files.push(args),
  openUrlInWorkPanel: (...args) => calls.urls.push(args),
  openWorkPanelTab: (tab) => calls.tabs.push(tab),
  showToast: (...args) => calls.toasts.push(args),
};
const store = Object.assign((select) => select(state), {
  getState: () => state, setState: (update) => Object.assign(state, update),
});
let lookup;
let externalFails;
let plugin;
const api = {
  fsResolveRef: async (...args) => { calls.lookups.push(args); return { match: await lookup() }; },
  fsOpen: async (path) => { if (externalFails) throw Error("OS refused"); calls.external.push(path); },
  listPluginViews: async () => state.pluginViews,
  listPlugins: async () => ({ plugins: plugin ? [plugin] : [] }),
  enablePlugin: async (id) => { calls.enabled.push(id); state.pluginViews = views; },
  reloadPlugin: async () => { state.pluginViews = views; return {}; },
};
const shared = await import("@pi-desktop/shared");
const preview = loadModule("../src/hooks/use-preview-target.ts", {
  react: React,
  "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
  "@pi-desktop/shared": shared,
  "../stores/app-store": { useAppStore: store },
  "../lib/api": { api },
  "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {}),
  "../lib/open-http-url": { openHttpUrl: (...args) => calls.urls.push(args) },
  "../lib/work-panel-tabs": loadModule("../src/lib/work-panel-tabs.ts", {}),
});
const match = (extra = {}) => ({
  root: "workspace", relativePath: "pages/page.html", absolutePath: "/project/pages/page.html",
  matchedBy: "exact-relative", projectRoot: { primary: true }, ...extra,
});
function reset(value = match()) {
  Object.values(calls).forEach((items) => items.splice(0));
  state.workspace = { path: "/project" }; state.activeSessionId = "session-1"; state.pluginViews = views;
  lookup = async () => value; externalFails = false; plugin = null;
}
function opener() {
  let open;
  function Harness() { open = preview.useOpenChatFileRef(); return null; }
  renderToStaticMarkup(React.createElement(Harness));
  return open;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function open(destination, path = "page.html") {
  opener()(path, undefined, undefined, destination ? { destination } : undefined);
  await flush();
}

test("default browser receives the exact resolved absolute HTML path", async () => {
  reset(); await open("default-browser");
  assert.deepEqual(calls.external, ["/project/pages/page.html"]);
  assert.deepEqual(calls.lookups, [["page.html", "session-1"]]);
  assert.deepEqual(calls.urls, []); assert.deepEqual(calls.tabs, []);
});
test("built-in browser receives the same resolved file as an absolute path", async () => {
  reset(); await open("built-in-browser");
  assert.deepEqual(calls.urls, [["/project/pages/page.html"]]); assert.deepEqual(calls.external, []);
});
test("File Manager explicitly opens HTML as a file", async () => {
  reset(); await open("file-manager");
  assert.equal(calls.tabs[0]?.location, "pages/page.html"); assert.deepEqual(calls.urls, []);
});
test("scratch and sibling-root references reach the same external destination", async () => {
  for (const value of [
    match({ root: "scratch", absolutePath: "/data/scratch/session-1/page.html" }),
    match({ projectRoot: { primary: false }, absolutePath: "/other/pages/page.html" }),
  ]) {
    reset(value); await open("default-browser"); assert.deepEqual(calls.external, [value.absolutePath]);
  }
});
test("missing references never open a lookalike or fall through to another destination", async () => {
  reset(null); await open("default-browser");
  assert.deepEqual(calls.external, []); assert.deepEqual(calls.urls, []); assert.deepEqual(calls.tabs, []);
  assert.equal(calls.toasts[0]?.[0], "chat.fileRefMissing");
});
test("OS handoff failures are reported without switching destinations", async () => {
  reset(); externalFails = true; await open("default-browser");
  assert.equal(calls.toasts[0]?.[0], "chat.defaultBrowserOpenFailed"); assert.deepEqual(calls.urls, []);
});
for (const change of ["workspace", "session"]) {
  test(`a ${change} switch during completion cannot open a stale reference`, async () => {
    reset(); let finish; lookup = () => new Promise((resolve) => { finish = resolve; });
    const handler = opener(); handler("page.html", undefined, undefined, { destination: "default-browser" });
    if (change === "workspace") state.workspace = { path: "/new-project" }; else state.activeSessionId = "session-2";
    finish(match()); await flush();
    assert.deepEqual(calls.external, []); assert.deepEqual(calls.urls, []); assert.deepEqual(calls.tabs, []);
  });
}
test("plain HTML clicks keep the current side-browser behavior", async () => {
  reset(); await open(); assert.deepEqual(calls.urls, [["pages/page.html"]]); assert.deepEqual(calls.external, []);
});
test("plain non-HTML clicks still prefer the available file manager", async () => {
  reset(match({ relativePath: "src/a.ts", absolutePath: "/project/src/a.ts" })); await open(undefined, "a.ts");
  assert.equal(calls.tabs[0]?.location, "src/a.ts"); assert.deepEqual(calls.external, []);
});
test("a missing built-in browser is reported without an OS fallback", async () => {
  reset(); state.pluginViews = []; await open("built-in-browser");
  assert.equal(calls.toasts[0]?.[0], "chat.builtInBrowserUnavailable"); assert.deepEqual(calls.external, []); assert.deepEqual(calls.urls, []);
});
test("remote sessions cannot hand a server path to the local OS", async () => {
  reset(); state.activeSessionId = "remote:host:session"; await open("default-browser");
  assert.deepEqual(calls.external, []); assert.deepEqual(calls.urls, []);
});
test("an unavailable file manager reports an error instead of opening another app", async () => {
  reset(); state.pluginViews = []; await open("file-manager");
  assert.equal(calls.toasts[0]?.[0], "chat.fileManagerOpenFailed"); assert.deepEqual(calls.files, []); assert.deepEqual(calls.external, []);
});
test("an explicit File Manager choice may restore its existing ui.view grant", async () => {
  reset(); state.pluginViews = [];
  plugin = { id: "pi.file-manager", bundled: true, enabled: false, permissions: ["ui.view"] };
  await open("file-manager"); assert.deepEqual(calls.enabled, ["pi.file-manager"]); assert.equal(calls.tabs[0]?.location, "pages/page.html");
});
test("a plugin without the existing ui.view permission is never enabled", async () => {
  reset(); state.pluginViews = [];
  plugin = { id: "pi.file-manager", bundled: true, enabled: false, permissions: [] };
  await open("file-manager"); assert.deepEqual(calls.enabled, []); assert.deepEqual(calls.tabs, []);
});


const menuHooks = loadModule("../src/hooks/use-chat-file-menu.tsx", {
  react: React,
  "react/jsx-runtime": await import("react/jsx-runtime"),
  "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
  "../components/ContextMenu": { useContextMenu: () => ({}) },
  "../components/icons": new Proxy({}, { get: () => () => null }),
  "../lib/chat-links": loadModule("../src/lib/chat-links.ts", {}),
  "./use-preview-target": preview,
  "./use-chat-session-capability": loadModule("../src/hooks/use-chat-session-capability.ts", {
    "../stores/app-store": { useAppStore: store },
  }),
});
function menuFor(path) {
  let items;
  function Harness() { items = menuHooks.useChatFileMenuItems()({ path }); return null; }
  renderToStaticMarkup(React.createElement(Harness));
  return items;
}
test("HTML and HTM references expose the upstream three-destination submenu", () => {
  for (const path of ["page.html", "page.htm", "PAGE.HTML"]) {
    reset(); const items = menuFor(path);
    assert.deepEqual(items.map((item) => item.id), ["open-with", "copy-full-path", "copy-relative-path"]);
    assert.deepEqual(items[0].submenu.map((item) => item.id), [
      "open-with-file-manager", "open-with-built-in-browser", "open-with-default-browser",
    ]);
  }
});
test("choosing the real menu entry reaches the resolved OS destination", async () => {
  reset(); menuFor("page.html")[0].submenu.find((item) => item.id === "open-with-default-browser").onSelect();
  await flush(); assert.deepEqual(calls.external, ["/project/pages/page.html"]);
});
test("other file types keep path copying without HTML open destinations", () => {
  reset(); assert.deepEqual(menuFor("a.ts").map((item) => item.id), ["copy-full-path", "copy-relative-path"]);
});
test("remote sessions never expose native open destinations", () => {
  reset(); state.activeSessionId = "remote:host:session";
  assert.deepEqual(menuFor("page.html").map((item) => item.id), ["copy-full-path", "copy-relative-path"]);
});
test("a File Manager startup that races a session switch cannot open a stale tab", async () => {
  reset(); state.pluginViews = []; let resolveViews;
  const original = api.listPluginViews;
  api.listPluginViews = () => new Promise((resolve) => { resolveViews = resolve; });
  try {
    const handle = opener(); handle("page.html", undefined, undefined, { destination: "file-manager" });
    await flush(); state.activeSessionId = "session-2"; resolveViews(views); await flush();
    assert.deepEqual(calls.tabs, []);
  } finally { api.listPluginViews = original; }
});

async function withClipboard(run, fail = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const copied = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    clipboard: { writeText: async (value) => { if (fail) throw Error("clipboard refused"); copied.push(value); } },
  } });
  try { await run(copied); } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else delete globalThis.navigator;
  }
}
test("copy actions use the resolved absolute and project-relative paths", async () => {
  await withClipboard(async (copied) => {
    reset(); menuFor("page.html").find((item) => item.id === "copy-full-path").onSelect(); await flush();
    menuFor("page.html").find((item) => item.id === "copy-relative-path").onSelect(); await flush();
    assert.deepEqual(copied, ["/project/pages/page.html", "pages/page.html"]);
  });
});
test("a scratch reference never pretends to have a project-relative path", async () => {
  await withClipboard(async (copied) => {
    reset(match({ root: "scratch", absolutePath: "/data/scratch/page.html" }));
    menuFor("page.html").find((item) => item.id === "copy-relative-path").onSelect(); await flush();
    assert.deepEqual(copied, []); assert.equal(calls.toasts[0]?.[0], "chat.relativePathUnavailable");
  });
});
test("a refused clipboard operation reports its failure", async () => {
  await withClipboard(async () => {
    reset(); menuFor("page.html").find((item) => item.id === "copy-full-path").onSelect(); await flush();
    assert.equal(calls.toasts[0]?.[0], "chat.copyFailed");
  }, true);
});
