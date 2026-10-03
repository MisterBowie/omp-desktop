import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
import test from "node:test";

/**
 * M5/T20-D (B9): the composer's mode affordance is driven by the engine's
 * capability declaration.
 *
 * The real `ComposerToolbar` renders (through Vite, so the real component and
 * its real imports are used) with the option list the real `Composer` derives
 * from the session engine. Hiding/cycling is only an affordance — the
 * main-process boundaries are covered by `engine-session-ipc.test.mjs` and
 * `engine-router.test.mjs` — but an affordance that offers a mode the boundary
 * refuses would be exactly the "button only" bug this row exists to prevent.
 */
test("the composer mode chip is driven by the engine's declared modes", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  try {
    const { ComposerToolbar } = await server.ssrLoadModule(
      "/src/features/chat/composer/ComposerToolbar.tsx",
    );
    const { offeredModes, nextMode } = await server.ssrLoadModule(
      "/src/features/chat/composer/model.ts",
    );
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
    // The toolbar reads the platform from the preload bridge; SSR runs without
    // a window, so the smallest honest stand-in is a darwin desktop bridge.
    globalThis.window = { piDesktop: { platform: "darwin" } };

    const render = (props) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ComposerToolbar, props),
        ),
      );
    const baseProps = {
      t: i18n.t.bind(i18n),
      planningLive: false,
      providerId: "provider",
      modelId: "model",
      thinkingLevel: "off",
      composerPermissionMode: "ask",
      permissionOpen: false,
      setPermissionOpen: () => {},
      controlsBlocked: false,
      pasting: false,
      pickAndAttach: async () => {},
      configureActiveSession: async () => {},
      showToast: () => {},
      // The model picker's controller is only dereferenced once its menu is
      // open, which this acceptance never opens; the fields it reads on the
      // trigger path are the closed-menu defaults.
      modelMenu: {
        open: false,
        setOpen: () => {},
        view: "root",
        query: "",
        setQuery: () => {},
        modelHighlight: -1,
        setModelHighlight: () => {},
        thinkingHighlight: -1,
        setThinkingHighlight: () => {},
        rootMenuRef: { current: null },
        modelSearchRef: { current: null },
        modelListRef: { current: null },
        thinkingListRef: { current: null },
        modelGroups: [],
        hiddenCursorProviders: 0,
        flatModels: [],
        thinkingMenuLevels: [],
        showView: () => {},
        selectModel: async () => {},
        commitThinkingLevel: () => {},
        selectThinkingLevel: () => {},
        onMenuKeyDown: () => {},
      },
      modelLabel: "model",
      thinkingLabel: "off",
      contextUsage: null,
      enhancementDraft: "",
      value: "",
      modelReady: true,
      sendBlocked: false,
      enhancingPrompt: false,
      enhancementUndoText: null,
      enhancePrompt: async () => {},
      undoPromptEnhancement: () => {},
      clearEnhancementError: () => {},
      runActive: false,
      hasDraftContent: false,
      abort: async () => {},
      submit: async () => {},
    };

    // Both shipped engines declare the whole cycle, so a real session offers it.
    for (const engine of ["pi", "omp"]) {
      assert.deepEqual(offeredModes(engine), ["agent", "plan", "goal"], engine);
    }

    // Full cycle: the chip cycles Agent → Plan → Goal → Agent (unchanged
    // production behavior), and a stale mode outside the cycle lands on it.
    const full = offeredModes("omp");
    assert.equal(nextMode("agent", full), "plan");
    assert.equal(nextMode("plan", full), "goal");
    assert.equal(nextMode("goal", full), "agent");
    assert.equal(nextMode("chat", full), "agent");
    // Restricted cycle: the chip can only reach the declared modes.
    assert.equal(nextMode("agent", ["agent", "plan"]), "plan");
    assert.equal(nextMode("plan", ["agent", "plan"]), "agent");
    assert.equal(nextMode("goal", ["agent", "plan"]), "agent");

    // The chip renders for the full cycle and marks the current mode.
    const fullMarkup = render({
      ...baseProps,
      mode: "plan",
      modeOptions: full,
    });
    assert.match(fullMarkup, /class="icon-btn mode-chip composer-mode-chip"/);
    assert.match(fullMarkup, /data-mode="plan"/);
    assert.doesNotMatch(fullMarkup, /mode-chip composer-mode-chip"[^>]*disabled/);

    // A single declared mode equal to the current one cannot be cycled: the
    // chip is disabled instead of pretending a switch exists.
    const singleMarkup = render({
      ...baseProps,
      mode: "agent",
      modeOptions: ["agent"],
    });
    assert.match(singleMarkup, /class="icon-btn mode-chip composer-mode-chip"/);
    assert.match(singleMarkup, /data-mode="agent"/);
    assert.match(singleMarkup, /disabled/);

    // No declared mode at all: there is no mode control to render.
    const noneMarkup = render({ ...baseProps, mode: "agent", modeOptions: [] });
    assert.doesNotMatch(noneMarkup, /composer-mode-chip/);
  } finally {
    await server.close();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
