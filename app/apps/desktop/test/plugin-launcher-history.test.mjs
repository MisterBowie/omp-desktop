import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPluginLaunchHistory,
  rememberPluginLaunch,
} from "../src/lib/plugin-launcher-history.ts";

const KEY = "pi.desktop.pluginLaunchHistory";

function installStorage(values = new Map()) {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key() {
      return null;
    },
    get length() {
      return values.size;
    },
  };
  return { values, restore: () => (globalThis.localStorage = previousStorage) };
}

test("remembering a plugin moves it to the front and deduplicates", () => {
  const { restore } = installStorage();
  try {
    rememberPluginLaunch("mail");
    rememberPluginLaunch("canvas");
    rememberPluginLaunch("mail");
    assert.deepEqual(loadPluginLaunchHistory().map((record) => record.id), [
      "mail",
      "canvas",
    ]);
    assert.deepEqual(
      JSON.parse(globalThis.localStorage.getItem(KEY)).map((record) => record.id),
      ["mail", "canvas"],
    );
  } finally {
    restore();
  }
});

test("history is bounded and sorted newest first", () => {
  const { values, restore } = installStorage();
  try {
    const ids = Array.from({ length: 30 }, (_, index) => `plugin-${index}`);
    for (const id of ids) rememberPluginLaunch(id);
    assert.deepEqual(
      loadPluginLaunchHistory().map((record) => record.id),
      ids.slice(-24).reverse(),
    );
    assert.equal(JSON.parse(values.get(KEY)).length, 24);
  } finally {
    restore();
  }
});

test("history tolerates corrupted storage and missing localStorage", () => {
  const { values, restore } = installStorage();
  try {
    values.set(KEY, "{not json");
    assert.deepEqual(loadPluginLaunchHistory(), []);
    values.set(KEY, JSON.stringify([{ id: 42 }, null, { id: "ok", usedAt: 1 }]));
    assert.deepEqual(loadPluginLaunchHistory(), [{ id: "ok", usedAt: 1 }]);
  } finally {
    restore();
  }

  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = undefined;
  try {
    assert.deepEqual(loadPluginLaunchHistory(), []);
    assert.deepEqual(rememberPluginLaunch("mail").map((record) => record.id), [
      "mail",
    ]);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});
