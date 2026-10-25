import { z } from "zod";
const StorageId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const ThreadPageQuery = z.object({ projectId: StorageId, sessionId: StorageId,
  cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).default(50),
  maxBytes: z.number().int().min(1024).max(1024 * 1024).default(512 * 1024),
}).strict();
export type ThreadPageQuery = z.infer<typeof ThreadPageQuery>;
export const ThreadChunkQuery = z.object({ projectId: StorageId, sessionId: StorageId,
  epoch: z.string().length(64), key: z.string().min(1).max(2048), offset: z.number().int().nonnegative(),
  length: z.number().int().min(1).max(64 * 1024).default(64 * 1024),
}).strict();
export type ThreadChunkQuery = z.infer<typeof ThreadChunkQuery>;
export interface HistoryPageItem { key: string; messageId: string | null; ordinal: number; bytes: number; message: Record<string, unknown> | null; partial: boolean }
/** Read-only window. Intentionally NOT PersistedSession: never save this as full history. */
export interface ThreadHistoryPage {
  kind: "history-page"; epoch: string; items: HistoryPageItem[]; nextCursor: string | null;
  total: number; damagedRecords: number; coldBuild: boolean; sourceBytesRead: number;
}
export interface ThreadHistoryChunk { encoding: "base64"; epoch: string; data: string; nextOffset: number; eof: boolean }
export type HistoryReadResult = { ok: true; page: ThreadHistoryPage } | { ok: false; error: { code: string; message: string } };
export type HistoryChunkResult = { ok: true; chunk: ThreadHistoryChunk } | { ok: false; error: { code: string; message: string } };

export const HistoryPageSchema: z.ZodType<ThreadHistoryPage> = z.object({
  kind: z.literal("history-page"), epoch: z.string().length(64),
  items: z.array(z.object({ key: z.string(), messageId: z.string().nullable(), ordinal: z.number(), bytes: z.number(), message: z.record(z.string(), z.unknown()).nullable(), partial: z.boolean() })),
  nextCursor: z.string().nullable(), total: z.number(), damagedRecords: z.number(), coldBuild: z.boolean(), sourceBytesRead: z.number(),
});
export const HistoryChunkSchema: z.ZodType<ThreadHistoryChunk> = z.object({ encoding: z.literal("base64"), epoch: z.string().length(64), data: z.string(), nextOffset: z.number(), eof: z.boolean() });
