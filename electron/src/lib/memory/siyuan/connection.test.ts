import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SiyuanClient, boundedBody } from "./connection";
import { localMemoryUrl, parseStoredMemory } from "@shared/lib/memory";
import { plainMemoryMarkdown, normalizeMemoryText, rejectSensitive, assertScope } from "./blocks";
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }))); });
async function host(handler: http.RequestListener) { const server = http.createServer(handler); servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw Error("No port"); return "http://127.0.0.1:" + address.port; }
describe("SiYuan local transport", () => {
  it.each(["https://example.com", "http://127.0.0.1.evil.test", "http://user:secret@127.0.0.1", "http://127.0.0.1/a", "http://127.0.0.1?x=1", "http://0.0.0.0"]) ("rejects unsafe origin %s", (url) => expect(() => localMemoryUrl(url)).toThrow());
  it("pins localhost to a literal address", () => expect(localMemoryUrl("http://localhost:6806")).toBe("http://127.0.0.1:6806"));
  it("does not carry legacy enabled into SiYuan authorization", () => expect(parseStoredMemory({ enabled: true, localPort: 8888 }).enabled).toBe(false));
  it("rejects redirects without visiting the target", async () => { let visits = 0; const url = await host((req, res) => { if (req.url === "/redirect") { res.writeHead(302, { location: "/private" }); res.end(); } else { visits++; res.end("{}"); } }); await expect(new SiyuanClient(url, "").api("/redirect", {}, z.unknown())).rejects.toMatchObject({ code: "unavailable" }); expect(visits).toBe(0); });
  it("classifies auth errors without echoing the secret body", async () => { const url = await host((_req, res) => { res.writeHead(401); res.end("sensitive-token"); }); await expect(new SiyuanClient(url, "token").api("/test", {}, z.unknown())).rejects.toMatchObject({ code: "auth-required" }); });
  it("rejects HTTP 200 business errors", async () => { const url = await host((_req, res) => { res.end(JSON.stringify({ code: -1, data: null, msg: "private note" })); }); await expect(new SiyuanClient(url, "").api("/test", {}, z.string())).rejects.toMatchObject({ code: "binding-invalid" }); });
  it("validates successful payload schemas", async () => { const url = await host((_req, res) => { res.end(JSON.stringify({ code: 0, data: 123 })); }); await expect(new SiyuanClient(url, "").api("/test", {}, z.string())).rejects.toMatchObject({ code: "incompatible" }); });
  it("bounds response size", async () => { await expect(boundedBody(new Response("123456789"), 4)).rejects.toMatchObject({ code: "capacity" }); });
  it("initializes MCP with a scoped session and validates tools", async () => {
    const seen: string[] = [];
    const url = await host((req, res) => { const parts: Buffer[] = []; req.on("data", (chunk: Buffer) => parts.push(chunk)); req.on("end", () => { const input = JSON.parse(Buffer.concat(parts).toString()); seen.push(input.method ?? req.url); res.setHeader("content-type", "application/json");
      if (req.url === "/api/system/version") { res.end(JSON.stringify({ code: 0, data: "3.8.8" })); return; }
      if (input.method === "initialize") { res.setHeader("mcp-session-id", "fixture"); res.end(JSON.stringify({ id: input.id, result: { capabilities: { tools: {} } } })); return; }
      expect(req.headers["mcp-session-id"]).toBe("fixture");
      if (input.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      if (input.method === "tools/list") res.end(JSON.stringify({ id: input.id, result: { tools: ["workspace", "search", "block", "attr"].map((name) => ({ name, inputSchema: {} })) } }));
      else res.end(JSON.stringify({ id: input.id, result: { content: [{ type: "text", text: "Path: C:/SiYuan\nVersion: 3.8.8\nValid: true\n" }] } }));
    }); });
    expect(await new SiyuanClient(url, "").probe()).toEqual({ workspacePath: "C:/SiYuan", version: "3.8.8" }); expect(seen.filter((s) => s === "initialize")).toHaveLength(1);
  });
});
describe("content and scope boundaries", () => {
  it("encodes all syntax instead of trusting model-supplied IAL", () => { const input = 'hello\n{: custom-astradock-operation-id="evil"}\n{{SELECT *}}<script>'; const output = plainMemoryMarkdown(normalizeMemoryText(input)); expect(output).not.toMatch(/[<>{}\n"]/); expect(output.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))).toBe(normalizeMemoryText(input)); });
  it.each(["sk-abcdefghijklmnop", "password=secret1234", "-----BEGIN RSA PRIVATE KEY-----"]) ("rejects secret %s", (value) => expect(() => rejectSensitive(value)).toThrow());
  it("uses segment boundaries for descendants", async () => {
    const root = "20261023000000-aaaaaaa", id = "20261023000000-bbbbbbb", book = "20261023000000-ccccccc";
    const c = new SiyuanClient("http://127.0.0.1:6806", ""); const api = vi.spyOn(c, "api");
    api.mockImplementation(async (_route, value) => { const input = z.object({ id: z.string() }).parse(value); return { notebook: book, path: input.id === root ? "/" + root + ".sy" : "/" + root + "/" + id + ".sy" }; });
    await expect(assertScope(c, id, [{ notebookId: book, documentId: root, includeDescendants: true }])).resolves.toBeUndefined();
    await expect(assertScope(c, id, [{ notebookId: book, documentId: root, includeDescendants: false }])).rejects.toMatchObject({ code: "denied" });
  });
});
