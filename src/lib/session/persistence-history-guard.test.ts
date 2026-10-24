import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedSession } from "@/types";
import { saveSessionSmart } from "./persistence";
afterEach(() => vi.unstubAllGlobals());
describe("renderer incomplete snapshot guard", () => {
  it("refuses missing historical IDs before IPC, but permits an explicit replacement", async () => {
    const save = vi.fn().mockResolvedValue({}); const append = vi.fn().mockResolvedValue({});
    vi.stubGlobal("window", { claude: { sessions: { save, append } } });
    const data: PersistedSession = { id: crypto.randomUUID(), projectId: "p", title: "t", createdAt: 1, totalCost: 0,
      messages: [{ id: "u", role: "user", content: "question", timestamp: 1 }, { id: "a", role: "assistant", content: "answer", timestamp: 2 }] };
    await saveSessionSmart(data); save.mockClear();
    const partial = { ...data, messages: data.messages.slice(1) };
    await expect(saveSessionSmart(partial)).rejects.toThrow("incomplete snapshot");
    expect(save).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    await saveSessionSmart(partial, data.id); expect(save).toHaveBeenCalledWith(expect.objectContaining(partial), data.id);
  });
});
