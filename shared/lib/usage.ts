import type { UsageInterval, UsageRange, UsageRank, UsageReport, UsageTimings, UsageTokens } from "../types/usage";
import { buildTokenUsageReport } from "./token-usage";

export const USAGE_SAMPLE_MS = 15_000;
export const USAGE_MAX_GAP_MS = 45_000;
export const USAGE_IDLE_MS = 120_000;

type UsageEntry = { timestamp: number; kind: "user" | "assistant" | "tool" | "command" | "slash"; name?: string };

export interface UsageSessionSummary {
  key: string;
  lastMessageAt: number;
  modifiedAt: number;
  entries: UsageEntry[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

const SUBCOMMANDS = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "uv", "docker"]);

/** Keep command names, never arguments. Compound/expanded shell input stays one script. */
export function getCommandName(value: unknown): string | null {
  if (Array.isArray(value)) {
    if (typeof value[1] === "string" && /^-[a-z]*c[a-z]*$/.test(value[1])) return getCommandName(value[2]);
    value = value.filter((part) => typeof part === "string").map((part) => JSON.stringify(part)).join(" ");
  }
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.length > 8192) return "__shell_script__";
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== "'" && (char === "`" || (char === "$" && value[i + 1] === "("))) return "__shell_script__";
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/[;&|<>\n\r]/.test(char)) {
      return "__shell_script__";
    } else if (/\s/.test(char)) {
      if (word) words.push(word);
      word = "";
    } else {
      word += char;
    }
  }
  if (quote || escaped) return "__shell_script__";
  if (word) words.push(word);
  const executable = words[0]?.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "");
  if (!executable || !/^[\w.-]+$/.test(executable)) return "__shell_script__";
  if (["sh", "bash", "zsh", "fish"].includes(executable) && /^-[a-z]*c[a-z]*$/.test(words[1] ?? "")) {
    return getCommandName(words[2]) ?? "__shell_script__";
  }
  if (["env", "sudo", "sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].includes(executable)) return "__shell_script__";
  // An option before the subcommand makes inference ambiguous; group by executable.
  return SUBCOMMANDS.has(executable) && /^[a-z][a-z-]*$/.test(words[1] ?? "")
    ? `${executable} ${words[1]}` : executable;
}

export function summarizeUsageSession(data: Record<string, unknown>, modifiedAt = 0): UsageSessionSummary {
  const engine = typeof data.engine === "string" ? data.engine : "claude";
  const identity = engine === "codex" && data.codexThreadId ? data.codexThreadId : data.conversationId ?? data.id;
  const summary: UsageSessionSummary = {
    key: JSON.stringify([data.projectId, engine, identity]),
    lastMessageAt: typeof data.lastMessageAt === "number" ? data.lastMessageAt : 0,
    modifiedAt,
    entries: [],
  };
  const messages = new Map<string, Record<string, unknown>>();
  for (const [index, value] of (Array.isArray(data.messages) ? data.messages : []).entries()) {
    const message = record(value);
    messages.set(typeof message.id === "string" ? message.id : `legacy-${index}`, message);
  }
  const seenTools = new Set<string>();
  const addTool = (id: string, tool: Record<string, unknown>, timestamp: number) => {
    if (seenTools.has(id) || typeof tool.toolName !== "string") return;
    seenTools.add(id);
    summary.entries.push({ timestamp, kind: "tool", name: tool.toolName });
    const input = record(tool.toolInput);
    const command = getCommandName(input.command ?? input.cmd);
    if (command) summary.entries.push({ timestamp, kind: "command", name: command });
  };
  for (const [id, message] of messages) {
    const timestamp = message.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || message.isQueued) continue;
    if (message.role === "user") {
      summary.lastMessageAt = Math.max(summary.lastMessageAt, timestamp);
      summary.entries.push({ timestamp, kind: "user" });
      const text = typeof message.displayContent === "string" ? message.displayContent : message.content;
      const slash = typeof text === "string" ? text.trim().match(/^\/[a-zA-Z][\w:.-]{0,79}(?=\s|$)/)?.[0] : undefined;
      if (slash) summary.entries.push({ timestamp, kind: "slash", name: slash });
    } else if (message.role === "assistant") {
      if ((typeof message.content === "string" && message.content.trim()) || (Array.isArray(message.images) && message.images.length)) {
        summary.entries.push({ timestamp, kind: "assistant" });
      }
    } else if (message.role === "tool_call" && !id.startsWith("codex-plan-")) {
      addTool(id, message, timestamp);
      for (const step of Array.isArray(message.subagentSteps) ? message.subagentSteps : []) {
        const tool = record(step);
        // Older subagent steps have no timestamp: retain the parent call's date.
        if (typeof tool.toolUseId === "string") addTool(tool.toolUseId, tool, timestamp);
      }
    }
  }
  return summary;
}

export function mergeUsageIntervals(intervals: UsageInterval[]): UsageInterval[] {
  const result: UsageInterval[] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue;
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function ranking(counts: Map<string, number>): UsageRank[] {
  return [...counts].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function buildUsageReport(
  sessions: UsageSessionSummary[], timings: UsageTimings, range: UsageRange, tokens: UsageTokens, now = Date.now(),
): UsageReport {
  const today = new Date(now);
  const starts = Array.from({ length: range + 1 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - range + 1 + i));
  const active = mergeUsageIntervals(timings.active);
  const agent = mergeUsageIntervals(timings.agent);
  const duration = (intervals: UsageInterval[], start: number, end: number) => intervals.reduce(
    (sum, [a, b]) => sum + Math.max(0, Math.min(b, end, now) - Math.max(a, start)), 0,
  );
  const days = starts.slice(0, -1).map((date, i) => ({
    date: dateKey(date), userMessages: 0, assistantMessages: 0,
    activeMs: +starts[i + 1] <= timings.trackingStartedAt ? null : duration(active, +date, +starts[i + 1]),
    agentMs: +starts[i + 1] <= timings.trackingStartedAt ? null : duration(agent, +date, +starts[i + 1]),
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const latest = new Map<string, UsageSessionSummary>();
  for (const session of sessions) {
    const previous = latest.get(session.key);
    if (!previous || session.lastMessageAt > previous.lastMessageAt || (session.lastMessageAt === previous.lastMessageAt && session.modifiedAt > previous.modifiedAt)) {
      latest.set(session.key, session);
    }
  }
  const tools = new Map<string, number>();
  const commands = new Map<string, number>();
  const slashCommands = new Map<string, number>();
  for (const { entries } of latest.values()) {
    for (const entry of entries) {
      if (entry.timestamp < +starts[0] || entry.timestamp > now) continue;
      const day = byDate.get(dateKey(new Date(entry.timestamp)));
      if (!day) continue;
      if (entry.kind === "user") day.userMessages++;
      else if (entry.kind === "assistant") day.assistantMessages++;
      else if (entry.name) {
        const counts = entry.kind === "tool" ? tools : entry.kind === "command" ? commands : slashCommands;
        counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
      }
    }
  }
  return {
    days, tokens: buildTokenUsageReport(tokens, range, now),
    tools: ranking(tools), commands: ranking(commands), slashCommands: ranking(slashCommands),
    trackingStartedAt: timings.trackingStartedAt,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    incompleteHistory: false,
    incompleteTimings: false,
  };
}
