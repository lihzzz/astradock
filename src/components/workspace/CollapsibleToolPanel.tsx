import { useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PanelHeader } from "@/components/PanelHeader";
import { PANEL_TOOLS_MAP } from "@/components/ToolPicker";
import { useI18n } from "@/lib/i18n";
import type { PanelToolId } from "@/types/tools";

interface CollapsibleToolPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "style"> {
  toolId: PanelToolId;
  fraction: number;
  headerControls: ReactNode;
  renderContent: (controls: ReactNode) => ReactNode;
}

/** Keeps a tool mounted while its title bar takes only the height it needs. */
export function CollapsibleToolPanel({
  toolId,
  fraction,
  headerControls,
  renderContent,
  className = "",
  ...props
}: CollapsibleToolPanelProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();
  const tool = PANEL_TOOLS_MAP[toolId];
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const label = t(collapsed ? "Expand tool" : "Collapse tool");
  // Grow factors below one leave space unused when their siblings collapse.
  const grow = fraction * 100;
  const controls = (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={!collapsed}
        aria-controls={contentId}
        onClick={() => setCollapsed((current) => !current)}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-foreground/40 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/70 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Chevron className="h-3.5 w-3.5" />
      </button>
      {headerControls}
    </>
  );

  return (
    <div
      {...props}
      data-tool-panel
      data-tool-panel-collapsed={collapsed}
      className={`island flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--island-radius)] bg-background ${className}`}
      style={{ flex: collapsed ? "0 0 auto" : `${grow} 1 0%` }}
    >
      {collapsed && (
        <PanelHeader icon={tool.icon} label={t(tool.label)} separator={false}>
          {controls}
        </PanelHeader>
      )}
      <div
        id={contentId}
        hidden={collapsed}
        className={collapsed ? "hidden" : "flex min-h-0 flex-1 flex-col"}
      >
        {renderContent(controls)}
      </div>
    </div>
  );
}
