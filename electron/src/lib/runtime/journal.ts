import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppThread, AppRun, CommandReceipt, RuntimeRequest, RuntimeError } from "@shared/types/runtime";

export const RuntimeCommit = z.object({
  threads: z.array(AppThread).default([]), runs: z.array(AppRun).default([]),
  receipts: z.array(CommandReceipt).default([]), requests: z.array(RuntimeRequest).default([]),
  writer: z.object({ generation: z.number().int().nonnegative(), mode: z.enum(["legacy", "shadow", "managed"]) }).optional(),
}).strict();
export type RuntimeCommit = z.infer<typeof RuntimeCommit>;
const Frame = z.object({ version: z.literal(1), sequence: z.number().int().positive(), previous: z.string(), payload: RuntimeCommit, checksum: z.string().length(64) }).strict();
export type JournalFrame = z.infer<typeof Frame>;
function checksum(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
const Lock = z.object({ pid: z.number().int().positive(), nonce: z.string() });

/** Private, fail-closed append journal. One durable frame is one application commit.
 * No external provider call is performed by this storage component. */
export class OperationJournal {
  readonly file: string;
  private lockFile: string;
  private nonce = randomUUID();
  private handle: fs.FileHandle | null = null;
  private queue: Promise<void> = Promise.resolve();
  private fault: unknown = null;
  private sequence = 0;
  private previous = "";
  private bytes = 0;
  private closing = false;
  private initialized: Promise<JournalFrame[]> | null = null;
  constructor(private readonly directory: string, private readonly maxBytes = 64 * 1024 * 1024) {
    this.file = path.join(directory, "operations.jsonl"); this.lockFile = path.join(directory, "writer.lock");
  }
  get lastSequence(): number { return this.sequence; }
  open(): Promise<JournalFrame[]> {
    return this.initialized ??= this.initialize();
  }
  private async initialize(): Promise<JournalFrame[]> {
    await fs.mkdir(this.directory, { recursive: true });
    // Do not steal a stale lock automatically: PID reuse and uncertain ownership
    // need explicit offline recovery, not an unsafe second writer.
    const lock = await fs.open(this.lockFile, "wx", 0o600).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new RuntimeError("PROFILE_BUSY", "Runtime journal is locked; use offline recovery after confirming its owner exited");
      throw error;
    });
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: this.nonce })); await lock.sync(); }
    finally { await lock.close(); }
    try {
      this.handle = await fs.open(this.file, "r+", 0o600).catch((error: unknown) => {
        if (missing(error)) return fs.open(this.file, "wx+", 0o600);
        throw error;
      });
      const frames: JournalFrame[] = []; let pending = Buffer.alloc(0), offset = 0;
      for await (const chunk of createReadStream(this.file, { highWaterMark: 64 * 1024 })) {
        pending = Buffer.concat([pending, chunk]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
          if (line.length > 1024 * 1024) throw new RuntimeError("JOURNAL_RECORD_LIMIT");
          const frame = Frame.parse(JSON.parse(line.toString("utf8")));
          const { checksum: actual, ...body } = frame;
          if (frame.sequence !== this.sequence + 1 || frame.previous !== this.previous || actual !== checksum(body)) throw new RuntimeError("JOURNAL_CORRUPT");
          frames.push(frame); this.sequence = frame.sequence; this.previous = actual; offset += newline + 1;
          if (offset > this.maxBytes) throw new RuntimeError("JOURNAL_LIMIT");
        }
        if (pending.length > 1024 * 1024) throw new RuntimeError("JOURNAL_RECORD_LIMIT");
      }
      // A partial final frame was never acknowledged; complete corrupt frames
      // fail closed instead of silently dropping accepted history.
      if (pending.length) { await this.handle.truncate(offset); await this.handle.sync(); }
      this.bytes = offset; return frames;
    } catch (error) { await this.handle?.close(); this.handle = null; await this.releaseLock(); throw error; }
  }
  append(payload: RuntimeCommit): Promise<JournalFrame> {
    if (this.closing) return Promise.reject(new RuntimeError("JOURNAL_CLOSED"));
    const frozen = RuntimeCommit.parse(structuredClone(payload));
    const operation = this.queue.then(async () => {
      await this.open();
      if (this.fault) throw new RuntimeError("JOURNAL_UNCERTAIN", "Reopen and inspect the journal before retrying");
      const body = { version: 1 as const, sequence: this.sequence + 1, previous: this.previous, payload: frozen };
      const frame: JournalFrame = { ...body, checksum: checksum(body) };
      const encoded = Buffer.from(JSON.stringify(frame) + "\n", "utf8");
      if (encoded.length > 1024 * 1024 || this.bytes + encoded.length > this.maxBytes) throw new RuntimeError("JOURNAL_LIMIT");
      if (!this.handle) throw new RuntimeError("JOURNAL_CLOSED");
      try {
        let written = 0;
        while (written < encoded.length) {
          const result = await this.handle.write(encoded, written, encoded.length - written, this.bytes + written);
          if (result.bytesWritten === 0) throw new RuntimeError("JOURNAL_WRITE_STALLED");
          written += result.bytesWritten;
        }
        await this.handle.sync();
      }
      catch (error) { this.fault = error; throw error; }
      this.sequence = frame.sequence; this.previous = frame.checksum; this.bytes += encoded.length;
      return frame;
    });
    this.queue = operation.then(() => {}, () => {}); return operation;
  }
  private async releaseLock(): Promise<void> {
    try {
      const owner = Lock.parse(JSON.parse(await fs.readFile(this.lockFile, "utf8")));
      if (owner.nonce === this.nonce) await fs.unlink(this.lockFile);
    } catch (error) { if (!missing(error)) throw error; }
  }
  async close(): Promise<void> {
    this.closing = true; await this.queue;
    if (!this.initialized) return;
    try { await this.initialized; } catch { return; }
    await this.handle?.close(); this.handle = null; await this.releaseLock();
  }
}
