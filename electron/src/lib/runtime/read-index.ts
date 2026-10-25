import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ThreadHistoryPage, ThreadHistoryChunk, ThreadPageQuery, ThreadChunkQuery, HistoryPageItem } from "@shared/types/runtime-history";
import { RuntimeError } from "@shared/types/runtime";
import { isRecord } from "../productivity-errors";
const Cursor = z.object({ epoch: z.string().length(64), before: z.number().int().nonnegative() }).strict();
async function signature(source: string): Promise<string> {
  const stat = await fs.stat(source, { bigint: true });
  return createHash("sha256").update(JSON.stringify([source, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)])).digest("hex");
}
/** Derived SQLite read model. Production calls this in a worker, never on the UI thread. */
export class ThreadReadIndex {
  constructor(private readonly directory: string) {}
  private async prune(protectedFile: string): Promise<void> {
    const names = (await fs.readdir(this.directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^[a-f0-9]{64}\.sqlite$/.test(entry.name));
    const files = await Promise.all(names.map(async entry => { const file = path.join(this.directory, entry.name), stat = await fs.stat(file); return { file, bytes: stat.size, modified: stat.mtimeMs }; }));
    let total = files.reduce((sum, file) => sum + file.bytes, 0), count = files.length;
    for (const entry of files.sort((a, b) => a.modified - b.modified)) {
      if (count <= 6 && total <= 256 * 1024 * 1024) break;
      if (entry.file === protectedFile) continue;
      for (const file of [entry.file, entry.file + "-wal", entry.file + "-shm"]) {
        try { await fs.unlink(file); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      }
      count--; total -= entry.bytes;
    }
  }
  private async connect(source: string, repaired = false): Promise<DatabaseSync> {
    await fs.mkdir(this.directory, { recursive: true });
    if ((await fs.lstat(this.directory)).isSymbolicLink()) throw new RuntimeError("HISTORY_CACHE_REDIRECTED");
    const file = path.join(this.directory, createHash("sha256").update(source).digest("hex") + ".sqlite");
    try { if ((await fs.lstat(file)).isSymbolicLink()) throw new RuntimeError("HISTORY_CACHE_REDIRECTED"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await this.prune(file);
    const db = new DatabaseSync(file, { allowExtension: false });
    try { db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(key TEXT PRIMARY KEY,message_id TEXT,ordinal INTEGER NOT NULL,payload BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS message_order ON messages(ordinal);`); }
    catch (error) {
      db.close();
      if (!repaired && error instanceof Error && "errcode" in error && (error.errcode === 11 || error.errcode === 26)) {
        for (const candidate of [file, file + "-wal", file + "-shm"]) {
          try { await fs.unlink(candidate); }
          catch (cleanup) { if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT")) throw cleanup; }
        }
        return this.connect(source, true);
      }
      throw error;
    }
    return db;
  }
  private async ensure(db: DatabaseSync, source: string, epoch: string): Promise<{ coldBuild: boolean; sourceBytesRead: number }> {
    if (db.prepare("SELECT value FROM meta WHERE key='epoch'").get()?.value === epoch) return { coldBuild: false, sourceBytesRead: 0 };
    if ((await fs.stat(source)).size > 128 * 1024 * 1024) throw new RuntimeError("HISTORY_SOURCE_LIMIT", "This source exceeds the bounded reader limit; use the existing full-history/export path");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM messages; DELETE FROM meta;");
      const insert = db.prepare("INSERT INTO messages VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload");
      let ordinal = 0, damaged = 0, sourceBytesRead = 0;
      const add = (value: unknown) => {
        if (!isRecord(value)) { damaged++; return; }
        const id = typeof value.id === "string" ? value.id : null;
        // Legacy no-ID records follow identified messages, as the existing fold does.
        const order = id === null ? 1_000_000_000 + ordinal : ordinal;
        const key = id === null ? `legacy:${ordinal}` : `id:${JSON.stringify(id)}`;
        insert.run(key, id, order, Buffer.from(JSON.stringify(value), "utf8")); ordinal++;
      };
      if (source.endsWith(".jsonl")) {
        let pending = Buffer.alloc(0);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const consume = (line: Buffer) => {
          let text: string;
          try { text = decoder.decode(line); } catch { damaged++; return; }
          if (!text.trim()) return;
          let value: unknown;
          try { value = JSON.parse(text); } catch { damaged++; return; }
          if (isRecord(value) && value.type === "msg") add(value.msg);
          else if (!isRecord(value) || value.type !== "header") damaged++;
        };
        for await (const chunk of createReadStream(source, { highWaterMark: 64 * 1024 })) {
          sourceBytesRead += chunk.length; pending = Buffer.concat([pending, chunk]);
          let newline: number;
          while ((newline = pending.indexOf(10)) >= 0) {
            if (newline > 32 * 1024 * 1024) throw new RuntimeError("HISTORY_RECORD_TOO_LARGE");
            consume(pending.subarray(0, newline)); pending = pending.subarray(newline + 1);
          }
          if (pending.length > 32 * 1024 * 1024) throw new RuntimeError("HISTORY_RECORD_TOO_LARGE");
        }
        if (pending.length) consume(pending);
      } else {
        const stat = await fs.stat(source);
        if (stat.size > 32 * 1024 * 1024) throw new RuntimeError("LEGACY_HISTORY_REQUIRES_FULL_LOAD");
        const data = await fs.readFile(source); sourceBytesRead = data.length;
        const value: unknown = JSON.parse(data.toString("utf8"));
        if (!isRecord(value) || !Array.isArray(value.messages)) throw new RuntimeError("HISTORY_INVALID");
        for (const message of value.messages) add(message);
      }
      if (await signature(source) !== epoch) throw new RuntimeError("CURSOR_EXPIRED", "History changed during indexing; retry when stable");
      const put = db.prepare("INSERT INTO meta VALUES (?,?)"); put.run("epoch", epoch); put.run("damaged", String(damaged));
      db.exec("COMMIT"); return { coldBuild: true, sourceBytesRead };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  async page(source: string, query: ThreadPageQuery): Promise<ThreadHistoryPage> {
    const epoch = await signature(source);
    let before = Number.MAX_SAFE_INTEGER;
    if (query.cursor) {
      const cursor = Cursor.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
      if (cursor.epoch !== epoch) throw new RuntimeError("CURSOR_EXPIRED"); before = cursor.before;
    }
    const db = await this.connect(source);
    try {
      const build = await this.ensure(db, source, epoch);
      const rows = db.prepare("SELECT key,message_id,ordinal,length(payload) AS bytes FROM messages WHERE ordinal < ? ORDER BY ordinal DESC LIMIT ?").all(before, query.limit + 1);
      const items: HistoryPageItem[] = []; let bytes = 512;
      for (const row of rows.slice(0, query.limit)) {
        if (typeof row.key !== "string" || typeof row.ordinal !== "number" || typeof row.bytes !== "number") throw new RuntimeError("HISTORY_INDEX_CORRUPT");
        let message: Record<string, unknown> | null = null;
        if (row.bytes <= 128 * 1024 && row.bytes + bytes + 256 < query.maxBytes) {
          const payload = db.prepare("SELECT payload FROM messages WHERE key=?").get(row.key)?.payload;
          if (!(payload instanceof Uint8Array)) throw new RuntimeError("HISTORY_INDEX_CORRUPT");
          const value: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
          if (!isRecord(value)) throw new RuntimeError("HISTORY_INDEX_CORRUPT"); message = value;
        }
        const item: HistoryPageItem = { key: row.key, messageId: typeof row.message_id === "string" ? row.message_id : null,
          ordinal: row.ordinal, bytes: row.bytes, message, partial: message === null };
        const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
        if (bytes + itemBytes > query.maxBytes) {
          if (!items.length) throw new RuntimeError("HISTORY_ITEM_METADATA_TOO_LARGE");
          break;
        }
        items.push(item); bytes += itemBytes;
      }
      const last = items.at(-1);
      const older = last ? Boolean(db.prepare("SELECT 1 FROM messages WHERE ordinal < ? LIMIT 1").get(last.ordinal)) : false;
      const total = db.prepare("SELECT count(*) AS total FROM messages").get()?.total;
      const damaged = db.prepare("SELECT value FROM meta WHERE key='damaged'").get()?.value;
      if (await signature(source) !== epoch) throw new RuntimeError("CURSOR_EXPIRED");
      return { kind: "history-page", epoch, items: items.reverse(), nextCursor: older && last ? Buffer.from(JSON.stringify({ epoch, before: last.ordinal })).toString("base64url") : null,
        total: typeof total === "number" ? total : 0, damagedRecords: Number(damaged) || 0, ...build };
    } finally {
      db.close();
      const file = path.join(this.directory, createHash("sha256").update(source).digest("hex") + ".sqlite");
      await fs.utimes(file, new Date(), new Date()); await this.prune(file);
    }
  }
  async chunk(source: string, query: ThreadChunkQuery): Promise<ThreadHistoryChunk> {
    if (await signature(source) !== query.epoch) throw new RuntimeError("CURSOR_EXPIRED");
    const db = await this.connect(source);
    try {
      await this.ensure(db, source, query.epoch);
      const row = db.prepare("SELECT substr(payload,?,?) AS chunk,length(payload) AS bytes FROM messages WHERE key=?").get(query.offset + 1, query.length, query.key);
      if (!row || !(row.chunk instanceof Uint8Array) || typeof row.bytes !== "number") throw new RuntimeError("SOURCE_GONE");
      if (query.offset > row.bytes) throw new RuntimeError("INVALID_OFFSET");
      if (await signature(source) !== query.epoch) throw new RuntimeError("CURSOR_EXPIRED");
      const nextOffset = query.offset + row.chunk.length;
      return { encoding: "base64", epoch: query.epoch, data: Buffer.from(row.chunk).toString("base64"), nextOffset, eof: nextOffset >= row.bytes };
    } finally {
      db.close();
      const file = path.join(this.directory, createHash("sha256").update(source).digest("hex") + ".sqlite");
      await fs.utimes(file, new Date(), new Date()); await this.prune(file);
    }
  }
}
