import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRepository } from "../session-repository";
import { SessionOperations } from "../session-operations";
import { conversationKey } from "@shared/lib/session-identity";
import { extractSessionMeta } from "@shared/lib/session-persistence";
import type { BatchJob, BatchPreparedRequest } from "@shared/types/productivity";

let root: string;
let repository: SessionRepository;
let operations: SessionOperations;
let preparation: (job: BatchJob) => void;
let completed: Promise<BatchJob>;
let finish: (job: BatchJob) => void;
let chooseDirectory: () => Promise<string | null>;
let remove: (projectId: string, id: string) => Promise<void | "deleted" | "already_deleted">;
const session = (id: string) => ({ id, projectId: "project", title: "Same title", createdAt: 1, messages: [{ id: "m", role: "user", content: "hello", timestamp: 1 }] });
const target = (id: string) => ({ projectId: "project", conversationKey: conversationKey(session(id)) });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-batch-"));
  repository = new SessionRepository(path.join(root, "data"), vi.fn());
  chooseDirectory = vi.fn(async () => root);
  remove = vi.fn((projectId, id) => repository.remove(projectId, id, async () => {}));
  completed = new Promise((resolve) => { finish = resolve; });
  preparation = (job) => {
    if (!job.preparation) throw new Error("Missing preparation");
    operations.prepared({ jobId: job.jobId, prepareId: job.preparation.prepareId, results: job.preparation.targets.map((target) => ({ ...target, ok: true })) });
  };
  operations = new SessionOperations({ repository, chooseDirectory: () => chooseDirectory(), remove: (projectId, id) => remove(projectId, id),
    progress: (job) => { if (job.completedAt !== null) finish(job); }, prepare: (job) => preparation(job) });
  await repository.save(session("one"));
  await repository.save(session("two"));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("batch session operations", () => {
  it("archives valid items independently and exposes the missing source", async () => {
    await operations.start({ requestId: "request", action: "archive", targets: [target("one"), target("missing")] });
    const job = await completed;
    expect(job.state).toBe("partially_failed");
    expect(job.items.map((item) => item.state)).toEqual(["succeeded", "failed"]);
    expect(job.items[1].error?.code).toBe("SOURCE_GONE");
    expect(await repository.load("project", "one")).toMatchObject({ archived: true });
  });

  it("deduplicates simultaneous requests and rejects reuse with different targets", async () => {
    const request = { requestId: "same", action: "archive" as const, targets: [target("one"), target("one")] };
    const [first, second] = await Promise.all([operations.start(request), operations.start(request)]);
    expect(first.jobId).toBe(second.jobId);
    expect((await completed).items).toHaveLength(1);
    await expect(operations.start({ ...request, targets: [target("two")] })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("requires a successful freeze before deleting an item", async () => {
    preparation = (job) => {
      expect(job.preparation?.purpose).toBe("freeze");
      operations.prepared({ jobId: job.jobId, prepareId: job.preparation!.prepareId, results: [{ ...target("one"), ok: false, error: "pane busy" }, { ...target("two"), ok: true }] });
    };
    await operations.start({ requestId: "delete", action: "delete", targets: [target("one"), target("two")] });
    const job = await completed;
    expect(job.state).toBe("partially_failed");
    expect(remove).toHaveBeenCalledExactlyOnceWith("project", "two");
    expect(await repository.load("project", "one")).not.toBeNull();
    expect(await repository.load("project", "two")).toBeNull();
  });

  it("selects one directory then exports acknowledged snapshots with unique complete files", async () => {
    let savedRequest: BatchPreparedRequest | null = null;
    preparation = (job) => {
      expect(chooseDirectory).toHaveBeenCalledTimes(1);
      savedRequest = { jobId: job.jobId, prepareId: job.preparation!.prepareId, results: job.preparation!.targets.map((item) => ({ ...item, ok: true, inProgress: true })) };
      operations.prepared(savedRequest);
      operations.prepared(savedRequest);
    };
    await operations.start({ requestId: "export", action: "exportMarkdown", targets: [target("one"), target("two")] });
    const job = await completed;
    expect(job.state).toBe("completed");
    expect(new Set(job.items.map((item) => item.outputPath)).size).toBe(2);
    for (const item of job.items) expect(await fs.readFile(item.outputPath!, "utf8")).toContain("in progress: true");
    expect((await fs.readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("cancel during preparation prevents source deletion", async () => {
    preparation = (job) => { operations.cancel(job.jobId); };
    await operations.start({ requestId: "cancel", action: "delete", targets: [target("one"), target("two")] });
    expect((await completed).state).toBe("cancelled");
    expect(remove).not.toHaveBeenCalled();
    expect(await repository.load("project", "one")).not.toBeNull();
  });

  it("retries only failed deletions after a partial unlink, and skips committed targets", async () => {
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(`${path.sep}one.jsonl`)) throw new Error("file locked");
      return unlink(file);
    });
    await operations.start({ requestId: "first-delete", action: "delete", targets: [target("one"), target("two")] });
    const first = await completed;
    expect(first.items.map((item) => item.state)).toEqual(["failed", "succeeded"]);
    expect(first.items[0].error?.code).toBe("DELETE_INCOMPLETE");
    failure.mockRestore();
    completed = new Promise((resolve) => { finish = resolve; });
    await operations.start({ requestId: "retry-delete", action: "delete", targets: [target("one"), target("two")] });
    const retried = await completed;
    expect(retried.items.map((item) => item.state)).toEqual(["succeeded", "skipped"]);
    expect(retried.items[1].error?.code).toBe("ALREADY_DELETED");
    expect(await repository.list("project")).toEqual([]);
  });

  it("exposes pending startup cleanup as deduplicated retry jobs without replaying operations", async () => {
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(`${path.sep}one.jsonl`)) throw new Error("file locked");
      return unlink(file);
    });
    await expect(repository.remove("project", "one", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    repository = new SessionRepository(path.join(root, "data"), vi.fn());
    const recovered = new SessionOperations({ repository, remove: vi.fn(), chooseDirectory: vi.fn(), progress: vi.fn(), prepare: vi.fn() });
    const first = await recovered.recoveries();
    expect(first).toHaveLength(1);
    expect(first[0].items[0]).toMatchObject({ ...target("one"), state: "failed", error: { code: "DELETE_INCOMPLETE", retryable: true } });
    expect(await recovered.recoveries()).toEqual(first);
    failure.mockRestore();
  });

  it("rejects another batch for a conversation held during preparation, then releases it on cancellation", async () => {
    let prepared!: (job: BatchJob) => void;
    const preparing = new Promise<BatchJob>((resolve) => { prepared = resolve; });
    preparation = prepared;
    const first = await operations.start({ requestId: "holding", action: "delete", targets: [target("one")] });
    await preparing;
    await operations.start({ requestId: "conflict", action: "archive", targets: [target("one")] });
    expect((await completed).items[0].error?.code).toBe("BUSY");
    completed = new Promise((resolve) => { finish = resolve; });
    operations.cancel(first.jobId);
    await completed;
    completed = new Promise((resolve) => { finish = resolve; });
    await operations.start({ requestId: "released", action: "archive", targets: [target("one")] });
    expect((await completed).state).toBe("completed");
  });

  it("coalesces a 500-item batch without delaying its final result", async () => {
    vi.useFakeTimers();
    try {
      const records = Array.from({ length: 500 }, (_, index) => extractSessionMeta(session(`fixture-${index}`), 1));
      const metadata = new Map(records.map((meta) => [conversationKey(meta), meta]));
      vi.spyOn(repository, "resolve").mockImplementation(async (_projectId, key) => {
        const meta = metadata.get(key);
        if (!meta) throw new Error("Unknown fixture");
        return meta;
      });
      const update = vi.spyOn(repository, "updateMeta").mockResolvedValue(0);
      const progress = vi.fn((job: BatchJob) => { if (job.completedAt !== null) finish(job); });
      operations = new SessionOperations({ repository, remove: vi.fn(), chooseDirectory: vi.fn(), prepare: vi.fn(), progress });
      await operations.start({ requestId: "five-hundred", action: "archive", targets: records.map((meta) => ({ projectId: meta.projectId, conversationKey: conversationKey(meta) })) });
      const job = await completed;
      expect(job.items).toHaveLength(500);
      expect(job.items.every((item) => item.state === "succeeded")).toBe(true);
      expect(update).toHaveBeenCalledTimes(500);
      expect(progress.mock.calls.length).toBeLessThanOrEqual(3);
      expect(progress.mock.calls.at(-1)?.[0].completedAt).not.toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
