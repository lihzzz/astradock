import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { UIMessage } from "@/types";
import { deriveToolName, normalizeToolInput, normalizeToolResult, mergeToolInput } from "./acp-adapter";

/** Explicit import only. Resume events never run through history reconstruction. */
export function acpHistoryMessages(events: SessionNotification[]): UIMessage[] {
  const messages: UIMessage[] = [];
  const tools = new Map<string, UIMessage>();
  let lastKey = "";
  let index = 0;
  for (const { update } of events) {
    const kind = update.sessionUpdate;
    if (kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const role = kind === "user_message_chunk" ? "user" : "assistant";
      const remoteId = "messageId" in update && typeof update.messageId === "string" ? update.messageId : "";
      const key = role + ":" + remoteId;
      let message = messages.at(-1);
      if (!message || key !== lastKey || message.role !== role) {
        message = { id: "acp-import-" + index++, role, content: "", timestamp: Date.now() };
        messages.push(message);
      }
      lastKey = key;
      const content = update.content;
      const text = content.type === "text" ? content.text
        : content.type === "resource" && "text" in content.resource ? content.resource.text
        : content.type === "resource_link" ? content.uri
        : "[" + content.type + " attachment]";
      if (role === "user" && content.type === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].some(type => type === content.mimeType)) {
        const mediaType = content.mimeType;
        if (mediaType === "image/png" || mediaType === "image/jpeg" || mediaType === "image/gif" || mediaType === "image/webp") {
          message.images = [...(message.images ?? []), { id: "acp-image-" + index++, data: content.data, mediaType }];
        }
      }
      if (kind === "agent_thought_chunk") { message.thinking = (message.thinking ?? "") + text; message.thinkingComplete = true; }
      else message.content += text;
    } else if (kind === "tool_call") {
      lastKey = "";
      const message: UIMessage = { id: "tool-" + update.toolCallId, role: "tool_call", content: "", timestamp: Date.now(),
        toolName: deriveToolName(update.title, update.kind ?? undefined, update.rawInput),
        toolInput: normalizeToolInput(update.rawInput, update.kind ?? undefined, update.locations?.map(location => ({ path: location.path, line: location.line ?? undefined }))),
        toolResult: normalizeToolResult(update.rawOutput, update.content), toolError: update.status === "failed" };
      tools.set(update.toolCallId, message); messages.push(message);
    } else if (kind === "tool_call_update") {
      const message = tools.get(update.toolCallId);
      if (!message) continue;
      message.toolInput = mergeToolInput(message.toolInput, update.rawInput, update.kind ?? undefined, update.locations?.map(location => ({ path: location.path, line: location.line ?? undefined })));
      message.toolResult = normalizeToolResult(update.rawOutput, update.content ?? undefined) ?? message.toolResult;
      message.toolError = update.status === "failed";
    }
  }
  return messages;
}
