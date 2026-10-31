import { MemoryError } from "./siyuan/connection";
import { MemoryOperationError } from "./operation";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { McpServerInput } from "@shared/lib/mcp-config";
const scopes = new Map<string, { token: string; call: (tool: string, args: unknown) => Promise<unknown> }>();
let server: http.Server | null = null; let listening: Promise<string> | null = null; let url = "";
function listen(): Promise<string> {
  if (listening) return listening;
  listening = new Promise<string>((resolve, reject) => {
    server = http.createServer((req, res) => { void (async () => {
      const send = (status: number, result: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(result)); };
      if (req.method !== "POST" || req.url !== "/call" || req.headers.origin || req.socket.remoteAddress !== "127.0.0.1") { send(403, { error: "Forbidden" }); return; }
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const scope = [...scopes.values()].find((s) => s.token === token);
      if (!scope) { send(401, { error: "Session revoked" }); return; }
      try { const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 16384) { send(413, { error: "Too large" }); return; } chunks.push(data); }
        const input = z.object({ tool: z.string(), args: z.unknown() }).strict().parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (![...scopes.values()].includes(scope)) throw new Error("Session revoked");
        send(200, { value: await scope.call(input.tool, input.args) });
      } catch (error) { send(400, error instanceof MemoryError ? { error: error.message, code: error.code } : error instanceof MemoryOperationError ? { error: error.message, code: error.reason } : { error: "记忆操作不可用或不在授权范围内，请检查记忆状态" }); }
    })(); });
    server.requestTimeout = 30000; server.headersTimeout = 5000;
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { const addr = server?.address(); if (!addr || typeof addr === "string") { reject(new Error("Memory bridge unavailable")); return; } url = "http://127.0.0.1:" + addr.port + "/call"; resolve(url); });
  }).catch((error: unknown) => { listening = null; throw error; }); return listening;
}
export async function registerMemoryBridge(id: string, call: (tool: string, args: unknown) => Promise<unknown>): Promise<string> {
  await listen(); const token = randomBytes(32).toString("hex"); scopes.set(id, { token, call }); return token;
}
export function revokeMemoryBridge(id: string, expectedToken?: string): void { if (expectedToken === undefined || scopes.get(id)?.token === expectedToken) scopes.delete(id); }
export function memoryMcpDefinition(id: string): McpServerInput | null {
  const scope = scopes.get(id); if (!scope) return null;
  return { name: "harnss_memory", transport: "stdio", command: process.execPath, args: [path.join(__dirname, "memory-mcp.js")], env: { ELECTRON_RUN_AS_NODE: "1", HARNSS_MEMORY_URL: url, HARNSS_MEMORY_TOKEN: scope.token } };
}
export async function shutdownMemoryBridge(): Promise<void> { scopes.clear(); const current = server; server = null; listening = null; if (current) await new Promise<void>((resolve) => { current.close(() => resolve()); current.closeAllConnections(); }); }
