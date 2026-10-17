import { useMemo } from "react";
import type { UIMessage } from "@/types";
import { getToolFilePaths, getToolStatus } from "@/lib/chat/tool-activity";

/** Cheap, always-visible result hints; never mount full logs or diffs here. */
export function ToolActivitySummary({ message }: { message: UIMessage }) {
  const paths = useMemo(() => ["Edit", "Write", "NotebookEdit"].includes(message.toolName ?? "")
    ? getToolFilePaths(message) : [], [message.toolName, message.toolInput, message.toolResult]);
  const output = message.toolResult?.stdout ?? message.toolResult?.content;
  const status = getToolStatus(message);
  const error = (status === "failed" || status === "declined") && typeof output === "string"
    ? output.slice(0, 4096).split("\n").find(line => line.trim() && !/^(Exit code:|Duration:)/.test(line)) : null;
  if (!error && paths.length < 2) return null;
  return (
    <div className="ms-5 mb-1 space-y-1 border-s border-border ps-3 text-xs text-muted-foreground">
      {paths.slice(0, 3).map(path => <div key={path} className="truncate font-mono" title={path}>{path}</div>)}
      {paths.length > 3 && <div>+{paths.length - 3} more files</div>}
      {error && <div className="line-clamp-2 wrap-break-word text-destructive" title={error}>{error}</div>}
    </div>
  );
}
