import { HindsightClient, createClient, sdk, type DryRunExtractionResult, type ListDocumentsResponse, type ListMemoryUnitsResponse, type RecallResponse, type RetainResponse } from "@vectorize-io/hindsight-client";
import type { MemoryRecallItem } from "@shared/types/memory";
import { getAppSettings } from "../app-settings";
import { log } from "../logger";
import { ensureMemoryDaemon, getMemoryBaseUrl } from "./daemon";

let client: HindsightClient | null = null;
let rawClient: ReturnType<typeof createClient> | null = null;
let clientBaseUrl = "";
const knownBanks = new Set<string>();
const configuredDefense = new Map<string, string>();

export function resetMemoryClient(): void {
  client = null;
  rawClient = null;
  clientBaseUrl = "";
  knownBanks.clear();
  configuredDefense.clear();
}

export async function getMemoryClient(): Promise<HindsightClient | null> {
  if (!(await ensureMemoryDaemon())) return null;
  const baseUrl = getMemoryBaseUrl();
  if (!client || clientBaseUrl !== baseUrl) {
    client = new HindsightClient({
      baseUrl,
      userAgent: "harnss-memory/0.1",
      maxAttempts: 2,
    });
    clientBaseUrl = baseUrl;
    // Keep the generated SDK's typed `{ data, error }` response shape. The
    // high-level client and low-level endpoints share this transport.
    rawClient = createClient({ baseUrl, throwOnError: true });
  }
  return client;
}

function getRawMemoryClient(): ReturnType<typeof createClient> | null {
  return rawClient;
}

export async function ensureMemoryBank(bankId: string): Promise<boolean> {
  const hindsight = await getMemoryClient();
  if (!hindsight) return false;
  const memoryDefense = getAppSettings().memory.memoryDefense;
  if (knownBanks.has(bankId) && configuredDefense.get(bankId) === memoryDefense) return true;
  try {
    if (!knownBanks.has(bankId)) {
      await hindsight.createBank(bankId, {
        enableObservations: true,
        retainExtractionMode: "concise",
      });
    }
    await hindsight.updateBankConfig(bankId, {
      memoryDefense: memoryDefense === "off"
        ? { enabled: false }
        : {
          enabled: true,
          default_action: memoryDefense,
          rules: [
            { on: "sensitive_data", action: memoryDefense },
            { on: "prompt_injection", action: memoryDefense === "block" ? "block" : "redact" },
          ],
        },
    });
    knownBanks.add(bankId);
    configuredDefense.set(bankId, memoryDefense);
    return true;
  } catch (error) {
    log("MEMORY_BANK_ERR", { bankId, error });
    return false;
  }
}

export async function retainMemory(
  bankId: string,
  content: string,
  options: { documentId: string; tags: string[]; operationId?: string },
): Promise<RetainResponse | null> {
  const hindsight = await getMemoryClient();
  if (!hindsight || !(await ensureMemoryBank(bankId))) return null;
  return hindsight.retain(bankId, content, {
    documentId: options.documentId,
    tags: options.tags,
    async: false,
    operationId: options.operationId,
    updateMode: "replace",
  });
}

export async function recallMemory(
  bankId: string,
  query: string,
  options: { maxTokens: number; budget: "low" | "mid" | "high"; tags: string[] },
): Promise<MemoryRecallItem[]> {
  const hindsight = await getMemoryClient();
  if (!hindsight) throw new Error("Hindsight daemon is not ready");
  if (!(await ensureMemoryBank(bankId))) throw new Error(`Unable to initialize memory bank ${bankId}`);
  const response: RecallResponse = await hindsight.recall(bankId, query, {
    maxTokens: options.maxTokens,
    budget: options.budget,
    tags: options.tags,
    tagsMatch: "any_strict",
    includeSourceFacts: true,
  });
  return response.results
    .map((result) => ({
      text: typeof result.text === "string" ? result.text : "",
      type: typeof result.type === "string" ? result.type : undefined,
      context: result.context,
      documentId: result.document_id,
      tags: result.tags ?? undefined,
      score: result.scores?.final ?? result.scores?.reranker ?? undefined,
      sourceFacts: (result.source_fact_ids ?? []).flatMap((id) => {
        const source = response.source_facts?.[id];
        return source?.text ? [{ id, text: source.text }] : [];
      }),
    }))
    .filter((item) => item.text.length > 0);
}

export async function listMemoryDocuments(bankId: string, limit = 100): Promise<ListDocumentsResponse | null> {
  const hindsight = await getMemoryClient();
  if (!hindsight || !(await ensureMemoryBank(bankId))) return null;
  return hindsight.listDocuments(bankId, { limit });
}

export async function listMemoryUnits(bankId: string, limit = 100): Promise<ListMemoryUnitsResponse | null> {
  const hindsight = await getMemoryClient();
  if (!hindsight || !(await ensureMemoryBank(bankId))) return null;
  return hindsight.listMemories(bankId, { limit, state: "valid" });
}

export async function listMemoryBanks(): Promise<string[]> {
  const hindsight = await getMemoryClient();
  const lowLevel = getRawMemoryClient();
  if (!hindsight || !lowLevel) return [];
  const response = await sdk.listBanks({ client: lowLevel, query: { limit: 200 } });
  return (response.data?.banks ?? []).map((bank) => bank.bank_id);
}

export interface MemoryUpdatePatch {
  text?: string;
  context?: string;
  state?: "valid" | "invalidated";
  reason?: string;
}

export async function updateMemoryUnit(bankId: string, memoryId: string, patch: MemoryUpdatePatch): Promise<boolean> {
  const hindsight = await getMemoryClient();
  const lowLevel = getRawMemoryClient();
  if (!hindsight || !lowLevel || !(await ensureMemoryBank(bankId))) return false;
  try {
    await sdk.updateMemory({
      client: lowLevel,
      path: { bank_id: bankId, memory_id: memoryId },
      body: patch,
    });
    return true;
  } catch (error) {
    log("MEMORY_UNIT_UPDATE_ERR", { bankId, memoryId, error });
    return false;
  }
}

export async function dryRunExtractMemory(bankId: string, content: string, context?: string): Promise<DryRunExtractionResult | null> {
  const hindsight = await getMemoryClient();
  const lowLevel = getRawMemoryClient();
  if (!hindsight || !lowLevel || !(await ensureMemoryBank(bankId))) return null;
  const response = await sdk.dryRunExtractMemories({
    client: lowLevel,
    path: { bank_id: bankId },
    body: { content, context },
  });
  return response.data ?? null;
}

export async function deleteMemoryDocument(bankId: string, documentId: string): Promise<boolean> {
  const hindsight = await getMemoryClient();
  if (!hindsight) return false;
  try {
    await hindsight.deleteDocument(bankId, documentId);
    return true;
  } catch (error) {
    log("MEMORY_DOCUMENT_DELETE_ERR", { bankId, documentId, error });
    return false;
  }
}
