import crypto from "node:crypto";
export interface ImportedMessage {
  id: string; role: string; content: string; timestamp: number;
  thinking?: string; thinkingComplete?: boolean; isStreaming?: boolean;
  toolName?: string; toolInput?: unknown; toolResult?: unknown; toolError?: boolean;
  subagentSteps?: unknown[]; subagentStatus?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Incremental JSONL parsing: no full source string or intermediate parsed-document array.
 * Tool results are resolved through an ID map rather than repeated transcript scans. */
export async function parseClaudeJsonl(lines: AsyncIterable<string>): Promise<ImportedMessage[]> {
  const messages: ImportedMessage[] = [];
  const tools = new Map<string, ImportedMessage>();
  let thinking: { text: string; uuid: string } | null = null;
  for await (const line of lines) {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!record(msg) || msg.isSidechain || msg.isMeta || (msg.type !== "user" && msg.type !== "assistant")) continue;
    const timestamp = typeof msg.timestamp === "string" || typeof msg.timestamp === "number" ? new Date(msg.timestamp).getTime() : Date.now();
    const uuid = typeof msg.uuid === "string" && msg.uuid ? msg.uuid : crypto.randomUUID();
    const content = record(msg.message) ? msg.message.content : undefined;
    if (msg.type === "user") {
      thinking = null;
      if (typeof content === "string" && content.trim()) {
        messages.push({ id: `imported-user-${uuid}`, role: "user", content, timestamp });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!record(item) || item.type !== "tool_result") continue;
          const text = typeof item.content === "string" ? item.content
            : Array.isArray(item.content) ? item.content.map(part => record(part) && typeof part.text === "string" ? part.text : "").join("\n") : "";
          const raw = msg.toolUseResult || msg.tool_use_result;
          const result = record(raw) ? { ...raw } : { stdout: text };
          const id = typeof item.tool_use_id === "string" ? item.tool_use_id : "";
          const tool = tools.get(id);
          if (tool) { tool.toolResult = result; if (item.is_error) tool.toolError = true; }
          messages.push({ id: `imported-result-${uuid}-${id}`, role: "tool_result", content: text, toolResult: result, timestamp });
        }
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!record(block)) continue;
        if (block.type === "thinking" && typeof block.thinking === "string") thinking = { text: block.thinking, uuid };
        else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          messages.push({ id: `imported-assistant-${uuid}`, role: "assistant", content: block.text, thinking: thinking?.text,
            thinkingComplete: thinking ? true : undefined, isStreaming: false, timestamp });
          thinking = null;
        } else if (block.type === "tool_use") {
          if (thinking) {
            messages.push({ id: `imported-thinking-${thinking.uuid}`, role: "assistant", content: "", thinking: thinking.text, thinkingComplete: true, isStreaming: false, timestamp });
            thinking = null;
          }
          const id = typeof block.id === "string" ? block.id : crypto.randomUUID();
          const tool: ImportedMessage = { id: `tool-${id}`, role: "tool_call", content: "", toolName: typeof block.name === "string" ? block.name : undefined,
            toolInput: block.input, timestamp, ...(block.name === "Task" ? { subagentSteps: [], subagentStatus: "completed" } : {}) };
          messages.push(tool);
          if (!tools.has(id)) tools.set(id, tool);
        }
      }
    }
  }
  return messages;
}
