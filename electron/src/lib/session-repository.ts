import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { conversationKey } from "@shared/lib/session-identity";
import { extractSessionMeta, type SessionMeta } from "@shared/lib/session-persistence";
import { writeJsonAtomically, writeTextAtomically } from "./atomic-file";
import { repairJsonlTail } from "./jsonl-tail";
import { parseSessionJsonl, serializeAppendLines, serializeSessionJsonl } from "./session-jsonl";
import { assertStorageId, isMissingFile, isRecord, ProductivityError } from "./productivity-errors";
import type { SessionResumeSource } from "@shared/types/productivity";
import type { EngineId } from "@shared/types/engine";
import { notifyProjectsChanged, readProjectCatalog, writeProjectCatalog } from "./project-catalog";
import { assertReplacementKeys, readSessionReplacements, replacementPath, replacementBackupDirectory, replacementBackupFile,
  SESSION_SOURCE_FORMATS, type SessionReplacement, type SessionSourceFormat } from "./session-replacements";

export type SessionData = Record<string, unknown> & { id: string; projectId: string };
export type SessionMetaPatch = import("@shared/lib/session-persistence").SessionMetadataPatch;
export interface SessionChange { kind: "upsert" | "delete"; conversationKey: string; projectId: string; runtimeSessionId: string }
interface Deletion {
  version: 1;
  conversationKey: string;
  projectId: string;
  runtimeIds: string[];
  state: "pending" | "committed";
  unlinkStarted: boolean;
  updatedAt: number;
  title?: string;
  operationId?: string;
}
interface ProjectDeletion {
  version: 1; projectId: string; state: "pending" | "committed"; unlinkStarted: boolean; updatedAt: number;
}
export interface DeletionTarget {
  projectId: string; conversationKey: string; id: string; title: string;
  state: "available" | "pending" | "committed";
}
export interface SessionRuntimeLease { assertActive: () => void; release: () => void }
interface BoundRuntime { cancelled: boolean; stop: () => Promise<void> }
const META_FIELDS = ["archived", "pinned", "folderId", "branch", "title", "model", "effort", "permissionMode", "planMode"] as const;
const PATCH_FIELDS = [...META_FIELDS, "codexGoal"] as const;

function asSession(value: unknown, projectId: string, id: string): SessionData {
  if (!isRecord(value) || value.id !== id || value.projectId !== projectId) {
    throw new ProductivityError("INVALID_ARGUMENT", "Session identity does not match its source");
  }
  return { ...value, id, projectId };
}

function lastUserTime(data: Record<string, unknown>): number {
  const messages: unknown = data.messages ?? data.appendedMessages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message: unknown = messages[i];
      if (isRecord(message) && message.role === "user" && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
    }
  }
  return typeof data.lastMessageAt === "number" ? data.lastMessageAt : typeof data.createdAt === "number" ? data.createdAt : 0;
}

/** JSONL remains authoritative. Locks are logical conversations, never runtime IDs. */
export class SessionRepository {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly deletions = new Map<string, Deletion>();
  private readonly deletedAliases = new Map<string, string>();
  private readonly deletionKeys = new Map<string, string>();
  private readonly replacements = new Map<string, SessionReplacement>();
  private readonly replacementRecords = new Map<string, SessionReplacement>();
  private readonly preparingReplacements = new Map<string, SessionReplacement>();
  private readonly keyRedirects = new Map<string, string>();
  private readonly metadata = new Map<string, SessionMeta>();
  private readonly projectLoads = new Map<string, Promise<void>>();
  private readonly appendLines = new Map<string, number>();
  private readonly listeners = new Set<(change: SessionChange) => void>();
  private readonly runtimes = new Map<string, Map<string, BoundRuntime>>();
  private readonly projectRuntimes = new Map<string, Map<string, BoundRuntime>>();
  private readonly projectDeletions = new Map<string, ProjectDeletion>();
  private readonly projectRemovals = new Map<string, Promise<"deleted" | "already_deleted">>();
  private ready: Promise<void> | null = null;

  constructor(readonly root: string, private readonly report: (label: string, error: unknown) => void = console.error) {}

  onChange(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  isProjectBlocked(projectId: string): boolean { return this.projectDeletions.has(projectId); }
  isHistoryBlocked(key: string): boolean {
    if (this.deletionForKey(key) || this.keyRedirects.has(key)) return true;
    try { const tuple: unknown = JSON.parse(key); return Array.isArray(tuple) && this.isProjectBlocked(String(tuple[0])); }
    catch { return false; }
  }

  /** Drafts have no saved conversation yet, but project deletion must still stop them. */
  async bindProjectRuntime(projectId: string, runtimeId: string, stop: () => Promise<void>): Promise<SessionRuntimeLease> {
    assertStorageId(projectId); assertStorageId(runtimeId);
    await this.initialize();
    this.assertCurrent("", projectId, runtimeId);
    return this.registerRuntime(projectId, runtimeId, stop);
  }

  /** Register before the first async startup step; deletion can cancel even an unspawned runtime. */
  async bindRuntime(source: SessionResumeSource, engine: EngineId, runtimeId: string, stop: () => Promise<void>): Promise<SessionRuntimeLease> {
    this.file(source.projectId, source.runtimeSessionId, "jsonl");
    assertStorageId(runtimeId);
    await this.initialize();
    this.assertCurrent("", source.projectId, source.runtimeSessionId);
    const meta = await this.readMeta(source.projectId, source.runtimeSessionId);
    this.assertCurrent("", source.projectId, source.runtimeSessionId);
    if (!meta) throw new ProductivityError("SOURCE_GONE");
    if ((meta.engine ?? "claude") !== engine) throw new ProductivityError("INVALID_ARGUMENT", "The source conversation uses another engine");
    const key = conversationKey(meta);
    this.assertCurrent(key, source.projectId, source.runtimeSessionId);
    return this.registerRuntime(source.projectId, runtimeId, stop, key, source.runtimeSessionId);
  }

  private registerRuntime(projectId: string, runtimeId: string, stop: () => Promise<void>, key?: string, sourceId?: string): SessionRuntimeLease {
    const project = this.projectRuntimes.get(projectId) ?? new Map<string, BoundRuntime>();
    if (project.has(runtimeId)) throw new ProductivityError("BUSY", "This runtime is already being started", true);
    const bound = key ? this.runtimes.get(key) ?? new Map<string, BoundRuntime>() : undefined;
    const runtime: BoundRuntime = { cancelled: false, stop };
    project.set(runtimeId, runtime); this.projectRuntimes.set(projectId, project);
    if (bound && key) { bound.set(runtimeId, runtime); this.runtimes.set(key, bound); }
    return {
      assertActive: () => {
        if (runtime.cancelled) throw new ProductivityError("SESSION_DELETING");
        if (sourceId) this.assertWritable(key ?? "", projectId, sourceId);
        this.assertWritable(this.currentKey(key ?? ""), projectId, runtimeId);
        // An in-place identity promotion can occur while this same process is
        // streaming. Only retirement of its runtime ID invalidates the lease.
        if (this.replacements.has(this.alias(projectId, runtimeId))) throw new ProductivityError("SESSION_REPLACED");
      },
      release: () => {
        if (bound?.get(runtimeId) === runtime) bound.delete(runtimeId);
        if (bound && !bound.size && key && this.runtimes.get(key) === bound) this.runtimes.delete(key);
        if (project.get(runtimeId) === runtime) project.delete(runtimeId);
        if (!project.size && this.projectRuntimes.get(projectId) === project) this.projectRuntimes.delete(projectId);
      },
    };
  }

  private emit(kind: SessionChange["kind"], meta: SessionMeta): void {
    for (const listener of this.listeners) {
      try { listener({ kind, conversationKey: conversationKey(meta), projectId: meta.projectId, runtimeSessionId: meta.id }); }
      catch (error) { this.report("SESSIONS:CHANGE_LISTENER_ERR", error); }
    }
  }

  private file(projectId: string, id: string, extension: string): string {
    assertStorageId(projectId);
    assertStorageId(id);
    return path.join(this.root, "sessions", projectId, `${id}.${extension}`);
  }

  private alias(projectId: string, id: string): string { return JSON.stringify([projectId, id]); }
  private deletionPath(key: string): string {
    return path.join(this.root, "sessions", ".deletions", `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  initialize(): Promise<void> {
    return this.ready ??= this.recoverProjectDeletions().then(() => this.recoverReplacements())
      .catch((error: unknown) => { this.ready = null; throw error; });
  }

  private currentKey(key: string): string {
    const seen = new Set<string>();
    while (this.keyRedirects.has(key)) {
      if (seen.has(key)) throw new ProductivityError("REPLACEMENT_STATE_INVALID");
      seen.add(key); key = this.keyRedirects.get(key)!;
    }
    return key;
  }

  private currentRuntime(projectId: string, id: string): string {
    const seen = new Set<string>();
    while (this.replacements.has(this.alias(projectId, id))) {
      if (seen.has(id)) throw new ProductivityError("REPLACEMENT_STATE_INVALID");
      seen.add(id); id = this.replacements.get(this.alias(projectId, id))!.runtimeId;
    }
    return id;
  }

  private deletionForKey(key: string): Deletion | undefined {
    return this.deletions.get(this.deletionKeys.get(this.currentKey(key)) ?? key);
  }

  private rememberReplacement(record: SessionReplacement): void {
    this.preparingReplacements.delete(this.alias(record.projectId, record.runtimeId));
    this.replacementRecords.set(replacementPath(this.root, record), record);
    for (const id of record.retiredIds) this.replacements.set(this.alias(record.projectId, id), record);
    const deletion = this.deletionForKey(record.previousKey);
    if (record.previousKey !== record.conversationKey) this.keyRedirects.set(record.previousKey, record.conversationKey);
    if (deletion) {
      deletion.runtimeIds = [...new Set([...deletion.runtimeIds, ...record.retiredIds, record.runtimeId])];
      this.rememberDeletion(deletion);
    }
  }

  private async rollbackReplacement(record: SessionReplacement): Promise<void> {
    if (record.previousId === record.runtimeId) {
      for (const format of SESSION_SOURCE_FORMATS) {
        const file = this.file(record.projectId, record.runtimeId, format);
        if (record.backupFormats.includes(format)) await writeTextAtomically(file, await fs.readFile(replacementBackupFile(this.root, record, format), "utf8"));
        else await fs.unlink(file).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
      }
      this.appendLines.delete(this.file(record.projectId, record.runtimeId, "jsonl"));
    } else await this.unlinkSnapshot(record.projectId, record.runtimeId);
    await fs.unlink(replacementPath(this.root, record));
    this.preparingReplacements.delete(this.alias(record.projectId, record.runtimeId));
    await fs.rm(replacementBackupDirectory(this.root, record), { recursive: true, force: true });
  }

  private async backupReplacement(record: SessionReplacement): Promise<void> {
    await fs.mkdir(replacementBackupDirectory(this.root, record), { recursive: true });
    for (const format of SESSION_SOURCE_FORMATS) {
      try {
        await fs.copyFile(this.file(record.projectId, record.runtimeId, format), replacementBackupFile(this.root, record, format));
        record.backupFormats.push(format);
      } catch (error) { if (!isMissingFile(error)) throw error; }
    }
    if (!record.backupFormats.some((format) => format !== "meta.json")) throw new ProductivityError("SOURCE_GONE");
  }

  private async cleanupReplacement(record: SessionReplacement): Promise<void> {
    for (const id of record.retiredIds) await this.unlinkSnapshot(record.projectId, id);
    await fs.rm(replacementBackupDirectory(this.root, record), { recursive: true, force: true });
  }

  private async purgeReplacementBackups(records: SessionReplacement[]): Promise<void> {
    for (const record of records) {
      await fs.rm(replacementBackupDirectory(this.root, record), { recursive: true, force: true });
      if (record.state === "prepared") {
        await fs.unlink(replacementPath(this.root, record)).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
        this.preparingReplacements.delete(this.alias(record.projectId, record.runtimeId));
      }
    }
  }

  private replacementsForKey(key: string): SessionReplacement[] {
    const current = this.currentKey(key);
    return [...this.replacementRecords.values(), ...this.preparingReplacements.values()].filter((record) => this.currentKey(record.previousKey) === current);
  }

  private async recoverReplacements(): Promise<void> {
    const records = await readSessionReplacements(this.root);
    this.replacements.clear(); this.replacementRecords.clear(); this.preparingReplacements.clear(); this.keyRedirects.clear();
    for (const record of records) {
      if (record.state === "prepared") this.preparingReplacements.set(this.alias(record.projectId, record.runtimeId), record);
      else {
        if (record.retiredIds.some((id) => this.replacements.has(this.alias(record.projectId, id)))) throw new ProductivityError("REPLACEMENT_STATE_INVALID");
        const redirected = this.keyRedirects.get(record.previousKey);
        if (redirected && redirected !== record.conversationKey) throw new ProductivityError("REPLACEMENT_STATE_INVALID");
        this.rememberReplacement(record);
      }
    }
    for (const record of records) {
      this.currentKey(record.previousKey); this.currentRuntime(record.projectId, record.previousId);
      if (record.state === "prepared" && this.replacements.has(this.alias(record.projectId, record.runtimeId))) throw new ProductivityError("REPLACEMENT_STATE_INVALID");
    }
    // Deletion wins over rollback: restoring a prepared in-place backup after a
    // committed delete would recreate user data that was explicitly removed.
    await this.recoverDeletions();
    for (const record of records) {
      try {
        if (this.isProjectBlocked(record.projectId) || this.deletionForKey(record.previousKey)) await this.purgeReplacementBackups([record]);
        else if (record.state === "prepared") await this.rollbackReplacement(record);
        else await this.cleanupReplacement(record);
      } catch (error) { this.report("SESSIONS:REPLACEMENT_RECOVERY_ERR", error); }
    }
    // A crash before the prepared marker can leave only a backup directory.
    // Its original files have not been changed yet, so that orphan is disposable.
    const folder = path.join(this.root, "sessions", ".replacements");
    const retained = new Set(records.map((record) => path.basename(replacementBackupDirectory(this.root, record))));
    const files = await fs.readdir(folder, { withFileTypes: true }).catch((error: unknown) => { if (isMissingFile(error)) return []; throw error; });
    for (const file of files) if (file.isDirectory() && /^[a-f0-9]{64}\.json\.backup$/.test(file.name) && !retained.has(file.name)) {
      try { await fs.rm(path.join(folder, file.name), { recursive: true, force: true }); }
      catch (error) { this.report("SESSIONS:REPLACEMENT_BACKUP_CLEANUP_ERR", error); }
    }
  }

  private rememberDeletion(deletion: Deletion): void {
    this.deletions.set(deletion.conversationKey, deletion);
    this.deletionKeys.set(this.currentKey(deletion.conversationKey), deletion.conversationKey);
    for (const id of deletion.runtimeIds) this.deletedAliases.set(this.alias(deletion.projectId, id), deletion.conversationKey);
  }

  private async recoverDeletions(): Promise<void> {
    const dir = path.join(this.root, "sessions", ".deletions");
    let files: string[];
    try { files = await fs.readdir(dir); } catch (error) { if (isMissingFile(error)) return; throw error; }
    for (const name of files.filter((name) => name.endsWith(".json"))) {
      const contents = await fs.readFile(path.join(dir, name), "utf8");
      let raw: unknown;
      try { raw = JSON.parse(contents); }
      catch { throw new ProductivityError("DELETION_STATE_INVALID", "A deletion record is damaged. Repair it before changing saved conversations.", true); }
      if (!isRecord(raw) || raw.version !== 1 || typeof raw.conversationKey !== "string" || typeof raw.projectId !== "string"
        || !Array.isArray(raw.runtimeIds) || !raw.runtimeIds.length || !raw.runtimeIds.every((id: unknown) => typeof id === "string")
        || (raw.state !== "pending" && raw.state !== "committed")) throw new ProductivityError("DELETION_STATE_INVALID", "A deletion record is damaged. Repair it before changing saved conversations.", true);
      let identity: unknown;
      try { identity = JSON.parse(raw.conversationKey); } catch { throw new ProductivityError("DELETION_STATE_INVALID"); }
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== raw.projectId
        || !["claude", "codex", "acp"].includes(String(identity[1])) || typeof identity[2] !== "string" || !identity[2]
        || name !== path.basename(this.deletionPath(raw.conversationKey))) throw new ProductivityError("DELETION_STATE_INVALID");
      assertStorageId(raw.projectId);
      const runtimeIds: string[] = raw.runtimeIds.filter((id: unknown): id is string => typeof id === "string");
      runtimeIds.forEach(assertStorageId);
      const deletion: Deletion = { version: 1, conversationKey: raw.conversationKey, projectId: raw.projectId, runtimeIds, state: raw.state, unlinkStarted: raw.unlinkStarted === true, updatedAt: Number(raw.updatedAt) || 0,
        title: typeof raw.title === "string" ? raw.title : undefined, operationId: typeof raw.operationId === "string" ? raw.operationId : undefined };
      this.rememberDeletion(deletion);
    }
    // Load every barrier before attempting cleanup. An inaccessible snapshot must
    // not prevent other records from protecting their conversations or loading chats.
    for (const deletion of this.deletions.values()) {
      if (deletion.state === "pending") {
        try {
          // No agent processes have been started during repository initialization.
          for (const id of deletion.runtimeIds) await this.unlinkSnapshot(deletion.projectId, id);
          await this.purgeReplacementBackups(this.replacementsForKey(deletion.conversationKey));
          await this.commitDeletion(deletion);
        } catch (error) { this.report("SESSIONS:DELETE_RECOVERY_ERR", error); }
      }
    }
  }

  private projectDeletionPath(projectId: string): string {
    assertStorageId(projectId);
    return path.join(this.root, "sessions", ".project-deletions", `${projectId}.json`);
  }

  private async recoverProjectDeletions(): Promise<void> {
    const folder = path.join(this.root, "sessions", ".project-deletions");
    let files: string[];
    try { files = await fs.readdir(folder); } catch (error) { if (isMissingFile(error)) return; throw error; }
    for (const name of files.filter((file) => file.endsWith(".json"))) {
      let value: unknown;
      try { value = JSON.parse(await fs.readFile(path.join(folder, name), "utf8")); }
      catch (error) { if (error instanceof SyntaxError) throw new ProductivityError("DELETION_STATE_INVALID"); throw error; }
      if (!isRecord(value) || value.version !== 1 || typeof value.projectId !== "string"
        || (value.state !== "pending" && value.state !== "committed")) throw new ProductivityError("DELETION_STATE_INVALID");
      assertStorageId(value.projectId);
      if (name !== `${value.projectId}.json`) throw new ProductivityError("DELETION_STATE_INVALID");
      this.projectDeletions.set(value.projectId, { version: 1, projectId: value.projectId, state: value.state,
        unlinkStarted: value.unlinkStarted === true, updatedAt: Number(value.updatedAt) || 0 });
    }
    // Initialization precedes any registered startup. One locked directory must
    // not prevent other projects from loading or retaining their own barriers.
    for (const deletion of this.projectDeletions.values()) {
      try {
        if (deletion.state === "committed") this.removeProjectCatalogEntry(deletion.projectId);
        else await this.finishProjectDeletion(deletion);
      }
      catch (error) { this.report("PROJECTS:DELETE_RECOVERY_ERR", error); }
    }
  }

  private async finishProjectDeletion(deletion: ProjectDeletion): Promise<void> {
    if (!deletion.unlinkStarted) {
      deletion.unlinkStarted = true;
      await writeJsonAtomically(this.projectDeletionPath(deletion.projectId), deletion);
    }
    await fs.rm(path.join(this.root, "sessions", deletion.projectId), { recursive: true, force: true });
    await this.purgeReplacementBackups((await readSessionReplacements(this.root)).filter((record) => record.projectId === deletion.projectId));
    const committed: ProjectDeletion = { ...deletion, state: "committed", updatedAt: Date.now() };
    await writeJsonAtomically(this.projectDeletionPath(deletion.projectId), committed);
    this.projectDeletions.set(deletion.projectId, committed);
    this.projectLoads.delete(deletion.projectId);
    for (const [key, meta] of this.metadata) if (meta.projectId === deletion.projectId) this.metadata.delete(key);
    const prefix = path.join(this.root, "sessions", deletion.projectId) + path.sep;
    for (const file of this.appendLines.keys()) if (file.startsWith(prefix)) this.appendLines.delete(file);
    // Keep the catalog row as a retry entry until source deletion is committed.
    // A catalog failure leaves that row visible and the project write-blocked.
    this.removeProjectCatalogEntry(deletion.projectId);
    notifyProjectsChanged(this.report);
  }

  private removeProjectCatalogEntry(projectId: string): void {
    const projects = readProjectCatalog(this.root, true);
    if (projects.some((project) => project.id === projectId)) writeProjectCatalog(this.root, projects.filter((project) => project.id !== projectId), this.report);
  }

  async removeProject(projectId: string, stop: (runtimeIds: string[], meta: SessionMeta) => Promise<void>): Promise<"deleted" | "already_deleted"> {
    assertStorageId(projectId);
    await this.initialize();
    const running = this.projectRemovals.get(projectId);
    if (running) return running;
    if (this.projectDeletions.get(projectId)?.state === "committed") { this.removeProjectCatalogEntry(projectId); return "already_deleted"; }
    const task = this.deleteProject(projectId, stop);
    this.projectRemovals.set(projectId, task);
    try { return await task; }
    finally { if (this.projectRemovals.get(projectId) === task) this.projectRemovals.delete(projectId); }
  }

  private async deleteProject(projectId: string, stop: (runtimeIds: string[], meta: SessionMeta) => Promise<void>): Promise<"deleted"> {
    const previous = this.projectDeletions.get(projectId);
    const deletion: ProjectDeletion = previous ?? { version: 1, projectId, state: "pending", unlinkStarted: false, updatedAt: Date.now() };
    this.projectDeletions.set(projectId, deletion);
    notifyProjectsChanged(this.report);
    let durable = !!previous;
    try {
      await fs.mkdir(path.dirname(this.projectDeletionPath(projectId)), { recursive: true });
      await writeJsonAtomically(this.projectDeletionPath(projectId), deletion);
      durable = true;
      // The project barrier rejects future writers; let every writer or single
      // conversation deletion already in the queue finish before removing files.
      await Promise.all([...this.tails].filter(([key]) => JSON.parse(key)[0] === projectId).map(([, tail]) => tail));
      const runtimes = [...(this.projectRuntimes.get(projectId)?.values() ?? [])];
      const snapshots = await this.snapshots(projectId);
      try {
        for (const runtime of runtimes) runtime.cancelled = true;
        for (const runtime of runtimes) await runtime.stop();
        for (const meta of snapshots) await stop([meta.id], meta);
      } catch (error) {
        if (!deletion.unlinkStarted) {
          await fs.unlink(this.projectDeletionPath(projectId));
          this.projectDeletions.delete(projectId); notifyProjectsChanged(this.report);
        }
        throw new ProductivityError("STOP_FAILED", error instanceof Error ? error.message : "Could not stop the project's sessions", true);
      }
      deletion.unlinkStarted = true;
      await writeJsonAtomically(this.projectDeletionPath(projectId), deletion);
      await this.finishProjectDeletion(deletion);
      return "deleted";
    } catch (error) {
      if (!durable) { this.projectDeletions.delete(projectId); notifyProjectsChanged(this.report); }
      if (this.projectDeletions.has(projectId)) {
        this.report("PROJECTS:DELETE_INCOMPLETE", error);
        throw new ProductivityError("DELETE_INCOMPLETE", "Project deletion is incomplete. Its conversations remain blocked; retry deletion to finish.", true);
      }
      throw error;
    }
  }

  async pendingDeletions(): Promise<DeletionTarget[]> {
    await this.initialize();
    return [...this.deletions.values()].filter((item) => item.state === "pending" && !this.isProjectBlocked(item.projectId)).map((item) => ({ projectId: item.projectId,
      conversationKey: item.conversationKey, id: item.runtimeIds[0], title: item.title ?? "Untitled", state: item.state }));
  }

  /** Deletion retries use the durable intent even after every snapshot is gone. */
  async resolveDeletion(projectId: string, key: string): Promise<DeletionTarget> {
    assertStorageId(projectId);
    await this.initialize();
    const deletion = this.deletionForKey(key);
    if (deletion?.projectId === projectId) return { projectId, conversationKey: key, id: deletion.runtimeIds[0], title: deletion.title ?? "Untitled", state: deletion.state };
    const meta = await this.resolve(projectId, key);
    return { projectId, conversationKey: key, id: meta.id, title: meta.title, state: "available" };
  }

  private assertWritable(key: string, projectId: string, id: string): void {
    const project = this.projectDeletions.get(projectId);
    if (project) throw new ProductivityError(project.state === "committed" ? "PROJECT_DELETED" : "PROJECT_DELETING");
    const deletion = this.deletionForKey(key) ?? this.deletions.get(this.deletedAliases.get(this.alias(projectId, id)) ?? "")
      ?? this.deletions.get(this.deletedAliases.get(this.alias(projectId, this.currentRuntime(projectId, id))) ?? "");
    if (deletion) throw new ProductivityError(deletion.state === "committed" ? "SESSION_DELETED" : "SESSION_DELETING");
  }

  private assertCurrent(key: string, projectId: string, id: string): void {
    this.assertWritable(key, projectId, id);
    if (this.replacements.has(this.alias(projectId, id)) || this.keyRedirects.has(key)) throw new ProductivityError("SESSION_REPLACED", "This runtime has been replaced. Reload the current conversation.");
    if (this.preparingReplacements.has(this.alias(projectId, id))) throw new ProductivityError("REPLACEMENT_INCOMPLETE", "This runtime has no committed snapshot.", true);
  }

  private runtimeLock(projectId: string, id: string): string { return JSON.stringify([projectId, "runtime", id]); }

  private async locked<T>(key: string | string[], task: () => Promise<T>): Promise<T> {
    const keys = [...new Set(typeof key === "string" ? [key] : key)];
    const previous = Promise.all(keys.map((item) => this.tails.get(item)));
    const result = previous.then(task);
    const tail = result.then(() => {}, () => {});
    for (const item of keys) this.tails.set(item, tail);
    try { return await result; } finally { for (const item of keys) if (this.tails.get(item) === tail) this.tails.delete(item); }
  }

  private async readRaw(projectId: string, id: string): Promise<SessionData | null> {
    try { return asSession(parseSessionJsonl(await fs.readFile(this.sourceFile(projectId, id, "jsonl"), "utf8")), projectId, id); }
    catch (error) { if (!isMissingFile(error)) throw error; }
    try { return asSession(JSON.parse(await fs.readFile(this.sourceFile(projectId, id, "json"), "utf8")), projectId, id); }
    catch (error) { if (isMissingFile(error)) return null; throw error; }
  }

  private async readMeta(projectId: string, id: string): Promise<SessionMeta | null> {
    try {
      const metaFile = this.sourceFile(projectId, id, "meta.json");
      const data = asSession(JSON.parse(await fs.readFile(metaFile, "utf8")), projectId, id);
      // JSONL is authoritative. A crash can commit it without updating the sidecar.
      const source = this.sourceFile(projectId, id, "jsonl");
      try {
        const [sourceStat, metaStat] = await Promise.all([fs.stat(source), fs.stat(metaFile)]);
        if (sourceStat.mtimeMs > metaStat.mtimeMs) {
          const raw = await this.readRaw(projectId, id);
          if (raw) return extractSessionMeta(raw, lastUserTime(raw));
        }
      } catch (error) { if (!isMissingFile(error)) throw error; }
      return extractSessionMeta(data, lastUserTime(data));
    } catch (error) { if (!isMissingFile(error)) throw error; }
    const data = await this.readRaw(projectId, id);
    return data ? extractSessionMeta(data, lastUserTime(data)) : null;
  }

  private sourceFile(projectId: string, id: string, format: SessionSourceFormat): string {
    const prepared = this.preparingReplacements.get(this.alias(projectId, id));
    return prepared?.previousId === id ? replacementBackupFile(this.root, prepared, format) : this.file(projectId, id, format);
  }

  async snapshots(projectId: string): Promise<SessionMeta[]> {
    assertStorageId(projectId);
    let files: string[];
    const dir = path.join(this.root, "sessions", projectId);
    try { files = await fs.readdir(dir); } catch (error) { if (isMissingFile(error)) return []; throw error; }
    const ids = new Set(files.filter((name) => /\.jsonl?$/.test(name)).map((name) => name.replace(/\.(meta\.json|jsonl|json)$/, "")));
    const result: Array<{ meta: SessionMeta; modifiedAt: number }> = [];
    for (const id of ids) {
      try {
        const meta = await this.readMeta(projectId, id);
        if (!meta) continue;
        let stat;
        try { stat = await fs.stat(this.sourceFile(projectId, id, "meta.json")); }
        catch (error) {
          if (!isMissingFile(error)) throw error;
          try { stat = await fs.stat(this.sourceFile(projectId, id, "jsonl")); }
          catch (inner) { if (!isMissingFile(inner)) throw inner; stat = await fs.stat(this.sourceFile(projectId, id, "json")); }
        }
        result.push({ meta, modifiedAt: stat.mtimeMs });
      } catch (error) {
        // Legacy listing tolerates corrupt snapshots. History extraction separately reports coverage.
        if (error instanceof ProductivityError && error.code === "SESSION_DELETING") throw error;
      }
    }
    return result.sort((a, b) => b.meta.lastMessageAt - a.meta.lastMessageAt || b.modifiedAt - a.modifiedAt || a.meta.id.localeCompare(b.meta.id)).map(({ meta }) => meta);
  }

  private async seedMetadata(projectId: string): Promise<void> {
    let loading = this.projectLoads.get(projectId);
    if (!loading) {
      loading = this.snapshots(projectId).then((snapshots) => {
        for (const meta of snapshots) { const key = conversationKey(meta); if (!this.hiddenRuntime(projectId, meta.id) && !this.keyRedirects.has(key) && !this.metadata.has(key)) this.metadata.set(key, meta); }
      });
      this.projectLoads.set(projectId, loading);
    }
    await loading;
  }

  async list(projectId: string): Promise<SessionMeta[]> {
    assertStorageId(projectId);
    await this.initialize();
    if (this.isProjectBlocked(projectId)) return [];
    const seen = new Set<string>();
    return (await this.snapshots(projectId)).filter((meta) => {
      const key = conversationKey(meta);
      if (this.isProjectBlocked(projectId) || seen.has(key) || this.isHistoryBlocked(key) || this.hiddenRuntime(projectId, meta.id)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Exact-runtime lookup for committed change events, without scanning every conversation. */
  async currentMetadata(projectId: string, id: string): Promise<SessionMeta | null> {
    this.file(projectId, id, "jsonl");
    await this.initialize();
    if (this.isProjectBlocked(projectId) || this.hiddenRuntime(projectId, id)) return null;
    const meta = await this.readMeta(projectId, id);
    if (!meta || this.isProjectBlocked(projectId) || this.hiddenRuntime(projectId, id) || this.isHistoryBlocked(conversationKey(meta))) return null;
    return meta;
  }

  async resolve(projectId: string, key: string): Promise<SessionMeta> {
    const meta = (await this.list(projectId)).find((meta) => conversationKey(meta) === this.currentKey(key));
    if (!meta) throw new ProductivityError("SOURCE_GONE", "The conversation is no longer available");
    return meta;
  }

  private hiddenRuntime(projectId: string, id: string): boolean {
    const alias = this.alias(projectId, id);
    const prepared = this.preparingReplacements.get(alias);
    return this.deletedAliases.has(alias) || this.replacements.has(alias) || !!prepared && prepared.previousId !== id;
  }

  async load(projectId: string, id: string): Promise<SessionData | null> {
    this.file(projectId, id, "jsonl");
    await this.initialize();
    if (this.isProjectBlocked(projectId) || this.hiddenRuntime(projectId, id)) return null;
    const data = await this.readRaw(projectId, id);
    if (this.isProjectBlocked(projectId) || this.hiddenRuntime(projectId, id)) return null;
    if (data && this.isHistoryBlocked(conversationKey(extractSessionMeta(data, lastUserTime(data))))) return null;
    return data;
  }

  private async writeOperation(data: SessionData, task: (header: SessionData, key: string) => Promise<void>, previousId?: string): Promise<number> {
    this.file(data.projectId, data.id, "jsonl");
    if (previousId) assertStorageId(previousId);
    await this.initialize();
    const key = conversationKey(extractSessionMeta(data, lastUserTime(data)));
    this.assertCurrent(key, data.projectId, data.id);
    if (previousId) this.assertCurrent("", data.projectId, previousId);
    const sourceId = previousId ?? data.id;
    const previous = await this.readMeta(data.projectId, sourceId);
    if (sourceId !== data.id && !previous) throw new ProductivityError("SOURCE_GONE");
    if (previous && (previous.engine ?? "claude") !== (data.engine ?? "claude")) throw new ProductivityError("INVALID_ARGUMENT", "A runtime replacement cannot change engines");
    const previousKey = previous ? conversationKey(previous) : key;
    const replacing = previous !== null && (sourceId !== data.id || previousKey !== key);
    const destination = sourceId === data.id ? previous : await this.readMeta(data.projectId, data.id);
    await this.seedMetadata(data.projectId);
    return this.locked([key, previousKey, ...(destination ? [conversationKey(destination)] : []), this.runtimeLock(data.projectId, data.id), this.runtimeLock(data.projectId, sourceId)], async () => {
      this.assertCurrent(key, data.projectId, data.id);
      if (previous) this.assertCurrent(previousKey, data.projectId, sourceId);
      const diskMeta = await this.readMeta(data.projectId, sourceId);
      const revision = diskMeta?.persistenceRevision ?? 0;
      if (data.persistenceRevision !== undefined && data.persistenceRevision !== revision) {
        throw new ProductivityError("REVISION_CONFLICT", "The conversation changed since this snapshot was read. Reload before replacing its messages.", true);
      }
      const header: SessionData = { ...data, persistenceRevision: revision + 1, lastMessageAt: lastUserTime(data) };
      const current = diskMeta ?? this.metadata.get(previousKey);
      if (current) for (const field of META_FIELDS) if (current[field] !== undefined) header[field] = current[field];
      await fs.mkdir(path.dirname(this.file(data.projectId, data.id, "jsonl")), { recursive: true });
      if (replacing) {
        if (sourceId !== data.id && await this.readMeta(data.projectId, data.id)) throw new ProductivityError("INVALID_ARGUMENT", "The replacement runtime already has a saved conversation");
        if (previousKey !== key && this.metadata.has(key)) throw new ProductivityError("INVALID_ARGUMENT", "The replacement identity belongs to another conversation");
        const legacyIds = (await this.snapshots(data.projectId)).filter((meta) => conversationKey(meta) === previousKey
          && meta.id !== data.id && !this.replacements.has(this.alias(data.projectId, meta.id))).map((meta) => meta.id);
        const record: SessionReplacement = { version: 1, projectId: data.projectId, previousId: sourceId, runtimeId: data.id,
          previousKey, conversationKey: key, state: "prepared", backupFormats: [],
          retiredIds: [...new Set([...legacyIds, ...(sourceId !== data.id ? [sourceId] : [])])] };
        assertReplacementKeys(record);
        const recordPath = replacementPath(this.root, record);
        if (this.replacementRecords.has(recordPath)) throw new ProductivityError("INVALID_ARGUMENT", "This runtime already owns a committed replacement record");
        await fs.mkdir(path.dirname(recordPath), { recursive: true });
        try {
          if (sourceId === data.id) await this.backupReplacement(record);
          await writeJsonAtomically(recordPath, record);
        } catch (error) {
          try { await fs.rm(replacementBackupDirectory(this.root, record), { recursive: true, force: true }); }
          catch (cleanupError) { this.report("SESSIONS:REPLACEMENT_BACKUP_CLEANUP_ERR", cleanupError); }
          throw error;
        }
        this.preparingReplacements.set(this.alias(data.projectId, data.id), record);
        const cached = this.metadata.get(key);
        try {
          await task(header, key);
          this.assertWritable(previousKey, data.projectId, sourceId);
          this.assertWritable(key, data.projectId, data.id);
          const committed: SessionReplacement = { ...record, state: "committed" };
          // The durable marker is the commit point. Until then history ignores
          // the new files, and rollback/restart keeps the original authoritative.
          await writeJsonAtomically(recordPath, committed);
        } catch (error) {
          if (cached) this.metadata.set(key, cached); else this.metadata.delete(key);
          try { await this.rollbackReplacement(record); }
          catch (rollbackError) { this.report("SESSIONS:REPLACEMENT_ROLLBACK_ERR", rollbackError); }
          throw error;
        }
        this.rememberReplacement({ ...record, state: "committed" });
        if (previousKey !== key) this.metadata.delete(previousKey);
        // Invalidate the previous indexed snapshot even if its logical key is
        // unchanged; queries already in flight must not return the retired ID.
        if (previous) this.emit("delete", previous);
        this.emit("upsert", extractSessionMeta(header, lastUserTime(header)));
        // A committed replacement must not be reported as failed merely because
        // an obsolete file is locked. The record hides it and startup retries.
        try { await this.cleanupReplacement(record); }
        catch (error) { this.report("SESSIONS:REPLACEMENT_CLEANUP_ERR", error); }
        return revision + 1;
      } else {
        await task(header, key);
      }
      this.emit("upsert", extractSessionMeta(header, lastUserTime(header)));
      return revision + 1;
    });
  }

  private async saveMeta(data: SessionData, key: string): Promise<void> {
    const meta = extractSessionMeta(data, lastUserTime(data));
    await writeJsonAtomically(this.file(data.projectId, data.id, "meta.json"), meta);
    this.metadata.set(key, meta);
  }

  async save(data: SessionData, previousId?: string): Promise<number> {
    return this.writeOperation(data, async (header, key) => {
      // Check under the write lock: even a current revision can carry only a
      // partial background snapshot. Ordinary saves must retain historical IDs.
      // Explicit recovery/revert uses previousId (including the same runtime).
      if (!previousId) {
        const current = await this.readRaw(data.projectId, data.id);
        const previousMessages: unknown[] = Array.isArray(current?.messages) ? current.messages : [];
        const nextMessages: unknown[] = Array.isArray(header.messages) ? header.messages : [];
        const ids = new Set(nextMessages.filter(isRecord).map(message => message.id));
        if (nextMessages.length < previousMessages.length || previousMessages.some(message =>
          isRecord(message) && typeof message.id === "string" && !ids.has(message.id))) {
          throw new ProductivityError("INCOMPLETE_SNAPSHOT", "Refusing to overwrite saved history with an incomplete snapshot. Reload the conversation before retrying.", true);
        }
      }
      const file = this.file(data.projectId, data.id, "jsonl");
      await writeTextAtomically(file, serializeSessionJsonl(header));
      this.appendLines.delete(file);
      await fs.unlink(this.file(data.projectId, data.id, "json")).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
      await this.saveMeta(header, key);
    }, previousId);
  }

  async append(data: SessionData, previousId?: string): Promise<number> {
    return this.writeOperation(data, async (incoming, key) => {
      const { appendedMessages, messageCount, messages: _messages, ...header } = incoming;
      const appended: Record<string, unknown>[] = Array.isArray(appendedMessages) ? appendedMessages.filter(isRecord) : [];
      const file = this.file(data.projectId, data.id, "jsonl");
      let exists = true;
      try { await fs.access(file); } catch (error) { if (!isMissingFile(error)) throw error; exists = false; }
      const previousCount = this.appendLines.get(file) ?? (exists ? (await fs.readFile(file, "utf8")).split("\n").length - 1 : 0);
      const lines = previousCount + appended.length + 1;
      if (!exists || lines > 3 * Math.max(1, typeof messageCount === "number" ? messageCount : appended.length)) {
        const current = await this.readRaw(data.projectId, data.id);
        if (!current) throw new ProductivityError("append-before-save");
        const allMessages = [...(Array.isArray(current.messages) ? current.messages : []), ...appended];
        const folded = parseSessionJsonl(serializeSessionJsonl({ ...current, ...header, messages: allMessages }));
        await writeTextAtomically(file, serializeSessionJsonl(folded));
        this.appendLines.delete(file);
        if (!exists) await fs.unlink(this.file(data.projectId, data.id, "json"));
      } else {
        await repairJsonlTail(file);
        await fs.appendFile(file, serializeAppendLines(header, appended), "utf8");
        this.appendLines.set(file, lines);
      }
      await this.saveMeta(header, key);
    }, previousId);
  }

  async updateMeta(projectId: string, id: string, patch: SessionMetaPatch): Promise<number> {
    this.file(projectId, id, "jsonl");
    await this.initialize();
    this.assertCurrent("", projectId, id);
    const meta = await this.readMeta(projectId, id);
    if (!meta) throw new ProductivityError("SOURCE_GONE");
    const key = conversationKey(meta);
    return this.locked([key, this.runtimeLock(projectId, id)], async () => {
      this.assertCurrent(key, projectId, id);
      const current = await this.readMeta(projectId, id);
      if (!current) throw new ProductivityError("SOURCE_GONE");
      const fields: Record<string, unknown> = {};
      if (!isRecord(patch)) throw new ProductivityError("INVALID_ARGUMENT", "Invalid metadata patch");
      for (const field of PATCH_FIELDS) if (field in patch) {
        const value = patch[field];
        if (["archived", "pinned", "planMode"].includes(field) ? typeof value !== "boolean"
          : field === "codexGoal" ? value !== null && !isRecord(value)
          : value !== null && (typeof value !== "string" || value.length > 10_000)) {
          throw new ProductivityError("INVALID_ARGUMENT", "Invalid metadata field: " + field);
        }
        fields[field] = value ?? null;
      }
      // Metadata patches do not advance the message revision: they never replace messages.
      fields.persistenceRevision = current.persistenceRevision ?? 0;
      const next = { ...current, ...fields };
      const file = this.file(projectId, id, "jsonl");
      try { await repairJsonlTail(file); await fs.appendFile(file, serializeAppendLines(fields, []), "utf8"); }
      catch (error) {
        if (!isMissingFile(error)) throw error;
        const data = await this.readRaw(projectId, id);
        if (!data) throw new ProductivityError("SOURCE_GONE");
        await writeJsonAtomically(this.file(projectId, id, "json"), { ...data, ...fields });
      }
      await this.saveMeta(next, key);
      this.emit("upsert", extractSessionMeta(next, current.lastMessageAt));
      return current.persistenceRevision ?? 0;
    });
  }

  private async unlinkSnapshot(projectId: string, id: string): Promise<void> {
    for (const extension of ["json", "jsonl", "meta.json"]) {
      await fs.unlink(this.file(projectId, id, extension)).catch((error: unknown) => { if (!isMissingFile(error)) throw error; });
    }
    this.appendLines.delete(this.file(projectId, id, "jsonl"));
  }

  private async commitDeletion(deletion: Deletion): Promise<void> {
    const committed: Deletion = { ...deletion, state: "committed", updatedAt: Date.now() };
    await writeJsonAtomically(this.deletionPath(deletion.conversationKey), committed);
    this.rememberDeletion(committed);
    this.metadata.delete(deletion.conversationKey);
  }

  private forgetDeletion(deletion: Deletion): void {
    this.deletions.delete(deletion.conversationKey);
    for (const [key, source] of this.deletionKeys) if (source === deletion.conversationKey) this.deletionKeys.delete(key);
    for (const runtimeId of deletion.runtimeIds) this.deletedAliases.delete(this.alias(deletion.projectId, runtimeId));
  }

  async remove(projectId: string, id: string, stop: (runtimeIds: string[], meta: SessionMeta) => Promise<void>): Promise<"deleted" | "already_deleted"> {
    this.file(projectId, id, "jsonl");
    await this.initialize();
    if (this.isProjectBlocked(projectId)) throw new ProductivityError("PROJECT_DELETING");
    const existingKey = this.deletedAliases.get(this.alias(projectId, id)) ?? this.deletedAliases.get(this.alias(projectId, this.currentRuntime(projectId, id)));
    const existing = existingKey ? this.deletions.get(existingKey) : undefined;
    if (existing?.state === "committed") return "already_deleted";
    let currentId = this.currentRuntime(projectId, id);
    let meta = await this.readMeta(projectId, currentId);
    // The handoff may have committed while its previous metadata was loading.
    if (this.currentRuntime(projectId, id) !== currentId) { currentId = this.currentRuntime(projectId, id); meta = await this.readMeta(projectId, currentId); }
    if (!meta && !existingKey) throw new ProductivityError("SOURCE_GONE");
    const key = existingKey ?? conversationKey(meta!);
    const known = existing ?? this.deletionForKey(key);
    if (known?.state === "committed") return "already_deleted";
    const deletion: Deletion = known ?? { version: 1, conversationKey: key, projectId, runtimeIds: [id], state: "pending", unlinkStarted: false, updatedAt: Date.now(), title: meta?.title, operationId: randomUUID() };
    this.rememberDeletion(deletion); // Reject incoming and queued writes before waiting for the current writer.
    if (meta) this.emit("delete", meta);
    return this.locked([key, this.runtimeLock(projectId, id), this.runtimeLock(projectId, currentId)], async () => {
      if (this.deletionForKey(key)?.state === "committed") return "already_deleted";
      let durable = !!known;
      try {
        const resolvedKey = this.currentKey(key);
        meta = await this.readMeta(projectId, this.currentRuntime(projectId, id)) ?? meta;
        const snapshots = await this.snapshots(projectId);
        const runtimes = [...this.runtimes].filter(([source]) => this.currentKey(source) === resolvedKey).flatMap(([, bound]) => [...bound]);
        const aliases = this.replacementsForKey(resolvedKey)
          .flatMap((record) => [...record.retiredIds, record.runtimeId]);
        deletion.runtimeIds = [...new Set([...deletion.runtimeIds, ...aliases, ...snapshots.filter((item) => this.currentKey(conversationKey(item)) === resolvedKey).map((item) => item.id), ...runtimes.map(([runtimeId]) => runtimeId)])];
        this.rememberDeletion(deletion);
        await fs.mkdir(path.dirname(this.deletionPath(key)), { recursive: true });
        await writeJsonAtomically(this.deletionPath(key), deletion);
        durable = true;
        try {
          // Set every cancellation flag before awaiting any one process teardown.
          for (const [, runtime] of runtimes) runtime.cancelled = true;
          for (const [, runtime] of runtimes) await runtime.stop();
          if (meta) await stop(deletion.runtimeIds, meta);
        }
        catch (error) {
          if (!deletion.unlinkStarted) {
            await fs.unlink(this.deletionPath(key));
            this.forgetDeletion(deletion);
            if (meta) this.emit("upsert", meta);
          }
          throw new ProductivityError("STOP_FAILED", error instanceof Error ? error.message : "Could not stop the session", true);
        }
        deletion.unlinkStarted = true;
        await writeJsonAtomically(this.deletionPath(key), deletion);
        for (const runtimeId of deletion.runtimeIds) await this.unlinkSnapshot(projectId, runtimeId);
        await this.purgeReplacementBackups(this.replacementsForKey(key));
        await this.commitDeletion(deletion);
        if (meta) this.emit("delete", meta);
        return "deleted";
      } catch (error) {
        if (!durable) { this.forgetDeletion(deletion); if (meta) this.emit("upsert", meta); }
        if (this.deletions.has(key)) {
          this.report("SESSIONS:DELETE_INCOMPLETE", error);
          throw new ProductivityError("DELETE_INCOMPLETE", "Deletion is incomplete. This conversation remains blocked; retry deletion to finish.", true);
        }
        throw error;
      }
    });
  }

  async snapshot(projectId: string, key: string): Promise<SessionData> {
    await this.initialize();
    return this.locked([key, this.currentKey(key)], async () => {
      const meta = await this.resolve(projectId, key);
      this.assertWritable(key, projectId, meta.id);
      const data = await this.readRaw(projectId, meta.id);
      this.assertWritable(key, projectId, meta.id);
      if (!data) throw new ProductivityError("SOURCE_GONE");
      return data;
    });
  }
}
