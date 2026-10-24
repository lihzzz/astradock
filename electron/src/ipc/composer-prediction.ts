import { ipcMain, type WebContents } from "electron";
import { buildComposerPredictionPrompt, parseComposerPrediction } from "@shared/lib/composer-prediction";
import type {
  ComposerPredictionCancelResult,
  ComposerPredictionRequest,
  ComposerPredictionResult,
} from "@shared/types/composer-prediction";
import { acpUtilityPrompt } from "../lib/acp-utility-prompt";
import { claudeUtilityPrompt } from "../lib/claude-utility-prompt";
import { codexUtilityPrompt } from "../lib/codex-utility-prompt";
import { retryComposerPrediction } from "../lib/composer-prediction-retry";
import { reportError } from "../lib/error-utils";

// Prediction lifetime is controlled by user input/session cancellation, not a deadline.
const PREDICTION_TIMEOUT_MS = null;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_SOURCE_REVISION_LENGTH = 512;
const MAX_CONTEXT_TURNS = 80;
const MAX_CONTEXT_CHARS = 28_000;

interface PredictionJob {
  requestId: string;
  sessionId: string;
  controller: AbortController;
}

const jobsByRequest = new Map<string, PredictionJob>();
const jobsBySession = new Map<string, PredictionJob>();

function invalidRequest(request: ComposerPredictionRequest): ComposerPredictionResult {
  return {
    requestId: typeof request?.requestId === "string" ? request.requestId : "",
    sourceRevision: typeof request?.sourceRevision === "string" ? request.sourceRevision : "",
    status: "failed",
    text: undefined,
    latencyMs: 0,
  };
}

function validateRequest(value: unknown): ComposerPredictionRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<ComposerPredictionRequest>;
  if (typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 128) return null;
  if (typeof request.sessionId !== "string" || request.sessionId.length < 1 || request.sessionId.length > MAX_SESSION_ID_LENGTH) return null;
  if (request.engine !== "claude" && request.engine !== "codex" && request.engine !== "acp") return null;
  if (typeof request.sourceRevision !== "string" || request.sourceRevision.length < 1 || request.sourceRevision.length > MAX_SOURCE_REVISION_LENGTH) return null;
  if (!request.context || typeof request.context !== "object" || !Array.isArray(request.context.turns)) return null;
  if (request.context.turns.length > MAX_CONTEXT_TURNS) return null;
  const contextLength = request.context.turns.reduce((sum, turn) => {
    if (!turn || typeof turn !== "object" || (turn.role !== "user" && turn.role !== "assistant" && turn.role !== "tool" && turn.role !== "summary") || typeof turn.content !== "string") return Number.POSITIVE_INFINITY;
    return sum + turn.content.length;
  }, 0);
  if (!Number.isFinite(contextLength) || contextLength > MAX_CONTEXT_CHARS) return null;
  return {
    ...request,
    model: typeof request.model === "string" ? request.model.slice(0, 256) : undefined,
    cwd: typeof request.cwd === "string" ? request.cwd.slice(0, 2048) : undefined,
    locale: typeof request.locale === "string" ? request.locale.slice(0, 32) : undefined,
  } as ComposerPredictionRequest;
}

async function executePrediction(request: ComposerPredictionRequest, signal: AbortSignal): Promise<string> {
  const prompt = buildComposerPredictionPrompt({
    turns: request.context.turns,
    locale: request.locale ?? request.context.locale,
  });
  const cwd = request.cwd?.trim() || process.cwd();
  if (request.engine === "claude") {
    return claudeUtilityPrompt(prompt, cwd, {
      timeoutMs: PREDICTION_TIMEOUT_MS,
      model: request.model,
      signal,
    });
  }
  if (request.engine === "codex") {
    return codexUtilityPrompt(prompt, cwd, "COMPOSER_PREDICTION", {
      timeoutMs: PREDICTION_TIMEOUT_MS,
      model: request.model,
      signal,
    });
  }
  return acpUtilityPrompt(request.sessionId, prompt, PREDICTION_TIMEOUT_MS, signal);
}

async function handleRequest(request: ComposerPredictionRequest, sender: WebContents): Promise<ComposerPredictionResult> {
  const startedAt = Date.now();
  const existing = jobsBySession.get(request.sessionId);
  existing?.controller.abort();

  const controller = new AbortController();
  const cancelOnDestroy = () => controller.abort();
  sender.once("destroyed", cancelOnDestroy);
  if (sender.isDestroyed()) controller.abort();
  const job: PredictionJob = { requestId: request.requestId, sessionId: request.sessionId, controller };
  jobsByRequest.set(request.requestId, job);
  jobsBySession.set(request.sessionId, job);

  try {
    const raw = await retryComposerPrediction(() => executePrediction(request, controller.signal), controller.signal);
    if (controller.signal.aborted) {
      return { requestId: request.requestId, sourceRevision: request.sourceRevision, status: "cancelled", latencyMs: Date.now() - startedAt };
    }
    const text = parseComposerPrediction(raw);
    return {
      requestId: request.requestId,
      sourceRevision: request.sourceRevision,
      status: text ? "available" : "empty",
      ...(text ? { text } : {}),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return { requestId: request.requestId, sourceRevision: request.sourceRevision, status: "cancelled", latencyMs: Date.now() - startedAt };
    }
    reportError("COMPOSER_PREDICTION_ERR", error, { engine: request.engine });
    return { requestId: request.requestId, sourceRevision: request.sourceRevision, status: "failed", latencyMs: Date.now() - startedAt };
  } finally {
    sender.removeListener("destroyed", cancelOnDestroy);
    if (jobsByRequest.get(request.requestId) === job) jobsByRequest.delete(request.requestId);
    if (jobsBySession.get(request.sessionId) === job) jobsBySession.delete(request.sessionId);
  }
}

export function register(): void {
  ipcMain.handle("composer-prediction:request", async (event, value: unknown): Promise<ComposerPredictionResult> => {
    const request = validateRequest(value);
    if (!request) return invalidRequest((value ?? {}) as ComposerPredictionRequest);
    return handleRequest(request, event.sender);
  });

  ipcMain.handle("composer-prediction:cancel", async (_event, requestId: unknown): Promise<ComposerPredictionCancelResult> => {
    if (typeof requestId !== "string") return { ok: false };
    const job = jobsByRequest.get(requestId);
    if (!job) return { ok: true };
    job.controller.abort();
    return { ok: true };
  });
}
