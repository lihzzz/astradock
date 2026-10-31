import type { MemoryKind, MemoryScope } from "./memory";
export interface MemoryIntelligenceSettings { version: 1; enabled: boolean; briefing: boolean; persistTrace: boolean }
export type MemoryLevel = "index" | "summary" | "full";
export type MemoryFeedbackSignal = "helpful" | "not_helpful" | "outdated" | "condition_mismatch";
export interface MemoryEntryInput {
  formatVersion: 2; title: string; conclusion: string; applicability: string; detail: string;
  evidenceRefs: string[];
  relation?: { type: "supplement" | "contradiction"; ref: string };
}
export interface MemoryEvidence {
  ref: string; kind: "explicit_user_statement" | "observed_tool_result" | "recorded_user_statement" | "recorded_tool_result";
  sourceId: string; sourceHash: string; observedAt: number; excerpt: string;
}
export interface MemoryEntrySource { kind: MemoryEvidence["kind"]; sourceId: string; sourceHash: string; observedAt: number }
export interface MemoryEntry extends Omit<MemoryEntryInput, "evidenceRefs" | "relation"> { sources: MemoryEntrySource[]; relation?: { type: "supplement" | "contradiction"; blockId: string } }
export type MemoryValidity = "current" | "review_requested" | "disputed" | "explicitly_corrected" | "incomplete" | "legacy_unverified";
export interface MemoryReadDetails { level: MemoryLevel; validity: MemoryValidity; truncated: boolean; feedback: MemoryFeedbackSignal[]; sourceStatus?: "session_available" | "session_missing" | "unverified" }
export type MemoryTraceStage = "query_planned" | "search_finished" | "candidate_checked" | "body_read" | "context_selected" | "dispatch_attempted" | "dispatch_confirmed" | "extraction_checked" | "write_submitted" | "write_verified" | "write_unknown" | "write_changed" | "write_conflict" | "excluded";
export type MemoryTraceReason = "ok" | "scope_denied" | "source_missing" | "body_changed" | "duplicate" | "not_applicable" | "superseded" | "conflict" | "relations_incomplete" | "budget_exhausted" | "cancelled" | "unavailable" | "delivery_unconfirmed" | "legacy" | "feedback";
export interface MemoryTraceEvent {
  id: string; projectId: string; sessionId: string; turnId: string; at: number;
  stage: MemoryTraceStage; reason: MemoryTraceReason; count: number; bytes: number;
}
export interface MemorySearchOptions { variants: string[]; kind?: MemoryKind; explain: boolean }
export interface MemorySearchCandidate { ref: string; snippet: string; scope: MemoryScope; score?: number; ranks?: number[] }
export interface MemorySearchResult { candidates: MemorySearchCandidate[]; instruction: string; partial?: boolean; reason?: string }
