const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const cache = path.resolve(__dirname, "../../.cache/performance-smoke");
fs.mkdirSync(cache, { recursive: true });
app.setPath("userData", path.join(cache, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { backgroundThrottling: false } });
  let exitCode = 0;
  try {
    await win.loadURL(process.env.PERFORMANCE_SMOKE_URL);
    const result = await win.webContents.executeJavaScript(`(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let i = 0; i < 100 && !window.smoke; i++) await wait(100);
  await wait(1500);
  const state = () => {
    const el = document.querySelector('[data-usage-chat]');
    return { rows: document.querySelectorAll('[data-message-id]').length, scrollTop: el?.scrollTop,
      height: el?.scrollHeight, client: el?.clientHeight, text: el?.textContent?.slice(-250) };
  };
  const initial = state();
  window.smoke.setTarget('m10'); await wait(2500);
  const search = { ...state(), found: !!document.querySelector('[data-message-id="m10"]') };
  window.smoke.setTarget(undefined);
  const el = document.querySelector('[data-usage-chat]');
  el.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll'));
  await wait(500); window.smoke.append(); await wait(1000);
  const appended = state();
  const long = 'Long streamed paragraph. '.repeat(1000);
  window.smoke.updateTail(long, true); await wait(200);
  for (let i = 0; i < 10; i++) { window.smoke.updateTail(long + ' tail-' + i, true); await wait(20); }
  window.smoke.updateTail(long + ' COMPLETE $E=mc^2$', false);
  for (let i = 0; i < 100 && !document.querySelector('.katex'); i++) await wait(100);
  const stream = { complete: document.body.textContent.includes('COMPLETE'), math: !!document.querySelector('.katex') };
  window.smoke.setMode('files'); await wait(1500);
  const files = { rows: document.querySelectorAll('[data-index]').length };
  return { initial, search, appended, stream, files };
})()`);
    console.log(JSON.stringify(result, null, 2));
    assert(result.initial.rows > 0 && result.initial.rows < 100, "10k-message chat must be windowed");
    assert(result.search.found, "search must mount an offscreen message");
    assert(result.appended.text.includes("NEW TAIL"), "appended message must be visible");
    assert(Math.abs(result.appended.height - result.appended.scrollTop - result.appended.client) < 2, "bottom lock must survive measurement");
    assert(result.stream.complete && result.stream.math, "final stream and lazy math must render");
    assert(result.files.rows > 0 && result.files.rows < 100, "10k-file explorer must be windowed");
    fs.writeFileSync(path.join(cache, "result.json"), JSON.stringify(result, null, 2));
  } catch (error) { console.error(error); exitCode = 1; }
  finally { win.destroy(); app.exit(exitCode); }
});
