// Run: pnpm exec electron scripts/test-token-usage-ui.cjs
// Actual React dashboard, generated token reports and fake usage IPC in an isolated profile.
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const output = path.join(root, ".cache/token-usage");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-token-ui-"));
app.setPath("userData", profile);
app.commandLine.appendSwitch("use-mock-keychain");
app.on("window-all-closed", () => {});
let exitCode = 1;
const timeout = setTimeout(() => { console.error("Token usage UI check timed out"); app.exit(1); }, 45_000);
app.once("quit", () => {
  clearTimeout(timeout);
  const resolvedProfile = path.resolve(profile);
  if (path.dirname(resolvedProfile) !== path.resolve(os.tmpdir()) || !path.basename(resolvedProfile).startsWith("harnss-token-ui-")) {
    throw new Error("Unsafe fixture cleanup");
  }
  try { fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch (error) { console.warn(`Temporary profile retained at ${resolvedProfile}: ${error.message}`); }
});
app.whenReady().then(async () => {
  try {
    const fixtureSession = session.fromPartition("token-usage-fixture", { cache: false });
    fixtureSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, reply) => reply({ cancel: true }));
    const { build } = require(require.resolve("esbuild", { paths: [require.resolve("tsup")] }));
    await build({ entryPoints: [path.join(__dirname, "fixtures/token-usage-ui.tsx")], outfile: path.join(profile, "fixture.js"),
      bundle: true, platform: "browser", format: "iife", tsconfig: path.join(root, "tsconfig.json"),
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" } });
    const { build: buildStyles } = await import("vite");
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    await buildStyles({ configFile: false, root, plugins: [tailwindcss()], base: "./", logLevel: "warn",
      build: { outDir: path.join(profile, "styles"), emptyOutDir: false, rollupOptions: { input: path.join(root, "src/index.css") } } });
    const stylesheet = fs.readdirSync(path.join(profile, "styles/assets")).find((file) => file.endsWith(".css"));
    if (!stylesheet) throw new Error("Fixture stylesheet missing");
    fs.writeFileSync(path.join(profile, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/assets/${stylesheet}"><style>body{background:var(--background);color:var(--foreground)}main{container-type:inline-size;max-width:920px;margin:0 auto;padding:24px}</style></head><body><script src="fixture.js"></script></body></html>`);
    const win = new BrowserWindow({ show: false, width: 1000, height: 1300, webPreferences: { session: fixtureSession, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on("console-message", (event) => { if (event.level === "error") console.error("renderer:", event.message); });
    await win.loadFile(path.join(profile, "index.html"));
    const checks = await win.webContents.executeJavaScript("window.runTokenUsageChecks()", true);
    for (const check of checks) console.log(`token-ui: ${check}`);
    fs.mkdirSync(output, { recursive: true });
    for (const language of ["en-US", "zh-CN"]) {
      await win.webContents.executeJavaScript(`window.setTokenUsageLanguage(${JSON.stringify(language)})`, true);
      win.webContents.invalidate();
      await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
      fs.writeFileSync(path.join(output, `token-usage-${language}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    }
    await win.webContents.executeJavaScript("window.cleanupTokenUsageChecks()", true);
    win.destroy();
    await fixtureSession.clearStorageData();
    console.log(`token-ui: screenshots saved in ${output}`);
    exitCode = 0;
  } catch (error) { console.error(error); }
  finally { app.exit(exitCode); }
});
