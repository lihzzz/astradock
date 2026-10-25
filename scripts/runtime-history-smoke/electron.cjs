const { app, BrowserWindow, ipcMain } = require("electron");
const { Worker } = require("node:worker_threads");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
let directory, worker, window;
const pending = new Map();
const calls = [];
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Timed out: ${expression}`);
}
(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-history-ui-"));
  app.setPath("userData", path.join(directory, "profile"));
  await app.whenReady();
  const source = path.join(directory, "fixture.jsonl");
  const rows = Array.from({ length: 250 }, (_, i) => ({ type: "msg", msg: { id: `message-${i}`, role: i % 2 ? "assistant" : "user", content: i === 249 ? "大工具输出 😀\n".repeat(30000) : `Generated message ${i}: no user data or provider access.`, timestamp: i } }));
  await fs.writeFile(source, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  worker = new Worker(path.join(root, "electron/dist/runtime-history-worker.js"), { workerData: { directory: path.join(directory, "index") } });
  worker.on("message", reply => { const callback = pending.get(reply.id); if (callback) { pending.delete(reply.id); callback(reply); } });
  ipcMain.handle("fixture:history", async (_event, kind, query) => {
    const id = randomUUID(); calls.push(kind);
    const response = await new Promise(resolve => { pending.set(id, resolve); worker.postMessage({ id, kind, query, source }); });
    if (!response.ok) return response;
    return kind === "page" ? { ok: true, page: response.value } : { ok: true, chunk: response.value };
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true } });
  window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) console.error("RENDERER", message); });
  await window.loadURL(process.env.RUNTIME_HISTORY_SMOKE_URL);
  await until("document.querySelectorAll('[data-index]').length > 0");
  assert(await window.webContents.executeJavaScript("document.body.textContent.includes('250')"));
  await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => /Older messages|更早的消息/.test(b.textContent)).click()");
  await until("document.body.textContent.includes('Generated message 150')");
  await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => /Latest messages|最新消息/.test(b.textContent)).click()");
  await until("document.body.textContent.includes('Generated message 200')");
  await window.webContents.executeJavaScript("const el = document.querySelector('[aria-label=\"Saved conversation history\"], [aria-label=\"已保存的会话历史\"]'); el.scrollTop = el.scrollHeight;");
  await until("[...document.querySelectorAll('button')].some(b => /Read next content chunk|读取下一段内容/.test(b.textContent))");
  await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b => /Read next content chunk|读取下一段内容/.test(b.textContent)).click()");
  await until("document.body.textContent.includes('大工具输出')");
  const output = path.join(root, ".cache/runtime-optimization"); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "history-ui.png"), (await window.webContents.capturePage()).toPNG());
  const report = { status: "passed", platform: process.platform, electron: process.versions.electron, sourceMessages: 250, calls, visibleRows: await window.webContents.executeJavaScript("document.querySelectorAll('[data-index]').length"), sourceUntouched: (await fs.readFile(source, "utf8")) === rows.map(row => JSON.stringify(row)).join("\n") + "\n", scope: "Hidden Electron UI + production history worker with generated data; not a provider or installed-package acceptance test" };
  assert(report.sourceUntouched); assert(report.visibleRows < 50); assert(calls.includes("chunk"));
  await fs.writeFile(path.join(output, "history-ui.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  window?.destroy(); await worker?.terminate();
  if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith("astradock-history-ui-")) await fs.rm(directory, { recursive: true, force: true }).catch(error => console.error("Fixture cleanup", error.message));
  app.exit(process.exitCode || 0);
});
