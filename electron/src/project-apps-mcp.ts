/** Per-engine stdio transport only. The desktop host owns runs, permissions and storage. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PROJECT_APP_AGENT_TOOLS } from "@shared/lib/project-app-agent-tools";

async function main(): Promise<void> {
  const endpoint = new URL(process.env.HARNSS_PROJECT_APPS_URL ?? "");
  const token = process.env.HARNSS_PROJECT_APPS_TOKEN;
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/call" || !token) {
    throw new Error("Invalid AstraDock application bridge configuration.");
  }
  const server = new Server({ name: "harnss-apps", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PROJECT_APP_AGENT_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: request.params.name, args: request.params.arguments ?? {} }),
        redirect: "error", signal: AbortSignal.timeout(140_000) });
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
void main().catch((error: unknown) => { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
