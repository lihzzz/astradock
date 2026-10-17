import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnExecutable, execFileExecutable, resolveExecutableCommand } from "../command-launch";
import { stopProcessAndWait } from "@shared/lib/process-stop";
import { closeAcpSession, restoreAcpSession, withAcpTimeout } from "../acp-runtime";
import { reduceAcpUsage } from "../../../../src/lib/engine/acp-usage";

// Only the Electron session registry/log sink is mocked. OpenCode, ACP transport,
// provider inference, utility processes, filesystem and MCP server are all real.
const registry = vi.hoisted(() => ({
  model: "",
  sessions: new Map<string, { agentId: string; agentBinary: string; agentEnv: Record<string, string>; connection: { signal: AbortSignal } }>(),
}));
vi.mock("../../ipc/acp-sessions", () => ({ acpSessions: registry.sessions, getAcpSessionModel: () => registry.model }));
vi.mock("../error-utils", () => ({ reportError: (label: string, error: unknown) => { console.error(label, String(error)); return String(error); } }));
import { acpUtilityPrompt } from "../acp-utility-prompt";

const enabled = process.env.OPENCODE_FREE_LIVE === "1";
const model = process.env.OPENCODE_FREE_MODEL ?? "opencode/deepseek-v4.1-flash-free";
const reportPath = process.env.OPENCODE_FREE_REPORT;
const report: { model: string; version?: string; pricing?: unknown; checks: Array<{ name: string; ok: boolean; details?: unknown; error?: string; blocked?: boolean }> } = { model, checks: [] };
let directory = "";
let workspace = "";
let env: Record<string, string>;
let binary = "";
let connection: acp.ClientSideConnection;
let child: ReturnType<typeof spawnExecutable> | undefined;
let capabilities: acp.AgentCapabilities;
let sessionId = "";
let savedId = "";
const nonce = "FREE_ACP_CONTEXT_" + Math.random().toString(36).slice(2);
const events: acp.SessionNotification[] = [];
const permissionRequests: acp.RequestPermissionRequest[] = [];
let stderr = "";
let providerBlock = "";

function checkFreeMetadata(stdout: string) {
  const record = stdout.split(/(?=^opencode\/)/m).find(value => value.startsWith(model + "\n") || value.startsWith(model + "\r\n"));
  if (!record) throw new Error("Selected model is unavailable: " + model);
  const metadata: unknown = JSON.parse(record.slice(record.indexOf("{")));
  if (typeof metadata !== "object" || metadata === null || !("cost" in metadata)) throw new Error("Missing pricing metadata");
  const cost = metadata.cost;
  if (typeof cost !== "object" || cost === null || !("input" in cost) || !("output" in cost) || cost.input !== 0 || cost.output !== 0) throw new Error("Refusing non-free or unknown model pricing");
  if (!("cache" in cost) || typeof cost.cache !== "object" || cost.cache === null || !("read" in cost.cache) || !("write" in cost.cache) || cost.cache.read !== 0 || cost.cache.write !== 0) throw new Error("Refusing unknown/nonzero cache pricing");
  report.pricing = cost;
}
async function capture(name: string, operation: () => Promise<unknown>) {
  try { const details = await operation(); report.checks.push({ name, ok: true, details }); console.log("FREE_LIVE", name, JSON.stringify(details)); }
  catch (error) {
    const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : String(error);
    if (/free tier can only be used|FreeTierError/i.test(message)) providerBlock = message;
    report.checks.push({ name, ok: false, error: message }); throw error;
  }
}
function bounded<T>(operation: Promise<T>, timeout = 90000) { return withAcpTimeout(operation, timeout, "Free-model live ACP", connection.signal); }
function textSince(index: number) {
  return events.slice(index).flatMap(event => event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : []).join("");
}
function assertZeroCost(index: number) {
  const costs = events.slice(index).flatMap(event => event.update.sessionUpdate === "usage_update" && event.update.cost ? [event.update.cost] : []);
  expect(costs.length).toBeGreaterThan(0);
  expect(costs.every(cost => cost.amount === 0 && cost.currency === "USD")).toBe(true);
  return costs;
}
async function startProcess() {
  child = spawnExecutable(binary, ["acp", "--pure", "--cwd", workspace], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = child.stdout;
  if (!stdout || !child.stdin) throw new Error("Missing OpenCode stdio");
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-6000); });
  const output = new ReadableStream<Uint8Array>({ start(controller) {
    stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk)); stdout.on("end", () => controller.close()); stdout.on("error", error => controller.error(error));
  } });
  connection = new acp.ClientSideConnection(() => ({
    sessionUpdate: async event => { events.push(event); },
    requestPermission: async request => {
      permissionRequests.push(request);
      const locations = request.toolCall.locations ?? [];
      const fixture = path.join(workspace, "fixture.txt");
      const allowed = locations.length > 0 && locations.every(location => path.resolve(location.path) === fixture);
      const option = request.options.find(option => option.kind === (allowed ? "allow_once" : "reject_once"));
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    },
    readTextFile: async params => {
      const file = path.resolve(params.path);
      if (path.dirname(file) !== workspace) throw new Error("Test file read outside fixture denied");
      return { content: await readFile(file, "utf8") };
    },
    writeTextFile: async params => {
      const file = path.resolve(params.path);
      if (file !== path.join(workspace, "fixture.txt")) throw new Error("Test file write outside approved fixture denied");
      await writeFile(file, params.content); return {};
    },
  }), acp.ndJsonStream(Writable.toWeb(child.stdin), output));
  const initialized = await bounded(connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "astradock-free-live", version: "1" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } }), 20000);
  capabilities = initialized.agentCapabilities ?? {};
  report.version = initialized.agentInfo?.version;
}
async function newSession(mcpServers: acp.McpServer[] = []) {
  const session = await bounded(connection.newSession({ cwd: workspace, mcpServers }), 20000);
  expect(session.configOptions?.find(option => option.category === "model")?.currentValue).toBe(model);
  const configured = await bounded(connection.setSessionConfigOption({ sessionId: session.sessionId, configId: "model", value: model }), 20000);
  expect(configured.configOptions.find(option => option.category === "model")?.currentValue).toBe(model);
  sessionId = session.sessionId;
  return sessionId;
}

describe.skipIf(!enabled)("OpenCode real free-model inference (opt-in; no paid fallback)", () => {
  beforeAll(async () => {
    if (!model.startsWith("opencode/")) throw new Error("Only the verified anonymous OpenCode provider is allowed");
    directory = await mkdtemp(path.join(tmpdir(), "astradock-free-live-"));
    workspace = path.join(directory, "work"); await mkdir(workspace);
    env = {};
    // Do not pass provider keys, tokens, OPENCODE overrides or user HOME/config.
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
      const value = process.env[key]; if (value) env[key] = value;
    }
    // Empty credential overrides also prevent the production utility's inherited
    // environment from reintroducing the host's provider keys.
    for (const key of Object.keys(process.env)) {
      if (/(TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_KEY)/i.test(key) || key.startsWith("OPENCODE_")) env[key] = "";
    }
    Object.assign(env, { HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home"),
      XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"), XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache"),
      OPENCODE_CONFIG_DIR: path.join(directory, "config"), OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model, small_model: model, enabled_providers: ["opencode"], provider: { opencode: { whitelist: [model.slice("opencode/".length)] } }, permission: { "*": "deny", read: "allow", edit: "ask", external_directory: "deny", "liveprobe_*": "allow" } }),
    });
    binary = resolveExecutableCommand("opencode", [], { env }).command;
    const models = await execFileExecutable(binary, ["models", "opencode", "--verbose", "--refresh", "--pure"], { cwd: workspace, env, encoding: "utf8", timeout: 30000 });
    checkFreeMetadata(models);
    await startProcess();
  }, 60000);

  beforeEach(context => {
    if (providerBlock) {
      report.checks.push({ name: context.task.name, ok: false, blocked: true, error: providerBlock });
      context.skip("Provider rejected free-tier access; no paid fallback or access-control bypass");
    }
  });

  afterAll(async () => {
    if (child) await stopProcessAndWait(child);
    registry.sessions.clear();
    if (reportPath) { await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true }); await writeFile(reportPath, JSON.stringify({ ...report, stderr }, null, 2)); }
    console.log("FREE_LIVE_SUMMARY", JSON.stringify(report));
    if (directory) {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("astradock-free-live-")) throw new Error("Unsafe test cleanup path");
      await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 15000);

  it("streams real text, reports tokens and zero cost", async () => capture("stream-and-zero-cost", async () => {
    savedId = await newSession(); const index = events.length;
    const response = await bounded(connection.prompt({ sessionId, prompt: [{ type: "text", text: `Remember the secret marker ${nonce} for later. Do not use tools. Reply READY and then list the numbers 1 through 30, one per line. Do not explain.` }] }));
    expect(response.stopReason).toBe("end_turn"); expect(textSince(index)).toContain("READY");
    const chunks = events.slice(index).filter(event => event.update.sessionUpdate === "agent_message_chunk").length;
    expect(chunks).toBeGreaterThan(1); expect(response.usage?.outputTokens).toBeGreaterThan(0);
    return { chunks, usage: response.usage, costs: assertZeroCost(index) };
  }), 100000);

  it("restores context across process restart without replay", async () => capture("restart-resume-context", async () => {
    expect(savedId).not.toBe(""); if (child) await stopProcessAndWait(child); await startProcess();
    const index = events.length;
    const restored = await bounded(restoreAcpSession(connection, capabilities, { sessionId: savedId, cwd: workspace, mcpServers: [] }), 20000);
    expect(restored.method).toBe("resume"); expect(events.slice(index).some(event => ["user_message_chunk", "agent_message_chunk"].includes(event.update.sessionUpdate))).toBe(false);
    const response = await bounded(connection.prompt({ sessionId: savedId, prompt: [{ type: "text", text: "What secret marker did I ask you to remember? Reply with only that exact marker. Do not use tools." }] }));
    expect(response.stopReason).toBe("end_turn"); expect(textSince(index)).toContain(nonce);
    return { restored: true, reply: textSince(index), costs: assertZeroCost(index) };
  }), 100000);

  it("executes an approved edit only inside the test directory", async () => capture("approved-file-edit", async () => {
    await writeFile(path.join(workspace, "fixture.txt"), "OLD_TEST_VALUE\n"); await newSession();
    const index = events.length; const permissionIndex = permissionRequests.length;
    const response = await bounded(connection.prompt({ sessionId, prompt: [{ type: "text", text: "Use the read tool to read fixture.txt, then use the edit tool to replace OLD_TEST_VALUE with NEW_TEST_VALUE in that file. Use tools, do not just describe the edit. Do not use shell or touch any other files. Reply EDIT_DONE after completing the edit." }] }));
    expect(response.stopReason).toBe("end_turn"); expect(await readFile(path.join(workspace, "fixture.txt"), "utf8")).toContain("NEW_TEST_VALUE");
    expect(permissionRequests.length).toBeGreaterThan(permissionIndex);
    const tools = events.slice(index).filter(event => event.update.sessionUpdate === "tool_call").map(event => event.update);
    expect(tools.length).toBeGreaterThan(0);
    return { tools, permissions: permissionRequests.length - permissionIndex, costs: assertZeroCost(index) };
  }), 100000);

  it("honors a rejected file permission", async () => capture("rejected-file-edit", async () => {
    await writeFile(path.join(workspace, "forbidden.txt"), "KEEP_UNCHANGED\n"); await newSession();
    const permissionIndex = permissionRequests.length;
    const response = await bounded(connection.prompt({ sessionId, prompt: [{ type: "text", text: "Read forbidden.txt and attempt one edit replacing KEEP_UNCHANGED with SHOULD_NOT_BE_WRITTEN. If permission is rejected, stop immediately and report that. Do not use any other tools or try to work around denial." }] }));
    expect(response.stopReason).toBe("end_turn"); expect(permissionRequests.length).toBeGreaterThan(permissionIndex);
    expect(await readFile(path.join(workspace, "forbidden.txt"), "utf8")).toBe("KEEP_UNCHANGED\n");
    return { permissions: permissionRequests.length - permissionIndex, unchanged: true };
  }), 100000);

  it("runs the production text-only utility in an isolated process", async () => capture("production-utility-isolation", async () => {
    registry.model = model; registry.sessions.set("live", { agentId: "opencode", agentBinary: binary, agentEnv: env, connection: { signal: connection.signal } });
    const index = events.length;
    const title = await acpUtilityPrompt("live", "Reply with exactly FREE_UTILITY_OK. Do not call tools.", 90000);
    expect(title).toContain("FREE_UTILITY_OK"); expect(events.length).toBe(index); expect(child?.exitCode).toBeNull();
    return { title, mainSessionUnaffected: true };
  }), 100000);

  it("cancels a real in-flight MCP tool", async () => capture("cancel-running-tool", async () => {
    const require = createRequire(import.meta.url);
    const serverModule = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/mcp.js")).href;
    const transportModule = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href;
    const marker = path.join(workspace, "wait-started");
    const script = `import {McpServer} from ${JSON.stringify(serverModule)}; import {StdioServerTransport} from ${JSON.stringify(transportModule)}; import {writeFile} from 'node:fs/promises'; const server=new McpServer({name:'liveprobe',version:'1'}); server.registerTool('wait',{description:'Wait for 60 seconds. Call this exact tool when asked to test cancellation.',inputSchema:{}},async()=>{await writeFile(${JSON.stringify(marker)},'started');await new Promise(r=>setTimeout(r,60000));return {content:[{type:'text',text:'finished'}]};}); await server.connect(new StdioServerTransport());`;
    await newSession([{ name: "liveprobe", command: process.execPath, args: ["--input-type=module", "-e", script], env: [] }]);
    const responsePromise = bounded(connection.prompt({ sessionId, prompt: [{ type: "text", text: "Call the liveprobe_wait tool exactly once now to test cancellation. Do not use any other tool and do not answer before it finishes." }] }));
    // Attach rejection handling while waiting for the local tool-start marker.
    let settled: { result: acp.PromptResponse } | { error: unknown } | undefined;
    const outcome = responsePromise.then(result => ({ result }), (error: unknown) => ({ error })).then(value => { settled = value; return value; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await readFile(marker, "utf8").catch(() => "") === "started") break;
      if (settled) { if ("error" in settled) throw settled.error; throw new Error("Prompt finished before invoking the cancellation test tool"); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(await readFile(marker, "utf8")).toBe("started");
    const started = Date.now(); await bounded(connection.cancel({ sessionId }), 5000);
    const cancelled = await bounded(outcome, 15000);
    if (!("result" in cancelled)) throw cancelled.error;
    expect(cancelled.result.stopReason).toBe("cancelled");
    return { stopReason: cancelled.result.stopReason, cancellationMs: Date.now() - started };
  }), 100000);

  it("keeps duplicate real usage snapshots idempotent", async () => capture("real-usage-idempotence", async () => {
    expect(report.checks.find(check => check.name === "stream-and-zero-cost")?.ok).toBe(true);
    const usage = events.flatMap(event => event.update.sessionUpdate === "usage_update" ? [{ sessionUpdate: "usage_update" as const, used: event.update.used, size: event.update.size, cost: event.update.cost ?? undefined }] : []);
    expect(usage.length).toBeGreaterThan(0);
    let state = reduceAcpUsage({ totalCost: 0, contextUsage: null }, usage[0]);
    for (const update of usage) { state = reduceAcpUsage(state, update); const replayed = reduceAcpUsage(state, update); expect(replayed).toEqual(state); }
    expect(state.totalCost).toBe(0);
    await bounded(closeAcpSession(connection, capabilities, sessionId), 5000);
    return { updates: usage.length, totalCost: state.totalCost, contextUsage: state.contextUsage };
  }));
});
