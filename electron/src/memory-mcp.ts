/** Per-engine stdio transport only. The desktop host owns runs, permissions and storage. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MEMORY_AGENT_TOOLS } from "@shared/lib/memory-tools";

async function main(): Promise<void> {
  const endpoint = new URL(process.env.HARNSS_MEMORY_URL ?? "");
  const token = process.env.HARNSS_MEMORY_TOKEN;
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/call" || !token) {
    throw new Error("Invalid AstraDock application bridge configuration.");
  }
  const server = new Server({ name: "harnss-memory", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MEMORY_AGENT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: request.params.name, args: request.params.arguments ?? {} }),
        redirect: "error", signal: AbortSignal.timeout(30_000) });
      const result: unknown = await response.json();
      const isError = !response.ok || typeof result === "object" && result !== null && "error" in result;
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => { void server.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", () => { void server.close().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void server.close().finally(() => process.exit(0)); });
  await server.connect(transport);
}
void main().catch(() => { process.stderr.write("Memory bridge unavailable"); process.exitCode = 1; });
