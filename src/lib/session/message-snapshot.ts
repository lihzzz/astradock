import type { UIMessage } from "@/types";
/** Include buffered tokens without flushing React state or waiting for a visible frame. */
export function snapshotStreamingMessages(messages: UIMessage[], id: string | null, text: string, thinking: string, complete: boolean): UIMessage[] {
  if (!id) return messages;
  const last = messages.length - 1;
  const index = messages[last]?.id === id ? last : messages.findIndex((message) => message.id === id);
  if (index < 0) return messages;
  const previous = messages[index];
  const next = { ...previous, content: text || previous.content,
    thinking: thinking || previous.thinking, thinkingComplete: complete || previous.thinkingComplete };
  if (next.content === previous.content && next.thinking === previous.thinking && next.thinkingComplete === previous.thinkingComplete) return messages;
  const result = [...messages]; result[index] = next; return result;
}
