import { BackgroundSessionStore } from "./session-store";
/** One renderer-owned conversation registry, independent of pane mount/unmount. */
export const sharedSessionStore = new BackgroundSessionStore();
