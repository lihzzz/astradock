import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
function load(file, transform = source => source) {
  const exports = {};
  const source = transform(fs.readFileSync(path.join(root, file), "utf8"));
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, Intl }, { filename: file });
  return exports;
}
function measure(action) {
  action(); const samples = [];
  for (let i = 0; i < 7; i++) { const start = performance.now(); action(); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { medianMs: +samples[3].toFixed(2), maxMs: +samples[6].toFixed(2) };
}
const current = load("src/lib/file-tree.ts");
const previous = load("src/lib/file-tree.ts", source => source.replace("fileNameCollator.compare(a.name, b.name)", 'a.name.localeCompare(b.name, undefined, { sensitivity: "base" })'));
const results = [];
for (const count of [1000, 10000]) {
  const files = Array.from({ length: count }, (_, i) => `packages/pkg-${i % 20}/src/module-${(i * 7919) % count}.tsx`);
  assert.equal(JSON.stringify(current.buildFileTree(files)), JSON.stringify(previous.buildFileTree(files)));
  results.push({ name: "file-tree", files: count, previous: measure(() => previous.buildFileTree(files)), current: measure(() => current.buildFileTree(files)) });
}
const history = load("electron/src/lib/terminal-history.ts");
results.push({ name: "terminal-history-100k-chunks", ...measure(() => {
  let state = history.EMPTY_TERMINAL_HISTORY;
  for (let i = 0; i < 100000; i++) state = history.appendTerminalHistory(state, "output-line\n");
  assert(state.totalChars <= history.MAX_TERMINAL_HISTORY_CHARS);
}) });
const htmlPath = path.join(root, "dist/index.html");
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, "utf8");
  const entry = /<script[^>]*src="([^"]+\.js)"/.exec(html)?.[1];
  if (entry) { const data = fs.readFileSync(path.join(root, "dist", entry)); results.push({ name: "built-entry", bytes: data.length, gzip: gzipSync(data).length }); }
}
console.log(JSON.stringify(results, null, 2));
