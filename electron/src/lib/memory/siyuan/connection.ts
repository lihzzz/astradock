import { memoryRequestSignal, MemoryOperationError } from "../operation";
import { z } from "zod";
import { localMemoryUrl } from "@shared/lib/memory";

export class MemoryError extends Error {
  constructor(public readonly code: "unavailable" | "auth-required" | "incompatible" | "workspace-mismatch" | "binding-invalid" | "denied" | "capacity", message: string) { super(message); }
}
const envelope = z.object({ code: z.number(), data: z.unknown() });
const rpcResult = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(), structuredContent: z.unknown().optional() }) });
export async function boundedBody(response: Response, maximum = 1024 * 1024): Promise<string> {
  if (!response.body) throw new MemoryError("incompatible", "Empty memory response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > maximum) { await reader.cancel(); throw new MemoryError("capacity", "Memory response exceeds limit"); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
export class SiyuanClient {
  readonly baseUrl: string;
  private session = ""; private sequence = 0; private initialization: Promise<void> | null = null;
  constructor(baseUrl: string, private readonly token: string, private readonly transport: typeof fetch = fetch) { this.baseUrl = localMemoryUrl(baseUrl); }
  private async request(route: string, body: unknown, timeoutMs = 5000): Promise<unknown> {
    try {
      const response = await this.transport(this.baseUrl + route, { method: "POST", redirect: "error", signal: memoryRequestSignal(timeoutMs),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.token ? { Authorization: "Token " + this.token } : {}),
          ...(route === "/mcp" && this.session ? { "Mcp-Session-Id": this.session, "MCP-Protocol-Version": "2025-03-26" } : {}) }, body: JSON.stringify(body) });
      if ([401, 403].includes(response.status)) throw new MemoryError("auth-required", "思源鉴权失败，请检查 API Token");
      if (!response.ok) {
        if (route === "/mcp" && [404, 410].includes(response.status)) { this.session = ""; this.initialization = null; }
        throw new MemoryError("unavailable", "思源请求失败，长期记忆暂时失效");
      }
      if (route === "/mcp") this.session = response.headers.get("mcp-session-id") ?? this.session;
      if (response.status === 202 || response.status === 204) return null;
      const raw = await boundedBody(response);
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
        const found = data.find((value: unknown) => z.object({ id: z.union([z.string(), z.number()]) }).safeParse(value).success);
        if (!found) throw new MemoryError("incompatible", "Invalid MCP response"); return found;
      }
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      if (error instanceof MemoryError || error instanceof MemoryOperationError) throw error;
      if (error instanceof SyntaxError) throw new MemoryError("incompatible", "Invalid JSON memory response");
      // Never propagate server bodies, credentials, note content or fetch URLs to telemetry.
      throw new MemoryError("unavailable", "思源未连接或响应超时，长期记忆暂时失效");
    }
  }
  async api<T>(route: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = envelope.safeParse(await this.request(route, input));
    if (!response.success) throw new MemoryError("incompatible", "Unexpected SiYuan API response");
    if (response.data.code !== 0) throw new MemoryError("binding-invalid", "思源内容不存在、不可访问或尚未完成索引");
    const parsed = schema.safeParse(response.data.data);
    if (!parsed.success) throw new MemoryError("incompatible", "Unexpected SiYuan data shape");
    return parsed.data;
  }
  private initialize(): Promise<void> {
    if (!this.initialization) this.initialization = (async () => {
      const result = await this.request("/mcp", { jsonrpc: "2.0", id: ++this.sequence, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "astradock-memory", version: "1" } } });
      if (!z.object({ result: z.object({ capabilities: z.object({ tools: z.unknown() }) }) }).safeParse(result).success) throw new MemoryError("incompatible", "思源 MCP 工具不可用");
      await this.request("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((error: unknown) => { this.initialization = null; this.session = ""; throw error; });
    return this.initialization;
  }
  async tools(): Promise<string[]> {
    await this.initialize();
    const raw = await this.request("/mcp", { jsonrpc: "2.0", id: ++this.sequence, method: "tools/list" });
    const parsed = z.object({ result: z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })) }) }).safeParse(raw);
    if (!parsed.success) throw new MemoryError("incompatible", "Invalid tool list");
    return parsed.data.result.tools.map((tool) => tool.name);
  }
  async call(name: "workspace" | "search" | "block", args: Record<string, unknown>, timeoutMs = 5000): Promise<{ text: string; structured: unknown }> {
    await this.initialize();
    const raw = await this.request("/mcp", { jsonrpc: "2.0", id: ++this.sequence, method: "tools/call", params: { name, arguments: args } }, timeoutMs);
    const parsed = rpcResult.safeParse(raw);
    if (!parsed.success) throw new MemoryError("incompatible", "Invalid MCP result");
    if (parsed.data.result.isError) throw new MemoryError("binding-invalid", "思源工具执行未确认，请核对状态");
    return { text: (parsed.data.result.content ?? []).map((entry) => entry.text ?? "").join("\n"), structured: parsed.data.result.structuredContent };
  }
  async probe(): Promise<{ workspacePath: string; version: string }> {
    const version = await this.api("/api/system/version", {}, z.string());
    const names = await this.tools();
    if (!["workspace", "search", "block", "attr"].every((name) => names.includes(name))) throw new MemoryError("incompatible", "思源缺少必要 MCP 工具");
    const { text } = await this.call("workspace", { action: "info" });
    const workspacePath = /^Path:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!workspacePath || !/^Valid:\s*true\s*$/m.test(text)) throw new MemoryError("incompatible", "无法识别思源工作空间");
    return { workspacePath, version };
  }
}
