// Run: pnpm exec node scripts/test-tool-result-selection-ui.cjs [--screenshot]
// Real React, Chromium layout and freshly compiled app CSS. No network or user data.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");

function removeProfile(profile) {
  // Only remove the exact temporary profile created by this test.
  if (path.dirname(path.resolve(profile)) !== path.resolve(os.tmpdir()) || !path.basename(profile).startsWith("harnss-tool-result-selection-ui-")) {
    throw new Error("Unexpected temporary profile path");
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function run() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-tool-result-selection-ui-"));
  try {
    const { build, stop } = require(require.resolve("esbuild", { paths: [require.resolve("tsup")] }));
    try {
      await build({ entryPoints: [path.join(__dirname, "fixtures/tool-result-selection-ui.tsx")], outfile: path.join(profile, "fixture.js"),
        bundle: true, platform: "browser", format: "iife", tsconfig: path.join(root, "tsconfig.json"),
        define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" } });
    } finally { stop(); }
    const { build: buildStyles } = await import("vite");
    const styles = path.join(profile, "styles");
    await buildStyles({ root, configFile: path.join(root, "vite.config.ts"), publicDir: false, logLevel: "error",
      build: { outDir: styles, emptyOutDir: false, rollupOptions: { input: path.join(root, "src/index.css") } } });
    const css = fs.readdirSync(path.join(styles, "assets")).find((name) => name.endsWith(".css"));
    if (!css) throw new Error("App stylesheet was not built");
    fs.writeFileSync(path.join(profile, "index.html"), `<!doctype html><html><head><link rel="stylesheet" href="styles/assets/${css}"></head><body><script src="fixture.js"></script></body></html>`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const child = require("node:child_process").spawn(require("electron"), [__filename, "--profile", profile, ...process.argv.slice(2)],
        { cwd: root, env, windowsHide: true, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`UI checks exited with ${code ?? signal}`)));
    });
  } finally {
    // Chromium must exit first to release Windows profile/cache file locks.
    removeProfile(profile);
  }
}

function runElectron() {
  const { app, BrowserWindow, session } = require("electron");
  const profile = process.argv[process.argv.indexOf("--profile") + 1];
  if (!process.argv.includes("--profile") || !profile) {
    console.error("Run this check with pnpm exec node, not directly with electron.");
    app.exit(1);
    return;
  }
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("use-mock-keychain");
  const timeout = setTimeout(() => { console.error("Tool selection UI check timed out"); app.exit(1); }, 30_000);
  app.once("quit", () => clearTimeout(timeout));
  app.whenReady().then(async () => {
    let exitCode = 1;
    try {
      session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, reply) => reply({ cancel: true }));
      const win = new BrowserWindow({ show: false, width: 900, height: 500, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.on("console-message", (event) => { if (event.level === "error") console.error("renderer:", event.message); });
      await win.loadFile(path.join(profile, "index.html"));
      for (const result of await win.webContents.executeJavaScript("window.runToolResultSelectionChecks()", true)) console.log(`tool-selection-ui: ${result}`);
      if (process.argv.includes("--screenshot")) {
        const output = path.join(root, "outputs", "tool-result-selection.png");
        fs.mkdirSync(path.dirname(output), { recursive: true });
        await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const screenshot = await win.webContents.capturePage();
        if (screenshot.isEmpty()) throw new Error("Screenshot was empty");
        fs.writeFileSync(output, screenshot.toPNG());
        console.log(`Screenshot: ${output}`);
      }
      exitCode = 0;
    } catch (error) { console.error(error); }
    finally { app.exit(exitCode); }
  });
}

if (process.versions.electron) runElectron();
else void run().catch((error) => { console.error(error); process.exitCode = 1; });
