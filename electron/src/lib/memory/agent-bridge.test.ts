import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryMcpDefinition, registerMemoryBridge, revokeMemoryBridge, shutdownMemoryBridge } from "./agent-bridge";
afterEach(() => shutdownMemoryBridge());
async function setup() { const call = vi.fn(async () => ({ state: "verified" })); await registerMemoryBridge("s", call); const def = memoryMcpDefinition("s"); if (!def || !("env" in def) || !def.env) throw Error("No definition"); return { call, url: def.env.HARNSS_MEMORY_URL, token: def.env.HARNSS_MEMORY_TOKEN }; }
describe("memory bridge", () => {
  it("authenticates and executes without an application approval dialog", async () => { const { call, url, token } = await setup(); const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ tool: "memory_remember", args: { text: "fixture" } }) }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ value: { state: "verified" } }); expect(call).toHaveBeenCalledOnce(); });
  it("rejects missing credentials and browser-origin calls", async () => { const { call, url, token } = await setup(); expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401); expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, origin: "http://evil.test" }, body: "{}" })).status).toBe(403); expect(call).not.toHaveBeenCalled(); });
  it("revokes old session tokens", async () => { const { url, token } = await setup(); revokeMemoryBridge("s"); expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token }, body: "{}" })).status).toBe(401); });
  it("bounds tool request payloads", async () => { const { call, url, token } = await setup(); expect((await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token }, body: "x".repeat(20000) })).status).toBe(413); expect(call).not.toHaveBeenCalled(); });
});
