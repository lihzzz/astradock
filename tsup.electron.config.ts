import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "electron/src/main.ts",
    preload: "electron/src/preload.ts",
    "computer-use-mcp": "electron/src/computer-use-mcp.ts",
    "memory-mcp": "electron/src/memory-mcp.ts",
    "project-apps-mcp": "electron/src/project-apps-mcp.ts",
    "cc-import-worker": "electron/src/cc-import-worker.ts",
    "runtime-history-worker": "electron/src/lib/runtime/history-worker.ts",
    "history-worker": "electron/src/lib/history/worker.ts",
    "embedding-worker": "electron/src/lib/history/embedding-worker.ts",
  },
  outDir: "electron/dist",
  format: ["cjs"],
  target: "es2020",
  platform: "node",
  // node:sqlite is prefix-only; stripping "node:" turns it into a missing npm package.
  removeNodeProtocol: false,
  splitting: false,
  clean: true,
  external: [
    "electron",
    "node-pty",
    "electron-liquid-glass",
    "@anthropic-ai/claude-agent-sdk",
    "posthog-node",
    "@huggingface/transformers",
    "@trycua/cua-driver",
    "@trycua/cua-driver/electron",
  ],
  // The unpacked Computer Use helper cannot resolve dependencies inside app.asar.
  // Bundle Zod (including its v3/v4 subpaths) alongside the MCP SDK.
  noExternal: ["@modelcontextprotocol/sdk", "zod"],
  treeshake: true,
});
