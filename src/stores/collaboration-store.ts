import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { CollaborationGroup } from "@shared/types/collaboration";
import { parseCollaborationGroups } from "@shared/lib/collaboration";

const memory = new Map<string, string>();

const storage = {
  getItem: (key: string): string | null => {
    try {
      if (typeof localStorage !== "undefined") return localStorage.getItem(key);
    } catch {
      // Private mode and tests can reject storage access.
    }
    return memory.get(key) ?? null;
  },
  setItem: (key: string, value: string): void => {
    memory.set(key, value);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      // Keep the in-memory copy when persistence is unavailable.
    }
  },
  removeItem: (key: string): void => {
    memory.delete(key);
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  },
};

interface CollaborationLibraryState {
  groups: CollaborationGroup[];
  saveGroup: (group: CollaborationGroup) => void;
  deleteGroup: (id: string) => void;
}

export const useCollaborationLibrary = create<CollaborationLibraryState>()(
  persist(
    (set) => ({
      groups: [],
      saveGroup: (group) => set((state) => {
        const index = state.groups.findIndex((entry) => entry.id === group.id);
        if (index === -1) return { groups: [group, ...state.groups] };
        const groups = state.groups.slice();
        groups[index] = group;
        return { groups };
      }),
      deleteGroup: (id) => set((state) => ({
        groups: state.groups.filter((group) => group.id !== id),
      })),
    }),
    {
      name: "harnss-collaboration-groups",
      storage: createJSONStorage(() => storage),
      merge: (persisted, current) => {
        const stored = persisted && typeof persisted === "object" && "groups" in persisted
          ? (persisted as { groups?: unknown }).groups
          : undefined;
        return { ...current, groups: parseCollaborationGroups(stored) };
      },
    },
  ),
);
