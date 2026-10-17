// Run: pnpm exec electron scripts/test-session-token-usage-ui.cjs
// Exercise actual React headers/popovers in a hidden, isolated Electron renderer.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = path.join(root, ".cache/session-token-usage");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-session-token-ui-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("use-mock-keychain");
app.on("window-all-closed", () => {});
const timeout = setTimeout(() => { console.error("Session token UI check timed out"); app.exit(1); }, 45_000);
app.once("quit", () => {
  clearTimeout(timeout);
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("harnss-session-token-ui-")) throw new Error("Unsafe fixture cleanup");
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error) { console.warn(`Temporary profile retained at ${resolved}: ${error.message}`); }
});
app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const isolated = session.fromPartition("session-token-usage-fixture", { cache: false });
    isolated.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, reply) => reply({ cancel: true }));
    const { build } = require(require.resolve("esbuild", { paths: [require.resolve("tsup")] }));
    await build({ entryPoints: [path.join(__dirname, "fixtures/session-token-usage-ui.tsx")], outfile: path.join(profile, "fixture.js"),
      bundle: true, platform: "browser", format: "iife", tsconfig: path.join(root, "tsconfig.json"),
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" } });
    const { build: buildStyles } = await import("vite");
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    await buildStyles({ configFile: false, root, plugins: [tailwindcss()], base: "./", logLevel: "warn",
      build: { outDir: path.join(profile, "styles"), emptyOutDir: false, rollupOptions: { input: path.join(root, "src/index.css") } } });
    const stylesheet = fs.readdirSync(path.join(profile, "styles/assets")).find((file) => file.endsWith(".css"));
    if (!stylesheet) throw new Error("Fixture stylesheet missing");
    fs.writeFileSync(path.join(profile, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/assets/${stylesheet}"><style>body{background:var(--muted);color:var(--foreground)}main{padding:24px}</style></head><body><script src="fixture.js"></script></body></html>`);
    const win = new BrowserWindow({ show: false, width: 920, height: 580, webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on("console-message", (event) => { if (event.level === "error") console.error("renderer:", event.message); });
    await win.loadFile(path.join(profile, "index.html"));
    const checks = await win.webContents.executeJavaScript("window.runSessionTokenUsageChecks()", true);
    for (const check of checks) console.log(`session-token-ui: ${check}`);
    fs.mkdirSync(output, { recursive: true });
    for (const language of ["en-US", "zh-CN"]) {
      await win.webContents.executeJavaScript(`window.setSessionTokenUsageLanguage(${JSON.stringify(language)})`, true);
      for (const theme of ["light", "dark"]) {
        await win.webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${theme === "dark"})`, true);
        win.webContents.invalidate();
        await win.webContents.executeJavaScript("new Promise(resolve => setTimeout(resolve, 200))", true);
        await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
        fs.writeFileSync(path.join(output, `session-tokens-${language}-${theme}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
      }
    }
    win.setContentSize(440, 580);
    for (const language of ["en-US", "zh-CN"]) {
      await win.webContents.executeJavaScript(`window.setSessionTokenUsageLanguage(${JSON.stringify(language)})`, true);
      await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
      const overflow = await win.webContents.executeJavaScript("document.documentElement.scrollWidth > innerWidth", true);
      if (overflow) throw new Error(`Narrow ${language} chat header overflows its pane`);
      fs.writeFileSync(path.join(output, `session-tokens-${language}-narrow.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    }
    await win.webContents.executeJavaScript("window.cleanupSessionTokenUsageChecks()", true);
    win.destroy();
    await isolated.clearStorageData();
    console.log(`session-token-ui: screenshots saved in ${output}`);
    exitCode = 0;
  } catch (error) { console.error(error); }
  finally { app.exit(exitCode); }
});
