import type { SessionTokenUsage, UsageTokenTotals } from "@shared/types/usage";
import { cleanTokenCount, emptyTokenTotals } from "./token-usage-tracker";

interface SessionTokens extends UsageTokenTotals {
  reported: boolean;
  trackingStartedAt: number;
  subagents: Record<string, number>;
}

export interface SessionTokenData {
  aliases: Record<string, string>;
  sessions: Record<string, SessionTokens>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSessionTokenData(value: unknown): value is SessionTokenData {
  return isRecord(value) && isRecord(value.aliases) && isRecord(value.sessions)
    && Object.values(value.aliases).every((id) => typeof id === "string")
    && Object.values(value.sessions).every((session) => isRecord(session)
      && typeof session.reported === "boolean" && isCount(session.trackingStartedAt)
      && [session.totalTokens, session.inputTokens, session.outputTokens, session.cacheReadTokens, session.cacheCreationTokens].every(isCount)
      && isRecord(session.subagents) && Object.values(session.subagents).every(isCount));
}

/** Runtime IDs change on revival; every alias points directly to the original conversation. */
export class SessionTokenUsageTracker {
  private aliases: Map<string, string>;
  private sessions: Map<string, SessionTokens>;

  constructor(private startedAt: number, saved?: SessionTokenData) {
    this.aliases = new Map(Object.entries(saved?.aliases ?? {}));
    this.sessions = new Map(Object.entries(saved?.sessions ?? {}));
  }

  get data(): SessionTokenData {
    return { aliases: Object.fromEntries(this.aliases), sessions: Object.fromEntries(this.sessions) };
  }

  bind(sessionId: string, sourceId?: string): void {
    const id = this.aliases.get(sourceId ?? sessionId) ?? sourceId ?? sessionId;
    this.aliases.set(sessionId, id);
    if (!this.sessions.has(id)) {
      this.sessions.set(id, { ...emptyTokenTotals(), reported: false, trackingStartedAt: Date.now(), subagents: {} });
    }
  }

  private session(sessionId: string): SessionTokens {
    const id = this.aliases.get(sessionId) ?? sessionId;
    let session = this.sessions.get(id);
    if (!session) {
      this.bind(sessionId);
      session = this.sessions.get(id)!;
    }
    return session;
  }

  record(sessionId: string, totals: UsageTokenTotals): void {
    const session = this.session(sessionId);
    for (const key of ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
      session[key] = cleanTokenCount(session[key] + totals[key]);
    }
    session.reported = true;
  }

  recordSubagent(sessionId: string, agentId: string, tokens: number): void {
    const session = this.session(sessionId);
    const previous = Object.hasOwn(session.subagents, agentId) ? session.subagents[agentId] : 0;
    session.subagents = { ...session.subagents, [agentId]: cleanTokenCount(previous + tokens) };
  }

  read(sessionId: string): SessionTokenUsage {
    const session = this.sessions.get(this.aliases.get(sessionId) ?? sessionId);
    const { subagents, ...totals } = session ?? {
      ...emptyTokenTotals(), reported: false, trackingStartedAt: this.startedAt, subagents: {},
    };
    const subagentTokens = Math.min(totals.totalTokens, Object.values(subagents).reduce((sum, count) => sum + count, 0));
    return { ...totals, mainTokens: totals.totalTokens - subagentTokens, subagentTokens, subagentCount: Object.keys(subagents).length };
  }
}
