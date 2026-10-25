import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import ts from "typescript";
const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, ".cache/runtime-optimization"); fs.mkdirSync(directory, { recursive: true });
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, "shared/lib/runtime/message-wire.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = path.join(directory, "message-wire.cjs"); fs.writeFileSync(modulePath, compiled);
const { prepareWireMessages } = createRequire(import.meta.url)(modulePath);
const quick = process.argv.includes("--quick"), samples = quick ? 7 : 60, warmup = quick ? 2 : 5;
function measurePair(first, second) {
  for (let i = 0; i < warmup; i++) { first(); second(); }
  const a = [], b = [];
  const sample = (action, values) => { const start = performance.now(); action(); values.push(performance.now() - start); };
  for (let i = 0; i < samples; i++) {
    if (i % 2) { sample(second, b); sample(first, a); }
    else { sample(first, a); sample(second, b); }
  }
  const stats = raw => { const sorted = [...raw].sort((x, y) => x - y); return { samples: raw, p50Ms: sorted[Math.ceil(samples * .5) - 1], p95Ms: sorted[Math.ceil(samples * .95) - 1], maxMs: sorted.at(-1) }; };
  return [stats(a), stats(b)];
}
const results = [];
for (const [name, count] of [["S", 200], ["M", 2000], ["L", 10000]]) {
  const text = "ordinary code 文本 😀\n".repeat(385);
  const messages = Array.from({ length: count }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user", content: text, timestamp: i, toolInput: { nested: [1, 2] } }));
  let snapshot = prepareWireMessages(messages); let encoded = 0;
  const encode = message => { encoded++; return JSON.stringify(message); };
  const [original, optimized] = measurePair(
    () => { messages[count - 1].content += "x"; messages.map(message => JSON.stringify(message)); },
    () => { messages[count - 1].content += "x"; snapshot = prepareWireMessages(messages.map(message => ({ ...message })), snapshot, encode); },
  );
  // The last interleaved sample can belong to the original path.
  snapshot = prepareWireMessages(messages, snapshot);
  // Validate encoded content separately; timing never buys reduced fidelity.
  if (snapshot.some((entry, index) => entry.json !== JSON.stringify(messages[index]))) throw Error("Snapshot mismatch");
  results.push({ name, messages: count, utf8Bytes: Buffer.byteLength(JSON.stringify(messages)), encodedMessages: encoded, expectedEncodedMessages: samples + warmup,
    original, optimized, improvementPercent: (1 - optimized.p50Ms / original.p50Ms) * 100 });
}
const report = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, totalMemory: os.totalmem(), samples, warmup,
  sampling: "interleaved A/B", scope: "Isolated serialization microbenchmark; not application paint, provider throughput, or end-to-end history latency", results };
fs.writeFileSync(path.join(directory, quick ? "wire-benchmark-quick.json" : "wire-benchmark.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: results.map(({ original, optimized, ...entry }) => ({ ...entry, original: { ...original, samples: undefined }, optimized: { ...optimized, samples: undefined } })) }, null, 2));
