import { describe, expect, it } from "vitest";
import type { UIMessage } from "@/types";
import { materializedState, appendMessageOnce } from "./materialized-state";
const user: UIMessage = { id: "persisted-user", role: "user", content: "first prompt", timestamp: 1 };
describe("draft persistence identity", () => {
  it("shares the saved user ID with foreground send, including attachments", () => {
    const message: UIMessage = { ...user, images: [{ id: "image", data: "YQ==", mediaType: "image/png" }] };
    const state = materializedState(undefined, message);
    expect(appendMessageOnce(state.messages, message)).toBe(state.messages);
    expect(state.messages).toEqual([message]);
  });
  it("preserves events arriving during materialization and does not replace an existing user ID", () => {
    const state = materializedState(undefined, user);
    state.messages.push({ id: "a", role: "assistant", content: "early event", timestamp: 2 });
    const seeded = materializedState(state, { ...user, id: "new-random-id" });
    expect(seeded.messages.map(m => m.id)).toEqual(["persisted-user", "a"]);
    expect(appendMessageOnce(seeded.messages, { ...user, id: "second-turn" })).toHaveLength(3);
  });
});
