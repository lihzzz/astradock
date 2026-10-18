import { lazy, memo, Suspense, useEffect, useState, useMemo, useCallback, createContext, useContext, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { AlertCircle, Brain, ChevronDown, ChevronUp, Clock, Crosshair, File, Folder, Info, RotateCcw, Send, Undo2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { MarkdownFileLink } from "./MarkdownFileLink";
import { markdownUrlTransform } from "@/lib/markdown-links";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { guessLanguage } from "@/lib/languages";
import { useStreamingTextReveal } from "@/hooks/useStreamingTextReveal";
import { useChatPersistedState } from "@/components/chat-ui-state";
import type { UIMessage, ImageAttachment } from "@/types";
import type { AutoRetryState } from "@/lib/session/auto-retry";
import { ThinkingBlock } from "./ThinkingBlock";
import { CopyButton } from "./CopyButton";
import { ImageLightbox } from "./ImageLightbox";
import {
  CHAT_CONTENT_STACK_CLASS,
  CHAT_PROSE_EDGE_CLASS,
  CHAT_ROW_CLASS,
} from "@/components/lib/chat-layout";

// Stable references to avoid re-creating on every render
const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

const AUTO_RETRY_BUTTON_CLASS = "rounded-full px-1.5 py-0.5 text-foreground/60 transition-colors hover:bg-foreground/[0.08] hover:text-foreground";

function RememberMenu({ onRemember }: { onRemember: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="rounded p-1 text-foreground/25 opacity-0 transition hover:bg-foreground/[0.08] hover:text-foreground/70 group-hover/user:opacity-100 group-hover/assistant:opacity-100" aria-label="Remember this message" title="Remember this message">
          <Brain className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onRemember}>
          <Brain className="me-2 h-3.5 w-3.5" /> Remember this message
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Countdown shown on a retryable error while an auto-retry is scheduled. */
function AutoRetryCountdown({
  autoRetry,
  onRetryNow,
  onCancel,
}: {
  autoRetry: AutoRetryState;
  onRetryNow: () => void;
  onCancel?: () => void;
}) {
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    Math.max(0, Math.ceil((autoRetry.runAt - Date.now()) / 1000)),
  );
  useEffect(() => {
    const interval = setInterval(() => {
      setRemainingSeconds(Math.max(0, Math.ceil((autoRetry.runAt - Date.now()) / 1000)));
    }, 250);
    return () => clearInterval(interval);
  }, [autoRetry.runAt]);

  return (
    <span className="ms-1 inline-flex items-center gap-1 text-[11px] text-foreground/60">
      <RotateCcw className="h-3 w-3 animate-spin [animation-duration:2.5s]" />
      <span>
        Auto-retry in {remainingSeconds}s ({autoRetry.attempt}/{autoRetry.maxAttempts})
      </span>
      <button type="button" className={AUTO_RETRY_BUTTON_CLASS} onClick={onRetryNow}>
        Retry now
      </button>
      {onCancel && (
        <button
          type="button"
          aria-label="Cancel auto-retry"
          className={AUTO_RETRY_BUTTON_CLASS}
          onClick={onCancel}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function getFenceMarker(line: string): { char: "`" | "~"; length: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(line);
  if (!match) return null;
  return { char: match[2][0] as "`" | "~", length: match[2].length };
}

function isFenceClose(line: string, fence: { char: "`" | "~"; length: number }): boolean {
  const pattern = new RegExp(`^ {0,3}${fence.char}{${fence.length},}[ \\t]*(?:\\n|$)`);
  return pattern.test(line);
}

/** Normalize LaTeX delimiters while leaving fenced and inline code unchanged. */
function normalizeMathText(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    if (text[index] === "`") {
      const runStart = index;
      while (index < text.length && text[index] === "`") index += 1;
      const marker = text.slice(runStart, index);
      const close = text.indexOf(marker, index);
      if (close < 0) {
        result += text.slice(runStart);
        break;
      }
      const end = close + marker.length;
      result += text.slice(runStart, end);
      index = end;
      continue;
    }

    const displayStart = text.startsWith("\\[", index) ? "\\[" : null;
    const inlineStart = text.startsWith("\\(", index) ? "\\(" : null;
    const start = displayStart ?? inlineStart;
    if (!start) {
      result += text[index];
      index += 1;
      continue;
    }

    const endMarker = displayStart ? "\\]" : "\\)";
    const close = text.indexOf(endMarker, index + start.length);
    if (close < 0) {
      result += start;
      index += start.length;
      continue;
    }

    const expression = text.slice(index + start.length, close).trim();
    if (displayStart) {
      const linePrefix = text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
      const afterClose = text.slice(close + endMarker.length);
      const isBlock = /^[ \t]*$/.test(linePrefix) && /^[ \t]*(?:\n|$)/.test(afterClose);
      result += isBlock ? `$$\n${expression}\n$$` : `$$${expression}$$`;
    } else {
      result += `$${expression}$`;
    }
    index = close + endMarker.length;
  }

  return result;
}

/**
 * Models commonly emit the LaTeX display delimiters `\[` and `\]`, while
 * remark-math follows Markdown's dollar delimiters. Normalize the former
 * before parsing so persisted messages render the same as new ones.
 */
function normalizeMathDelimiters(markdown: string): string {
  const lines = markdown.split(/(?<=\n)/);
  const output: string[] = [];
  let fence: { char: "`" | "~"; length: number } | null = null;
  let text = "";

  const flushText = () => {
    if (text) {
      output.push(normalizeMathText(text));
      text = "";
    }
  };

  for (const line of lines) {
    if (fence) {
      output.push(line);
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }

    const marker = getFenceMarker(line);
    if (marker) {
      flushText();
      output.push(line);
      fence = marker;
      continue;
    }

    text += line;
  }

  flushText();
  return output.join("");
}
import type { Components } from "react-markdown";

const SyntaxHighlightedCode = lazy(() =>
  import("./SyntaxHighlightedCode").then(({ SyntaxHighlightedCode: Component }) => ({ default: Component })),
);
const MermaidDiagram = lazy(() =>
  import("./MermaidDiagram").then(({ MermaidDiagram: Component }) => ({ default: Component })),
);

/**
 * Context to distinguish fenced code blocks (inside <pre>) from inline `code`.
 * react-markdown v10 removed the `inline` prop from the code component —
 * this Context replaces it by having the `pre` component signal block context.
 */
const IsBlockCodeContext = createContext(false);
const IsStreamingMarkdownContext = createContext(false);

const MD_COMPONENTS: Components = {
  a: MarkdownFileLink,
  code: CodeBlock,
  // Strip the <pre> wrapper but signal block context to CodeBlock
  pre({ children }) {
    return (
      <IsBlockCodeContext.Provider value={true}>
        {children}
      </IsBlockCodeContext.Provider>
    );
  },
};
const SYNTAX_STYLE: React.CSSProperties = {
  margin: 0,
  borderRadius: 0,
  background: "transparent",
  textShadow: "none",
  fontSize: "12px",
  padding: "12px",
};

/** Override oneDark's background on the inner <code> element */
const CODE_TAG_PROPS = { style: { background: "transparent", textShadow: "none" } };

const USER_MESSAGE_COLLAPSE_LINE_LIMIT = 12;
const USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT = 1_200;

function getCollapsedUserContent(content: string): string {
  const firstLines = content.split("\n").slice(0, USER_MESSAGE_COLLAPSE_LINE_LIMIT).join("\n");
  const truncated = firstLines.slice(0, USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT).trimEnd();
  return truncated.length < content.length ? `${truncated}…` : content;
}

/** Strip `<file path="...">...</file>` and `<folder path="...">...</folder>` context blocks from user messages */
function stripFileContext(text: string): string {
  let result = text.replace(/<file path="[^"]*">[\s\S]*?<\/file>\s*/g, "");
  result = result.replace(/<folder path="[^"]*">[\s\S]*?<\/folder>\s*/g, "");
  result = result.replace(/<element [^>]*>[\s\S]*?<\/element>\s*/g, "");
  return result.trim();
}

/** Render @path references and grabbed-element markers as styled inline badges */
function renderWithMentions(text: string): ReactNode[] {
  // Match @path/to/file, @path/to/dir/, or [[element:...]]
  const parts = text.split(/(@[\w./_-]+\/?|\[\[element:[^\]]+\]\])/g);
  return parts.map((part, i) => {
    const browserMatch = /^\[\[element:(.+)\]\]$/.exec(part);
    if (browserMatch) {
      return (
        <span
          key={i}
          className="inline-flex items-baseline gap-0.5 rounded bg-blue-500/15 px-1 py-px font-mono text-xs text-blue-300"
        >
          <Crosshair className="inline h-3 w-3 shrink-0 self-center" />
          {browserMatch[1]}
        </span>
      );
    }
    if (part.startsWith("@") && part.length > 1) {
      const filePath = part.slice(1);
      const isDir = filePath.endsWith("/");
      return (
        <span
          key={i}
          className="inline-flex items-baseline gap-0.5 rounded bg-accent/50 px-1 py-px font-mono text-xs text-accent-foreground"
        >
          {isDir ? (
            <Folder className="inline h-3 w-3 shrink-0 self-center text-blue-400" />
          ) : (
            <File className="inline h-3 w-3 shrink-0 self-center text-muted-foreground" />
          )}
          {filePath}
        </span>
      );
    }
    return part;
  });
}

interface MessageBubbleProps {
  message: UIMessage;
  showThinking?: boolean;
  assistantTurnDividerLabel?: string;
  isContinuation?: boolean;
  /** True when this queued message is the prioritized "send next" item */
  isSendNextQueued?: boolean;
  /** Called when user clicks "Revert files only" — restores files to state before this message */
  onRevert?: (checkpointId: string) => void;
  /** Called when user clicks "Revert files + chat" — restores files AND truncates conversation */
  onFullRevert?: (checkpointId: string) => void;
  /** Called when user clicks "Send next" on a queued user message */
  onSendQueuedNow?: (messageId: string) => void;
  /** Called when user removes a queued user message before it is sent */
  onUnqueueQueued?: (messageId: string) => void;
  /** Called when a failed or interrupted turn should be retried/continued. */
  onRetry?: (errorMessageId: string) => void | Promise<void>;
  /** Scheduled auto-retry for this error — replaces the manual Retry button with a countdown. */
  autoRetry?: AutoRetryState | null;
  onCancelAutoRetry?: () => void;
  onRemember?: (content: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  showThinking = true,
  assistantTurnDividerLabel,
  isContinuation,
  isSendNextQueued = false,
  onRevert,
  onFullRevert,
  onSendQueuedNow,
  onUnqueueQueued,
  onRetry,
  autoRetry,
  onCancelAutoRetry,
  onRemember,
}: MessageBubbleProps) {
  // All hooks must be called before any early returns (Rules of Hooks)
  const isUser = message.role === "user";
  const [viewingImage, setViewingImage] = useState<ImageAttachment | null>(null);
  const [rememberMenu, setRememberMenu] = useState<{ x: number; y: number } | null>(null);
  const time = useMemo(() => new Date(message.timestamp).toLocaleTimeString(), [message.timestamp]);
  const displayContent = useMemo(() => isUser ? (message.displayContent ?? stripFileContext(message.content)) : message.content, [isUser, message.content, message.displayContent]);
  const markdownContent = useMemo(() => normalizeMathDelimiters(message.content), [message.content]);
  const [isUserMessageExpanded, setIsUserMessageExpanded] = useChatPersistedState(
    `user-message:${message.id}`,
    false,
  );
  const isLongUserMessage = isUser && (
    displayContent.length > USER_MESSAGE_COLLAPSE_CHARACTER_LIMIT ||
    displayContent.split("\n").length > USER_MESSAGE_COLLAPSE_LINE_LIMIT
  );
  const renderedUserContent = isLongUserMessage && !isUserMessageExpanded
    ? getCollapsedUserContent(displayContent)
    : displayContent;

  const handleRememberContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!onRemember || !message.content.trim()) return;
    event.preventDefault();
    setRememberMenu({ x: event.clientX, y: event.clientY });
  }, [message.content, onRemember]);

  useEffect(() => {
    if (!rememberMenu) return;
    const close = () => setRememberMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [rememberMenu]);

  const rememberContextAction = onRemember && rememberMenu ? (
    <div className="fixed z-50 rounded-md border border-foreground/10 bg-popover p-1 shadow-lg" style={{ left: rememberMenu.x, top: rememberMenu.y }} onClick={(event) => event.stopPropagation()}>
      <button type="button" className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-popover-foreground hover:bg-foreground/[0.08]" onClick={() => { setRememberMenu(null); onRemember(message.content); }}>
        <Brain className="h-3.5 w-3.5" /> Remember this message
      </button>
    </div>
  ) : null;

  // Per-token fade-in animation via DOM surgery in useLayoutEffect.
  // Always renders ReactMarkdown (real-time markdown parsing) — the hook
  // splits trailing text nodes into [old | animated-new] before each paint.
  const proseRef = useStreamingTextReveal(
    message.role === "assistant" ? message.isStreaming : undefined,
    message.role === "assistant" ? message.content : "",
  );

  if (message.role === "system") {
    const isError = message.isError;
    const canRetry = !!onRetry && ((isError && message.retryable) || message.continuable);
    const isContinuation = !!message.continuable;
    return (
      <div className={cn(
        "mx-auto max-w-3xl px-4 py-1 text-center text-xs",
        isError ? "text-destructive" : "text-muted-foreground",
      )}>
        <div className="inline-flex items-center gap-1.5">
          {isError ? <AlertCircle className="h-3 w-3" /> : <Info className="h-3 w-3" />}
          {message.content}
          {canRetry && (
            autoRetry?.errorMessageId === message.id ? (
              <AutoRetryCountdown
                autoRetry={autoRetry}
                onRetryNow={() => void onRetry!(message.id)}
                onCancel={onCancelAutoRetry}
              />
            ) : (
              <button
                type="button"
                className="ms-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] text-foreground/60 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                onClick={() => void onRetry!(message.id)}
              >
                <RotateCcw className="h-3 w-3" />
                {isContinuation ? "Continue" : "Retry"}
              </button>
            )
          )}
        </div>
      </div>
    );
  }

  if (isUser) {
    const checkpointId = message.checkpointId;
    const canRevert = !!checkpointId && (!!onRevert || !!onFullRevert);
    return (
      <div className={cn("group/user flex justify-end", CHAT_ROW_CLASS, message.isQueued && "opacity-60")} onContextMenu={handleRememberContextMenu}>
        <div className={cn("relative max-w-[var(--chat-user-message-max-width,80%)]", canRevert && "pb-5")}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className={cn(
                "rounded-2xl rounded-tr-sm bg-foreground/[0.06] px-3.5 py-2 text-sm text-foreground wrap-break-word whitespace-pre-wrap",
                message.isQueued && !isSendNextQueued && "border border-dashed border-foreground/10",
                message.isQueued && isSendNextQueued && "border border-dashed border-red-400/50",
              )}>
                {message.images && message.images.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {message.images.map((img) => (
                      <img
                        key={img.id}
                        src={`data:${img.mediaType};base64,${img.data}`}
                        alt={img.fileName ?? "attached image"}
                        className="max-h-48 cursor-pointer rounded-lg transition-opacity hover:opacity-90"
                        onClick={() => setViewingImage(img)}
                      />
                    ))}
                  </div>
                )}
                <ImageLightbox
                  image={viewingImage}
                  open={!!viewingImage}
                  onOpenChange={(isOpen) => { if (!isOpen) setViewingImage(null); }}
                />
                {renderWithMentions(renderedUserContent)}
                {isLongUserMessage && (
                  <button
                    type="button"
                    aria-expanded={isUserMessageExpanded}
                    className="mt-2 flex w-fit items-center gap-1 rounded-md text-[11px] font-medium text-foreground/45 transition-colors hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => setIsUserMessageExpanded((expanded) => !expanded)}
                  >
                    {isUserMessageExpanded ? (
                      <>
                        <ChevronUp className="h-3 w-3" />
                        Collapse message
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3 w-3" />
                        Show full message
                      </>
                    )}
                  </button>
                )}
                {message.isQueued && (
                  <div className="mt-2 flex items-center gap-2 border-t border-foreground/[0.06] pt-2 text-[11px] text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" />
                    <span>Queued</span>
                    {(onSendQueuedNow || onUnqueueQueued) && (
                      <div className="ms-auto flex items-center gap-1">
                        {onSendQueuedNow && (
                          <button
                            type="button"
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-all",
                              isSendNextQueued
                                ? "bg-primary/15 text-primary hover:bg-primary/25"
                                : "text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground",
                            )}
                            onClick={() => onSendQueuedNow(message.id)}
                          >
                            <Send className="h-2.5 w-2.5" />
                            Send next
                          </button>
                        )}
                        {onUnqueueQueued && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => onUnqueueQueued(message.id)}
                          >
                            <X className="h-2.5 w-2.5" />
                            Unqueue
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="left">
              <p className="text-xs">{time}</p>
            </TooltipContent>
          </Tooltip>
          {onRemember && message.content.trim() && <div className="absolute -bottom-1 -start-7"><RememberMenu onRemember={() => onRemember(message.content)} /></div>}
          {/* Revert dropdown — visible on hover, offers file-only or full (files + chat) revert */}
          {canRevert && (
            <div className="pointer-events-none absolute end-0 -bottom-0.5 w-max opacity-0 transition-opacity group-hover/user:opacity-100">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="pointer-events-auto flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-foreground/30 transition-colors hover:text-foreground/60">
                    <Undo2 className="h-3 w-3" />
                    Revert to here
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {onRevert && (
                    <DropdownMenuItem onClick={() => onRevert(checkpointId)}>
                      <Undo2 className="h-3.5 w-3.5 me-2" />
                      Revert files only
                    </DropdownMenuItem>
                  )}
                  {onFullRevert && (
                    <DropdownMenuItem onClick={() => onFullRevert(checkpointId)}>
                      <RotateCcw className="h-3.5 w-3.5 me-2" />
                      Revert files + chat
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        {rememberContextAction}
      </div>
    );
  }

  // Assistant message — always render with ReactMarkdown.
  // Previously this used IntersectionObserver to defer markdown parsing for
  // off-screen messages, but that caused messages to render as plain text
  // (showing literal # and * characters) when the observer didn't fire
  // reliably — e.g. after session switch-back, persistence restore, or within
  // Radix ScrollArea. Always rendering markdown is fast enough for individual
  // messages; for truly long chats, proper virtualization should be used instead.
  const hasRenderableAssistantContent = !!message.content || (showThinking && !!message.thinking);
  if (!hasRenderableAssistantContent) {
    return null;
  }

  return (
    <div
      className={cn("group/assistant flex justify-start", CHAT_ROW_CLASS, message.phase === "final_answer" && "mt-3")}
      data-message-phase={message.phase ?? undefined}
      data-continuation={isContinuation || undefined}
      onContextMenu={handleRememberContextMenu}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={cn("min-w-0 max-w-[var(--chat-assistant-message-max-width,85%)]", assistantTurnDividerLabel && "w-full")}>
            <div className={cn("flow-root wrap-break-word", CHAT_CONTENT_STACK_CLASS, assistantTurnDividerLabel ? "w-full" : "min-w-0")}>
            {assistantTurnDividerLabel ? (
              <div className="relative mb-3 w-full text-center text-[11px] text-muted-foreground/70">
                <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-foreground/[0.08]" />
                <span className="relative inline-block bg-background px-3 font-medium">
                  {assistantTurnDividerLabel}
                </span>
              </div>
            ) : null}
              <div className={cn(assistantTurnDividerLabel && "inline-block min-w-0 max-w-full", message.phase === "commentary" && "border-s-2 border-border ps-3")}>
                {message.phase && <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground">{message.phase === "commentary" ? "Progress" : "Response"}</div>}
                {showThinking && message.thinking && (
                  <ThinkingBlock
                    thinking={message.thinking}
                    isStreaming={message.isStreaming}
                    thinkingComplete={message.thinkingComplete}
                    storageKey={`thinking:${message.id}`}
                  />
                )}
                {message.content ? (
                  <div
                    ref={proseRef}
                    className={cn(
                      "flow-root prose dark:prose-invert prose-sm max-w-none text-foreground [&_li::marker]:text-foreground dark:[&_li::marker]:text-foreground/70",
                      CHAT_PROSE_EDGE_CLASS,
                      message.phase === "commentary" && "text-muted-foreground prose-headings:text-muted-foreground prose-strong:text-foreground/80",
                    )}
                  >
                    <IsStreamingMarkdownContext.Provider value={!!message.isStreaming}>
                      <ReactMarkdown
                        remarkPlugins={REMARK_PLUGINS}
                        rehypePlugins={REHYPE_PLUGINS}
                        components={MD_COMPONENTS}
                        urlTransform={markdownUrlTransform}
                      >
                        {markdownContent}
                      </ReactMarkdown>
                    </IsStreamingMarkdownContext.Provider>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p className="text-xs">{time}</p>
        </TooltipContent>
      </Tooltip>
      {onRemember && message.content.trim() && <div className="ms-1 self-end"><RememberMenu onRemember={() => onRemember(message.content)} /></div>}
      {rememberContextAction}
    </div>
  );
}, (prev, next) =>
  prev.message.phase === next.message.phase &&
  prev.message.content === next.message.content &&
  prev.message.thinking === next.message.thinking &&
  prev.message.isStreaming === next.message.isStreaming &&
  prev.message.thinkingComplete === next.message.thinkingComplete &&
  prev.message.images === next.message.images &&
  prev.message.isError === next.message.isError &&
  prev.message.retryable === next.message.retryable &&
  prev.message.continuable === next.message.continuable &&
  prev.message.checkpointId === next.message.checkpointId &&
  prev.message.isQueued === next.message.isQueued &&
  prev.assistantTurnDividerLabel === next.assistantTurnDividerLabel &&
  prev.isSendNextQueued === next.isSendNextQueued &&
  prev.showThinking === next.showThinking &&
  prev.isContinuation === next.isContinuation &&
  prev.onRevert === next.onRevert &&
  prev.onFullRevert === next.onFullRevert &&
  prev.onSendQueuedNow === next.onSendQueuedNow &&
  prev.onUnqueueQueued === next.onUnqueueQueued &&
  prev.onRetry === next.onRetry &&
  prev.autoRetry === next.autoRetry &&
  prev.onCancelAutoRetry === next.onCancelAutoRetry &&
  prev.onRemember === next.onRemember,
);

/**
 * Handles both fenced code blocks and inline `code` spans.
 * Uses IsBlockCodeContext (from the `pre` component) to detect fenced blocks,
 * since react-markdown v10 removed the `inline` prop.
 */
function CodeBlock(props: React.HTMLAttributes<HTMLElement> & { node?: unknown }) {
  const { className, children } = props;
  const isBlock = useContext(IsBlockCodeContext);
  const isStreaming = useContext(IsStreamingMarkdownContext);
  const match = /language-(\w+)/.exec(String(className ?? ""));
  const code = String(children).replace(/\n$/, "");

  // Fenced code block with language tag → syntax highlighted
  if (isBlock && match) {
    const language = match[1];

    // Render mermaid diagrams with MermaidDiagram component
    if (language === "mermaid") {
      return (
        <Suspense fallback={<pre className="overflow-x-auto p-3 text-xs font-mono"><code>{code}</code></pre>}>
          <MermaidDiagram code={code} isStreaming={isStreaming} />
        </Suspense>
      );
    }

    return (
      <div className="not-prose group/code relative my-2 rounded-lg bg-foreground/[0.03] overflow-hidden" style={{ contain: "content" }}>
        <div className="flex items-center justify-between bg-foreground/[0.04] px-3 py-1">
          <span className="text-[11px] text-muted-foreground">{language}</span>
          <CopyButton text={code} className="opacity-0 transition-opacity group-hover/code:opacity-100" />
        </div>
        {isStreaming ? (
          <pre className="overflow-x-auto p-3 text-xs font-mono" style={SYNTAX_STYLE}>
            <code>{code}</code>
          </pre>
        ) : (
          <Suspense fallback={<pre className="overflow-x-auto p-3 text-xs font-mono" style={SYNTAX_STYLE}><code>{code}</code></pre>}>
            <SyntaxHighlightedCode
              code={code}
              language={language}
              customStyle={SYNTAX_STYLE}
              codeTagProps={CODE_TAG_PROPS}
            />
          </Suspense>
        )}
      </div>
    );
  }

  // Fenced code block without language tag → try auto-detect
  if (isBlock) {
    const guessedLang = !isStreaming ? guessLanguage(code) : null;
    return (
      <div className="not-prose group/code relative my-2 rounded-lg bg-foreground/[0.03] overflow-hidden" style={{ contain: "content" }}>
        <div className="flex items-center justify-between bg-foreground/[0.04] px-3 py-1">
          {guessedLang ? (
            <span className="text-[11px] text-muted-foreground">{guessedLang}</span>
          ) : (
            <span />
          )}
          <CopyButton text={code} className="opacity-0 transition-opacity group-hover/code:opacity-100" />
        </div>
        {guessedLang ? (
          <Suspense fallback={<pre className="overflow-x-auto p-3 text-xs font-mono" style={SYNTAX_STYLE}><code>{code}</code></pre>}>
            <SyntaxHighlightedCode
              code={code}
              language={guessedLang}
              customStyle={SYNTAX_STYLE}
              codeTagProps={CODE_TAG_PROPS}
            />
          </Suspense>
        ) : (
          <pre className="overflow-x-auto p-3 text-xs font-mono">
            <code>{code}</code>
          </pre>
        )}
      </div>
    );
  }

  // Inline code — not-prose prevents Typography backtick pseudo-elements
  return (
    <code className="not-prose rounded bg-foreground/[0.08] px-1.5 py-0.5 text-xs font-mono">
      {children}
    </code>
  );
}
