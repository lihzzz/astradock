import { AsyncLocalStorage } from "node:async_hooks";
export class MemoryOperationError extends Error { constructor(readonly reason: "budget_exhausted" | "cancelled") { super(reason === "cancelled" ? "记忆操作已取消" : "记忆读取预算已耗尽"); } }
interface Operation { remaining: number; signal: AbortSignal }
const operations = new AsyncLocalStorage<Operation>();
let active = 0;
const sessions = new Map<string, number>();
export function checkMemoryOperation(): void { if (operations.getStore()?.signal.aborted) throw new MemoryOperationError("cancelled"); }
export function memoryRequestSignal(timeoutMs: number): AbortSignal {
  const op = operations.getStore(); if (!op) return AbortSignal.timeout(timeoutMs);
  checkMemoryOperation(); if (--op.remaining < 0) throw new MemoryOperationError("budget_exhausted");
  return AbortSignal.any([op.signal, AbortSignal.timeout(timeoutMs)]);
}
export async function withMemoryOperation<T>(sessionId: string, signal: AbortSignal, run: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  if (operations.getStore()) { checkMemoryOperation(); return run(); }
  if (active >= 8 || (sessions.get(sessionId) ?? 0) >= 2) throw new MemoryOperationError("budget_exhausted");
  active++; sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
  try { return await operations.run({ remaining: 192, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) }, run); }
  finally { active--; const n = (sessions.get(sessionId) ?? 1)-1; if(n) sessions.set(sessionId,n); else sessions.delete(sessionId); }
}
