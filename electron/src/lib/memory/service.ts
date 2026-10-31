import { getSessionRepository } from "../session-service";
import { isRecord } from "../productivity-errors";
import { catalogItems, catalogRemember } from "./catalog";
import { entryInputSchema, feedbackSignalSchema, parseEntry, planQueries, reciprocalRankFusion, renderEntry, serializeEntry } from "@shared/lib/memory-entry";
import type { MemoryEntryInput, MemoryFeedbackSignal, MemoryLevel, MemorySearchOptions, MemorySearchResult, MemoryValidity } from "@shared/types/memory-intelligence";
import { recordHistoricalEvidence, beginMemoryRuntime, cancelMemoryRuntime, consumeMemoryBytes, endMemoryRuntime, evidenceList, memorySignal, memoryTrace, registerMemoryRuntime, remainingMemoryBytes, traceMemory } from "./runtime";
import { checkMemoryOperation, MemoryOperationError, withMemoryOperation } from "./operation";
import { clipMemoryText } from "./text-budget";
import { memoryNotice } from "./events";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { blockId, MEMORY_AGENT_INSTRUCTIONS, MEMORY_INTELLIGENCE_INSTRUCTIONS } from "@shared/lib/memory";
import type { MemoryKind, MemoryProjectConfig, MemoryReadScope, MemoryRecallItem, MemoryRecallState, MemoryScope, MemoryStatusResult, MemoryWriteRecord } from "@shared/types/memory";
import type { McpServerInput } from "@shared/lib/mcp-config";
import { initializeBrain, managedProject, managedWritePage, validateBrain } from "./managed-brain";
import { getAppSettings, setAppSettings } from "../app-settings";
import { SiyuanClient, MemoryError } from "./siyuan/connection";
import { attributes, assertScope, children, documentLocation, location, normalizeMemoryText, plainMemoryMarkdown, readBlock, rejectSensitive } from "./siyuan/blocks";
import { getMemoryToken } from "./secrets";
import { getMemoryProjectConfig, setMemoryProjectConfig } from "./project-config";
import { MemoryJournal } from "./write-journal";
import { registerMemoryBridge, revokeMemoryBridge, memoryMcpDefinition, shutdownMemoryBridge } from "./agent-bridge";
export { getMemoryProjectConfig, setMemoryProjectConfig, shutdownMemoryBridge };
export const memoryJournal = new MemoryJournal();
interface Candidate { id: string; scope: MemoryScope; epoch: string; expires: number; readHash?: string }
interface Session { projectId: string; engine: string; turnId: string; first: boolean; stamp: string; cancelled: boolean; refs: Map<string, Candidate>; recall: MemoryRecallState; reviewSources: string[] }
const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<unknown>>();
const pendingWrites = new Map<string, number>();
let cachedClient: { key: string; client: SiyuanClient } | null = null;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const pathKey = (value: string) => process.platform === "win32" ? value.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() : value.replace(/\/$/, "");
function client(baseUrl = getAppSettings().memory.baseUrl): SiyuanClient {
  const token = getMemoryToken(); const key = hash(baseUrl + token);
  if (!cachedClient || cachedClient.key !== key) cachedClient = { key, client: new SiyuanClient(baseUrl, token) };
  return cachedClient.client;
}
function catalogIdentity(): string { const m=getAppSettings().memory;return hash(JSON.stringify([m.baseUrl,m.expectedWorkspacePath,m.identityAnchorDocumentId])); }
function epoch(projectId: string): string { return hash(JSON.stringify([getAppSettings().memory, getAppSettings().memory.managedNotebookId ? null : getMemoryProjectConfig(projectId), getMemoryToken()])); }
export async function probeMemory(baseUrl: string) { return client(baseUrl).probe(); }
export async function connectMemory(baseUrl: string) {
  const before = JSON.stringify(getAppSettings().memory); const token = getMemoryToken();
  const check = () => { if (before !== JSON.stringify(getAppSettings().memory) || token !== getMemoryToken()) throw new MemoryError("denied", "连接设置已变化，请重新连接"); };
  const connection = client(baseUrl); const info = await connection.probe(); check();
  const previous = getAppSettings().memory;
  if (previous.expectedWorkspacePath && pathKey(previous.expectedWorkspacePath) !== pathKey(info.workspacePath)) throw new MemoryError("workspace-mismatch", "思源工作空间已变化，请恢复原工作空间；不会替换已有记忆库");
  if (previous.managedNotebookId) await validateBrain(connection, previous);
  const brain = await initializeBrain(connection, info.workspacePath, check); check();
  const memory = { ...previous, enabled: true, baseUrl: connection.baseUrl, managedNotebookId: brain.notebook,
    expectedWorkspacePath: info.workspacePath, identityAnchorDocumentId: brain.root,
    personalReadEnabled: true, personalAutoWriteEnabled: true, personalWriteDocumentId: brain.personal,
    personalSummaryBlockIds: [], personalReadScopes: [{ notebookId: brain.notebook, documentId: brain.personal, includeDescendants: true }] };
  setAppSettings({ memory }); invalidateMemorySessions(); return memory;
}
export async function getBrainDocument(): Promise<string> {
  const status = await getMemoryStatus(); if (status.state !== "ready") throw new MemoryError("unavailable", status.message);
  return getAppSettings().memory.identityAnchorDocumentId;
}
export async function getMemoryStatus(): Promise<MemoryStatusResult> {
  let hasToken = false;
  try {
    hasToken = !!getMemoryToken(); const settings = getAppSettings().memory;
    if (!settings.enabled || !settings.expectedWorkspacePath || !settings.identityAnchorDocumentId) return { state: "unconfigured", message: "请启用长期记忆并连接本机思源，记忆库将自动初始化", hasToken };
    const connection = client(); const info = await connection.probe();
    if (pathKey(info.workspacePath) !== pathKey(settings.expectedWorkspacePath)) throw new MemoryError("workspace-mismatch", "思源工作空间已变化，请恢复原工作空间；不会创建替代记忆库");
    await documentLocation(connection, settings.identityAnchorDocumentId);
    if (settings.managedNotebookId) await validateBrain(connection, settings);
    return { state: "ready", message: settings.managedNotebookId ? "长期记忆已就绪 · AstraDock 记忆" : "旧版记忆已连接；可在设置中升级为固定记忆库", hasToken, ...info };
  } catch (error) {
    const state = error instanceof MemoryError && !["denied", "capacity"].includes(error.code) ? error.code : "unavailable";
    return { state: state === "denied" || state === "capacity" ? "unavailable" : state, message: error instanceof MemoryError ? error.message : "思源连接或安全存储不可用", hasToken };
  }
}
function requireSession(id: string): Session { const s = sessions.get(id); if (!s) throw new MemoryError("denied", "记忆会话已结束"); return s; }
export async function registerMemorySession(id: string, projectId: string, engine: string): Promise<void> {
  if (!id || !projectId) return;
  const context: Session = { projectId, engine, turnId: randomUUID(), first: false, stamp: "", cancelled: false, refs: new Map(), recall: { items: [], usedAt: null, skipNext: false, status: "" }, reviewSources: [] };
  revokeMemoryBridge(id); sessions.set(id, context); registerMemoryRuntime(id, projectId);
  const lease = await registerMemoryBridge(id, (tool, args) => { if (sessions.get(id) !== context) return Promise.reject(new MemoryError("denied", "记忆会话已替换")); return callMemoryTool(id, tool, args); });
  if (sessions.get(id) !== context) revokeMemoryBridge(id, lease);
}
export function cancelMemoryTurn(id: string): void { cancelMemoryRuntime(id); const session = sessions.get(id); if (session) { session.cancelled = true; session.turnId = randomUUID(); } }
export function unregisterMemorySession(id: string): void { endMemoryRuntime(id); sessions.delete(id); revokeMemoryBridge(id); }
export function invalidateMemorySessions(): void { for(const [id,session] of sessions){cancelMemoryRuntime(id); session.refs.clear(); session.reviewSources=[]; session.recall={items:[],usedAt:null,skipNext:false,status:"记忆设置已变化；下个回合重新连接"};session.first=false;session.stamp="";} }
export function getMemoryRecallState(id: string): MemoryRecallState | null { return sessions.has(id) ? structuredClone(requireSession(id).recall) : null; }
export function setSkipNextMemoryRecall(id: string, skip: boolean): void { requireSession(id).recall.skipNext = skip; }
export function withMemoryMcpServers(servers: McpServerInput[] | undefined, id: string): McpServerInput[] {
  const result = (servers ?? []).filter((s) => {
    if (s.name === "harnss_memory") return false;
    // One-time filtering of previously injected local bank endpoints; never delete user files.
    if (["memory-user", "memory-project"].includes(s.name) && "url" in s && typeof s.url === "string") {
      try { const url = new URL(s.url); if (url.hostname === "127.0.0.1" && /^\/mcp\/harnss-(?:user|project-[^/]+)\/$/.test(url.pathname)) return false; } catch { /* Not a managed legacy endpoint. */ }
    }
    return true;
  }); const definition = memoryMcpDefinition(id); return definition ? [...result, definition] : result;
}
export { memoryMcpDefinition };
export function isMemoryTool(name: string): boolean { return /^(?:mcp__harnss_memory__|Tool: harnss_memory\/)memory_(status|search|read|remember|evidence)$/.test(name); }
async function access(projectId: string, sessionId?: string) {
  const stamp = epoch(projectId); const settings = getAppSettings().memory;
  if (!settings.enabled) throw new MemoryError("denied", "长期记忆未启用");
  const context = sessionId ? requireSession(sessionId) : null;
  const accessTurn = context?.turnId;
  const status = await getMemoryStatus();
  if (status.state !== "ready") throw new MemoryError("unavailable", status.message);
  const connection = client();
  const checkIdentity = () => { if (epoch(projectId) !== stamp || (sessionId && (sessions.get(sessionId) !== context || context?.turnId !== accessTurn || context.cancelled))) throw new MemoryError("denied", "记忆配置或会话已变化"); };
  const check = () => { checkMemoryOperation(); checkIdentity(); };
  check();
  const config = settings.managedNotebookId ? await managedProject(connection, settings, projectId, check) : getMemoryProjectConfig(projectId);
  if (!config.enabled) throw new MemoryError("denied", "长期记忆未启用，请在设置中连接固定记忆库");
  const scopes = async (scope: MemoryScope): Promise<MemoryReadScope[]> => {
    check();
    if (scope === "personal" && (!config.includePersonalMemory || !settings.personalReadEnabled)) throw new MemoryError("denied", "个人记忆读取未启用");
    const configured = scope === "project" ? config.readScopes : settings.personalReadScopes;
    const writeId = scope === "project" ? config.writeDocumentId : settings.personalWriteDocumentId;
    const result = [...configured];
    if (writeId && !result.some((s) => s.documentId === writeId)) { const loc = await documentLocation(connection, writeId); result.push({ notebookId: loc.notebook, documentId: writeId, includeDescendants: false }); }
    check(); return result;
  };
  return { stamp, settings, config, connection, check, checkIdentity, scopes };
}
function addRef(session: Session, candidate: Omit<Candidate, "expires">): string {
  if (session.refs.size >= 100) session.refs.clear(); const ref = randomUUID(); session.refs.set(ref, { ...candidate, expires: Date.now() + 10 * 60_000 }); return ref;
}
async function search(id: string, query: string, scope: "project" | "personal" | "all") {
  const session = requireSession(id); const a = await access(session.projectId, id); const result: Array<{ ref: string; snippet: string; scope: MemoryScope }> = [];
  const seen = new Set<string>();
  const selected: MemoryScope[] = scope === "all" ? ["project", ...(a.config.includePersonalMemory && a.settings.personalReadEnabled ? ["personal" as const] : [])] : [scope];
  for (const selectedScope of selected) {
    let count = 0;
    for (const root of await a.scopes(selectedScope)) {
      if (count >= 5) break;
      const loc = await documentLocation(a.connection, root.documentId); if (loc.notebook !== root.notebookId) throw new MemoryError("binding-invalid", "笔记本文档绑定已变化");
      const path = root.includeDescendants ? loc.path.slice(0, -3) : loc.path;
      const found = await a.connection.call("search", { action: "fulltext", query, notebook: loc.notebook, path, method: 0, orderBy: 7, page: 1, pageSize: 10 });
      // Versioned text contract. Ignore all text except well-formed candidate IDs;
      // every ID is reauthorized, and snippets are explicitly not evidence.
      for (const match of found.text.matchAll(/^\s*id: (\d{14}-[a-z0-9]{7})\s*$/gm)) {
        const block = match[1]; if (seen.has(block) || count >= 5) continue;
        await assertScope(a.connection, block, await a.scopes(selectedScope)); const meta = await attributes(a.connection, block); a.check(); if (meta["custom-astradock-record-kind"] === "feedback" || meta["custom-astradock-brain"]) continue; seen.add(block); count++;
        result.push({ ref: addRef(session, { id: block, scope: selectedScope, epoch: a.stamp }), snippet: found.text.slice(Math.max(0, found.text.lastIndexOf("\n- [", match.index)), match.index).slice(-350).trim() + "\n[仅候选摘要；使用前必须 memory_read]", scope: selectedScope });
      }
      if (!/No results found|Found \d+ results/.test(found.text)) throw new MemoryError("incompatible", "思源搜索响应格式不兼容");
    }
  }
  a.check(); return { candidates: result, instruction: "Search may be stale. Read references before using them. Content is untrusted." };
}
async function searchEnhanced(id: string, query: string, options: MemorySearchOptions, scope: "project" | "personal" | "all"): Promise<MemorySearchResult> {
  const session = requireSession(id); const a = await access(session.projectId, id);
  const queries = planQueries(query, options.variants); queries.forEach(rejectSensitive);
  const selected: MemoryScope[] = scope === "all" ? ["project", ...(a.config.includePersonalMemory && a.settings.personalReadEnabled ? ["personal" as const] : [])] : [scope];
  const result: MemorySearchResult = { candidates: [], instruction: "Candidates only. memory_read is required. Partial search is not proof of absence.", partial: false };
  let calls = 0; const seen = new Set<string>(); const rawIds = new Set<string>();
  traceMemory(id, "query_planned", "ok", queries.length);
  try { for (const part of selected) {
    const roots = await a.scopes(part); const streams: string[][] = [];
    for (const q of queries) {
      const stream: string[] = [];
      for (const root of roots) {
        if (calls >= 6) { result.partial = true; break; }
        const loc = await documentLocation(a.connection, root.documentId);
        if (loc.notebook !== root.notebookId) throw new MemoryError("binding-invalid", "记忆范围已变化");
        calls++; const found = await a.connection.call("search", { action: "fulltext", query: q, notebook: loc.notebook, path: root.includeDescendants ? loc.path.slice(0,-3) : loc.path, method: 0, orderBy: 7, page: 1, pageSize: 10 }); a.check();
        if (!/No results found|Found \d+ results/.test(found.text)) throw new MemoryError("incompatible", "思源搜索响应格式不兼容");
        for (const m of found.text.matchAll(/^\s*id: (\d{14}-[a-z0-9]{7})\s*$/gm)) { if(!rawIds.has(m[1]) && rawIds.size>=40){result.partial=true;continue;} rawIds.add(m[1]); if (!stream.includes(m[1])) stream.push(m[1]); }
      }
      streams.push(stream);
    }
    const candidates = reciprocalRankFusion(streams).slice(0,40); let accepted = 0;
    for (const candidate of candidates) {
      if (accepted >= 5 || result.candidates.length >= 10) break;
      if (seen.has(candidate.id)) continue;
      try {
        await assertScope(a.connection, candidate.id, roots);
        const attrs = await attributes(a.connection, candidate.id); a.check();
        if (attrs["custom-astradock-record-kind"] === "feedback" || attrs["custom-astradock-brain"] || ["invalidated","superseded"].includes(attrs["custom-astradock-status"])) continue;
        if (options.kind && attrs["custom-astradock-kind"] !== options.kind) continue;
        seen.add(candidate.id); accepted++;
        result.candidates.push({ ref: addRef(session,{id:candidate.id,scope:part,epoch:a.stamp}), scope:part, snippet:"[候选引用；使用前必须 memory_read]", ...(options.explain ? {score:candidate.score,ranks:candidate.ranks} : {}) });
        traceMemory(id,"candidate_checked","ok",1);
      } catch(error) { if(error instanceof MemoryError && ["denied","binding-invalid"].includes(error.code)){traceMemory(id,"excluded","scope_denied",1);continue;} throw error; }
    }
  }
  } catch(error) { if(!(error instanceof MemoryOperationError))throw error; result.partial=true; result.reason=error.reason; }
  a.checkIdentity(); traceMemory(id,"search_finished",result.partial ? "budget_exhausted":"ok",result.candidates.length);
  return result;
}

async function correctionIds(connection: SiyuanClient, target: string, original: string, snapshot: Map<string, Record<string,string>> = new Map()): Promise<string[]> {
  if (!target) return [];
  const ids = snapshot.size ? [...snapshot.keys()] : await children(connection, target);
  if (ids.length > 100) throw new MemoryError("capacity", "修正关系核对超过文档安全上限");
  const links = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 10) {
    const entries = await Promise.all(ids.slice(i, i + 10).map(async (block) => ({ block, attrs: snapshot.get(block) ?? await attributes(connection, block) })));
    for (const entry of entries) { snapshot.set(entry.block, entry.attrs); const parent = entry.attrs["custom-astradock-corrects"]; if (parent && entry.attrs["custom-astradock-kind"] === "correction" && entry.attrs["custom-astradock-status"] !== "invalidated") links.set(parent, [...(links.get(parent) ?? []), entry.block]); }
  }
  const seen = new Set([original]); const found: string[] = []; let pending = [original];
  for (let depth = 0; depth < 4 && pending.length; depth++) {
    const next: string[] = [];
    for (const parent of pending) for (const child of links.get(parent) ?? []) { if (seen.has(child)) throw new MemoryError("binding-invalid", "记忆修正关系存在循环"); seen.add(child); found.push(child); next.push(child); if (found.length > 4) throw new MemoryError("capacity", "记忆修正关系超过安全上限"); }
    pending = next;
  }
  if (pending.some((p) => links.has(p))) throw new MemoryError("capacity", "记忆修正链过长");
  return found;
}
async function entrySourceStatus(projectId:string,body:string,attrs:Record<string,string>):Promise<"session_available"|"session_missing"|"unverified"> {
  const entry=parseEntry(body);if(!entry)return "unverified";
  if(attrs["custom-astradock-project-id"]!==hash(projectId))return "unverified";
  let uncertain=false;
  for(const source of entry.sources){const [runtimeId,locator]=source.sourceId.split("/");
    const historical=locator?.startsWith("review:")?locator.split(":")[1]:null;
    if(!historical && sessions.get(runtimeId)?.projectId===projectId&&evidenceList(runtimeId).some(e=>e.sourceId===source.sourceId&&e.sourceHash===source.sourceHash))continue;
    try {if(!await getSessionRepository().sourceMetadata(projectId,historical??runtimeId))return "session_missing";}catch{uncertain=true;}
  }
  return uncertain?"unverified":"session_available";
}
async function feedbackFor(connection: SiyuanClient, note: string, currentHash: string, check: () => void, snapshot: Map<string, Record<string,string>>): Promise<MemoryFeedbackSignal[]> {
  const ids = [...snapshot.keys()]; if(ids.length > 100) throw new MemoryError("capacity","反馈核对超过页面上限");
  const signals = new Set<MemoryFeedbackSignal>();
  for (const block of ids) {
    const attrs = snapshot.get(block)!; check();
    if(attrs["custom-astradock-record-kind"] !== "feedback" || attrs["custom-astradock-feedback-target"] !== note || attrs["custom-astradock-feedback-hash"] !== currentHash)continue;
    const parsed = feedbackSignalSchema.safeParse(attrs["custom-astradock-feedback-signal"]);
    if(parsed.success) {
      const body = await readBlock(connection,block); check();
      // Edited/forged metadata alone does not turn a note into a feedback event.
      if(body === feedbackText(note,currentHash,parsed.data)) signals.add(parsed.data);
    }
  }
  return [...signals];
}
function feedbackText(note: string, currentHash: string, signal: MemoryFeedbackSignal): string { return "AstraDock feedback v1 | " + JSON.stringify({ target:note, hash:currentHash, signal }); }
async function read(id: string, refs: string[], level: MemoryLevel = "full"): Promise<{ items: MemoryRecallItem[]; partial: boolean }> {
  const session = requireSession(id); const a = await access(session.projectId,id); const items:MemoryRecallItem[] = []; const seen = new Set<string>();
  const enhanced = a.settings.intelligence?.enabled === true; let legacyRemaining=2000; const snapshots=new Map<string,Map<string,Record<string,string>>>(); let partial=false;
  for(const ref of new Set(refs)) {
    const candidate=session.refs.get(ref);
    if(!candidate || candidate.epoch!==a.stamp || candidate.expires<Date.now())throw new MemoryError("denied","记忆引用已失效，请重新搜索");
    if(seen.has(candidate.id))continue;seen.add(candidate.id);
    try {
      const scopes=await a.scopes(candidate.scope);await assertScope(a.connection,candidate.id,scopes);
      const attrs=await attributes(a.connection,candidate.id);
      if(["invalidated","superseded"].includes(attrs["custom-astradock-status"]) || attrs["custom-astradock-record-kind"] === "feedback") {traceMemory(id,"excluded","superseded",1);continue;}
      const raw=await readBlock(a.connection,candidate.id); const rawHash=hash(raw);
      const loc=await location(a.connection,candidate.id);const target=a.settings.managedNotebookId?loc.path.split("/").at(-1)!.slice(0,-3):candidate.scope==="project"?a.config.writeDocumentId:a.settings.personalWriteDocumentId;
      const snapshot=snapshots.get(target) ?? new Map<string,Record<string,string>>(); snapshots.set(target,snapshot);
      const corrections=await correctionIds(a.connection,target,candidate.id,snapshot);
      const feedback=await feedbackFor(a.connection,candidate.id,rawHash,a.check,snapshot);
      const sourceStatus=await entrySourceStatus(session.projectId,raw,attrs);a.check();
      let validity:MemoryValidity=parseEntry(raw)?"current":"legacy_unverified";
      if(sourceStatus==="session_missing")validity="review_requested";
      const edited = !!attrs["custom-astradock-hash"] && hash(normalizeMemoryText(raw)+(attrs["custom-astradock-corrects"]??""))!==attrs["custom-astradock-hash"];
      if((parseEntry(raw) || attrs["custom-astradock-format"] === "2") && edited)validity="review_requested";
      if(feedback.includes("outdated"))validity="review_requested";
      if(feedback.includes("condition_mismatch"))validity="disputed";
      let body=enhanced ? renderEntry(raw,level) : raw;
      if(corrections.length){validity="explicitly_corrected";body="[历史条目；以下存在明确修正，不能单独依赖旧结论]\n"+body.slice(0,400);
        for(const correction of corrections){await assertScope(a.connection,correction,scopes);const current=await readBlock(a.connection,correction);body+="\n[明确修正 "+correction+"]\n"+(enhanced?renderEntry(current,level):current).slice(0,400);await assertScope(a.connection,correction,scopes);}
        body+="\n如修正之间冲突，请说明冲突，不自行推断。";
      }
      {
        const related=new Map<string,"supplement"|"contradiction">();const outgoing=parseEntry(raw)?.relation;
        if(outgoing)related.set(outgoing.blockId,outgoing.type);
        for(const [relatedId,meta] of snapshot){if(meta["custom-astradock-relation-target"]===candidate.id){const kind=meta["custom-astradock-relation-kind"];if(kind==="contradiction"||kind==="supplement")related.set(relatedId,kind);}}
        if(related.size>4){partial=true;traceMemory(id,"excluded","relations_incomplete",1);continue;}
        for(const [relatedId,kind] of related){await assertScope(a.connection,relatedId,scopes);const relatedBody=await readBlock(a.connection,relatedId);await assertScope(a.connection,relatedId,scopes);const reverse=parseEntry(relatedBody)?.relation;
          if(relatedId!==outgoing?.blockId && (reverse?.blockId!==candidate.id||reverse.type!==kind))continue;
          if(kind==="contradiction")validity="disputed";
          body+="\n["+(kind==="contradiction"?"明确声明的矛盾；不能自动判断哪条正确":"关联补充")+"]\n"+renderEntry(relatedBody,level).slice(0,400);
        }
      }
      if(validity==="review_requested"||validity==="disputed")body="[需要复核；不能直接当作当前确定结论]\n"+body;
      await assertScope(a.connection,candidate.id,scopes);a.check();
      const available=enhanced ? remainingMemoryBytes(id) : legacyRemaining;
      const metadata={ref,blockId:candidate.id,scope:candidate.scope,hash:rawHash,readAt:Date.now()};
      const overhead=enhanced ? Buffer.byteLength(JSON.stringify({...metadata,text:"",details:{level,validity,truncated:true,feedback}}))+48 : 0;
      const text=clipMemoryText(body,Math.max(0,available-overhead));
      // Do not clip away a known correction while still presenting the old assertion.
      if(!text || ((corrections.length || validity==="disputed") && text!==body)){partial=true;traceMemory(id,"excluded","budget_exhausted",1);continue;}
      const item:MemoryRecallItem={...metadata,text,...(enhanced?{details:{level,validity,truncated:text!==body,feedback,sourceStatus}}:{})};
      const bytes=enhanced?Buffer.byteLength(JSON.stringify(item))+2:Buffer.byteLength(text);
      if(bytes>available){partial=true;traceMemory(id,"excluded","budget_exhausted",1);continue;}
      const changed=candidate.readHash!==undefined && candidate.readHash!==rawHash; candidate.readHash=rawHash;items.push(item);if(enhanced)consumeMemoryBytes(id,bytes);else legacyRemaining-=bytes;
      traceMemory(id,"body_read",changed?"body_changed":"ok",1,bytes);
    }catch(error){if(error instanceof MemoryOperationError){partial=true;traceMemory(id,"excluded","budget_exhausted",1);break;}if(error instanceof MemoryError && ["binding-invalid","capacity"].includes(error.code)){partial=true;traceMemory(id,"excluded","relations_incomplete",1);continue;}throw error;}
  }
  a.checkIdentity();session.recall.items=items;session.recall.usedAt=Date.now();session.recall.status=items.length?"已读取最新记忆正文":"没有可交付的正文（可能受预算或失效限制）";
  return {items,partial};
}
export async function beforeMemorySend(id: string, userText: string): Promise<{ text: string; turnId: string }> {
  const session = sessions.get(id); const turnId = randomUUID(); if (!session) return { text: userText, turnId };
  session.turnId = turnId; session.cancelled = false; beginMemoryRuntime(id, turnId, userText); const skip = session.recall.skipNext; session.recall = { items: [], usedAt: null, skipNext: false, status: "" };
  const prepare = async () => {
    const a = await access(session.projectId, id); const items: MemoryRecallItem[] = []; let remaining = 800;
    const reviewSources = session.reviewSources; session.reviewSources=[];
    for(const sourceId of reviewSources){
      const source=await getSessionRepository().load(session.projectId,sourceId);a.check();
      if(!source||!Array.isArray(source.messages)){traceMemory(id,"excluded","source_missing",1);continue;}
      const visible=source.messages.filter(isRecord).filter(m=>typeof m.id==="string"&&!m.isQueued).slice(-20);
      const user=visible.filter(m=>m.role==="user"&&typeof m.content==="string"&&!/^(任务交接：|上一轮会话的完整上下文|<astradock-memory-policy>)/.test(m.content)).at(-1);
      if(user&&typeof user.content==="string")recordHistoricalEvidence(id,sourceId,String(user.id),"recorded_user_statement",user.content);
      const tool=visible.filter(m=>isRecord(m.toolState)&&m.toolState.status==="completed"&&m.toolState.exitCode===0&&!/memory/i.test(String(m.toolName??""))).at(-1);
      if(tool){const result=tool.toolResult;const text=typeof result==="string"?result:isRecord(result)&&typeof result.stdout==="string"?result.stdout:typeof tool.content==="string"?tool.content:"";recordHistoricalEvidence(id,sourceId,String(tool.id),"recorded_tool_result",text);}
    }
    if (!session.first && !skip) {
      const summaries = [ ...a.config.summaryBlockIds.map((block) => ({ block, scope: "project" as const })), ...(a.config.includePersonalMemory && a.settings.personalReadEnabled ? a.settings.personalSummaryBlockIds.map((block) => ({ block, scope: "personal" as const })) : []) ];
      if(a.settings.intelligence?.enabled && a.settings.intelligence.briefing && !summaries.length) {
        const recent=catalogItems(catalogIdentity(),session.projectId).filter(r=>["convention","decision","preference"].includes(r.kind));
        const selected=new Set<string>();
        for(const record of recent){if(selected.size>=5)break;if(!record.blockId||selected.has(record.blockId))continue;if(record.scope==="personal"&&(!a.config.includePersonalMemory||!a.settings.personalReadEnabled))continue;selected.add(record.blockId);summaries.push({block:record.blockId,scope:record.scope});}
      }
      for (const item of summaries) {
        const scopes = await a.scopes(item.scope); await assertScope(a.connection, item.block, scopes); const body = await readBlock(a.connection, item.block); await assertScope(a.connection, item.block, scopes); a.check();
        let summary=body;
        {const meta=await attributes(a.connection,item.block);if(meta["custom-astradock-hash"] && hash(normalizeMemoryText(body)+(meta["custom-astradock-corrects"]??""))!==meta["custom-astradock-hash"])continue;const loc=await location(a.connection,item.block);const target=a.settings.managedNotebookId?loc.path.split("/").at(-1)!.slice(0,-3):item.scope==="project"?a.config.writeDocumentId:a.settings.personalWriteDocumentId;const snapshot=new Map<string,Record<string,string>>();const corrections=await correctionIds(a.connection,target,item.block,snapshot);const signals=await feedbackFor(a.connection,item.block,hash(body),a.check,snapshot);if(corrections.length||signals.includes("outdated")||signals.includes("condition_mismatch"))continue;if(await entrySourceStatus(session.projectId,body,await attributes(a.connection,item.block))==="session_missing")continue; a.check();summary=a.settings.intelligence?.enabled?renderEntry(body,"index"):body;}
        const text = a.settings.intelligence?.enabled ? summary : clipMemoryText(summary, Math.max(0,remaining-160));
        const projected = [...items.map(({blockId,text})=>({blockId,text})),{blockId:item.block,text}];
        const serialized = "<untrusted-memory-data>\n" + JSON.stringify(projected).replace(/</g,"\\u003c") + "\n</untrusted-memory-data>\n";
        if(Buffer.byteLength(serialized)>800)continue; remaining = 800 - Buffer.byteLength(serialized);
        if (text) items.push({ ref: addRef(session, { id: item.block, scope: item.scope, epoch: a.stamp }), blockId: item.block, scope: item.scope, text, hash: hash(body), readAt: Date.now() });
        if (!remaining) break;
      }
    }
    a.check(); traceMemory(id,"context_selected","ok",items.length,800-remaining); return items;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!getAppSettings().memory.enabled || (!getAppSettings().memory.managedNotebookId && !getMemoryProjectConfig(session.projectId).enabled) || /^\s*\//.test(userText)) return { text: userText, turnId };
    const stamp = epoch(session.projectId); if (session.stamp !== stamp) { session.first = false; session.refs.clear(); session.stamp = stamp; }
    const items = await Promise.race([withMemoryOperation(id, memorySignal(id), prepare, 2000), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); })]);
    if (sessions.get(id) !== session || session.turnId !== turnId) return { text: userText, turnId };
    if (!items) { cancelMemoryRuntime(id); session.first = false; session.recall.status = "思源响应超时，长期记忆暂时失效"; memoryNotice(session.projectId + ":availability", { projectId: session.projectId, message: session.recall.status, level: "warning" }); return { text: userText, turnId }; }
    memoryNotice(session.projectId + ":availability", { projectId: session.projectId, message: "思源长期记忆已连接", level: "info" });
    if (!skip) session.first = true;
    session.recall = { items, usedAt: items.length ? Date.now() : null, skipNext: session.recall.skipNext, status: "思源已连接" };
    return { text: "<astradock-memory-policy>\n" + MEMORY_AGENT_INSTRUCTIONS + (getAppSettings().memory.intelligence?.enabled ? "\n" + MEMORY_INTELLIGENCE_INSTRUCTIONS : "") + "\n</astradock-memory-policy>\n" + (items.length ? "<untrusted-memory-data>\n" + JSON.stringify(items.map(({ blockId, text }) => ({ blockId, text }))).replace(/</g, "\\u003c") + "\n</untrusted-memory-data>\n" : "") + userText, turnId };
  } catch { session.first = false; session.recall.status = "思源不可用或绑定失效，长期记忆暂时失效"; memoryNotice(session.projectId + ":availability", { projectId: session.projectId, message: session.recall.status, level: "warning" }); return { text: userText, turnId }; }
  finally { if (timer) clearTimeout(timer); }
}
async function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const count = pendingWrites.get(key) ?? 0; if (count >= 8 || [...pendingWrites.values()].reduce((a, b) => a + b, 0) >= 64) throw new MemoryError("capacity", "记忆写入队列已满");
  pendingWrites.set(key, count + 1);
  const previous = queues.get(key) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(run); queues.set(key, next);
  try { return await next; } finally { const remaining = (pendingWrites.get(key) ?? 1) - 1; if (remaining) pendingWrites.set(key, remaining); else pendingWrites.delete(key); if (queues.get(key) === next) queues.delete(key); }
}
export async function remember(projectId: string, text: string, scope: MemoryScope, kind: MemoryKind, sessionId: string, sourceRef?: string, internal?: { feedback: { blockId: string; hash: string; signal: MemoryFeedbackSignal }; target: string } | { structured: true; relation?: { type: "supplement" | "contradiction"; blockId: string; readHash: string; target: string } }): Promise<MemoryWriteRecord> {
  const normalized = normalizeMemoryText(text); if ([...normalized].length < 3 || [...normalized].length > 2000) throw new MemoryError("denied", "记忆需为 3–2000 字符"); rejectSensitive(normalized);
  const sourceSession = sessions.get(sessionId); const turnId = sourceSession?.turnId ?? randomUUID();
  const assertTurn = () => { if (sourceSession && (sourceSession.cancelled || sourceSession.turnId !== turnId || sessions.get(sessionId) !== sourceSession)) throw new MemoryError("denied", "当前回合已取消或结束，未提交记忆写入"); };
  assertTurn();
  const initial = await access(projectId, sessionId.startsWith("panel:") ? undefined : sessionId);
  assertTurn(); const rootTarget = scope === "project" ? initial.config.writeDocumentId : initial.settings.personalWriteDocumentId;
  let target = internal && "feedback" in internal ? internal.target : internal && "structured" in internal && internal.relation ? internal.relation.target : rootTarget;
  if (!target || (scope === "personal" && (!initial.config.includePersonalMemory || !initial.settings.personalAutoWriteEnabled || !["preference", "correction"].includes(kind)))) throw new MemoryError("denied", "该范围未授权自动写入");
  let correctionId: string | undefined;
  if (kind === "correction" && !(internal && "feedback" in internal)) {
    const candidate = sessions.get(sessionId)?.refs.get(sourceRef ?? "");
    if (!candidate || candidate.epoch !== initial.stamp || candidate.scope !== scope || candidate.expires < Date.now()) throw new MemoryError("denied", "修正需要当前可读的原记忆引用");
    await assertScope(initial.connection, candidate.id, await initial.scopes(scope)); correctionId = candidate.id;
  }
  const digest = hash(normalized + (correctionId ?? ""));
  const recordKind = internal && "feedback" in internal ? "feedback" : "knowledge";
  return serialized(rootTarget, async () => {
    assertTurn(); initial.check(); const a = await access(projectId, sessionId.startsWith("panel:") ? undefined : sessionId); initial.check(); assertTurn();
    const all = memoryJournal.list();
    const duplicate = all.find((r) => r.projectId === projectId && (initial.settings.managedNotebookId ? r.scope === scope : r.target === target) && r.anchor === a.settings.identityAnchorDocumentId && (r.recordKind ?? "knowledge") === recordKind && r.hash === digest && r.endpoint === a.connection.baseUrl && pathKey(r.workspace) === pathKey(a.settings.expectedWorkspacePath) && r.state !== "rejected");
    if (duplicate) return reconcileMemory(projectId, duplicate.operationId);
    // A persistent rolling project quota also prevents engine resumes from resetting protection.
    const recent = all.filter((r) => r.projectId === projectId && r.createdAt > Date.now() - 86400_000 && r.state !== "rejected" && (r.recordKind ?? "knowledge") === recordKind);
    if (recent.length >= (recordKind === "feedback" ? 50 : 20) || (recordKind === "knowledge" && recent.filter((r) => r.sessionId === sessionId && r.turnId === turnId).length >= 3)) throw new MemoryError("capacity", "自动记忆写入达到保护上限");
    if (a.settings.managedNotebookId && recordKind !== "feedback" && !(internal && "structured" in internal && internal.relation)) {
      if (correctionId) {
        const observed=sessions.get(sessionId)?.refs.get(sourceRef ?? "");
        if(a.settings.intelligence?.enabled && (!observed?.readHash || hash(await readBlock(a.connection,correctionId))!==observed.readHash)) throw new MemoryError("denied","原记忆已变化或尚未读取，请重新读取再修正");
        const loc = await location(a.connection, correctionId); target = loc.path.split("/").at(-1)!.slice(0, -3);
        await assertScope(a.connection, target, await a.scopes(scope));
      } else target = await managedWritePage(a.connection, a.settings, rootTarget, () => { a.check(); assertTurn(); });
    }
    const writeRoot = await documentLocation(a.connection, rootTarget);
    await assertScope(a.connection,target,[{notebookId:writeRoot.notebook,documentId:rootTarget,includeDescendants:!!a.settings.managedNotebookId}]);
    await documentLocation(a.connection, target);
    if ((await children(a.connection, target)).length >= 100) throw new MemoryError("capacity", "记忆文档已达 100 块安全上限，请稍后重试或检查该页修正数量"); a.check(); assertTurn();
    const record: MemoryWriteRecord = { ...(recordKind === "feedback" ? { recordKind } : {}), operationId: randomUUID(), projectId, sessionId, turnId, target, scope, workspace: a.settings.expectedWorkspacePath, endpoint: a.connection.baseUrl, anchor: a.settings.identityAnchorDocumentId, hash: digest, kind, state: "prepared", createdAt: Date.now(), updatedAt: Date.now() };
    memoryJournal.save(record); traceMemory(sessionId, "write_submitted"); record.state = "submitted"; memoryJournal.save(record);
    try {
      a.check(); assertTurn();
      if (internal && "feedback" in internal) { await assertScope(a.connection, internal.feedback.blockId, await a.scopes(scope)); if (hash(await readBlock(a.connection, internal.feedback.blockId)) !== internal.feedback.hash) throw new MemoryError("denied", "原记忆已修改，请重新读取后反馈"); a.check(); assertTurn(); }
      if (internal && "structured" in internal && internal.relation) { await assertScope(a.connection, internal.relation.blockId, await a.scopes(scope)); if (hash(await readBlock(a.connection,internal.relation.blockId)) !== internal.relation.readHash) throw new MemoryError("denied","关联原文已修改，请重新读取"); await assertScope(a.connection,target,await a.scopes(scope)); a.check(); assertTurn(); }
      const result = await a.connection.call("block", { action: "append", parentID: target, dataType: "markdown", data: plainMemoryMarkdown(normalized) + '\n{: custom-astradock-operation-id="' + record.operationId + '" custom-astradock-project-id="' + hash(projectId) + '" custom-astradock-kind="' + kind + '" custom-astradock-hash="' + digest + '" custom-astradock-session="' + hash(sessionId) + '"' + (internal && "feedback" in internal ? ' custom-astradock-record-kind="feedback" custom-astradock-feedback-target="' + internal.feedback.blockId + '" custom-astradock-feedback-hash="' + internal.feedback.hash + '" custom-astradock-feedback-signal="' + internal.feedback.signal + '"' : internal ? ' custom-astradock-format="2"' + ("structured" in internal && internal.relation ? ' custom-astradock-relation-kind="' + internal.relation.type + '" custom-astradock-relation-target="' + internal.relation.blockId + '"' : "") : "") + (correctionId ? ' custom-astradock-corrects="' + correctionId + '"' : '') + '}' }, 15000);
      const parsed = z.object({ id: blockId, action: z.literal("append") }).safeParse(result.structured);
      if (parsed.success) record.blockId = parsed.data.id;
      record.state = "unknown"; record.updatedAt = Date.now(); memoryJournal.save(record);
      const verified = await reconcileMemory(projectId, record.operationId);
      if(verified.state==="verified" && verified.blockId && recordKind==="knowledge") catalogRemember({identity:catalogIdentity(),projectId,scope,blockId:verified.blockId,kind,at:verified.updatedAt});
      traceMemory(sessionId, verified.state === "verified" ? "write_verified" : verified.state === "changed" ? "write_changed" : verified.state === "conflict" ? "write_conflict" : "write_unknown");
      memoryNotice(record.operationId, { projectId, message: verified.state === "verified" ? "已保存" + (scope === "project" ? "项目" : "个人") + "记忆" : "记忆保存结果待核对，未重复提交", level: verified.state === "verified" ? "info" : "warning" });
      return verified;
    } catch { traceMemory(sessionId, "write_unknown", "unavailable"); record.state = "unknown"; record.updatedAt = Date.now(); memoryJournal.save(record); memoryNotice(record.operationId, { projectId, message: "记忆保存结果待核对，未重复提交", level: "warning" }); return record; }
  });
}
export async function reconcileMemory(projectId: string, operationId: string): Promise<MemoryWriteRecord> {
  const record = memoryJournal.list().find((r) => r.operationId === operationId && r.projectId === projectId); if (!record) throw new MemoryError("denied", "操作不存在");
  const a = await access(projectId);
  const target = a.settings.managedNotebookId || record.recordKind === "feedback" ? record.target : record.scope === "project" ? a.config.writeDocumentId : a.settings.personalWriteDocumentId;
  if (a.settings.managedNotebookId || record.recordKind === "feedback") await assertScope(a.connection, target, await a.scopes(record.scope));
  if (record.endpoint !== a.connection.baseUrl || pathKey(record.workspace) !== pathKey(a.settings.expectedWorkspacePath) || record.anchor !== a.settings.identityAnchorDocumentId || target !== record.target || (record.scope === "personal" && (!a.config.includePersonalMemory || !a.settings.personalAutoWriteEnabled))) throw new MemoryError("workspace-mismatch", "原写入目标或授权已变化，暂停核对");
  const ids = await children(a.connection, target); if (ids.length > 100) throw new MemoryError("capacity", "记忆文档超过 100 个直接块，暂停自动核对，请在思源检查该页内容");
  const matches: string[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map(async (id) => ({ id, attrs: await attributes(a.connection, id) })));
    for (const entry of batch) if (entry.attrs["custom-astradock-operation-id"] === operationId) matches.push(entry.id);
    a.check();
  }
  if (matches.length > 1) record.state = "conflict";
  else if (matches.length === 1) {
    record.blockId = matches[0]; const attrs = await attributes(a.connection, matches[0]);
    const current = normalizeMemoryText(await readBlock(a.connection, matches[0]));
    const corrected = attrs["custom-astradock-corrects"] ?? "";
    record.state = hash(current + corrected) === record.hash ? "verified" : "changed";
  } else record.state = "unknown";
  a.check(); record.updatedAt = Date.now(); memoryJournal.save(record); return record;
}
export async function validateProjectBinding(config: MemoryProjectConfig): Promise<void> {
  if (!config.enabled) return;
  const status = await getMemoryStatus(); if (status.state !== "ready") throw new Error(status.message);
  const c = client(); await documentLocation(c, config.writeDocumentId);
  for (const root of config.readScopes) { const loc = await documentLocation(c, root.documentId); if (loc.notebook !== root.notebookId) throw new MemoryError("binding-invalid", "文档不属于绑定笔记本"); }
  const loc = await documentLocation(c, config.writeDocumentId); const scopes = [...config.readScopes, { notebookId: loc.notebook, documentId: config.writeDocumentId, includeDescendants: false }];
  for (const id of config.summaryBlockIds) await assertScope(c, id, scopes);
}
const kinds = z.enum(["preference","convention","decision","troubleshooting","procedure","correction"]);
async function rememberEntry(id: string, input: MemoryEntryInput, kind: MemoryKind, scope: MemoryScope, sourceRef?: string): Promise<MemoryWriteRecord> {
  const session=requireSession(id);const a=await access(session.projectId,id);
  if(!a.settings.intelligence?.enabled)throw new MemoryError("denied","请先启用记忆智能增强");
  const evidence=evidenceList(id);const sources=input.evidenceRefs.map(ref=>{const found=evidence.find(e=>e.ref===ref);if(!found)throw new MemoryError("denied","来源引用已失效或不属于当前回合");const {kind,sourceId,sourceHash,observedAt}=found;return {kind,sourceId,sourceHash,observedAt};});
  if(scope==="personal"&&!evidence.some(e=>input.evidenceRefs.includes(e.ref)&&(e.kind==="explicit_user_statement"||e.kind==="recorded_user_statement")&&/跨项目|所有项目|每个项目|across (?:my )?(?:projects|repos)|all (?:my )?(?:projects|repos)/i.test(e.excerpt)))throw new MemoryError("denied","跨项目偏好需要明确用户来源");
  let relation: { type: "supplement" | "contradiction"; blockId: string; readHash: string; target: string } | undefined;
  if(input.relation) {const candidate=session.refs.get(input.relation.ref);if(!candidate||candidate.scope!==scope||!candidate.readHash)throw new MemoryError("denied","关联需要同一范围已读取的记忆");const block=await memoryReferenceBlock(id,input.relation.ref);if(hash(await readBlock(a.connection,block))!==candidate.readHash)throw new MemoryError("denied","关联原文已变化");const loc=await location(a.connection,block);relation={type:input.relation.type,blockId:block,readHash:candidate.readHash,target:a.settings.managedNotebookId?loc.path.split("/").at(-1)!.slice(0,-3):scope==="project"?a.config.writeDocumentId:a.settings.personalWriteDocumentId};}
  const text=serializeEntry(input,sources,relation ? {type:relation.type,blockId:relation.blockId} : undefined);rejectSensitive(text);
  // Deterministic bounded comparison; similar text never authorizes overwriting.
  const found=await withMemoryOperation(id,memorySignal(id),()=>searchEnhanced(id,input.title,{variants:[],explain:false},scope));
  for(const hit of found.candidates.slice(0,5)) {
    const candidate=session.refs.get(hit.ref);if(!candidate)continue;
    await assertScope(a.connection,candidate.id,await a.scopes(scope));const body=await readBlock(a.connection,candidate.id);a.check();const old=parseEntry(body);
    if(old && old.conclusion===input.conclusion && old.applicability===input.applicability && old.detail===input.detail && kind!=="correction" && !relation) {
      const record=memoryJournal.list().find(r=>r.projectId===session.projectId&&r.blockId===candidate.id&&r.kind===kind&&r.scope===scope);
      if(record){traceMemory(id,"extraction_checked","duplicate",1);return reconcileMemory(session.projectId,record.operationId);}
      throw new MemoryError("denied","已存在相同结论与条件，请读取原条目，无需重复保存");
    }
  }
  traceMemory(id,"extraction_checked","ok",1);a.check();
  return remember(session.projectId,text,scope,kind,id,sourceRef,{structured:true,...(relation?{relation}:{})});
}
export async function feedbackMemory(id:string, ref:string, expectedHash:string, signal:MemoryFeedbackSignal):Promise<MemoryWriteRecord> {
  const session=requireSession(id);const a=await access(session.projectId,id);const candidate=session.refs.get(ref);
  if(!candidate||candidate.epoch!==a.stamp||candidate.expires<Date.now()||candidate.readHash!==expectedHash)throw new MemoryError("denied","反馈需要本轮已读取的当前记忆，请重新读取");
  if(!a.settings.intelligence?.enabled)throw new MemoryError("denied","请先启用记忆智能增强");
  await assertScope(a.connection,candidate.id,await a.scopes(candidate.scope));
  const raw=await readBlock(a.connection,candidate.id);if(hash(raw)!==expectedHash)throw new MemoryError("denied","原记忆已修改，请重新读取后反馈");
  const loc=await location(a.connection,candidate.id);a.check();
  return remember(session.projectId,feedbackText(candidate.id,expectedHash,signal),candidate.scope,"correction",id,undefined,{feedback:{blockId:candidate.id,hash:expectedHash,signal},target:a.settings.managedNotebookId?loc.path.split("/").at(-1)!.slice(0,-3):candidate.scope==="project"?a.config.writeDocumentId:a.settings.personalWriteDocumentId});
}
export async function authorizeMemoryReview(id:string,sourceSessionIds:string[]):Promise<{sources:number}> {
  const session=requireSession(id);const a=await access(session.projectId,id);if(!a.settings.intelligence?.enabled)throw new MemoryError("denied","请先启用记忆智能增强");
  const ids=[...new Set(z.array(z.string().min(1).max(200)).min(1).max(3).parse(sourceSessionIds))];
  for(const sourceId of ids){if(!await getSessionRepository().load(session.projectId,sourceId))throw new MemoryError("denied","来源不存在或不属于当前项目");a.check();}
  session.reviewSources=ids;return {sources:ids.length};
}
export async function memoryReferenceBlock(id:string,ref:string):Promise<string> {
  const session=requireSession(id);const a=await access(session.projectId,id);const candidate=session.refs.get(ref);
  if(!candidate||candidate.epoch!==a.stamp||candidate.expires<Date.now())throw new MemoryError("denied","引用已失效，请重新搜索");
  await assertScope(a.connection,candidate.id,await a.scopes(candidate.scope));a.check();return candidate.id;
}
export async function correctMemory(id:string,ref:string,expectedHash:string,text:string):Promise<MemoryWriteRecord> {
  const session=requireSession(id);const a=await access(session.projectId,id);const block=await memoryReferenceBlock(id,ref);const candidate=session.refs.get(ref)!;
  if(candidate.readHash!==expectedHash||hash(await readBlock(a.connection,block))!==expectedHash)throw new MemoryError("denied","原记忆已变化，请重新读取再修正");a.check();
  return remember(session.projectId,text,candidate.scope,"correction",id,ref);
}
export function getMemoryTrace(id:string) { requireSession(id); return getAppSettings().memory.enabled?memoryTrace(id):[]; }
export async function callMemoryTool(id: string, tool: string, value: unknown): Promise<unknown> {
  const session=requireSession(id);
  if(tool==="memory_status")return {...(await getMemoryStatus()),projectEnabled:getAppSettings().memory.enabled && (!!getAppSettings().memory.managedNotebookId || getMemoryProjectConfig(session.projectId).enabled),capabilities:{structured:getAppSettings().memory.intelligence?.enabled===true,evidence:true}};
  if(tool==="memory_evidence"){z.object({}).strict().parse(value);await access(session.projectId,id);const all=evidenceList(id);const visible=all.length<=8?all:[all[0],...all.slice(-7)];return {sources:visible.map(e=>({...e,excerpt:clipMemoryText(e.excerpt,240)})),instruction:"Current sources and explicitly selected history only. Historical records are not current verification. Source availability does not certify a conclusion."};}
  if(tool==="memory_search") {
    const args=z.object({query:z.string().trim().min(2).max(300),scope:z.enum(["project","personal","all"]).default("all"),variants:z.array(z.string().min(2).max(300)).max(2).default([]),kind:kinds.optional(),explain:z.boolean().default(false)}).strict().parse(value);
    return withMemoryOperation(id,memorySignal(id),()=>getAppSettings().memory.intelligence?.enabled?searchEnhanced(id,args.query,args,args.scope):search(id,args.query,args.scope));
  }
  if(tool==="memory_read"){const args=z.object({refs:z.array(z.string().uuid()).min(1).max(5),level:z.enum(["index","summary","full"]).default("full")}).strict().parse(value);return withMemoryOperation(id,memorySignal(id),async()=>({...await read(id,args.refs,args.level),untrusted:true,remainingBytes:remainingMemoryBytes(id)}));}
  if(tool==="memory_remember") {
    const common={scope:z.enum(["project","personal"]).default("project"),kind:kinds,sourceRef:z.string().uuid().optional()};
    const args=z.union([z.object({...common,text:z.string().min(3).max(2000)}).strict(),z.object({...common,entry:entryInputSchema}).strict()]).parse(value);
    const result="entry" in args?await rememberEntry(id,args.entry,args.kind,args.scope,args.sourceRef):await remember(session.projectId,args.text,args.scope,args.kind,id,args.sourceRef);
    session.recall.status=result.state==="verified"?"已保存记忆":"记忆保存状态："+result.state;return result;
  }
  throw new MemoryError("denied","未知记忆工具");
}

export async function rememberSession(id: string, text: string): Promise<MemoryWriteRecord> { return remember(requireSession(id).projectId, text, "project", "convention", id); }
