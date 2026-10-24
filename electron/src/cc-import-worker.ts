import fs from "node:fs";
import { createInterface } from "node:readline";
import { parentPort, workerData } from "node:worker_threads";
import { parseClaudeJsonl } from "./lib/cc-import-parser";
async function run(): Promise<void> {
  if (typeof workerData !== "string") throw new Error("Invalid import path");
  const stream = fs.createReadStream(workerData, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try { parentPort?.postMessage(await parseClaudeJsonl(lines)); }
  finally { lines.close(); stream.destroy(); }
}
void run();
