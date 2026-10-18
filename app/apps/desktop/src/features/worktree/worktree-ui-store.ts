import { create } from "zustand";
type WorktreeDialog = {
    kind: "merge";
    sessionId: string;
    title: string;
};
export const useWorktreeUi = create<{
    dialog: WorktreeDialog | null;
    open: (dialog: WorktreeDialog) => void;
    close: () => void;
}>((set) => ({
    dialog: null,
    open: (dialog) => set({ dialog }),
    close: () => set({ dialog: null }),
}));
