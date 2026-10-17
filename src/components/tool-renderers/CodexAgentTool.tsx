import { memo } from "react";
import { Bot, ChevronRight, Cpu, Target, BrainCircuit } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodexAgentCardData, CodexAgentDetails } from "@shared/types/codex-subagents";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { useChatPersistedState } from "@/components/chat-ui-state";
import { cn } from "@/lib/utils";

const REMARK_PLUGINS = [remarkGfm];
const OPERATIONS: Record<string, string> = {
  spawnAgent: "Create agent", sendInput: "Send input", resumeAgent: "Resume agent",
  wait: "Wait for agents", closeAgent: "Close agent", sendMessage: "Send message",
  followupTask: "Follow-up task", interruptAgent: "Interrupt agent", listAgents: "List agents",
};
const STATUSES: Record<string, string> = {
  inProgress: "In progress", pendingInit: "Starting", running: "Running",
  completed: "Completed", failed: "Failed", errored: "Failed", interrupted: "Interrupted",
  shutdown: "Closed", notFound: "Not found", unknown: "Not reported",
};

function StatusBadge({ status, prefix }: { status: string; prefix: string }) {
  return (
    <Badge variant="outline" className={cn("gap-1.5 border-transparent text-[10px] font-medium",
      status === "running" || status === "inProgress" || status === "pendingInit"
        ? "bg-sky-500/10 text-sky-600 dark:text-sky-400"
        : status === "failed" || status === "errored" || status === "notFound"
          ? "bg-red-500/10 text-red-600 dark:text-red-400"
          : status === "completed" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-foreground/5 text-muted-foreground")}
      title={`${prefix}: ${STATUSES[status] ?? status}`}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {prefix}: {STATUSES[status] ?? status}
    </Badge>
  );
}

function ModelDetails({ model, effort, source }: { model: string | null; effort: string | null; source: CodexAgentDetails["modelSource"] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5" title={model ?? "Codex did not report the subagent model"}>
        <Cpu className="size-3 shrink-0" aria-hidden="true" />
        <span className="shrink-0">{source === "requested" ? "Requested model" : source === "configured" ? "Configured model" : "Model"}</span>
        <span className="break-all font-mono text-foreground/80">{model ?? "Not reported"}</span>
      </span>
      {effort && <span className="inline-flex items-center gap-1.5">
        <BrainCircuit className="size-3 shrink-0" aria-hidden="true" />
        <span>Reasoning: {effort}</span>
      </span>}
    </div>
  );
}

function AgentDetails({ agent, expanded, showTask }: { agent: CodexAgentDetails; expanded: boolean; showTask: boolean }) {
  return (
    <div className="min-w-0 space-y-2 border-t border-foreground/[0.07] pt-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span className="truncate font-medium" title={agent.threadId}>{agent.nickname ?? `Agent ${agent.threadId.slice(0, 8)}`}</span>
          {agent.role && <span className="truncate text-muted-foreground">{agent.role}</span>}
        </div>
        <StatusBadge status={agent.status} prefix="Agent" />
      </div>
      <ModelDetails model={agent.model} effort={agent.reasoningEffort} source={agent.modelSource} />
      {showTask && <p className={cn("whitespace-pre-wrap wrap-break-word text-xs text-foreground/80", expanded ? "max-h-64 overflow-auto" : "line-clamp-3")}>
        <span className="font-medium">Task: </span>{agent.task ?? "Not reported"}
      </p>}
      {expanded && <div className="space-y-2">
        <p className="break-all font-mono text-[10px] text-muted-foreground">Thread: {agent.threadId}</p>
        {agent.message && <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Agent output</p>
          <div className="prose dark:prose-invert prose-sm max-h-96 max-w-none overflow-auto wrap-break-word text-xs">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{agent.message}</ReactMarkdown>
          </div>
        </div>}
      </div>}
    </div>
  );
}

/** Always a card (including completed calls), never hidden inside a tool group. */
export const CodexAgentTool = memo(function CodexAgentTool({ data, messageId }: {
  data: CodexAgentCardData;
  messageId: string;
}) {
  const [expanded, setExpanded] = useChatPersistedState(`codex-agent:${messageId}`, false);
  const { call, agents } = data;
  const title = call ? OPERATIONS[call.tool] ?? call.tool : "Subagent";
  const objective = call?.prompt ?? (agents.length === 1 ? agents[0].task : null);
  const showAgentTasks = agents.length > 1 && !call?.prompt;
  const isInput = call?.tool === "sendInput" || call?.tool === "sendMessage";

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="w-full min-w-0 overflow-hidden rounded-xl border border-foreground/10 bg-foreground/[0.025]">
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3.5 py-3 text-start hover:bg-foreground/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`${expanded ? "Collapse" : "Expand"} ${title} details`}>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <Bot className="size-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {agents.length === 1 ? agents[0].nickname ?? "Codex subagent" : agents.length > 1 ? `${agents.length} agents` : "Codex subagent"}
          </span>
        </span>
        {call && <StatusBadge status={call.status} prefix="Call" />}
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} aria-hidden="true" />
      </CollapsibleTrigger>
      <div className="space-y-3 px-3.5 pb-3.5">
        {agents.length === 0 && <ModelDetails model={call?.requestedModel ?? null} effort={call?.requestedReasoningEffort ?? null} source={call?.requestedModel ? "requested" : null} />}
        {!showAgentTasks && <div className="min-w-0 space-y-1.5">
          <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <Target className="size-3" aria-hidden="true" />{isInput ? "Input" : "Task objective"}
          </p>
          <p className={cn("whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-foreground/80", expanded ? "max-h-64 overflow-auto" : "line-clamp-3")}>
            {objective ?? "Task details not reported by Codex."}
          </p>
        </div>}
        {agents.map((agent) => <AgentDetails key={agent.threadId} agent={agent} expanded={expanded} showTask={showAgentTasks} />)}
        <CollapsibleContent>
          {call && <div className="space-y-1 break-all border-t border-foreground/[0.07] pt-2.5 font-mono text-[10px] text-muted-foreground">
            <p>Operation: {call.tool}</p>
            {call.requestedModel && <p>Requested model: {call.requestedModel}</p>}
            <p>Caller thread: {call.threadId}</p>
            <p>Call: {call.itemId}</p>
          </div>}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}, (previous, next) => previous.data === next.data && previous.messageId === next.messageId);
