import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, type CSSProperties } from "react";
import { ChevronRight, AlertCircle } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { UIMessage } from "@/types";
import { ToolCall } from "./ToolCall";
import { ThinkingBlock } from "./ThinkingBlock";
import { getToolLabel, getToolIcon, getToolColor } from "@/components/lib/tool-metadata";
import { getToolGroupSummary, getCommandActivity, getToolStatus } from "@/lib/chat/tool-activity";
import { formatCompactSummary } from "@/components/lib/tool-formatting";
import { useChatPersistedState } from "@/components/chat-ui-state";
import { ToolGlyph } from "@/components/lib/ToolGlyph";
import {
  CHAT_ROW_CLASS,
  CHAT_ROW_WIDTH_CLASS,
} from "@/components/lib/chat-layout";

interface ToolGroupBlockProps {
  tools: UIMessage[];
  messages: UIMessage[];
  showThinking?: boolean;
  autoExpandTools?: boolean;
  expandEditToolCallsByDefault?: boolean;
  showToolIcons?: boolean;
  coloredToolIcons?: boolean;
  disableCollapseAnimation?: boolean;
  /** When true (live streaming), runs a one-time tools -> group morph animation.
   *  When false (restored session), renders collapsed immediately. */
  animate: boolean;
  /** Search and timeline navigation can reveal a tool in an otherwise collapsed group. */
  revealMessageId?: string;
}

const GROUP_HEADER_BASE_CLASS = "relative flex w-full items-center gap-2 rounded-md px-2 py-2 text-[13px] leading-5 text-muted-foreground";
const GROUP_HEADER_BUTTON_CLASS = `${GROUP_HEADER_BASE_CLASS} cursor-pointer overflow-hidden text-start transition-colors hover:bg-foreground/[0.03] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`;
const MORPH_BASE_MS = 640;
const MORPH_STAGGER_MS = 32;

function ToolGroupHeaderContent({
  toolIcons,
  toolSummary,
  toolDetail,
  isOpen,
}: {
  toolIcons: Array<{ Icon: typeof AlertCircle; color: string }> | null;
  toolSummary: string;
  toolDetail: string;
  isOpen: boolean;
}) {
  return (
    <>
      <div className="relative flex min-w-0 flex-1 items-center gap-2">
        {toolIcons && (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            {toolIcons.map((entry, i) => (
              <ToolGlyph key={i} Icon={entry.Icon} className={entry.color} />
            ))}
          </span>
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground/80">{toolSummary}</span>
          {toolDetail && <span className="mt-1 block truncate text-xs text-muted-foreground" title={toolDetail}>{toolDetail}</span>}
        </span>
      </div>

      <ChevronRight
        className={`h-3 w-3 shrink-0 text-muted-foreground transition-all duration-200 ${
          isOpen ? "rotate-90" : ""
        }`}
      />
    </>
  );
}

export const ToolGroupBlock = memo(function ToolGroupBlock({
  tools,
  messages,
  showThinking = true,
  autoExpandTools = false,
  expandEditToolCallsByDefault = true,
  showToolIcons = true,
  coloredToolIcons = false,
  disableCollapseAnimation = false,
  animate,
  revealMessageId,
}: ToolGroupBlockProps) {
  // Lock animation decision at mount. Parent re-renders may flip `animate` to false
  // after first paint; we still want one morph animation for newly formed groups.
  const animateOnMount = useRef(animate).current;
  const groupKey = tools[0]?.id ?? "group";

  // Final grouped state is always collapsed by default.
  const [isOpen, setIsOpen] = useChatPersistedState(`tool-group:${groupKey}`, false);
  useLayoutEffect(() => {
    if (revealMessageId && tools.some((tool) => tool.id === revealMessageId)) setIsOpen(true);
  }, [revealMessageId, tools, setIsOpen]);
  const [isMorphing, setIsMorphing] = useState(animateOnMount);
  const [morphStarted, setMorphStarted] = useState(false);
  const [morphHeight, setMorphHeight] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);

  const morphDurationMs = useMemo(
    () => MORPH_BASE_MS + Math.min(6, Math.max(0, tools.length - 1)) * MORPH_STAGGER_MS,
    [tools.length],
  );

  useEffect(() => {
    if (!isMorphing) {
      setMorphStarted(false);
      setMorphHeight(null);
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsMorphing(false);
    }
  }, [isMorphing]);

  useLayoutEffect(() => {
    if (!isMorphing) return;

    const shellEl = shellRef.current;
    const headerEl = headerRef.current;
    const toolsEl = toolsRef.current;
    if (!shellEl || !headerEl || !toolsEl) {
      setIsMorphing(false);
      return;
    }

    setMorphStarted(false);
    const startHeight = Math.max(toolsEl.offsetHeight, 1);
    const endHeight = Math.max(headerEl.offsetHeight, 1);
    setMorphHeight(startHeight);

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setIsMorphing(false);
      setMorphStarted(false);
      setMorphHeight(null);
    };

    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === shellEl && event.propertyName === "height") {
        finish();
      }
    };
    shellEl.addEventListener("transitionend", onTransitionEnd);

    const raf = window.requestAnimationFrame(() => {
      setMorphStarted(true);
      setMorphHeight(endHeight);
    });

    const fallbackTimer = window.setTimeout(finish, morphDurationMs + 180);

    return () => {
      shellEl.removeEventListener("transitionend", onTransitionEnd);
      window.cancelAnimationFrame(raf);
      clearTimeout(fallbackTimer);
    };
  }, [isMorphing, morphDurationMs]);

  const summary = useMemo(() => getToolGroupSummary(tools), [tools]);
  const toolSummary = summary.label;

  const toolIcons = useMemo(() => {
    if (!showToolIcons) return null;
    const seen = new Set<typeof AlertCircle>();
    const unique: Array<{ Icon: typeof AlertCircle; color: string }> = [];
    for (const t of tools) {
      const Icon = t.toolError ? AlertCircle : getToolIcon(getCommandActivity(t)?.toolName ?? t.toolName ?? "");
      if (seen.has(Icon)) continue;
      seen.add(Icon);
      unique.push({
        Icon,
        color: t.toolError ? "text-red-400/70" : (coloredToolIcons ? getToolColor(t.toolName ?? "") : "text-foreground/40"),
      });
    }
    return unique;
  }, [tools, showToolIcons, coloredToolIcons]);

  const morphRows = useMemo(() => {
    return tools.map((tool) => {
      const toolName = getCommandActivity(tool)?.toolName ?? tool.toolName ?? "";
      const isError = !!tool.toolError;
      const isRunning = getToolStatus(tool) === "inProgress";
      const Icon = isError ? AlertCircle : getToolIcon(toolName);
      const label = isError
        ? `Failed to ${getToolLabel(toolName, "failure") ?? "run tool"}`
        : ((getToolLabel(toolName, isRunning ? "active" : "past") ?? toolName) || (isRunning ? "Running" : "Tool"));
      const summary = formatCompactSummary(tool);
      return { id: tool.id, Icon, toolName, label, summary, isError };
    });
  }, [tools]);

  const groupedRows = useMemo(() => {
    return messages.filter((message) => {
      if (message.role === "tool_call") return true;
      return showThinking && message.role === "assistant" && !!message.thinking && !message.content;
    });
  }, [messages, showThinking]);

  if (isMorphing) {
    const shellStyle: CSSProperties = {
      "--tool-group-morph-duration": `${morphDurationMs}ms`,
    } as CSSProperties;
    if (morphHeight !== null) shellStyle.height = `${morphHeight}px`;

    return (
      <div className={CHAT_ROW_CLASS}>
        <div className={CHAT_ROW_WIDTH_CLASS}>
          <div
            ref={shellRef}
            className="tool-group-morph-shell"
            style={shellStyle}
          >
            <div
              ref={headerRef}
              className={`tool-group-morph-header ${morphStarted ? "tool-group-morph-header-in" : ""}`}
            >
              <div className={GROUP_HEADER_BASE_CLASS}>
                <ToolGroupHeaderContent toolIcons={toolIcons} toolSummary={toolSummary} toolDetail={summary.detail} isOpen={false} />
              </div>
            </div>

            <div
              ref={toolsRef}
              className={`tool-group-morph-tools ${morphStarted ? "tool-group-morph-tools-out" : ""}`}
            >
              <div className="tool-group-morph-rows">
                {morphRows.map((row, index) => (
                  <div
                    key={row.id}
                    className={`tool-group-morph-row ${morphStarted ? "tool-group-morph-row-out" : ""}`}
                    style={{ "--tool-row-index": index } as CSSProperties}
                  >
                    {showToolIcons && <ToolGlyph Icon={row.Icon} className={row.isError ? "text-red-400/70" : (coloredToolIcons ? getToolColor(row.toolName) : "text-foreground/40")} />}
                    <span className={`shrink-0 whitespace-nowrap font-medium ${row.isError ? "text-red-400/70" : "text-foreground/60"}`}>
                      {row.label}
                    </span>
                    <span className="truncate text-foreground/40">{row.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const groupContent = isOpen ? (
    <div className="ms-[6.5px]">
      {groupedRows.map((message, i) => {
        const isLast = i === groupedRows.length - 1;
        const content = message.role === "tool_call" ? (
          <ToolCall
            message={message}
            compact
            autoExpandTools={autoExpandTools}
            expandEditToolCallsByDefault={expandEditToolCallsByDefault}
            showToolIcons={showToolIcons}
            coloredToolIcons={coloredToolIcons}
            disableCollapseAnimation={disableCollapseAnimation}
          />
        ) : (
          <ThinkingBlock
            thinking={message.thinking ?? ""}
            isStreaming={message.isStreaming}
            thinkingComplete={message.thinkingComplete}
            storageKey={`thinking:${message.id}`}
          />
        );
        return (
          <div key={message.id} data-message-id={message.id} className="flex">
            {/* Tree connector: vertical trunk + horizontal branch pinned to top row */}
            <div className="relative w-3.5 shrink-0">
              <div className={`absolute start-0 top-0 w-px bg-foreground/15 ${isLast ? "h-[15px]" : "h-full"}`} />
              <div className="absolute start-0 top-[15px] h-px w-full bg-foreground/15" />
            </div>
            <div className="min-w-0 flex-1 ps-1.5 py-px">
              {content}
            </div>
          </div>
        );
      })}
    </div>
  ) : null;

  // Fast path: conditional rendering — collapsed groups render ZERO children.
  if (disableCollapseAnimation) {
    return (
      <div className={CHAT_ROW_CLASS}>
        <div className={CHAT_ROW_WIDTH_CLASS}>
          <button
            type="button"
            onClick={() => setIsOpen((prev) => !prev)}
            className={`group ${GROUP_HEADER_BUTTON_CLASS}`}
            aria-expanded={isOpen}
          >
            <ToolGroupHeaderContent toolIcons={toolIcons} toolSummary={toolSummary} toolDetail={summary.detail} isOpen={isOpen} />
          </button>
          {groupContent}
        </div>
      </div>
    );
  }

  return (
    <div className={CHAT_ROW_CLASS}>
      <div className={CHAT_ROW_WIDTH_CLASS}>
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger
            className={`group ${GROUP_HEADER_BUTTON_CLASS}`}
          >
            <ToolGroupHeaderContent toolIcons={toolIcons} toolSummary={toolSummary} toolDetail={summary.detail} isOpen={isOpen} />
          </CollapsibleTrigger>
          <CollapsibleContent className="tool-group-collapse">
            {groupContent}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}, (prev, next) =>
  prev.tools === next.tools &&
  prev.messages === next.messages &&
  prev.showThinking === next.showThinking &&
  prev.autoExpandTools === next.autoExpandTools &&
  prev.expandEditToolCallsByDefault === next.expandEditToolCallsByDefault &&
  prev.showToolIcons === next.showToolIcons &&
  prev.coloredToolIcons === next.coloredToolIcons &&
  prev.disableCollapseAnimation === next.disableCollapseAnimation &&
  prev.revealMessageId === next.revealMessageId &&
  prev.animate === next.animate,
);
