import type { Terminal } from "lucide-react";

/** All tool identifiers available in the tool picker strip. */
export type ToolId = "terminal" | "browser" | "git" | "files" | "project-files" | "tasks" | "agents" | "mcp" | "memory" | "fingerprint";

/** Subset of ToolId that renders as a panel in the tools column (excludes contextual tools like tasks/agents). */
export type PanelToolId = Extract<ToolId, "terminal" | "browser" | "git" | "files" | "project-files" | "mcp" | "memory" | "fingerprint">;

/** Shape of a tool definition used by ToolPicker and workspace components. */
export interface ToolDef {
  id: ToolId;
  label: string;
  icon: typeof Terminal;
}
