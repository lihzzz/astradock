import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedSession } from "@/types";
import { saveSessionSmart, patchSessionMetadata } from "@/lib/session/persistence";
import { SessionRepository } from "../session-repository";
let root: string; let repo: SessionRepository;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-bridge-")); repo = new SessionRepository(root);
  vi.stubGlobal("window", { claude: { sessions: {
    save: async (data: PersistedSession) => ({ revision: await repo.save({ ...data }) }),
    append: async (data: Record<string, unknown> & { id: string; projectId: string }) => ({ revision: await repo.append(data) }),
    updateMeta: async (projectId: string, id: string, patch: Parameters<SessionRepository["updateMeta"]>[2]) => ({ revision: await repo.updateMeta(projectId, id, patch) }),
  } } });
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });
describe("renderer to repository writes", () => {
  it("serializes concurrent snapshots and field-only patches without reverting newer messages", async () => {
    const data: PersistedSession = { id: crypto.randomUUID(), projectId: "p", title: "original", createdAt: 1, totalCost: 0,
      messages: [{ id: "m1", role: "user", content: "one", timestamp: 1 }] };
    await saveSessionSmart(data);
    const next: PersistedSession = { ...data, messages: [...data.messages, { id: "m2", role: "assistant", content: "new", timestamp: 2 }] };
    await Promise.all([saveSessionSmart(next), patchSessionMetadata("p", data.id, { title: "renamed" }), saveSessionSmart(next)]);
    expect(await repo.load("p", data.id)).toMatchObject({ title: "renamed", messages: next.messages });
  });
});
