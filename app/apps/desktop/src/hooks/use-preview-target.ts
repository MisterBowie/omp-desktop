import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { isActiveInProject } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { isHtmlFilePath, toWorkspaceRel, type ChatPreviewTarget } from "../lib/chat-links";
import { openHttpUrl } from "../lib/open-http-url";
import {
  BROWSER_PLUGIN_TAB,
  FILE_MANAGER_PLUGIN_TAB,
  fileManagerPluginTab,
  hasPluginView,
} from "../lib/work-panel-tabs";

/**
 * Open one target the transcript named.
 *
 * A file never opens its own path directly. It goes through the same
 * completion the message body uses (`useOpenChatFileRef`, ADR 0262), so the
 * surface that named the file stops deciding where it shows: a tool row's
 * summary and a tool result's file/match list land in the bundled file view on
 * a project file exactly like a chat chip, and fall back the same way when the
 * view, the file, or the reference is not there. One opener for the whole
 * transcript is also what keeps a shorthand honest — a click opens the file
 * that matched, or reports that nothing did. HTTP(S) URLs follow the Link
 * open destination setting.
 */
export function useOpenPreviewTarget() {
  const openFileRef = useOpenChatFileRef();
  return useCallback(
    (target: ChatPreviewTarget) =>
      target.kind === "file" ? openFileRef(target.path) : openHttpUrl(target.url),
    [openFileRef],
  );
}

/** Dot-relative references resolve against the markdown file being viewed. */
function isDotRelative(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

/**
 * Where a chat file reference actually landed.
 *
 * The reference is completed in the main process first, because the token is
 * routinely a shorthand: an agent that works on `/root/dir/openimage.js` names
 * only `openimage.js` in its reply, and the open project answers before the
 * session's own scratch store does.
 *
 * Completion also picks how the file is addressed. A file in the project's
 * **primary** folder travels as a project-relative path, exactly as before; a
 * file in any other folder of the same project group (ADR 0249) can only be
 * named by its absolute path, and the file view switches its own folder to the
 * one that contains it. Scratch and attachment files are absolute too.
 *
 * A reference that matches nothing is reported here, once, so every action
 * built on a reference stays honest about a shorthand that resolved to
 * nothing instead of acting on a differently named file.
 */
export type ResolvedChatFileRef = {
  /** The address the host accepts for this reference. */
  path: string;
  /** The absolute path; the one spelling that resolves from anywhere. */
  absolutePath: string;
  /** Project-relative spelling; null when the file sits outside the project. */
  relativePath: string | null;
  /** True for a match inside a folder the open project registers (ADR 0249). */
  inProject: boolean;
  /** True when that folder is the project's primary one. */
  primary: boolean;
  /** Session-owned generated artifacts, rather than imported attachments. */
  scratch: boolean;
};

export type ChatFileOpenDestination =
  | "file-manager"
  | "built-in-browser"
  | "default-browser";

export type ChatFileOpenOptions = {
  destination?: ChatFileOpenDestination;
};

/**
 * Load the bundled file view on demand when a user explicitly opens a project
 * file. Its enabled state can be off or its runtime can have failed even though
 * the app still ships the plugin; project scope and the recorded ui.view grant
 * remain authoritative.
 */
const fileManagerViewLoads = new Map<string, Promise<boolean>>();

async function ensureFileManagerView(workspacePath: string | null): Promise<boolean> {
  const key = workspacePath ?? "";
  const pending = fileManagerViewLoads.get(key);
  if (pending) return pending;

  const load = (async () => {
    try {
      const views = await api.listPluginViews();
      useAppStore.setState({ pluginViews: views });
      if (hasPluginView(views, FILE_MANAGER_PLUGIN_TAB)) return true;

      const { plugins } = await api.listPlugins();
      const fileManager = plugins.find(
        (plugin) => plugin.id === FILE_MANAGER_PLUGIN_TAB.pluginId,
      );
      if (
        !fileManager?.bundled ||
        !fileManager.permissions.includes("ui.view") ||
        useAppStore.getState().workspace?.path !== workspacePath ||
        !isActiveInProject(
          { ...fileManager, enabled: true },
          workspacePath,
        )
      ) {
        return false;
      }

      if (!fileManager.enabled) {
        await api.enablePlugin(fileManager.id);
      } else {
        // The host can finish booting before the bundled plugin runtime has
        // restored its view. Reloading here joins that gap and retries a failed
        // startup without changing the user's scope or permission grants.
        const result = await api.reloadPlugin(fileManager.id);
        if (result.review) return false;
      }

      const refreshedViews = await api.listPluginViews();
      useAppStore.setState({ pluginViews: refreshedViews });
      return hasPluginView(refreshedViews, FILE_MANAGER_PLUGIN_TAB);
    } catch {
      return false;
    }
  })();
  fileManagerViewLoads.set(key, load);
  try {
    return await load;
  } finally {
    if (fileManagerViewLoads.get(key) === load) fileManagerViewLoads.delete(key);
  }
}

function useResolveChatFileRef() {
  const { t } = useTranslation();
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const sessionId = useAppStore((s) => s.activeSessionId);
  const showToast = useAppStore((s) => s.showToast);

  return useCallback(
    async (path: string, baseDir?: string): Promise<ResolvedChatFileRef | null> => {
      const state = useAppStore.getState();
      const ownerId = state.activeSessionId;
      if (ownerId?.startsWith("remote:")) return null;
      const raw = String(path ?? "").trim();
      if (!raw) return null;
      const anchored = isDotRelative(raw)
        ? toWorkspaceRel(raw, workspacePath, baseDir)
        : null;
      let result;
      try {
        result = await api.fsResolveRef(anchored ?? raw, ownerId);
      } catch {
        showToast(t("chat.fileRefLookupFailed"), { variant: "error" });
        return null;
      }
      const match = result.match;
      if (!match) {
        showToast(t("chat.fileRefMissing", { name: raw }), { variant: "error" });
        return null;
      }
      if (match.root !== "workspace") {
        return {
          path: match.absolutePath,
          absolutePath: match.absolutePath,
          relativePath: null,
          inProject: false,
          primary: false,
          scratch: match.root === "scratch",
        };
      }
      const primary = match.projectRoot ? match.projectRoot.primary : true;
      return {
        path: primary ? match.relativePath : match.absolutePath,
        absolutePath: match.absolutePath,
        relativePath: match.relativePath,
        inProject: true,
        primary,
        scratch: false,
      };
    },
    [sessionId, showToast, t, workspacePath],
  );
}

/**
 * Open a file reference the conversation mentioned.
 *
 * Explicit destinations follow the upstream HTML open-with flow. Plain clicks
 * retain this release's preview destinations: primary-folder HTML in the side
 * browser, project files in the available file view, other files in the host tab.
 */
export function useOpenChatFileRef() {
  const { t } = useTranslation();
  const resolveRef = useResolveChatFileRef();
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const sessionId = useAppStore((s) => s.activeSessionId);
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const openTab = useAppStore((s) => s.openWorkPanelTab);
  const showToast = useAppStore((s) => s.showToast);

  return useCallback(
    (
      path: string,
      baseDir?: string,
      mimeType?: string,
      options?: ChatFileOpenOptions,
    ) => {
      const destination = options?.destination;
      void (async () => {
        const resolved = await resolveRef(path, baseDir);
        if (!resolved) return;
        const current = useAppStore.getState();
        if (
          (current.workspace?.path ?? null) !== workspacePath ||
          current.activeSessionId !== sessionId
        ) {
          return;
        }
        if (destination === "file-manager") {
          if (current.activeSessionId?.startsWith("remote:")) {
            showToast(t("chat.fileManagerOpenFailed"), { variant: "error" });
            return;
          }
          const ready = await ensureFileManagerView(workspacePath);
          const latest = useAppStore.getState();
          if (
            (latest.workspace?.path ?? null) !== workspacePath ||
            latest.activeSessionId !== sessionId
          ) {
            return;
          }
          if (!ready) {
            showToast(t("chat.fileManagerOpenFailed"), { variant: "error" });
            return;
          }
          openTab(
            fileManagerPluginTab(
              resolved.inProject ? resolved.path : resolved.absolutePath,
            ),
          );
          return;
        }
        if (destination === "built-in-browser") {
          if (
            current.activeSessionId?.startsWith("remote:") ||
            !hasPluginView(current.pluginViews, BROWSER_PLUGIN_TAB)
          ) {
            showToast(t("chat.builtInBrowserUnavailable"), {
              variant: "error",
            });
            return;
          }
          openUrl(resolved.absolutePath);
          return;
        }
        if (destination === "default-browser") {
          if (current.activeSessionId?.startsWith("remote:")) {
            showToast(t("chat.defaultBrowserOpenFailed"), {
              variant: "error",
            });
            return;
          }
          try {
            await api.fsOpen(resolved.absolutePath);
          } catch {
            showToast(t("chat.defaultBrowserOpenFailed"), {
              variant: "error",
            });
          }
          return;
        }
        if (resolved.inProject) {
          if (resolved.primary && isHtmlFilePath(resolved.path)) {
            openUrl(resolved.path);
            return;
          }
          if (hasPluginView(current.pluginViews, FILE_MANAGER_PLUGIN_TAB)) {
            openTab(fileManagerPluginTab(resolved.path));
            return;
          }
          openFile(resolved.path, mimeType);
          return;
        }
        openFile(resolved.absolutePath, mimeType);
      })();
    },
    [
      openFile,
      openTab,
      openUrl,
      resolveRef,
      sessionId,
      showToast,
      t,
      workspacePath,
    ],
  );
}

/**
 * Copy a reference as an address a user can paste somewhere else.
 *
 * "Full" is the absolute path, the one spelling that resolves from any working
 * directory. "Relative" is the project-relative spelling, and only a file
 * inside the open project has one: a scratch or attachment file says so
 * instead of handing back an absolute path under a name that promises
 * something else.
 */
export function useCopyChatFileRef() {
  const { t } = useTranslation();
  const resolveRef = useResolveChatFileRef();
  const showToast = useAppStore((s) => s.showToast);

  return useCallback(
    (
      path: string,
      baseDir: string | undefined,
      kind: "absolute" | "relative",
    ) => {
      void (async () => {
        const resolved = await resolveRef(path, baseDir);
        if (!resolved) return;
        const value =
          kind === "absolute" ? resolved.absolutePath : resolved.relativePath;
        if (!value) {
          showToast(t("chat.relativePathUnavailable"), { variant: "error" });
          return;
        }
        try {
          await navigator.clipboard.writeText(value);
          showToast(t("chat.copied"), { variant: "success" });
        } catch {
          showToast(t("chat.copyFailed"), { variant: "error" });
        }
      })();
    },
    [resolveRef, showToast, t],
  );
}
