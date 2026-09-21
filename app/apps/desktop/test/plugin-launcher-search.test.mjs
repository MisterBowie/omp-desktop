import assert from "node:assert/strict";
import test from "node:test";
import {
  isLaunchablePlugin,
  searchLaunchablePlugins,
} from "../src/lib/plugin-launcher-search.ts";

function plugin(id, name, extra = {}) {
  return {
    id,
    name,
    version: "1.0.0",
    enabled: true,
    source: "installed",
    status: "ready",
    permissions: [],
    ui: { panel: { entry: "dist/panel.html" } },
    ...extra,
  };
}

const plugins = [
  plugin("canvas", "无限画布", { description: "Create visual workflows" }),
  plugin("mail", "邮件助手"),
  plugin("disabled", "无限插件", { enabled: false, status: "disabled" }),
  plugin("broken", "坏插件", { status: "error" }),
  plugin("headless", "后台服务", { ui: undefined }),
];

test("launcher searches Chinese plugin names by Chinese, pinyin, and initials", () => {
  assert.deepEqual(searchLaunchablePlugins(plugins, "画布").map((item) => item.id), [
    "canvas",
  ]);
  assert.deepEqual(searchLaunchablePlugins(plugins, "wuxianhuabu").map((item) => item.id), [
    "canvas",
  ]);
  assert.deepEqual(searchLaunchablePlugins(plugins, "wxhb").map((item) => item.id), [
    "canvas",
  ]);
});

test("launcher searches ids and excludes plugins that cannot open a panel", () => {
  assert.equal(isLaunchablePlugin(plugins[0]), true);
  assert.equal(isLaunchablePlugin(plugins[2]), false);
  assert.equal(isLaunchablePlugin(plugins[3]), false);
  assert.equal(isLaunchablePlugin(plugins[4]), false);
  assert.deepEqual(searchLaunchablePlugins(plugins, "mail").map((item) => item.id), [
    "mail",
  ]);
  assert.deepEqual(searchLaunchablePlugins(plugins, "").map((item) => item.id), [
    "canvas",
    "mail",
  ]);
});

test("launcher orders an empty query by most recent use", () => {
  assert.deepEqual(
    searchLaunchablePlugins(plugins, "", ["mail", "canvas"]).map((item) => item.id),
    ["mail", "canvas"],
  );
  assert.deepEqual(
    searchLaunchablePlugins(plugins, "", ["mail"]).map((item) => item.id),
    ["mail", "canvas"],
  );
});

test("launcher keeps search relevance ahead of recency", () => {
  assert.deepEqual(
    searchLaunchablePlugins(plugins, "wuxianhuabu", ["mail"]).map((item) => item.id),
    ["canvas"],
  );
  assert.deepEqual(
    searchLaunchablePlugins(plugins, "邮件", ["canvas"]).map((item) => item.id),
    ["mail"],
  );
});

test("launcher uses recency as a tiebreaker between equal matches", () => {
  const tie = [
    plugin("alpha", "Alpha Plugin"),
    plugin("beta", "Beta Plugin"),
  ];
  assert.deepEqual(
    searchLaunchablePlugins(tie, "", ["beta", "alpha"]).map((item) => item.id),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    searchLaunchablePlugins(tie, "", ["alpha"]).map((item) => item.id),
    ["alpha", "beta"],
  );
});
