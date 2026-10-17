import type { UIMessage } from "@/types";
import { getDistinctPatchPaths, getStructuredPatches } from "@/lib/diff/patch-utils";
import { getFileName } from "@shared/lib/file-paths";

/** A partial stdout is not a completion signal when explicit lifecycle data exists. */
export function getToolStatus(message: UIMessage) {
  if (message.toolError) return message.toolState?.status === "declined" ? "declined" : "failed";
  if (message.toolState) {
    if (message.toolState.status === "completed" && message.toolState.exitCode != null && message.toolState.exitCode !== 0) return "failed";
    return message.toolState.status;
  }
  return message.toolResult ? "completed" : "inProgress";
}

export function needsToolAttention(message: UIMessage): boolean {
  const status = getToolStatus(message);
  return status === "failed" || status === "declined" || status === "interrupted";
}

/** Keep Bash as the renderer; use parsed actions only for activity labels and grouping. */
export function getCommandActivity(message: UIMessage): { toolName: string; summary: string } | null {
  const actions = message.commandExecution?.actions;
  if (!actions?.length) return null;
  const first = actions[0];
  if (!actions.every(action => action.type === first.type)) return null;
  if (first.type === "read") return {
    toolName: "Read",
    summary: [...new Set(actions.flatMap(action => action.type === "read" ? [action.path || action.name] : []))].join(", "),
  };
  if (first.type === "search") return {
    toolName: "Grep",
    summary: actions.flatMap(action => action.type === "search" ? [
      [action.query ? `“${action.query}”` : "files", action.path ? `in ${action.path}` : ""].filter(Boolean).join(" "),
    ] : []).join("; "),
  };
  if (first.type === "listFiles") return {
    toolName: "ListFiles",
    summary: [...new Set(actions.flatMap(action => action.type === "listFiles" ? [action.path || "working directory"] : []))].join(", "),
  };
  return null;
}

export function getToolFilePaths(message: UIMessage): string[] {
  const paths = getDistinctPatchPaths(getStructuredPatches(message.toolResult));
  if (paths.length) return paths;
  const path = message.toolInput?.file_path ?? message.toolInput?.notebook_path;
  return typeof path === "string" && path ? [path] : [];
}

export function getToolGroupSummary(tools: UIMessage[]): { label: string; detail: string } {
  const edited = new Set<string>();
  const read = new Set<string>();
  let editsWithoutPath = 0, searches = 0, lists = 0, commands = 0, other = 0;
  const targets: string[] = [];
  for (const tool of tools) {
    const name = tool.toolName ?? "";
    const actions = tool.commandExecution?.actions;
    if (["Edit", "Write", "NotebookEdit"].includes(name)) {
      const paths = getToolFilePaths(tool);
      if (!paths.length) editsWithoutPath++;
      paths.forEach(path => { edited.add(path); targets.push(getFileName(path)); });
    } else if (actions?.length && actions.every(action => action.type !== "unknown")) {
      for (const action of actions) {
        if (action.type === "read") { read.add(action.path || action.name); targets.push(getFileName(action.path || action.name)); }
        if (action.type === "search") { searches++; if (action.query) targets.push(action.query); }
        if (action.type === "listFiles") { lists++; if (action.path) targets.push(action.path); }
      }
    } else if (name === "Read") {
      const path = tool.toolInput?.file_path;
      read.add(typeof path === "string" && path ? path : tool.id);
      if (typeof path === "string" && path) targets.push(getFileName(path));
    } else if (["Grep", "Glob", "WebSearch"].includes(name)) {
      searches++;
      const query = tool.toolInput?.query ?? tool.toolInput?.pattern;
      if (typeof query === "string") targets.push(query);
    } else if (name === "Bash") commands++;
    else other++;
  }
  const parts: string[] = [];
  const count = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  if (edited.size) parts.push(count(edited.size, "file edited", "files edited"));
  if (editsWithoutPath) parts.push(count(editsWithoutPath, "edit"));
  if (read.size) parts.push(count(read.size, "file read", "files read"));
  if (searches) parts.push(count(searches, "search", "searches"));
  if (lists) parts.push(count(lists, "directory listing"));
  if (commands) parts.push(count(commands, "command"));
  if (other) parts.push(count(other, "tool call"));
  const unique = [...new Set(targets)];
  return { label: parts.join(" · "), detail: unique.slice(0, 3).join(", ") + (unique.length > 3 ? ` +${unique.length - 3} more` : "") };
}
