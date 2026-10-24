/** Closed telemetry schema: never forward free text, arbitrary keys, or nested values. */
const EVENTS = new Set([
  "app_started", "daily_active_user", "app_error", "background_agent_completed", "background_agent_created",
  "browser_tab_created", "context_compaction_triggered", "engine_switched", "message_sent",
  "permission_responded", "session_imported", "session_revived", "space_created", "thinking_toggled",
  "plan_mode_entered", "file_opened_in_editor", "git_branch_switched", "git_commit_created",
  "mcp_server_added", "model_changed", "project_created", "session_completed", "session_created",
  "session_error", "terminal_created", "tool_executed",
]);
const NUMBERS = new Set(["duration_ms", "num_turns", "total_cost", "message_count", "message_length", "range"]);
const BOOLEANS = new Set(["is_error", "success", "enabled", "has_color", "has_images"]);
const ENUMS: Record<string, readonly string[]> = {
  engine: ["claude", "codex", "acp"], from_engine: ["claude", "codex", "acp"], to_engine: ["claude", "codex", "acp"],
  platform: ["win32", "darwin", "linux"], arch: ["x64", "arm64", "ia32"],
  phase: ["start", "send", "resume"], trigger: ["manual", "automatic"],
  error_type: ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError", "AggregateError"],
  transport: ["stdio", "http", "sse"], editor: ["code", "cursor", "zed", "default"], icon_type: ["emoji", "lucide"],
};
export function isTelemetryEvent(event: unknown): event is string {
  return typeof event === "string" && EVENTS.has(event);
}
export function sanitizeTelemetryProperties(properties: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (NUMBERS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
    else if (BOOLEANS.has(key) && typeof value === "boolean") safe[key] = value;
    else if (Object.hasOwn(ENUMS, key) && typeof value === "string" && ENUMS[key].includes(value)) safe[key] = value;
    else if ((key === "version" || key === "app_version") && typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value)) safe[key] = value;
    else if (key === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) safe[key] = value;
  }
  return safe;
}
/** No original message, stack, cause, component stack, or custom error fields leave the device. */
export function telemetryErrorProperties(error: Error, properties?: Record<string, unknown>): Record<string, string | number | boolean> {
  return sanitizeTelemetryProperties({ ...properties, error_type: ENUMS.error_type.includes(error.name) ? error.name : "Error" });
}
