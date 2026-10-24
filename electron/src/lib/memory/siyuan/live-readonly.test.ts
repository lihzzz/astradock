import { describe, expect, it } from "vitest";
import { SiyuanClient } from "./connection";
describe.skipIf(process.env.SIYUAN_READONLY_PROBE !== "1")("explicit local read-only SiYuan probe", () => {
  it("validates current MCP discovery and workspace identity shape without reading notes", async () => {
    const client = new SiyuanClient("http://127.0.0.1:6806", "");
    const result = await client.probe();
    expect(result.version).toMatch(/^\d+\.\d+\.\d+/); expect(result.workspacePath.length).toBeGreaterThan(0);
    console.log("SIYUAN_READONLY_VERSION", result.version);
  }, 20000);
});
