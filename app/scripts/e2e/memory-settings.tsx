import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { MemorySettingsPage } from "../../apps/desktop/src/features/settings/MemorySettingsPage";
import { api } from "../../apps/desktop/src/lib/api";
import "../../apps/desktop/src/styles/settings.css";

declare global {
  var memorySettingsProbe: (restart?: boolean) => Promise<{ ok: true }>;
}
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function until(condition: () => boolean, message: string) {
  const deadline = performance.now() + 15000;
  while (!condition() && performance.now() < deadline) await painted();
  if (!condition()) throw new Error(message);
}
globalThis.memorySettingsProbe = async (restart = false) => {
  const i18n = createInstance();
  await i18n.init({
    lng: "zh-CN",
    fallbackLng: "en",
    resources: { en: { translation: catalogs.en }, "zh-CN": { translation: catalogs["zh-CN"] } },
  });
  const root = document.createElement("div");
  document.body.append(root);
  flushSync(() =>
    createRoot(root).render(
      <I18nextProvider i18n={i18n}>
        <MemorySettingsPage />
      </I18nextProvider>,
    ),
  );
  const save = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动保存记忆"]')!;
  const read = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动读取记忆"]')!;
  await until(() => !!save() && !save().disabled, "memory settings failed to load");
  if (restart) {
    if (save().getAttribute("aria-checked") !== "true" || read().getAttribute("aria-checked") !== "false")
      throw new Error("memory choices did not survive restart");
    return { ok: true };
  }
  if (save().getAttribute("aria-checked") !== "false" || read().getAttribute("aria-checked") !== "false")
    throw new Error("memory must default off");
  flushSync(() => save().click());
  await until(
    () => !save().disabled && save().getAttribute("aria-checked") === "true",
    "auto-save did not enable",
  );
  if (read().getAttribute("aria-checked") !== "false") throw new Error("save incorrectly enabled read");
  flushSync(() => read().click());
  await until(
    () => !read().disabled && read().getAttribute("aria-checked") === "true",
    "auto-read did not enable",
  );
  flushSync(() => read().click());
  await until(
    () => !read().disabled && read().getAttribute("aria-checked") === "false",
    "auto-read did not disable independently",
  );
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="项目"]')!;
  await until(() => select.options.length > 1, "project selector is empty");
  flushSync(() => {
    select.value = select.options[1].value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
  await until(() => !button("搜索").disabled, "memory browser did not load");
  flushSync(() => button("清空此项目的记忆").click());
  await until(() => !!button("再次点击以清空记忆"), "clear did not request confirmation");
  flushSync(() => button("取消").click());
  if (button("再次点击以清空记忆")) throw new Error("clear confirmation did not cancel");
  flushSync(() => button("清空此项目的记忆").click());
  flushSync(() => button("再次点击以清空记忆").click());
  await until(
    () => !!button("清空此项目的记忆") && !button("清空此项目的记忆").disabled,
    "clear did not settle",
  );
  if (document.querySelector('[role="alert"]')) throw new Error("memory page displayed an unexpected error");
  const settings = await api.getOmpMemorySettings();
  if (!settings.autoSave || settings.autoRead)
    throw new Error("persisted memory switches differ from the UI");
  return { ok: true };
};
