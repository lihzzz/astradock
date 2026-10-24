import type { UIMessage } from "@/types";
import type { BackgroundSessionState } from "@/lib/background/session-store";

/** Share the exact first-message identity between the initial disk save and UI. */
export function materializedState(previous: BackgroundSessionState | undefined, user: UIMessage): BackgroundSessionState {
  const existing = previous?.messages.find(message => message.role === "user" && message.content === user.content);
  return {
    isConnected: true, isCompacting: false, sessionInfo: null, totalCost: 0, contextUsage: null,
    pendingPermission: null, rawAcpPermission: null, slashCommands: [], ...previous,
    isProcessing: true, messages: existing ? previous!.messages : [user, ...(previous?.messages ?? [])],
  };
}
export function appendMessageOnce(messages: UIMessage[], message: UIMessage): UIMessage[] {
  return messages.some(existing => existing.id === message.id) ? messages : [...messages, message];
}
