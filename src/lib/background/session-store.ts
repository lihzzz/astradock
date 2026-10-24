import type {
  ClaudeEvent,
  UIMessage,
  SessionInfo,
  PermissionRequest,
  SlashCommand,
  ContextUsage,
  CodexThreadGoal,
} from "@/types";
import type { ACPSessionEvent, ACPPermissionEvent, CodexSessionEvent } from "@/types";
import { handleClaudeEvent } from "./claude-handler";
import { handleACPEvent as acpHandler, handleACPTurnComplete as acpTurnComplete } from "./acp-handler";
import { settleCodexTools } from "@/lib/engine/codex-adapter";
import { handleCodexEvent as codexHandler } from "./codex-handler";

export interface BackgroundSessionState {
  messages: UIMessage[];
  isProcessing: boolean;
  isConnected: boolean;
  isCompacting: boolean;
  sessionInfo: SessionInfo | null;
  totalCost: number;
  contextUsage: ContextUsage | null;
  pendingPermission: PermissionRequest | null;
  /** Raw ACP permission event — needed for optionId lookup when responding */
  rawAcpPermission: ACPPermissionEvent | null;
  /** Slash commands available for this session (ACP agents update dynamically) */
  slashCommands: SlashCommand[];
  codexGoal?: CodexThreadGoal | null;
  codexGoalSupported?: boolean | null;
  /** Upstream reconnect in progress (Codex willRetry) — restored on switch-back. */
  reconnectMessage?: string | null;
}

export interface InternalState extends BackgroundSessionState {
  parentToolMap: Map<string, string>;
  currentStreamingMsgId: string | null;
  /** Accumulated plan text from item/plan/delta events (Codex only). */
  codexPlanText: string;
  /** Per-turn counter for unique plan card message IDs (Codex only). */
  codexPlanTurnCounter: number;
  /** Active ACP task/subagent — inner tool_calls and text are routed into its card. */
  activeTask: { msgId: string; toolCallId: string; hasInnerTools: boolean; textBuffer: string } | null;
}

/** Callback fired when a background session receives a permission request */
type PermissionRequestCallback = (sessionId: string, permission: PermissionRequest) => void;

/**
 * Accumulates UIMessages for sessions not currently active in useClaude.
 * Prevents event loss when switching between sessions with ongoing responses.
 */
export class BackgroundSessionStore {
  private sessions = new Map<string, InternalState>();
  private removed = new Set<string>();
  private live = new Map<string, Map<symbol, () => BackgroundSessionState>>();
  onChanged?: (sessionId: string) => void;
  hasLive(sessionId: string): boolean { return !!this.live.get(sessionId)?.size; }
  registerLive(sessionId: string, snapshot: () => BackgroundSessionState): () => void {
    const owners = this.live.get(sessionId) ?? new Map<symbol, () => BackgroundSessionState>();
    const owner = Symbol();
    owners.set(owner, snapshot); this.live.set(sessionId, owners);
    return () => {
      const state = snapshot();
      owners.delete(owner);
      if (!owners.size) {
        this.live.delete(sessionId);
        if (!this.removed.has(sessionId)) {
          this.initFromState(sessionId, state);
          this.onChanged?.(sessionId);
        }
      }
    };
  }
  notifyChanged(sessionId: string): void { this.onChanged?.(sessionId); }
  checkpointUrgent(sessionId: string): boolean {
    const state = this.liveState(sessionId) ?? this.sessions.get(sessionId);
    return !!state && (!state.isProcessing || !!state.pendingPermission);
  }
  private liveState(sessionId: string): BackgroundSessionState | undefined {
    const providers = this.live.get(sessionId);
    return providers ? [...providers.values()].at(-1)?.() : undefined;
  }
  onProcessingChange?: (sessionId: string, isProcessing: boolean) => void;
  onPermissionRequest?: PermissionRequestCallback;
  onGoalChange?: (sessionId: string, goal: CodexThreadGoal | null) => void;

  private getOrCreate(sessionId: string): InternalState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        messages: [],
        isProcessing: false,
        isConnected: false,
        isCompacting: false,
        sessionInfo: null,
        totalCost: 0,
        contextUsage: null,
        pendingPermission: null,
        rawAcpPermission: null,
        slashCommands: [],
        codexGoal: null,
        codexGoalSupported: null,
        reconnectMessage: null,
        parentToolMap: new Map(),
        currentStreamingMsgId: null,
        codexPlanText: "",
        codexPlanTurnCounter: 0,
        activeTask: null,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  handleEvent(event: ClaudeEvent & { _sessionId?: string }): void {
    const sessionId = event._sessionId;
    if (!sessionId) return;

    const state = this.getOrCreate(sessionId);
    const result = handleClaudeEvent(state, event);
    this.onChanged?.(sessionId);
    if (result?.processingChanged) {
      this.onProcessingChange?.(sessionId, result.isProcessing);
    }
  }

  handleACPEvent(event: ACPSessionEvent): void {
    const sessionId = event._sessionId;
    if (!sessionId) return;

    const state = this.getOrCreate(sessionId);
    acpHandler(state, event);
    this.onChanged?.(sessionId);
  }

  /** Handle ACP turn completion — finalize streaming, close tools, reset processing. */
  handleACPTurnComplete(sessionId: string, stopReason?: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    acpTurnComplete(state, stopReason);
    this.onChanged?.(sessionId);
    this.onProcessingChange?.(sessionId, false);
  }

  /** Handle a Codex notification for a background (non-active) session. */
  handleCodexEvent(event: CodexSessionEvent): void {
    const sessionId = event._sessionId;
    if (!sessionId) return;

    const state = this.getOrCreate(sessionId);
    const result = codexHandler(state, event);
    this.onChanged?.(sessionId);
    if (result?.processingChanged) {
      this.onProcessingChange?.(sessionId, result.isProcessing!);
    }
    if (result?.permissionRequest) {
      this.onPermissionRequest?.(sessionId, result.permissionRequest);
    }
    if (result?.goalChanged) {
      this.onGoalChange?.(sessionId, result.goal ?? null);
    }
  }

  /** Store a pending permission for a background session and fire the callback. */
  setPermission(sessionId: string, permission: PermissionRequest, rawAcpPermission?: ACPPermissionEvent | null): void {
    const state = this.getOrCreate(sessionId);
    state.pendingPermission = permission;
    state.rawAcpPermission = rawAcpPermission ?? null;
    this.onChanged?.(sessionId);
    this.onPermissionRequest?.(sessionId, permission);
  }

  has(sessionId: string): boolean {
    return this.hasLive(sessionId) || this.sessions.has(sessionId);
  }

  get(sessionId: string): BackgroundSessionState | undefined {
    const state = this.liveState(sessionId) ?? this.sessions.get(sessionId);
    if (!state) return undefined;
    // Clone messages to prevent external mutation of internal state
    return {
      messages: state.messages.map(m => ({ ...m })),
      isProcessing: state.isProcessing,
      isConnected: state.isConnected,
      isCompacting: state.isCompacting,
      sessionInfo: state.sessionInfo ? { ...state.sessionInfo } : null,
      totalCost: state.totalCost,
      contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
      pendingPermission: state.pendingPermission ? { ...state.pendingPermission } : null,
      rawAcpPermission: state.rawAcpPermission,
      slashCommands: state.slashCommands ?? [],
      codexGoal: state.codexGoal,
      codexGoalSupported: state.codexGoalSupported,
      reconnectMessage: state.reconnectMessage ?? null,
    };
  }

  /**
   * Capture bootstrap without removing the event accumulator. React may defer or
   * abandon the transition; events in that gap must still see the full history.
   * The pane re-reads at commit and registerLive takes over routing afterwards.
   */
  consume(sessionId: string): BackgroundSessionState | undefined {
    return this.get(sessionId);
  }

  delete(sessionId: string): void {
    this.removed.add(sessionId);
    this.sessions.delete(sessionId);
  }

  updateMessages(sessionId: string, updater: (messages: UIMessage[]) => UIMessage[]): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.messages = updater(state.messages);
  }

  setProcessing(sessionId: string, isProcessing: boolean): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.isProcessing === isProcessing) return;
    state.isProcessing = isProcessing;
    this.onProcessingChange?.(sessionId, isProcessing);
  }

  /** Seed store with the current session state when switching away. */
  initFromState(sessionId: string, state: BackgroundSessionState): void {
    this.removed.delete(sessionId);
    const parentToolMap = new Map<string, string>();
    // The active view treats message arrays immutably, so we can reuse the
    // existing objects here and avoid an O(n) clone on every session switch.
    const messages = state.messages;
    let codexPlanTurnCounter = 0;
    let latestPlanStreamTurn = -1;
    let latestPlanStreamMsg: UIMessage | undefined;
    let streamingMsg: UIMessage | undefined;

    for (const msg of messages) {
      if (msg.role === "tool_call" && msg.subagentSteps !== undefined) {
        const toolUseId = msg.id.replace(/^tool-/, "");
        parentToolMap.set(toolUseId, msg.id);
      }
      // Reconstruct Codex in-flight tool mappings from deterministic IDs
      if (msg.role === "tool_call" && msg.id.startsWith("codex-tool-") && !msg.toolResult && !msg.toolError) {
        const itemId = msg.id.replace("codex-tool-", "");
        parentToolMap.set(itemId, msg.id);
      }
      if (msg.id.startsWith("codex-plan-update-")) {
        const num = parseInt(msg.id.replace("codex-plan-update-", ""), 10);
        if (!isNaN(num) && num >= codexPlanTurnCounter) codexPlanTurnCounter = num;
      }
      if (msg.id.startsWith("codex-plan-stream-")) {
        const num = parseInt(msg.id.replace("codex-plan-stream-", ""), 10);
        if (!isNaN(num) && num >= codexPlanTurnCounter) codexPlanTurnCounter = num;
        if (!isNaN(num) && num >= latestPlanStreamTurn) {
          latestPlanStreamTurn = num;
          latestPlanStreamMsg = msg;
        }
      }
      if (msg.role === "assistant" && msg.isStreaming) {
        streamingMsg = msg;
      }
    }

    // Backward compatibility with older persisted sessions
    if (!latestPlanStreamMsg) {
      latestPlanStreamMsg = messages.find(m => m.id === "codex-plan-stream");
    }

    const planInput = latestPlanStreamMsg?.toolInput as { plan?: string } | undefined;
    const codexPlanText = planInput?.plan ?? "";

    this.sessions.set(sessionId, {
      messages,
      isProcessing: state.isProcessing,
      isConnected: state.isConnected,
      isCompacting: state.isCompacting ?? false,
      sessionInfo: state.sessionInfo ? { ...state.sessionInfo } : null,
      totalCost: state.totalCost,
      contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
      pendingPermission: state.pendingPermission ? { ...state.pendingPermission } : null,
      rawAcpPermission: state.rawAcpPermission ?? null,
      slashCommands: state.slashCommands ?? [],
      codexGoal: state.codexGoal ?? null,
      codexGoalSupported: state.codexGoalSupported ?? null,
      reconnectMessage: state.reconnectMessage ?? null,
      parentToolMap,
      currentStreamingMsgId: streamingMsg?.id ?? null,
      codexPlanText,
      codexPlanTurnCounter,
      activeTask: null,
    });
  }

  /** Mark a session as disconnected (process exited). */
  markDisconnected(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.isConnected = false;
    state.isCompacting = false;
    state.messages = settleCodexTools(state.messages, null, "interrupted");
    // Dead process = dead permission — clear both
    state.pendingPermission = null;
    state.rawAcpPermission = null;
    if (state.isProcessing) {
      state.isProcessing = false;
      this.onProcessingChange?.(sessionId, false);
    }
    for (const msg of state.messages) {
      if (msg.isStreaming) {
        msg.isStreaming = false;
      }
    }
  }
}
