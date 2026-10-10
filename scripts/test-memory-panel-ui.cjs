// Run: pnpm exec electron scripts/test-memory-panel-ui.cjs
// Real React effects and DOM; generated history and fake engine IPC only.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-memory-ui-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("use-mock-keychain");
let exitCode = 1;
const timeout = setTimeout(() => { console.error("Memory UI check timed out"); app.exit(1); }, 45_000);
app.once("quit", () => { clearTimeout(timeout); if (path.dirname(profile) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith("harnss-memory-ui-")) throw new Error("Unsafe fixture cleanup"); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch (error) { console.warn(`Temporary profile retained at ${profile}: ${error.message}`); } });
app.whenReady().then(async () => {
  try {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, reply) => reply({ cancel: true }));
    const { build } = require(require.resolve("esbuild", { paths: [require.resolve("tsup")] }));
    await build({ entryPoints: [path.join(__dirname, "fixtures/memory-panel-ui.tsx")], outfile: path.join(profile, "fixture.js"),
      bundle: true, platform: "browser", format: "iife", tsconfig: path.join(root, "tsconfig.json"),
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" } });
    fs.writeFileSync(path.join(profile, "index.html"), '<!doctype html><html><body><h1>Memory panel checks</h1><script src="fixture.js"></script></body></html>');
    const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    win.webContents.on("console-message", (event) => { if (event.level === "error") console.error("renderer:", event.message); });
    await win.loadFile(path.join(profile, "index.html"));
    const checks = await win.webContents.executeJavaScript("window.runMemoryPanelChecks()", true);
    for (const check of checks) console.log(`memory-ui: ${check}`);
    exitCode = 0;
  } catch (error) { console.error(error); }
  finally { app.exit(exitCode); }
});
