import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckSquare, Copy, X } from "lucide-react";
import { toast } from "sonner";
import type { UIMessage } from "@/types";
import { buildToolResultsMarkdown } from "@shared/lib/session-markdown";
import { copyToClipboard } from "@/lib/clipboard";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

interface ToolSelectionContext {
  t: (key: string) => string;
  active: boolean;
  selected: ReadonlySet<string>;
  toggle: (ids: string[]) => void;
  isTopLevel: (id: string) => boolean;
}
const Context = createContext<ToolSelectionContext | null>(null);

export function ToolResultSelection({ children, messages }: { children: ReactNode; messages: UIMessage[] }) {
  const { t } = useI18n();
  const latestMessages = useRef(messages);
  latestMessages.current = messages;
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [copying, setCopying] = useState(false);
  const toggle = useCallback((ids: string[]) => {
    setSelected((previous) => {
      const next = new Set(previous);
      const remove = ids.every((id) => next.has(id));
      for (const id of ids) { if (remove) next.delete(id); else next.add(id); }
      return next;
    });
  }, []);
  const isTopLevel = useCallback((id: string) => latestMessages.current.some((message) => message.id === id && message.role === "tool_call"), []);
  const value = useMemo(() => ({ active, selected, toggle, isTopLevel, t }), [active, selected, toggle, isTopLevel, t]);
  const clear = useCallback(() => { setSelected(new Set()); setActive(false); }, []);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); clear(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [active, clear]);
  const copy = async () => {
    setCopying(true);
    try {
      // Serialize one immutable message snapshot before awaiting any clipboard API.
      const text = buildToolResultsMarkdown(latestMessages.current, selected);
      if (await copyToClipboard(text)) toast.success(t("Tool results copied as Markdown"));
      else toast.error(t("Clipboard write failed"));
    } catch (error) { toast.error(t(error instanceof Error ? error.message : "Unable to copy tool results")); }
    finally { setCopying(false); }
  };
  return <Context value={value}>
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col pt-[56px]">
      {/* Reserve a row below the floating header, including when the actions wrap. */}
      <div className="z-20 flex shrink-0 justify-end px-4">
        <div role="group" aria-label={t("Select tool results")} className="flex min-w-0 flex-wrap items-center justify-end gap-1 rounded-lg border border-border/50 bg-background/95 p-1 text-xs shadow-sm">
          {!active ? <Button size="sm" variant="ghost" onClick={() => setActive(true)}><CheckSquare className="h-3.5 w-3.5" />{t("Select tool results")}</Button> : <>
            <span className="whitespace-nowrap px-1" role="status">{t("Selected")}: {selected.size}</span>
            <Button size="sm" variant="ghost" disabled={!selected.size || copying} onClick={() => void copy()}><Copy className="h-3.5 w-3.5" />{t("Copy Markdown")}</Button>
            <Button size="icon" variant="ghost" aria-label={t("Exit selection")} onClick={clear}><X className="h-3.5 w-3.5" /></Button>
          </>}
        </div>
      </div>
      {children}
    </div>
  </Context>;
}

export function SelectableToolResult({ message, children }: { message: UIMessage; children: ReactNode }) {
  const selection = useContext(Context);
  if (!selection?.active || !selection.isTopLevel(message.id)) return <>{children}</>;
  const complete = message.toolResult != null || message.toolError === true;
  return <div className="flex min-w-0 items-start gap-2">
    <input type="checkbox" className="mt-1.5 shrink-0 accent-primary" checked={selection.selected.has(message.id)} disabled={!complete}
      aria-label={`${selection.t("Select tool result")}: ${message.toolName ?? "Tool"}`} onChange={() => selection.toggle([message.id])} />
    <div className="min-w-0 flex-1">{children}</div>
  </div>;
}

export function SelectableToolGroup({ tools, children }: { tools: UIMessage[]; children: ReactNode }) {
  const selection = useContext(Context);
  if (!selection?.active) return <>{children}</>;
  const ids = tools.filter((tool) => tool.toolResult != null || tool.toolError).map((tool) => tool.id);
  return <div className="relative">
    <label className="ms-4 flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <input type="checkbox" className="accent-primary" checked={ids.length > 0 && ids.every((id) => selection.selected.has(id))} disabled={!ids.length} onChange={() => selection.toggle(ids)} />
      {selection.t("Select completed tools in group")}
    </label>
    {children}
  </div>;
}
