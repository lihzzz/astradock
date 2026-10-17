import type { UIMessage } from "@/types";
import { getToolStatus } from "./tool-activity";

function sameStructure(previous: UIMessage, next: UIMessage): boolean {
  if (previous === next) return true;
  if (previous.id !== next.id || previous.role !== next.role || previous.turnId !== next.turnId
    || previous.phase !== next.phase || previous.toolName !== next.toolName
    || previous.isStreaming !== next.isStreaming || previous.toolError !== next.toolError
    || !!previous.content !== !!next.content || !!previous.thinking !== !!next.thinking) return false;
  if (next.role === "tool_call") {
    const status = getToolStatus(next);
    if (getToolStatus(previous) !== status) return false;
    // Partial stdout changes don't regroup the transcript. Completed result/input
    // corrections must refresh group snapshots and per-turn file summaries.
    return status === "inProgress"
      || (previous.toolInput === next.toolInput && previous.toolResult === next.toolResult
        && previous.commandExecution === next.commandExecution && previous.toolState === next.toolState);
  }
  return !!next.isStreaming || (previous.content === next.content && previous.thinking === next.thinking);
}

/** Scan cheap object identities, not all text/JSON, on each streaming frame. */
export function createChatStructureTracker() {
  let previous: UIMessage[] = [];
  let processing = false;
  let revision = 0;
  return (messages: UIMessage[], isProcessing: boolean): number => {
    let changed = processing !== isProcessing || previous.length !== messages.length;
    if (!changed && previous !== messages) {
      for (let i = 0; i < messages.length; i++) {
        if (!sameStructure(previous[i], messages[i])) { changed = true; break; }
      }
    }
    previous = messages;
    processing = isProcessing;
    if (changed) revision++;
    return revision;
  };
}
