#!/usr/bin/env node
/**
 * Capture the README screenshots from an actual packaged build.
 *
 *   node scripts/readme-screenshots.mjs <installer> <output-directory> [en|zh-CN]
 *
 * The packaged app runs with the isolated profile of the installed-smoke
 * harness and drives real OMP sessions through the real Composer, approval
 * card, Review tab, and marketplace. Only the model is a fixture: the loopback
 * FakeProvider scripts each turn, so no paid model is called. The demo project
 * and marketplace live under /Users/Shared/omp-readme and are removed at the end.
 *
 * CDP frames do not contain macOS window vibrancy, so the capture paints the
 * sidebar with the opaque colour Windows and Linux use. Nothing else in the
 * renderer is changed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FakeProvider } from "../experiments/omp-bridge/lib/provider.mjs";
import { InstalledApplication, until } from "./e2e/installed-application.mjs";
import { click, idle, invoke, inspect, prompt, reloadAndSelect } from "./e2e/installed-workflow.mjs";

const [installer, outputDirectory, locale = "en"] = process.argv.slice(2);
assert(installer && outputDirectory, "usage: readme-screenshots.mjs <installer> <output-directory> [en|zh-CN]");
assert(["en", "zh-CN"].includes(locale), "locale must be en or zh-CN");
const zh = locale === "zh-CN";
const out = resolve(outputDirectory);
mkdirSync(out, { recursive: true });

// Not under /tmp: macOS resolves it to /private/tmp, OMP reports /tmp, and the
// two spellings keep file paths from showing relative to the project.
const DEMO_ROOT = "/Users/Shared/omp-readme";
const SHOP = join(DEMO_ROOT, "acme-shop");
const DOCS = join(DEMO_ROOT, "acme-docs");
const MARKET = join(DEMO_ROOT, "acme-plugins");
const electron = `process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron")`;

const L = zh
  ? {
      heroTitle: "优惠码校验",
      heroPrompt: "给优惠码加上校验：未知代码和过期代码要报错，折后价不能低于 0，并补上测试。",
      heroThinking: "先看现有的优惠码逻辑，再补校验和测试，最后跑一遍测试。",
      heroIntro: "我先看一下优惠码模块，并列出要做的事。",
      heroEdit: "现在的实现没有处理未知代码和过期代码。我来补上校验，并统一大小写和空格。",
      heroTest: "再加一组单元测试覆盖这些情况。",
      heroRun: "运行测试：",
      heroDone: "优惠码校验已完成：\n\n- 未知或过期的代码会抛出 `CouponError`，调用方可以给出明确提示。\n- 代码在查找前去掉空格并转成大写，` spring10 ` 也能识别。\n- 折后价保留两位小数，且不会低于 0。\n\n新增的 5 个测试全部通过。",
      todo: { phase: "优惠码校验", items: ["查看优惠码模块", "校验代码和有效期", "补充单元测试", "运行测试"] },
      pushTitle: "发布 2.0",
      pushPrompt: "给 2.0.0 打标签并推送到远端。",
      pushDone: "好的，没有创建标签，也没有推送。需要发布 2.0.0 时告诉我。",
      auditTitle: "审查结账流程",
      auditPrompt: "审查一下结账流程里的边界情况，分头并行查。",
      auditIntro: "结账涉及购物车、支付和配送三块，我分给三个子智能体并行审查。",
      auditLabels: ["购物车合计", "支付重试", "运费规则"],
      auditTasks: [
        ["CartReview", "审查 src/cart/cart.js 的合计计算：空购物车、数量为 0、金额舍入。"],
        ["PaymentReview", "审查 src/checkout/payments.js 的重试逻辑：重复扣款与超时。"],
        ["ShippingReview", "审查 src/checkout/shipping.js 的运费规则：免运费门槛与偏远地区。"],
      ],
      auditFindings: [
        "购物车合计逐行舍入，多件商品时会差 1 分钱；空购物车返回 0，正常。",
        "支付重试没有幂等键，超时后重试可能重复扣款。",
        "免运费门槛按折前金额判断，用了优惠码后仍会免运费。",
      ],
      auditDone: "三个方向都查完了，需要优先处理的问题：\n\n1. **支付重试缺少幂等键**：超时重试可能重复扣款（`payments.js`）。\n2. **免运费按折前金额判断**：用优惠码后仍免运费（`shipping.js`）。\n3. **合计逐行舍入**：多件商品时差 1 分钱（`cart.js`）。\n\n需要的话我可以按这个顺序逐个修复。",
      docsTitle: "撰写迁移指南",
      docsPrompt: "列一下 2.0 迁移指南的大纲。",
      docsDone: "迁移指南大纲：\n\n1. 升级前检查\n2. 配置文件变更\n3. API 破坏性改动\n4. 回退方式",
    }
  : {
      heroTitle: "Coupon validation",
      heroPrompt: "Validate coupon codes: reject unknown and expired codes, never let the total go below zero, and add tests.",
      heroThinking: "Inspect the current coupon logic, add validation and tests, then run the suite.",
      heroIntro: "I'll look at the coupon module first and list the steps.",
      heroEdit: "The current code doesn't handle unknown or expired codes. I'll add validation and normalize case and whitespace.",
      heroTest: "Now a set of unit tests for these cases.",
      heroRun: "Running the tests:",
      heroDone: "Coupon validation is in place:\n\n- Unknown or expired codes throw `CouponError`, so callers can show a clear message.\n- Codes are trimmed and upper-cased before lookup, so ` spring10 ` works.\n- The discounted total is rounded to cents and never drops below zero.\n\nAll 5 new tests pass.",
      todo: { phase: "Coupon validation", items: ["Inspect the coupon module", "Validate codes and expiry", "Add unit tests", "Run the tests"] },
      pushTitle: "Release 2.0",
      pushPrompt: "Tag the 2.0.0 release and push it.",
      pushDone: "Understood. Nothing was tagged or pushed. Tell me when you want to publish 2.0.0.",
      auditTitle: "Checkout audit",
      auditPrompt: "Audit the checkout flow for edge cases. Split the work and run it in parallel.",
      auditIntro: "Checkout spans the cart, payments, and shipping, so I'll give each to its own subagent.",
      auditLabels: ["Cart totals", "Payment retries", "Shipping rules"],
      auditTasks: [
        ["CartReview", "Review totals in src/cart/cart.js: empty carts, zero quantities, and rounding."],
        ["PaymentReview", "Review retries in src/checkout/payments.js: double charges and timeouts."],
        ["ShippingReview", "Review rules in src/checkout/shipping.js: free-shipping threshold and remote areas."],
      ],
      auditFindings: [
        "Totals are rounded per line, so multi-item carts can be off by a cent. Empty carts return 0 as expected.",
        "Payment retries send no idempotency key, so a retry after a timeout can charge twice.",
        "The free-shipping threshold uses the pre-discount subtotal, so coupons still unlock free shipping.",
      ],
      auditDone: "All three reviews are done. What to fix first:\n\n1. **Payment retries lack an idempotency key**: a retry after a timeout can charge twice (`payments.js`).\n2. **Free shipping uses the pre-discount subtotal**: coupons still unlock it (`shipping.js`).\n3. **Per-line rounding**: multi-item carts can be off by a cent (`cart.js`).\n\nI can fix them in that order if you like.",
      docsTitle: "Migration guide",
      docsPrompt: "Outline the 2.0 migration guide.",
      docsDone: "Migration guide outline:\n\n1. Before you upgrade\n2. Configuration changes\n3. Breaking API changes\n4. Rolling back",
    };

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const COUPONS_BEFORE = `const COUPONS = {
  SPRING10: { percentOff: 10, expires: "2026-05-31" },
  WELCOME5: { amountOff: 5 },
};

export function applyCoupon(total, code) {
  const coupon = COUPONS[code];
  if (coupon.percentOff) return total * (1 - coupon.percentOff / 100);
  return total - coupon.amountOff;
}
`;
const COUPONS_FIX = [
  "export class CouponError extends Error {}",
  "",
  "export function applyCoupon(total, code, today = new Date()) {",
  "  const coupon = COUPONS[code?.trim().toUpperCase()];",
  "  if (!coupon) throw new CouponError(`Unknown coupon: ${code}`);",
  "  if (coupon.expires && today > new Date(`${coupon.expires}T23:59:59Z`)) {",
  "    throw new CouponError(`Coupon ${code} has expired`);",
  "  }",
  "  const discounted = coupon.percentOff",
  "    ? total * (1 - coupon.percentOff / 100)",
  "    : total - coupon.amountOff;",
  "  return Math.max(0, Math.round(discounted * 100) / 100);",
  "}",
];
const COUPON_TESTS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCoupon, CouponError } from "./coupons.js";

const may = new Date("2026-05-01");

test("applies a percentage coupon", () => {
  assert.equal(applyCoupon(80, "SPRING10", may), 72);
});

test("normalizes case and whitespace", () => {
  assert.equal(applyCoupon(80, " spring10 ", may), 72);
});

test("rejects unknown codes", () => {
  assert.throws(() => applyCoupon(80, "FREE100", may), CouponError);
});

test("rejects expired coupons", () => {
  assert.throws(() => applyCoupon(80, "SPRING10", new Date("2026-06-02")), CouponError);
});

test("never goes below zero", () => {
  assert.equal(applyCoupon(3, "WELCOME5", may), 0);
});
`;
const CLIENT_BEFORE = `const BASE_URL = "https://api.acme-shop.example";

export async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(\`\${BASE_URL}\${path}\`, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
`;
function writeDemoProjects() {
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  write(join(SHOP, "package.json"), `${JSON.stringify({ name: "acme-shop", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
  write(join(SHOP, "README.md"), "# Acme Shop\n\nStorefront API and checkout for Acme.\n");
  write(join(SHOP, "src/cart/coupons.js"), COUPONS_BEFORE);
  write(join(SHOP, "src/cart/cart.js"), "export function cartTotal(lines) {\n  return lines.reduce((sum, line) => sum + Math.round(line.price * line.quantity * 100) / 100, 0);\n}\n");
  write(join(SHOP, "src/checkout/payments.js"), "export async function charge(gateway, order, attempts = 3) {\n  for (let attempt = 1; attempt <= attempts; attempt += 1) {\n    try {\n      return await gateway.charge(order.total, order.card);\n    } catch (error) {\n      if (attempt === attempts) throw error;\n    }\n  }\n}\n");
  write(join(SHOP, "src/checkout/shipping.js"), "export function shippingCost(order) {\n  if (order.subtotal >= 50) return 0;\n  return order.remote ? 12 : 6;\n}\n");
  write(join(SHOP, "src/api/client.js"), CLIENT_BEFORE);
  write(join(DOCS, "README.md"), "# Acme Docs\n");
  write(join(DOCS, "guides/install.md"), "# Install\n");
  for (const dir of [SHOP, DOCS]) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Acme", "-c", "user.email=dev@acme.example", "add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Acme", "-c", "user.email=dev@acme.example", "commit", "-q", "-m", "Initial commit"], { cwd: dir });
  }
}

function writeDemoMarketplace() {
  const plugins = [
    ["code-review", "1.4.0", "Review pull requests with severity-ranked findings and suggested fixes."],
    ["release-notes", "0.9.2", "Draft release notes from merged commits and closed issues."],
    ["postgres-tools", "2.1.0", "Inspect schemas and run read-only queries through an MCP server."],
    ["test-guard", "1.0.3", "Run the affected tests after every edit through a post-tool hook."],
  ];
  write(join(MARKET, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "acme-plugins",
    owner: { name: "Acme" },
    plugins: plugins.map(([name, version, description]) => ({ name, source: `./plugins/${name}`, version, description })),
  }, null, 2));
  for (const [name, version, description] of plugins) {
    const root = join(MARKET, "plugins", name);
    write(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version, description }, null, 2));
    write(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`);
  }
}

/** The hashline tag OMP printed for a file in the read result of the current request. */
function tagOf(provider, file) {
  const text = JSON.stringify(provider.requests.at(-1)?.body ?? null);
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\[([^\\[\\]"\\s]*${escaped}#[0-9a-fA-F]{4})\\]`));
  assert(match, `no snapshot tag for ${file} in the current request`);
  return match[1];
}

/** An edit call whose patch uses the tag of OMP's own read in the current request. */
function editCall(provider, file, start, end, lines) {
  const body = lines.map((line) => `+${line}`).join("\n");
  return { name: "edit", args: { input: `*** Begin Patch\n[${tagOf(provider, file)}]\nPUT ${start}.=${end}:\n${body}\n*** End Patch` } };
}

const usage = (prompt, completion) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion });

async function paintOpaqueSidebar(application) {
  await application.renderer.evaluate(`(() => {
    if (document.getElementById("readme-capture-style")) return true;
    const style = document.createElement("style");
    style.id = "readme-capture-style";
    style.textContent = ':root[data-platform="darwin"] .sidebar-surface, :root[data-platform="darwin"] .sidebar-rail, :root[data-platform="darwin"] .startup-splash { background-color: var(--ds-bg-sidebar, var(--ds-bg-primary)) !important; background-image: var(--ds-bg-sidebar-image, none) !important; } :root[data-platform="darwin"], :root[data-platform="darwin"] body { background: var(--ds-bg-primary) !important; }';
    document.head.append(style);
    return true;
  })()`);
}

async function shot(application, name) {
  await paintOpaqueSidebar(application);
  await delay(700);
  const result = await application.renderer.send("Page.captureScreenshot", { format: "webp", quality: 92 });
  const file = join(out, `omp-${name}-${zh ? "zh" : "en"}.webp`);
  writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log(`captured ${file}`);
}

async function createSession(application, providerId, project, title, permissionMode) {
  await invoke(application, "projectSet", [project]);
  const created = await invoke(application, "sessionCreate", [{ title, mode: "agent", engine: "omp", projectPath: project, providerId, modelId: "demo-model" }]);
  const id = created.session?.id;
  assert(id, `session ${title} was not created`);
  await invoke(application, "sessionConfigure", [id, { mode: "agent", permissionMode }]);
  return id;
}

async function openSession(application, id) {
  await reloadAndSelect(application, id);
  await paintOpaqueSidebar(application);
}

let application;
let provider;
try {
  writeDemoProjects();
  writeDemoMarketplace();
  provider = await FakeProvider.start({ model: "demo-model" });
  application = InstalledApplication.prepare(resolve(installer), out);
  // The runtime gives tools a minimal PATH that starts with the isolated
  // $HOME/.bun/bin, so the real test run below finds node there.
  mkdirSync(join(application.home, ".bun", "bin"), { recursive: true });
  copyFileSync(process.execPath, join(application.home, ".bun", "bin", "node"));
  await application.start();
  await application.main.evaluate(`(() => {
    const { BrowserWindow } = ${electron};
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    window.setContentSize(1440, 900);
    window.center();
    return true;
  })()`, "Main", { awaitPromise: false });

  const settings = await invoke(application, "settingsGet");
  await invoke(application, "settingsSet", [{ ...settings, theme: "dark", language: locale, onboardingDismissed: true }]);

  const createdProvider = await invoke(application, "providersCreate", [{
    name: "Demo", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: provider.baseUrl, authKind: "api_key_and_base_url", defaultModelId: "demo-model",
    secretValue: "demo-key", apiStyle: "chat_completions",
  }]);
  const providerId = createdProvider.provider?.id;
  assert(providerId, "demo provider was not created");

  // A finished side session in a second project fills the sidebar.
  const docs = await createSession(application, providerId, DOCS, L.docsTitle, "auto");
  provider.script([{ text: L.docsDone, finish: "stop", delayMs: 600, usage: usage(1800, 64) }]);
  await openSession(application, docs);
  await prompt(application, L.docsPrompt);
  await idle(application, docs, zh ? "回退方式" : "Rolling back");

  // Approval: a push waits on the card and never runs once denied.
  const push = await createSession(application, providerId, SHOP, L.pushTitle, "ask");
  provider.script([
    {
      finish: "tool_calls", delayMs: 600, usage: usage(2700, 52),
      toolCalls: [{ name: "bash", args: { command: 'git tag -a v2.0.0 -m "Release 2.0.0" && git push origin v2.0.0', timeout: 120 } }],
    },
    { text: L.pushDone, finish: "stop", delayMs: 500, usage: usage(3100, 38) },
  ]);
  await openSession(application, push);
  await prompt(application, L.pushPrompt);
  await until(async () => (await inspect(application)).permission, "bash approval card");
  await shot(application, "approval");
  await click(application, ".permission-card-actions button:first-child");
  await idle(application, push, zh ? "没有推送" : "Nothing was tagged");

  // Subagents: three parallel reviewers, one task call each.
  const audit = await createSession(application, providerId, SHOP, L.auditTitle, "auto");
  const files = ["src/cart/cart.js", "src/checkout/payments.js", "src/checkout/shipping.js"];
  const reviewers = files.map((file, index) => [
    { finish: "tool_calls", toolCalls: [{ name: "read", args: { path: file } }], delayMs: 900 + index * 500, usage: usage(2100, 40) },
    // A subagent hands its result back through OMP's yield tool.
    {
      text: L.auditFindings[index], finish: "tool_calls", delayMs: 1400 + index * 600, usage: usage(2600, 90),
      // The bundled scout agent's output schema: summary, files, architecture.
      toolCalls: [{ name: "yield", args: { data: { summary: L.auditFindings[index], files: [{ path: file, description: L.auditLabels[index] }], architecture: L.auditLabels[index] } } }],
    },
    { text: "", finish: "stop", delayMs: 100, usage: usage(2700, 2) },
  ]);
  const parent = [
    {
      text: L.auditIntro, finish: "tool_calls", delayMs: 600, usage: usage(4100, 120),
      toolCalls: L.auditTasks.map(([name, task], index) => ({ name: "task", args: { name, agent: "scout", description: L.auditLabels[index], task } })),
    },
    // Spawned jobs report in the background; wait collects each result in this turn.
    ...files.map(() => ({ finish: "tool_calls", toolCalls: [{ name: "wait", args: {} }], delayMs: 200, usage: usage(4300, 8) })),
    { text: L.auditDone, finish: "stop", delayMs: 1200, usage: usage(6200, 210) },
  ];
  provider.routeBySession({ parent, subagents: files.map((marker, index) => ({ marker, turns: reviewers[index] })) });
  // The parent's requests carry the user's prompt; a reviewer's carry only its own file.
  provider.classifyRequest = (body) => {
    const text = JSON.stringify(body?.messages ?? []);
    let where = { kind: "parent" };
    if (!text.includes(L.auditPrompt)) {
      const index = files.findIndex((file) => text.includes(file));
      if (index >= 0) where = { kind: "subagent", index, marker: files[index] };
    }
    return where;
  };
  await openSession(application, audit);
  await prompt(application, L.auditPrompt);
  await idle(application, audit, zh ? "逐个修复" : "in that order");
  delete provider.classifyRequest;
  await application.renderer.evaluate(`(() => {
    const header = document.querySelector('.tool-activity-group.has-subagents > .tool-activity-header[aria-expanded="false"]');
    header?.click();
    return Boolean(header);
  })()`);
  await delay(800);
  await shot(application, "subagents");

  // Marketplace: a Claude Code–compatible source with four plugins.
  await invoke(application, "ompMarketAddSource", [MARKET]);
  await click(application, '[data-nav="plugins"]');
  await until(() => application.renderer.evaluate('Boolean(document.querySelector("#plugins-tab-market"))'), "plugins page");
  await click(application, "#plugins-tab-market");
  await until(() => application.renderer.evaluate('document.body.innerText.includes("postgres-tools")'), "marketplace catalog");
  await shot(application, "marketplace");

  // Hero: todo list, real edits and a real test run, then Review.
  const hero = await createSession(application, providerId, SHOP, L.heroTitle, "auto");
  provider.script([
    {
      thinking: L.heroThinking, text: L.heroIntro, finish: "tool_calls", delayMs: 900, usage: usage(3900, 160),
      toolCalls: [
        { name: "todo", args: { op: "init", list: [{ phase: L.todo.phase, items: L.todo.items }] } },
        { name: "read", args: { path: "src/cart/coupons.js" } },
      ],
    },
    {
      text: L.heroEdit, finish: "tool_calls", delayMs: 1600, usage: usage(4800, 230),
      get toolCalls() {
        return [
          { name: "todo", args: { op: "done", task: L.todo.items[0] } },
          editCall(provider, "coupons.js", 6, 10, COUPONS_FIX),
        ];
      },
    },
    {
      text: L.heroTest, finish: "tool_calls", delayMs: 1400, usage: usage(5600, 260),
      toolCalls: [
        { name: "todo", args: { op: "done", task: L.todo.items[1] } },
        { name: "write", args: { path: "src/cart/coupons.test.js", content: COUPON_TESTS } },
      ],
    },
    {
      text: L.heroRun, finish: "tool_calls", delayMs: 500, usage: usage(6100, 60),
      toolCalls: [
        { name: "todo", args: { op: "done", task: L.todo.items[2] } },
        { name: "todo", args: { op: "done", task: L.todo.items[3] } },
        { name: "bash", args: { command: "node --test src/cart/coupons.test.js", timeout: 120 } },
      ],
    },
    { text: L.heroDone, finish: "stop", delayMs: 1500, usage: usage(6900, 190) },
  ]);
  await openSession(application, hero);
  await prompt(application, L.heroPrompt);
  await idle(application, hero, zh ? "全部通过" : "All 5 new tests pass");
  const heroSession = (await invoke(application, "sessionGet", [hero])).session;
  const failures = JSON.stringify(heroSession.messages ?? []).match(/"isError":true.{0,400}/g) ?? [];
  assert.equal(failures.length, 0, `a hero tool failed: ${failures.join(" | ")}`);
  await application.renderer.evaluate(`(() => {
    const card = document.querySelector(".turn-changes-card");
    if (!card) return false;
    const head = card.querySelector(".turn-changes-head");
    if (head && head.getAttribute("aria-expanded") === "false") head.click();
    return true;
  })()`);
  await until(() => application.renderer.evaluate('Boolean(document.querySelector(".turn-changes-row"))'), "changes card rows");
  await click(application, ".turn-changes-row");
  await delay(1500);
  // Keep the whole changes card and the usage line above the Tasks bar.
  await application.renderer.evaluate(`(() => {
    let node = document.querySelector(".turn-changes-card")?.parentElement;
    while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
    if (node) node.scrollTop = node.scrollHeight;
    return Boolean(node);
  })()`);
  await delay(800);
  await shot(application, "review");

  await application.quit();
} finally {
  if (application) {
    try { await application.cleanup(); } finally { if (application.clean) application.removeOwnedRoot(); }
  }
  await provider?.close();
  rmSync(DEMO_ROOT, { recursive: true, force: true });
}
