/** Built-artifact smoke test. Local fixture only; never contacts the user's SiYuan. */
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
(async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer smoke-secret");
    const chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(data.tool, "memory_status"); calls++;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ value: { state: "ready", fixture: true } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, "../electron/dist/memory-mcp.js")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HARNSS_MEMORY_URL: "http://127.0.0.1:" + server.address().port + "/call", HARNSS_MEMORY_TOKEN: "smoke-secret" }, stderr: "pipe" });
  const client = new Client({ name: "memory-smoke", version: "1" });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(t => t.name), ["memory_status", "memory_search", "memory_read", "memory_remember"]);
    const result = await client.callTool({ name: "memory_status", arguments: {} });
    assert.equal(result.isError, false); assert.equal(calls, 1);
    assert.equal(JSON.parse(result.content[0].text).value.state, "ready");
    console.log("PASS: built stdio memory helper, MCP discovery and authenticated loopback forwarding");
  } finally { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
