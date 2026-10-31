import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MEMORY_DEFAULTS } from "@shared/lib/memory";
import type { MemorySettings } from "@shared/types/memory";
const f = vi.hoisted(() => {
  const settings: MemorySettings = { schemaVersion: 2, enabled: false, baseUrl: "http://127.0.0.1:6806", expectedWorkspacePath: "", identityAnchorDocumentId: "", personalReadEnabled: false, personalAutoWriteEnabled: false, personalSummaryBlockIds: [], personalReadScopes: [], personalWriteDocumentId: "" };
  return { dir: "", settings, api: vi.fn(), call: vi.fn(), probe: vi.fn(), history: vi.fn(), metadata: vi.fn() };
});
vi.mock("../session-service", () => ({ getSessionRepository: () => ({ load: f.history, sourceMetadata: f.metadata }) }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../data-dir", () => ({ getDataDir: () => f.dir }));
vi.mock("../app-settings", () => ({ getAppSettings: () => ({ memory: f.settings }), setAppSettings: (patch: { memory: MemorySettings }) => { f.settings = patch.memory; return { memory: f.settings }; } }));
vi.mock("../error-utils", () => ({ reportError: vi.fn() }));
vi.mock("./secrets", () => ({ getMemoryToken: () => "" }));
vi.mock("./agent-bridge", () => ({ registerMemoryBridge: vi.fn(), revokeMemoryBridge: vi.fn(), memoryMcpDefinition: () => null, shutdownMemoryBridge: vi.fn() }));
vi.mock("./siyuan/connection", async original => { const actual = await original<typeof import("./siyuan/connection")>(); return { ...actual, SiyuanClient: class { baseUrl = "http://127.0.0.1:6806"; api = f.api; call = f.call; probe = f.probe; } }; });
const book = "20261024000000-aaaaaaa";
type Doc = { id: string; hpath: string; path: string; attrs: Record<string, string>; children: string[] };
let documents: Map<string, Doc>;
let notes: Map<string, { parent: string; body: string; attrs: Record<string, string> }>;
let notebooks: Array<{ id: string; name: string; closed: boolean }>;
let sequence = 0;
const nextId = () => "20261024000000-" + String(++sequence).padStart(7, "0");
const inputSchema = z.object({ id: z.string().optional(), path: z.string().optional(), name: z.string().optional(), markdown: z.string().optional(), attrs: z.record(z.string(), z.string()).optional() });
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); f.history.mockResolvedValue(null); f.metadata.mockResolvedValue(null); f.dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-brain-"));
  f.settings = { ...MEMORY_DEFAULTS }; documents = new Map(); notes = new Map(); notebooks = []; sequence = 0;
  f.probe.mockResolvedValue({ workspacePath: "C:/SiYuan", version: "3.8.8" });
  f.api.mockImplementation(async (route: string, value: unknown) => {
    const input = inputSchema.parse(value);
    if (route.endsWith("lsNotebooks")) return { notebooks };
    if (route.endsWith("createNotebook")) { notebooks.push({ id: book, name: input.name!, closed: false }); return { notebook: { id: book } }; }
    if (route.endsWith("getIDsByHPath")) return [...documents.values()].filter(d => d.hpath === input.path).map(d => d.id);
    if (route.endsWith("createDocWithMd")) {
      const id = nextId(), hpath = input.path!;
      const parent = [...documents.values()].find(d => d.hpath === hpath.slice(0, hpath.lastIndexOf("/")));
      const marker = nextId();
      const attrs = Object.fromEntries([...(input.markdown ?? "").matchAll(/(custom-[\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      notes.set(marker, { parent: id, body: "Initialization marker", attrs });
      documents.set(id, { id, hpath, path: (parent ? parent.path.slice(0, -3) : "") + "/" + id + ".sy", attrs: {}, children: [marker] }); return id;
    }
    const note = notes.get(input.id ?? "");
    const doc = documents.get(note?.parent ?? input.id ?? "");
    if (!doc) throw Error("missing document");
    if (route.endsWith("getPathByID")) return { notebook: book, path: doc.path };
    if (route.endsWith("setBlockAttrs")) { doc.attrs = { ...doc.attrs, ...input.attrs }; return null; }
    if (route.endsWith("getBlockAttrs")) return note?.attrs ?? doc.attrs;
    if (route.endsWith("getChildBlocks")) return doc.children.map(id => ({ id }));
    if (route.endsWith("getBlockKramdown")) return { id: input.id, kramdown: note?.body ?? "" };
    throw Error("unexpected route " + route);
  });
  f.call.mockImplementation(async (name: string, raw: unknown) => {
    if (name === "search") {
      const input = z.object({ path: z.string() }).parse(raw);
      const found = [...notes.entries()].filter(([, n]) => n.attrs["custom-astradock-operation-id"] && documents.get(n.parent)!.path.startsWith(input.path));
      return { text: "Found " + found.length + " results\n" + found.map(([id]) => "  id: " + id).join("\n") };
    }
    const input = z.object({ parentID: z.string(), data: z.string() }).parse(raw);
    const id = nextId(); const doc = documents.get(input.parentID)!;
    const attrs = Object.fromEntries([...input.data.matchAll(/(custom-[\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const body = input.data.split("\n")[0].replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
    notes.set(id, { parent: doc.id, body, attrs }); doc.children.push(id);
    return { text: "", structured: { action: "append", id } };
  });
});
afterEach(() => { fs.rmSync(f.dir, { recursive: true, force: true }); });
async function service() { return import("./service"); }
async function connected() { const s = await service(); await s.connectMemory(MEMORY_DEFAULTS.baseUrl); await s.registerMemorySession("session", "project", "codex"); return s; }
const calls = (route: string) => f.api.mock.calls.filter(args => String(args[0]).endsWith(route));
describe("fixed managed brain", () => {
  it("initializes one notebook without project binding", async () => {
    const s = await connected();
    expect(f.settings.managedNotebookId).toBe(book); expect(f.settings.personalAutoWriteEnabled).toBe(true);
    expect((await s.getMemoryStatus()).state).toBe("ready");
    expect(await s.callMemoryTool("session", "memory_status", {})).toHaveProperty("projectEnabled", true);
    expect((await s.beforeMemorySend("session", "Explain the project")).text).toContain("memory_remember");
    expect(calls("createNotebook")).toHaveLength(1);
  });
  it("reconnects and resumes after restart without duplicating the notebook", async () => {
    const s = await connected(); const anchor = f.settings.identityAnchorDocumentId;
    await s.connectMemory(MEMORY_DEFAULTS.baseUrl); vi.resetModules(); await (await service()).connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect(f.settings.identityAnchorDocumentId).toBe(anchor); expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("serializes concurrent initialization", async () => {
    const s = await service(); await Promise.allSettled([s.connectMemory(MEMORY_DEFAULTS.baseUrl), s.connectMemory(MEMORY_DEFAULTS.baseUrl)]);
    expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("writes both scopes and prioritizes this project while isolating other projects", async () => {
    const s = await connected();
    expect((await s.remember("project", "Use the project test runner", "project", "convention", "session")).state).toBe("verified");
    expect((await s.remember("project", "Always explain in Chinese", "personal", "preference", "session")).state).toBe("verified");
    const found = z.object({ candidates: z.array(z.object({ ref: z.string(), scope: z.string() })) }).parse(await s.callMemoryTool("session", "memory_search", { query: "test" }));
    expect(found.candidates.map(c => c.scope)).toEqual(["project", "personal"]);
    const result = await s.callMemoryTool("session", "memory_read", { refs: found.candidates.map(c => c.ref) });
    expect(JSON.stringify(result)).toContain("Use the project test runner"); expect(JSON.stringify(result)).toContain("Always explain in Chinese");
    await s.registerMemorySession("other", "other-project", "claude");
    const other = z.object({ candidates: z.array(z.object({ scope: z.string() })) }).parse(await s.callMemoryTool("other", "memory_search", { query: "test" }));
    expect(other.candidates.map(c => c.scope)).toEqual(["personal"]); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("rotates full pages and reconciles and deduplicates old writes", async () => {
    const s = await connected(); const first = await s.remember("project", "First project conclusion", "project", "convention", "session");
    const page = documents.get(first.target)!; page.children = Array.from({ length: 90 }, () => first.blockId!);
    const second = await s.remember("project", "Second project conclusion", "project", "convention", "session");
    expect(second.state).toBe("verified"); expect(second.target).not.toBe(first.target); page.children = [first.blockId!];
    expect((await s.reconcileMemory("project", first.operationId)).state).toBe("verified");
    expect((await s.remember("project", "First project conclusion", "project", "convention", "session")).operationId).toBe(first.operationId);
  });
  it("keeps corrections on the original page", async () => {
    const s = await connected(); const original = await s.remember("project", "Original conclusion", "project", "convention", "session");
    const result = z.object({ candidates: z.array(z.object({ ref: z.string() })) }).parse(await s.callMemoryTool("session", "memory_search", { query: "test" }));
    const correction = await s.remember("project", "Corrected conclusion", "project", "correction", "session", result.candidates[0].ref);
    expect(correction.target).toBe(original.target); expect(correction.state).toBe("verified");
    expect(JSON.stringify(await s.callMemoryTool("session", "memory_read", { refs: [result.candidates[0].ref] }))).toContain("Corrected conclusion");
  });
  it("never switches workspaces", async () => {
    const s = await connected(); f.probe.mockResolvedValue({ workspacePath: "C:/Different", version: "3.8.8" });
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("工作空间已变化"); expect(calls("createNotebook")).toHaveLength(1);
    expect((await s.getMemoryStatus()).state).toBe("workspace-mismatch");
  });
  it("does not replace missing or closed notebooks", async () => {
    const s = await connected(); notebooks[0].closed = true;
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("关闭或不存在"); notebooks = [];
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("关闭或不存在"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("does not recreate a deleted anchor", async () => {
    const s = await connected(); documents.delete(f.settings.identityAnchorDocumentId);
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow(); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("refuses an unrelated same-name user notebook", async () => {
    notebooks.push({ id: book, name: "AstraDock 记忆", closed: false }); const s = await service();
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("不是可识别"); expect(calls("createDocWithMd")).toHaveLength(0);
  });
  it("fails closed on corrupt registry", async () => {
    const s = await connected(); fs.writeFileSync(path.join(f.dir, "siyuan-managed-brain", "brain.json"), "corrupt");
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("身份记录损坏"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("never resubmits an unknown notebook creation", async () => {
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (...args) => { if (String(args[0]).endsWith("createNotebook")) throw Error("lost response"); return original(...args); });
    const s = await service(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("待核对"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("does not create replacements after an external rename", async () => {
    const s = await connected(); documents.get(f.settings.identityAnchorDocumentId)!.hpath = "/Renamed";
    await expect(s.remember("project", "New project conclusion", "project", "convention", "session")).rejects.toThrow("改名或移动"); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("disabling memory stops use and preserves notes", async () => {
    const s = await connected(); f.settings = { ...f.settings, enabled: false };
    await expect(s.remember("project", "New project conclusion", "project", "convention", "session")).rejects.toThrow("未启用");
    expect((await s.beforeMemorySend("session", "hello")).text).toBe("hello"); expect(documents.size).toBe(2);
  });
});

// Recovery exercises mutation boundaries, not just successful creation responses.
describe("managed initialization recovery", () => {
  it("does not append to a page moved into another category", async () => {
    const s = await connected(); const first = await s.remember("project", "First conclusion", "project", "convention", "session");
    const personal = documents.get(f.settings.personalWriteDocumentId)!;
    documents.get(first.target)!.path = personal.path.slice(0, -3) + "/" + first.target + ".sy";
    await expect(s.remember("project", "Second conclusion", "project", "convention", "session")).rejects.toThrow("其他分类");
    expect(f.call.mock.calls.filter(c => c[0] === "block")).toHaveLength(1);
  });
  it("recovers a lost document response by its persisted ownership marker", async () => {
    const original = f.api.getMockImplementation()!; let dropped = false;
    f.api.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!dropped && String(args[0]).endsWith("createDocWithMd")) { dropped = true; throw Error("response lost after commit"); }
      return result;
    });
    const s = await service(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow();
    await s.connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect((await s.getMemoryStatus()).state).toBe("ready"); expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("repairs interrupted document metadata idempotently without recreating notes", async () => {
    const original = f.api.getMockImplementation()!; let dropped = false;
    f.api.mockImplementation(async (...args) => {
      if (!dropped && String(args[0]).endsWith("setBlockAttrs")) { dropped = true; throw Error("connection lost"); }
      return original(...args);
    });
    const s = await service(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow(); await s.connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect((await s.getMemoryStatus()).state).toBe("ready"); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("never recreates a known brain when the local identity record disappears", async () => {
    const s = await connected(); fs.unlinkSync(path.join(f.dir, "siyuan-managed-brain", "brain.json")); notebooks = [];
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("身份记录不匹配"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("reuses an existing marked brain on a fresh installation", async () => {
    const s = await connected(); const root = f.settings.identityAnchorDocumentId;
    fs.unlinkSync(path.join(f.dir, "siyuan-managed-brain", "brain.json")); f.settings = { ...MEMORY_DEFAULTS };
    await s.connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect(f.settings.identityAnchorDocumentId).toBe(root); expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("refuses broad personal scopes even if a stale renderer submits them", async () => {
    const s = await connected(); f.settings = { ...f.settings, personalReadScopes: [] };
    expect((await s.getMemoryStatus()).state).toBe("binding-invalid");
    await expect(s.callMemoryTool("session", "memory_search", { query: "test" })).rejects.toThrow();
  });
  it("stops initialization if permissions change while probing", async () => {
    const s = await service(); f.probe.mockImplementation(async () => { f.settings = { ...f.settings, enabled: true }; return { workspacePath: "C:/SiYuan", version: "3.8.8" }; });
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("连接设置已变化"); expect(calls("createNotebook")).toHaveLength(0);
  });
});

describe("intelligence over the fixed SiYuan brain", () => {
  const candidatesSchema = z.object({candidates:z.array(z.object({ref:z.string(),scope:z.string()}))});
  const readSchema = z.object({items:z.array(z.object({ref:z.string(),hash:z.string(),text:z.string(),details:z.object({validity:z.string()}).optional()}))});
  async function intelligent() { const s=await connected(); f.settings.intelligence={version:1,enabled:true,briefing:false,persistTrace:false}; await s.beforeMemorySend("session","本项目使用 pnpm 运行测试，只有测试通过才算验证成功。"); return s; }
  async function source(s:Awaited<ReturnType<typeof connected>>) { return z.object({sources:z.array(z.object({ref:z.string()}))}).parse(await s.callMemoryTool("session","memory_evidence",{})).sources[0].ref; }
  it("writes a structured entry with host sources and deduplicates its conclusion",async()=>{
    const s=await intelligent(); const entry={formatVersion:2,title:"测试约定",conclusion:"使用 pnpm test",applicability:"当前项目",detail:"测试通过才算验证",evidenceRefs:[await source(s)]};
    const first=z.object({operationId:z.string(),state:z.string()}).parse(await s.callMemoryTool("session","memory_remember",{entry,kind:"convention"}));expect(first.state).toBe("verified");
    const second=z.object({operationId:z.string()}).parse(await s.callMemoryTool("session","memory_remember",{entry,kind:"convention"}));expect(second.operationId).toBe(first.operationId);
  });
  it("rejects forged source refs and an evidence ref after a new turn",async()=>{const s=await intelligent();const ref=await source(s);await s.beforeMemorySend("session","another question");await expect(s.callMemoryTool("session","memory_remember",{entry:{formatVersion:2,title:"test",conclusion:"must not save",applicability:"project",detail:"",evidenceRefs:[ref]},kind:"decision"})).rejects.toThrow("来源");});
  it("multi-query search deduplicates references and never includes another project",async()=>{const s=await intelligent();await s.remember("project","Use pnpm for tests","project","convention","session");await s.registerMemorySession("other","other-project","claude");await s.remember("other-project","Foreign secret convention","project","convention","other");const result=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"tests",variants:["pnpm","tests"],explain:true}));expect(result.candidates).toHaveLength(1);const read=await s.callMemoryTool("session","memory_read",{refs:[result.candidates[0].ref],level:"index"});expect(JSON.stringify(read)).not.toContain("Foreign");});
  it("appends version-bound feedback without modifying the knowledge",async()=>{const s=await intelligent();const saved=await s.remember("project","A known project convention","project","convention","session");const found=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"convention"}));const item=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[found.candidates[0].ref]})).items[0];const feedback=await s.feedbackMemory("session",item.ref,item.hash,"outdated");expect(feedback.state).toBe("verified");expect(feedback.recordKind).toBe("feedback");expect(notes.get(saved.blockId!)?.body).toBe("A known project convention");const repeated=await s.feedbackMemory("session",item.ref,item.hash,"outdated");expect(repeated.operationId).toBe(feedback.operationId);const reread=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[item.ref]}));expect(reread.items[0].details?.validity).toBe("review_requested");const after=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"convention"}));expect(after.candidates).toHaveLength(1);f.settings.intelligence={version:1,enabled:false,briefing:false,persistTrace:false};await s.beforeMemorySend("session","Read with optional enhancement off");const legacy=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"convention"}));expect(legacy.candidates).toHaveLength(1);const guarded=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[legacy.candidates[0].ref]}));expect(guarded.items[0].text).toContain("需要复核");});
  it("refuses feedback after the user edits the target",async()=>{const s=await intelligent();const saved=await s.remember("project","Original statement","project","convention","session");const hit=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"Original"})).candidates[0];const item=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[hit.ref]})).items[0];notes.get(saved.blockId!)!.body="User changed this";await expect(s.feedbackMemory("session",item.ref,item.hash,"outdated")).rejects.toThrow("已修改");});
  it("shares context allowance across repeated reads",async()=>{const s=await intelligent();await s.remember("project","Long memory "+"字".repeat(900),"project","convention","session");const hit=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"Long"})).candidates[0];const one=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[hit.ref]}));expect(one.items).toHaveLength(1);const two=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[hit.ref]}));expect(two.items).toHaveLength(0);});
  it("shows fresh structured L0 after opt-in without a background model",async()=>{const s=await intelligent();const entry={formatVersion:2,title:"项目测试",conclusion:"运行 pnpm test",applicability:"当前项目",detail:"通过后继续",evidenceRefs:[await source(s)]};await s.callMemoryTool("session","memory_remember",{entry,kind:"convention"});f.settings.intelligence={version:1,enabled:true,briefing:true,persistTrace:false};await s.registerMemorySession("new","project","codex");const result=await s.beforeMemorySend("new","继续工作");expect(result.text).toContain("运行 pnpm test");expect(result.text).toContain("untrusted-memory-data");});
  it("links an explicit contradiction and does not overwrite either conclusion",async()=>{
    const s=await intelligent();const first=await s.remember("project","Use approach A under the current conditions","project","decision","session");
    const hit=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"approach"})).candidates[0];await s.callMemoryTool("session","memory_read",{refs:[hit.ref]});
    const entry={formatVersion:2,title:"Different evidence",conclusion:"Approach B conflicts with A",applicability:"Conditions still require review",detail:"Do not silently choose a winner",evidenceRefs:[await source(s)],relation:{type:"contradiction",ref:hit.ref}};
    const result=z.object({state:z.string(),target:z.string()}).parse(await s.callMemoryTool("session","memory_remember",{entry,kind:"decision"}));expect(result.state).toBe("verified");expect(result.target).toBe(first.target);expect(notes.get(first.blockId!)!.body).toContain("approach A");
    await s.beforeMemorySend("session","Which approach is correct?");const reread=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[hit.ref],level:"index"}));expect(reread.items[0].details?.validity).toBe("disputed");expect(reread.items[0].text).toContain("不能自动判断");
  });
  it("user correction appends, preserves the original and refuses a stale hash",async()=>{const s=await intelligent();const original=await s.remember("project","Original project convention","project","convention","session");const hit=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"convention"})).candidates[0];const item=readSchema.parse(await s.callMemoryTool("session","memory_read",{refs:[hit.ref]})).items[0];expect((await s.correctMemory("session",item.ref,item.hash,"Use the corrected convention under these conditions")).state).toBe("verified");expect(notes.get(original.blockId!)!.body).toBe("Original project convention");notes.get(original.blockId!)!.body="User changed the original";await expect(s.correctMemory("session",item.ref,item.hash,"Another correction")).rejects.toThrow("已变化");});
  it("requires explicit history authorization and consumes it for only the next visible turn",async()=>{
    const s=await intelligent();f.history.mockImplementation(async(project:string,id:string)=>project==="project"&&id==="past"?{id:"past",projectId:"project",messages:[{id:"old-user",role:"user",content:"For this project use the established test runner"},{id:"thought",role:"assistant",thinking:"HIDDEN HISTORY THOUGHT",content:"claim"}]}:null);
    await expect(s.authorizeMemoryReview("session",["foreign"])).rejects.toThrow("来源");
    expect(await s.authorizeMemoryReview("session",["past"])).toEqual({sources:1});
    await s.beforeMemorySend("session","整理已选会话的经验");const first=await s.callMemoryTool("session","memory_evidence",{});expect(JSON.stringify(first)).toContain("recorded_user_statement");expect(JSON.stringify(first)).not.toContain("HIDDEN HISTORY THOUGHT");
    await expect(s.callMemoryTool("session","memory_evidence",{sourceSessionId:"foreign"})).rejects.toThrow();
    await s.beforeMemorySend("session","另一个普通回合");expect(JSON.stringify(await s.callMemoryTool("session","memory_evidence",{}))).not.toContain("recorded_user_statement");
  });
  it("marks missing source sessions and externally edited structured claims for review",async()=>{
    const s=await intelligent();const entry={formatVersion:2,title:"Source provenance",conclusion:"Use the observed setting",applicability:"Current project",detail:"Evidence is not a truth certificate",evidenceRefs:[await source(s)]};
    const saved=z.object({blockId:z.string()}).parse(await s.callMemoryTool("session","memory_remember",{entry,kind:"decision"}));s.unregisterMemorySession("session");await s.registerMemorySession("new","project","codex");await s.beforeMemorySend("new","Read the prior decision");
    const hit=candidatesSchema.parse(await s.callMemoryTool("new","memory_search",{query:"Source"})).candidates[0];const result=readSchema.parse(await s.callMemoryTool("new","memory_read",{refs:[hit.ref],level:"index"}));expect(result.items[0].details?.validity).toBe("review_requested");expect(f.metadata).toHaveBeenCalledWith("project","session");
    f.metadata.mockResolvedValue({id:"session"});notes.get(saved.blockId)!.body=notes.get(saved.blockId)!.body.replace("Use the observed setting","Use the user-edited setting");await s.beforeMemorySend("new","Read again");const changed=readSchema.parse(await s.callMemoryTool("new","memory_read",{refs:[hit.ref],level:"index"}));expect(changed.items[0].text).toContain("user-edited");expect(changed.items[0].details?.validity).toBe("review_requested");
  });
  it("trace distinguishes tool reads from model adoption",async()=>{const s=await intelligent();await s.remember("project","A remembered conclusion","project","convention","session");const hit=candidatesSchema.parse(await s.callMemoryTool("session","memory_search",{query:"conclusion"})).candidates[0];await s.callMemoryTool("session","memory_read",{refs:[hit.ref]});const trace=s.getMemoryTrace("session");expect(trace.some(e=>e.stage==="body_read")).toBe(true);expect(trace.some(e=>e.stage==="dispatch_confirmed")).toBe(false);expect(JSON.stringify(trace)).not.toContain("remembered conclusion");});
});
