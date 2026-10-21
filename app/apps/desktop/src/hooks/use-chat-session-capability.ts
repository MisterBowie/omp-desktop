/** Native file actions must never target a remote session. */
import { useAppStore } from "../stores/app-store";

export function useChatNativeFilesAllowed(): boolean {
  return useAppStore((state) =>
    !state.activeSessionId?.startsWith("remote:"),
  );
}
