import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { HISTORY_EMBEDDING_MODEL as model } from "@shared/lib/embedding-model";
import type { HistoryIndexStatus, HistorySearchRequest } from "@shared/types/productivity";
import { operationError, ProductivityError } from "../productivity-errors";
import { EmbeddingClient } from "./embedding-client";
import { projectsForScope } from "./query";
import type { HistorySqlite, StoredHistoryChunk } from "./sqlite";
import type { HistoryCatalog, HistorySnapshot } from "./types";

interface SemanticContext { database: HistorySqlite; snapshot: HistorySnapshot; catalog: HistoryCatalog; revision: number; generation: number }
export interface SemanticMatch { entryKey: string; entryContentHash: string; start: number; end: number; score: number }
export type SemanticUpdate = Pick<HistoryIndexStatus, "semanticState" | "semanticProgress"> & { indexedConversations: number; complete: boolean };
export interface SemanticHost {
  read: () => Promise<SemanticContext>;
  readQuery: () => Promise<SemanticContext & { release: () => void }>;
  clearCache: () => Promise<void>;
  commit: (conversationKey: string, entryKey: string, hash: string, revision: number, chunks: StoredHistoryChunk[], signal: AbortSignal) => Promise<boolean>;
  changed: (status: SemanticUpdate, force: boolean) => void;
}
export const emptySemanticProgress = (): HistoryIndexStatus["semanticProgress"] => ({ indexedEntries: 0, totalEntries: 0,
  failedEntries: 0, modelKey: null, download: null, error: null });

/** Background embedding is serial; queries take priority between inference batches. */
export class HistorySemantic {
  private readonly client: EmbeddingClient;
  private readonly cacheDir: string;
  private enabled = false;
  private paused = false;
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private dirty = false;
  private state: SemanticUpdate = { semanticState: "disabled", semanticProgress: emptySemanticProgress(), indexedConversations: 0, complete: false };
  constructor(root: string, private readonly host: SemanticHost) {
    this.cacheDir = path.join(root, "history", "models");
    this.client = new EmbeddingClient(this.cacheDir, (download) => {
      this.state.semanticProgress.download = download; this.publish();
    });
  }
  private publish(force = false): void { this.host.changed(structuredClone(this.state), force); }
  configure(enabled: boolean, key: string | null): void {
    if (enabled && key !== null && key !== model.key) {
      this.enabled = false; this.paused = true; this.dirty = false; this.controller?.abort(); void this.client.stop();
      this.state.semanticState = "error";
      this.state.semanticProgress.error = { code: "MODEL_VERSION_UNSUPPORTED", message: "Enable semantic search again to use the supported local model", retryable: true };
      this.publish(true); return;
    }
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.paused = false;
    if (!enabled) {
      this.controller?.abort(); void this.client.stop();
      this.state.semanticState = "disabled"; this.state.complete = false;
      this.state.semanticProgress.download = null; this.publish(true);
    } else { this.state.semanticProgress.modelKey = model.key; this.schedule(); }
  }
  schedule(): void {
    if (!this.enabled || this.paused) return;
    this.dirty = true;
    if (this.task) return;
    const controller = this.controller = new AbortController();
    this.task = (async () => {
      while (this.dirty && !controller.signal.aborted) { this.dirty = false; await this.index(controller.signal); }
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.state.semanticState = "error"; this.state.complete = false;
      this.state.semanticProgress.error = operationError(error); this.publish(true);
    }).finally(() => {
      this.task = null;
      if (this.controller === controller) this.controller = null;
      if (this.dirty && this.enabled && !this.paused) this.schedule();
    });
  }

  private async index(signal: AbortSignal): Promise<void> {
    const context = await this.host.read();
    signal.throwIfAborted();
    const conversations = [...context.snapshot.conversations.values()];
    const entries = conversations.flatMap((conversation) => conversation.entries
      .filter((entry) => entry.kind === "title" || entry.kind === "user" || entry.kind === "assistant")
      .map((entry) => ({ conversation, entry })));
    this.state = { semanticState: "preparing", semanticProgress: { ...emptySemanticProgress(), modelKey: model.key, totalEntries: entries.length }, indexedConversations: 0, complete: false };
    this.publish(true);
    const remaining = new Map(conversations.map((conversation) => [conversation.conversationKey,
      conversation.entries.filter((entry) => entry.kind === "title" || entry.kind === "user" || entry.kind === "assistant").length]));
    for (const { conversation, entry } of entries) {
      signal.throwIfAborted();
      const current = await this.host.read();
      if (current.revision !== context.revision) return;
      let indexed = current.database.hasEmbedding(entry.entryKey, entry.contentHash, model.key);
      if (!indexed && Buffer.byteLength(entry.displayText, "utf8") > 1024 * 1024) {
        this.state.semanticProgress.failedEntries++;
        this.state.semanticProgress.error = { code: "SEMANTIC_ENTRY_TOO_LARGE", message: "Messages over 1 MiB remain available in keyword search", retryable: false };
        continue;
      }
      if (!indexed) {
        const split = await this.client.call({ action: "chunks", text: entry.displayText }, signal);
        if (!("chunks" in split)) throw new ProductivityError("MODEL_OUTPUT_INVALID");
        const latest = await this.host.read();
        if (latest.revision !== context.revision) return;
        const chunks = split.chunks.map((chunk) => {
          const contentHash = createHash("sha256").update(entry.displayText.slice(chunk.start, chunk.end)).digest("hex");
          return { ...chunk, contentHash, vector: latest.database.cachedVector(contentHash, model.key, model.dimensions) };
        });
        this.state.semanticState = "indexing"; this.state.semanticProgress.download = null;
        this.publish();
        const encoded: StoredHistoryChunk[] = [];
        const vectors = new Map<string, Float32Array>();
        for (const chunk of chunks) {
          signal.throwIfAborted();
          let vector = chunk.vector ?? vectors.get(chunk.contentHash);
          if (!vector) {
            const result = await this.client.call({ action: "embed", texts: [entry.displayText.slice(chunk.start, chunk.end)], kind: "passage" }, signal);
            if (!("vectors" in result) || result.vectors.length !== 1) throw new ProductivityError("MODEL_OUTPUT_INVALID");
            vector = result.vectors[0];
          }
          vectors.set(chunk.contentHash, vector);
          encoded.push({ ...chunk, vector });
        }
        signal.throwIfAborted();
        indexed = await this.host.commit(conversation.conversationKey, entry.entryKey, entry.contentHash, context.revision, encoded, signal);
        if (!indexed) return;
      }
      this.state.semanticProgress.indexedEntries++;
      const left = (remaining.get(conversation.conversationKey) ?? 1) - 1;
      remaining.set(conversation.conversationKey, left);
      if (!left) this.state.indexedConversations++;
      this.publish();
    }
    this.state.semanticState = "ready";
    this.state.complete = context.snapshot.coverage.keywordComplete && this.state.semanticProgress.failedEntries === 0;
    this.state.semanticProgress.download = null;
    this.publish(true);
  }

  async search(request: HistorySearchRequest, signal: AbortSignal) {
    if (!this.enabled) throw new ProductivityError("SEMANTIC_DISABLED", "Enable local semantic search in settings", true);
    const before = await this.host.read();
    if (this.state.semanticProgress.indexedEntries === 0 && this.state.semanticProgress.totalEntries > 0) throw new ProductivityError("INDEX_NOT_READY", "Semantic history is still being indexed", true);
    const encoded = await this.client.call({ action: "embed", kind: "query", texts: [request.query.trim()] }, signal);
    if (!("vectors" in encoded) || encoded.vectors.length !== 1) throw new ProductivityError("MODEL_OUTPUT_INVALID");
    const context = await this.host.readQuery();
    try {
    signal.throwIfAborted();
    if (context.revision !== before.revision) throw new ProductivityError("CURSOR_EXPIRED", "History changed. Refresh the results.", true);
    const query = encoded.vectors[0];
    const norm = Math.sqrt(query.reduce((sum, number) => sum + number * number, 0));
    const top = new Map<string, SemanticMatch>();
    let minimum = -Infinity, visited = 0;
    for (const row of context.database.vectors([...projectsForScope(request.scope, context.catalog)], request, model.key)) {
      if (row.dimensions !== model.dimensions || row.vector.byteLength !== model.dimensions * 4 || !row.norm) throw new ProductivityError("SEMANTIC_CACHE_INVALID");
      const values = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      let score = 0;
      for (let index = 0; index < query.length; index++) score += query[index] * values.getFloat32(index * 4, true);
      score /= norm * row.norm;
      if (!Number.isFinite(score)) throw new ProductivityError("SEMANTIC_CACHE_INVALID");
      const previous = top.get(row.entryKey);
      if ((!previous || score > previous.score) && (top.size < 100 || score >= minimum)) {
        top.set(row.entryKey, { entryKey: row.entryKey, entryContentHash: row.entryContentHash, start: row.start, end: row.end, score });
        if (top.size > 100) {
          let worst: SemanticMatch | undefined;
          for (const candidate of top.values()) {
            if (!worst || candidate.score < worst.score || candidate.score === worst.score && candidate.entryKey.localeCompare(worst.entryKey) > 0) worst = candidate;
          }
          if (worst) top.delete(worst.entryKey);
        }
        minimum = -Infinity;
        if (top.size >= 100) {
          minimum = Infinity;
          for (const item of top.values()) minimum = Math.min(minimum, item.score);
        }
      }
      if (++visited % 256 === 0) { await new Promise<void>((resolve) => setImmediate(resolve)); signal.throwIfAborted(); }
    }
    signal.throwIfAborted();
    if (!this.enabled) throw new ProductivityError("SEMANTIC_DISABLED");
    return { context: { snapshot: context.snapshot, catalog: context.catalog, generation: context.generation, backend: "sqlite" as const },
      release: context.release, matches: [...top.values()].sort((a, b) => b.score - a.score || a.entryKey.localeCompare(b.entryKey)) };
    } catch (error) { context.release(); throw error; }
  }

  async pause(): Promise<void> {
    this.paused = true; this.dirty = false; this.controller?.abort();
    await this.client.stop(); await this.task;
    this.state.semanticState = this.enabled ? "paused" : "disabled";
    this.state.semanticProgress.download = null; this.publish(true);
  }
  resume(): void { this.paused = false; this.schedule(); }
  async clear(): Promise<void> {
    this.enabled = false; await this.pause();
    await this.host.clearCache();
    await fs.rm(this.cacheDir, { recursive: true, force: true });
    this.state = { semanticState: "disabled", semanticProgress: emptySemanticProgress(), indexedConversations: 0, complete: false }; this.publish(true);
  }
  async close(): Promise<void> { this.enabled = false; await this.pause(); }
}
