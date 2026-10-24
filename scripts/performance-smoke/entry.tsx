import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatView } from "@/components/ChatView";
import { AgentProvider, type AgentContextValue } from "@/components/AgentContext";
import { I18nProvider } from "@/lib/i18n";
import { ProjectFilesPanel } from "@/components/ProjectFilesPanel";
import type { UIMessage } from "@/types";
import "@/index.css";

declare global {
  interface Window {
    smoke: {
      setTarget: (id: string | undefined) => void;
      setMode: (mode: string) => void;
      append: () => void;
      updateTail: (content: string, streaming: boolean) => void;
    };
    searchDone?: boolean;
  }
}

// No preload or connection to the application's user-data profile.
Object.defineProperty(window, "claude", { value: {
  files: {
    listAll: async () => ({ files: Array.from({ length: 10000 }, (_, i) => `file-${i}.ts`) }),
    watch: async () => {},
    unwatch: async () => {},
    onChanged: () => () => {},
  },
  analytics: { capture: () => {} },
  memory: { rememberSession: async () => ({}) },
} });
const agent: AgentContextValue = {
  agents: [], selectedAgent: null, saveAgent: async () => ({}), deleteAgent: async () => ({}),
  handleAgentChange: () => {}, lockedEngine: null, lockedAgentId: null,
};
const initial: UIMessage[] = Array.from({ length: 10000 }, (_, i) => ({
  id: `m${i}`, role: i % 2 ? "assistant" : "user",
  content: `Message ${i}\n\n**synthetic** test content.`, timestamp: i + 1,
}));

function Harness() {
  const [messages, setMessages] = useState(initial);
  const [target, setTarget] = useState<string>();
  const [mode, setMode] = useState("chat");
  window.smoke = {
    setTarget, setMode,
    updateTail: (content, streaming) => setMessages(previous => [
      ...previous.slice(0, -1), { ...previous.at(-1)!, content, isStreaming: streaming },
    ]),
    append: () => setMessages(previous => [
      ...previous, { id: "last", role: "assistant", content: "NEW TAIL", timestamp: 20000 },
    ]),
  };
  return (
    <TooltipProvider>
      <I18nProvider>
        <AgentProvider value={agent}>
          <div style={{ display: "flex", height: 700, width: 1000 }}>
            {mode === "chat" ? (
              <ChatView cwd={undefined} messages={messages} isProcessing={false} showThinking={false}
                sessionId="smoke" scrollToMessageId={target} onScrolledToMessage={() => { window.searchDone = true; }} />
            ) : <ProjectFilesPanel cwd="synthetic" enabled />}
          </div>
        </AgentProvider>
      </I18nProvider>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
