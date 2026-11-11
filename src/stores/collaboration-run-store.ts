import { create } from "zustand";
import type { CollaborationMemberStatus } from "@/lib/collaboration/runtime";

interface CollaborationRunState {
  sessionId: string | null;
  groupName: string;
  members: CollaborationMemberStatus[];
  setRun: (sessionId: string, groupName: string, members: CollaborationMemberStatus[]) => void;
  clearRun: (sessionId: string) => void;
}

export const useCollaborationRunStore = create<CollaborationRunState>((set, get) => ({
  sessionId: null,
  groupName: "",
  members: [],
  setRun: (sessionId, groupName, members) => set({ sessionId, groupName, members }),
  clearRun: (sessionId) => {
    if (get().sessionId !== sessionId) return;
    set({ sessionId: null, groupName: "", members: [] });
  },
}));
