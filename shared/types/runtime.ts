import { z } from "zod";
export const RuntimeId = z.string().min(1).max(256);
export const RuntimeEngine = z.enum(["claude", "codex", "acp"]);
export const RunStatus = z.enum(["queued", "starting", "running", "waiting_permission", "waiting_user", "completed", "failed", "interrupted", "cancelled", "unknown"]);
export type RunStatus = z.infer<typeof RunStatus>;
export const AppRun = z.object({
  id: RuntimeId, threadId: RuntimeId, commandId: RuntimeId, principalId: RuntimeId, messageId: RuntimeId,
  ordinal: z.number().int().positive(), attempt: z.number().int().positive(),
  runtimeGeneration: z.number().int().nonnegative(), status: RunStatus,
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
});
export type AppRun = z.infer<typeof AppRun>;
export const AppThread = z.object({
  id: RuntimeId, projectId: RuntimeId, legacyKey: z.string().min(1).max(2048), engine: RuntimeEngine,
  runtimeId: RuntimeId, runtimeGeneration: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
});
export type AppThread = z.infer<typeof AppThread>;
export const RuntimeIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), clientMessageId: RuntimeId, text: z.string().min(1).max(256_000) }).strict(),
  z.object({ kind: z.literal("interrupt"), runId: RuntimeId }).strict(),
  z.object({ kind: z.literal("approval"), requestId: RuntimeId, requestRevision: z.number().int().nonnegative(), decision: z.enum(["allow", "deny"]) }).strict(),
]);
export type RuntimeIntent = z.infer<typeof RuntimeIntent>;
export const RuntimeCommand = z.object({
  commandId: RuntimeId, threadId: RuntimeId, projectId: RuntimeId,
  writerGeneration: z.number().int().nonnegative(), runtimeGeneration: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(), intent: RuntimeIntent,
}).strict();
export type RuntimeCommand = z.infer<typeof RuntimeCommand>;
export const CommandReceipt = z.object({
  commandId: RuntimeId, principalId: RuntimeId, payloadHash: z.string().length(64),
  command: RuntimeCommand, sequence: z.number().int().positive(), acceptedAt: z.number().finite(),
  status: z.enum(["accepted", "dispatching", "completed", "failed", "unknown"]),
  error: z.string().nullable(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;
export const RuntimeRequest = z.object({
  id: RuntimeId, threadId: RuntimeId, runId: RuntimeId,
  runtimeGeneration: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  status: z.enum(["pending", "resolved", "expired"]), decision: z.enum(["allow", "deny"]).nullable(),
});
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;
export const CapabilityName = z.enum(["resume", "interrupt", "steer", "fork", "image", "approval", "question", "rollback", "subagents"]);
export type CapabilityName = z.infer<typeof CapabilityName>;
export interface Capability { status: "supported" | "unsupported" | "degraded" | "unknown"; reason: string; evidence: string }
export type CapabilitySet = Record<CapabilityName, Capability>;
export interface RuntimeSnapshot { thread: AppThread; runs: AppRun[]; receipts: CommandReceipt[]; requests: RuntimeRequest[]; sequence: number }
export class RuntimeError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = "RuntimeError"; }
}
