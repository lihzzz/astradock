// Run: node --test scripts/test-packaging-config.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");

// Exercise the installed builder's normalization and walker together. Testing
// raw glob strings misses the separate matchers created by config merging.
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const builderLib = path.dirname(builderRequire.resolve("app-builder-lib/package.json"));
const { doMergeConfigs, validateConfiguration } = require(path.join(builderLib, "out/util/config/config.js"));
const { getMainFileMatchers, getNodeModuleFileMatcher } = require(path.join(builderLib, "out/fileMatcher.js"));
const { computeFileSets } = require(path.join(builderLib, "out/util/appFileCopier.js"));
const sourceConfig = require("../electron-builder.config.js");

const RUNTIME_FILES = [
  "package.json",
  "dist/index.html",
  "dist/assets/app.js",
  "dist/assets/app.css",
  "dist/assets/icon.png",
  "electron/dist/main.js",
  "electron/dist/preload.js",
  "electron/dist/history-worker.js",
  "electron/dist/computer-use-mcp.js",
];
const DEVELOPMENT_FILES = [
  ".git/HEAD",
  ".git/config",
  ".env",
  "logs/main.log",
  "outputs/compatibility-audit/live-report.log",
  "src/main.tsx",
  "shared/types/settings.ts",
  "electron/src/main.ts",
  "build/icon.png",
  "release/previous-win-unpacked/app.exe",
  "dist/assets/app.js.map",
  "dist/__tests__/app.js",
  "electron/dist/main.d.ts",
  "electron/dist/main.d.cts",
  "electron/dist/main.d.mts",
  "electron/dist/main.js.map",
];
const COMMON_DEPENDENCIES = [
  "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  "node_modules/@trycua/cua-driver/index.js",
  "node_modules/@trycua/cua-driver-win32-x64/cua.node",
  "node_modules/sharp/lib/index.js",
  "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node",
  "node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node",
  "node_modules/node-pty/lib/index.js",
];
const DEVELOPMENT_DEPENDENCY_FILES = [
  "node_modules/node-pty/lib/index.js.map",
  "node_modules/node-pty/lib/index.d.ts",
  "node_modules/node-pty/test/terminal.js",
];

function cloneConfig(value) {
  if (Array.isArray(value)) return value.map(cloneConfig);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneConfig(item)]));
  }
  return value;
}

async function fixture(t, files) {
  const tempDir = path.resolve(os.tmpdir());
  const prefix = "harnss-packaging-config-";
  const root = await fs.mkdtemp(path.join(tempDir, prefix));
  t.after(async () => {
    const resolvedRoot = path.resolve(root);
    assert.equal(path.dirname(resolvedRoot), tempDir);
    assert.ok(path.basename(resolvedRoot).startsWith(prefix));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  });
  for (const file of files) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file === "package.json" ? '{"name":"packaging-config-test"}' : "fixture");
  }
  return root;
}

for (const [platform, nodePlatform] of [["win", "win32"], ["mac", "darwin"], ["linux", "linux"]]) {
  test(`${platform} packages only runtime app files after config normalization`, async (t) => {
    const nativeFiles = ["node_modules/electron-liquid-glass/index.js"];
    for (const target of ["win32", "darwin", "linux"]) {
      nativeFiles.push(`node_modules/node-pty/prebuilds/${target}-x64/pty.node`);
      nativeFiles.push(`node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-${target}/rg`);
    }
    const root = await fixture(t, [
      ...RUNTIME_FILES, ...DEVELOPMENT_FILES, ...COMMON_DEPENDENCIES,
      ...DEVELOPMENT_DEPENDENCY_FILES, ...nativeFiles,
    ]);
    const config = doMergeConfigs([cloneConfig(sourceConfig)]);
    const debugLogger = { isEnabled: false };
    await validateConfiguration(config, debugLogger);
    const info = {
      projectDir: root,
      appDir: root,
      buildResourcesDir: "build",
      config,
      debugLogger,
      areNodeModulesHandledExternally: false,
    };
    const destination = path.join(root, "release", "app");
    const expand = (value) => value;
    const matchers = getMainFileMatchers(
      root, destination, expand, config[platform], { info }, path.join(root, "release"), false,
    );
    assert.equal(matchers.length, 1, "an extra negative-only matcher can include the whole project");
    const fileSets = await computeFileSets(matchers, null, { info }, false);
    const actual = fileSets.flatMap((fileSet) => fileSet.files.map((file) => path.relative(root, file).split(path.sep).join("/")));
    assert.equal(new Set(actual).size, actual.length, "app files must not occur in multiple file sets");
    assert.deepEqual(actual.sort(), [...RUNTIME_FILES].sort());

    // Production dependencies are collected separately from the app walker.
    // The shared exclusions must continue to apply to that second collection.
    const dependencyMatcher = getNodeModuleFileMatcher(root, destination, expand, config[platform], info);
    const filter = dependencyMatcher.createFilter();
    async function included(file) {
      const fullPath = path.join(root, file);
      return filter(fullPath, await fs.stat(fullPath));
    }
    for (const file of COMMON_DEPENDENCIES) assert.equal(await included(file), true, file);
    for (const file of DEVELOPMENT_DEPENDENCY_FILES) assert.equal(await included(file), false, file);
    assert.equal(await included(nativeFiles[0]), platform === "mac", "glass is needed only on macOS");
    for (const target of ["win32", "darwin", "linux"]) {
      const expected = platform === "mac" || target === nodePlatform;
      for (const file of [
        `node_modules/node-pty/prebuilds/${target}-x64/pty.node`,
        `node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/x64-${target}/rg`,
      ]) assert.equal(await included(file), expected, file);
    }
  });
}

test("unpacked Computer Use helper runs without the application's node_modules", { timeout: 30000 }, async (t) => {
  const { build } = require("tsup");
  const { spawnSync } = require("node:child_process");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  // Keep this outside the repository so Node cannot fall back to dev dependencies.
  // Only the native driver is stubbed; MCP and all its JS dependencies must bundle.
  const root = await fixture(t, ["package.json"]);
  const unpacked = path.join(root, "resources", "app.asar.unpacked");
  const outDir = path.join(unpacked, "electron", "dist");
  await build({
    config: path.resolve(__dirname, "../tsup.electron.config.ts"),
    entry: { "computer-use-mcp": path.resolve(__dirname, "../electron/src/computer-use-mcp.ts") },
    outDir,
    clean: false,
    silent: true,
  });

  const metadata = { driverVersion: "fixture-driver", contractVersion: "fixture-contract", embedded: true };
  const tool = { name: "fixture_echo", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
  const driverDir = path.join(unpacked, "node_modules", "@trycua", "cua-driver");
  await fs.mkdir(driverDir, { recursive: true });
  await fs.writeFile(path.join(driverDir, "package.json"), JSON.stringify({
    name: "@trycua/cua-driver", type: "module", exports: { ".": "./index.js" },
  }));
  await fs.writeFile(path.join(driverDir, "index.js"), [
    "export const CuaDriver = { create: async () => ({",
    "  metadata: async () => (" + JSON.stringify(metadata) + "),",
    "  listToolsJson: async () => JSON.stringify(" + JSON.stringify({ tools: [tool] }) + "),",
    "  callTool: async (name, args) => ({ text: JSON.stringify({ name, args: JSON.parse(args) }), images: [], isError: false }),",
    "  shutdown: async () => {}, uniffiDestroy: () => {},",
    "}) };",
  ].join("\n"));

  const helper = path.join(outDir, "computer-use-mcp.js");
  const env = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
  const health = spawnSync(process.execPath, [helper, "--health"], {
    cwd: root, env, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.ifError(health.error);
  assert.equal(health.status, 0, health.stderr);
  assert.deepEqual(JSON.parse(health.stdout), metadata);

  // Exercise normal startup too: health alone does not construct the MCP server.
  const transport = new StdioClientTransport({
    command: process.execPath, args: [helper], cwd: root, env, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "computer-use-packaging-test", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    assert.equal(client.getServerVersion().name, "harnss-cua");
    const { tools } = await client.listTools({}, { timeout: 5000 });
    assert.deepEqual(tools, [tool]);
    const result = await client.callTool({ name: tool.name, arguments: { value: "bundled" } }, undefined, { timeout: 5000 });
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ name: tool.name, args: { value: "bundled" } }) }]);
    assert.equal(stderr, "");
  } finally {
    await client.close();
  }
});
