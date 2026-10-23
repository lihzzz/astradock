import { useCallback, useState } from "react";
import { MIN_STACKED_TOOL_PANEL_HEIGHT } from "@/lib/layout/workspace-constraints";

interface UseToolColumnResizeOptions {
  columnRefs: React.RefObject<Record<string, HTMLDivElement | null>>;
  setSplitRatios: (columnId: string, ratios: number[]) => void;
}

export function useToolColumnResize({
  columnRefs,
  setSplitRatios,
}: UseToolColumnResizeOptions) {
  const [activeResizeId, setActiveResizeId] = useState<string | null>(null);

  const handleResizeStart = useCallback((
    columnId: string,
    handleIndex: number,
    splitRatios: number[],
    event: React.MouseEvent,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const container = columnRefs.current[columnId];
    if (!container) return;

    const panels = Array.from(container.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.hasAttribute("data-tool-panel"),
    );
    const topPanel = panels[handleIndex];
    const bottomPanel = panels[handleIndex + 1];
    if (!topPanel || !bottomPanel ||
      topPanel.dataset.toolPanelCollapsed === "true" || bottomPanel.dataset.toolPanelCollapsed === "true") return;

    setActiveResizeId(`${columnId}:${handleIndex}`);
    const startY = event.clientY;
    const startFractions = [...splitRatios];
    const pairHeight = Math.max(topPanel.getBoundingClientRect().height + bottomPanel.getBoundingClientRect().height, 1);
    const pairFraction = startFractions[handleIndex]! + startFractions[handleIndex + 1]!;
    const minPanelFraction = Math.min(pairFraction / 2, MIN_STACKED_TOOL_PANEL_HEIGHT / pairHeight * pairFraction);

    const handleMove = (moveEvent: MouseEvent) => {
      const deltaFraction = (moveEvent.clientY - startY) / pairHeight * pairFraction;
      const nextFractions = [...startFractions];

      const topNew = Math.max(minPanelFraction, Math.min(
        pairFraction - minPanelFraction,
        startFractions[handleIndex]! + deltaFraction,
      ));
      const bottomNew = pairFraction - topNew;

      nextFractions[handleIndex] = topNew;
      nextFractions[handleIndex + 1] = bottomNew;
      const sum = nextFractions.reduce((acc, value) => acc + value, 0);
      setSplitRatios(
        columnId,
        nextFractions.map((value) => value / sum),
      );
    };

    const handleUp = () => {
      setActiveResizeId(null);
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [columnRefs, setSplitRatios]);

  return {
    activeResizeId,
    handleResizeStart,
  };
}
