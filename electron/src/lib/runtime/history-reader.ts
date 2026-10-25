import { clearHistoryReadCache } from "./read-cache";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HistoryPageSchema, HistoryChunkSchema, type ThreadPageQuery, type ThreadChunkQuery, type ThreadHistoryPage, type ThreadHistoryChunk } from "@shared/types/runtime-history";
import { RuntimeError } from "@shared/types/runtime";
const Reply = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), value: z.union([HistoryPageSchema, HistoryChunkSchema]) }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export class ThreadHistoryReader {
  private worker: Worker | null = null;
  private invalidating: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, { resolve: (value: ThreadHistoryPage | ThreadHistoryChunk) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly directory: string, private readonly workerPath = path.join(__dirname, "runtime-history-worker.js")) {}
  private start(): Worker {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    if (this.worker) return this.worker;
    const worker = this.worker = new Worker(this.workerPath, { workerData: { directory: this.directory } });
    worker.on("message", (input: unknown) => {
      const parsed = Reply.safeParse(input);
      if (!parsed.success) { void this.stop(new RuntimeError("HISTORY_WORKER_PROTOCOL")); return; }
      const reply = parsed.data, job = this.pending.get(reply.id); if (!job) return;
      this.pending.delete(reply.id); clearTimeout(job.timer);
      if (reply.ok) job.resolve(reply.value); else job.reject(new RuntimeError(reply.error.code, reply.error.message));
      if (!this.pending.size) this.idle = setTimeout(() => { void this.close(); }, 30_000);
    });
    worker.on("error", error => { if (this.worker === worker) void this.stop(error instanceof Error ? error : new RuntimeError("HISTORY_WORKER_FAILURE")); });
    worker.on("exit", () => { if (this.worker === worker) void this.stop(new RuntimeError("HISTORY_WORKER_EXITED")); });
    return worker;
  }
  private call(source: string, request: { kind: "page"; query: ThreadPageQuery } | { kind: "chunk"; query: ThreadChunkQuery }): Promise<ThreadHistoryPage | ThreadHistoryChunk> {
    if (this.pending.size >= 16) return Promise.reject(new RuntimeError("HISTORY_BUSY"));
    const worker = this.start(), id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop(new RuntimeError("HISTORY_TIMEOUT")); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ ...request, id, source }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async page(source: string, query: ThreadPageQuery): Promise<ThreadHistoryPage> { await this.invalidating; return HistoryPageSchema.parse(await this.call(source, { kind: "page", query })); }
  async chunk(source: string, query: ThreadChunkQuery): Promise<ThreadHistoryChunk> { await this.invalidating; return HistoryChunkSchema.parse(await this.call(source, { kind: "chunk", query })); }
  private async stop(error: Error): Promise<void> {
    if (this.idle) clearTimeout(this.idle); this.idle = null;
    const worker = this.worker; this.worker = null;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear(); if (worker) await worker.terminate();
  }
  invalidate(): Promise<void> {
    if (this.invalidating) return this.invalidating;
    const work = this.stop(new RuntimeError("CURSOR_EXPIRED")).then(() => clearHistoryReadCache(this.directory));
    this.invalidating = work;
    void work.then(() => { if (this.invalidating === work) this.invalidating = null; }, () => { /* Retain failed barrier; do not serve an uncleared cache. */ });
    return work;
  }
  close(): Promise<void> { return this.stop(new RuntimeError("HISTORY_READER_CLOSED")); }
}
