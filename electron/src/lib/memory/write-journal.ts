import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MemoryWriteRecord } from "@shared/types/memory";
import { getDataDir } from "../data-dir";
const recordSchema = z.object({ operationId: z.string(), projectId: z.string(), sessionId: z.string(), turnId: z.string(), target: z.string(), scope: z.enum(["project", "personal"]), workspace: z.string(), endpoint: z.string(), anchor: z.string(), hash: z.string(), kind: z.enum(["preference", "convention", "decision", "troubleshooting", "procedure", "correction"]), state: z.enum(["prepared", "submitted", "verified", "unknown", "conflict", "rejected", "changed"]), createdAt: z.number(), updatedAt: z.number(), blockId: z.string().optional(), recordKind: z.enum(["knowledge", "feedback"]).optional() });
export class MemoryJournal {
  private records: MemoryWriteRecord[] | null = null;
  constructor(private readonly directory: () => string = getDataDir) {}
  private file(): string { return path.join(this.directory(), "siyuan-write-journal.json"); }
  private load(): MemoryWriteRecord[] {
    if (this.records) return this.records;
    let records: MemoryWriteRecord[] = [];
    try { records = z.array(recordSchema).parse(JSON.parse(fs.readFileSync(this.file(), "utf8"))); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("记忆写入记录不可读，已阻止新写入"); }
    this.records = records.map((r) => ["prepared", "submitted"].includes(r.state) ? { ...r, state: "unknown" } : r);
    return this.records;
  }
  list(): MemoryWriteRecord[] { return structuredClone(this.load()); }
  save(record: MemoryWriteRecord): void {
    const current = this.load(); const next = current.filter((r) => r.operationId !== record.operationId && !(["verified", "changed", "rejected"].includes(r.state) && r.updatedAt < Date.now() - 30 * 86400_000));
    if (next.length >= 5000) throw new Error("记忆操作记录已达安全上限，请处理历史记录");
    next.push(recordSchema.parse(record));
    const file = this.file(); fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = file + "." + randomUUID();
    try { fs.writeFileSync(temporary, JSON.stringify(next), { encoding: "utf8", flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); this.records = next; }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}
