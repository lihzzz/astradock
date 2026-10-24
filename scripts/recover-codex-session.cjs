// Offline, explicitly scoped recovery. Never replay engine events or usage counters.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function lines(text) { return text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
function reconstruct(applicationText, rolloutText, expected) {
  let header = {}; const existing = new Map();
  for (const row of lines(applicationText)) {
    if (row.type === "header") { const { type, ...fields } = row; header = { ...header, ...fields }; }
    else if (row.type === "msg" && typeof row.msg?.id === "string") existing.set(row.msg.id, row.msg);
    else throw new Error("Invalid application record; refusing partial recovery");
  }
  if (header.id !== expected.sessionId || header.projectId !== expected.projectId || header.codexThreadId !== expected.threadId) throw new Error("Application identity mismatch");
  const raw = lines(rolloutText);
  if (raw.find(row => row.type === "session_meta")?.payload?.id !== expected.threadId) throw new Error("Rollout identity mismatch");
  const result = []; const used = new Set(); const recoveredItems = new Map();
  for (const row of raw) {
    if (row.type !== "event_msg" || row.payload.type !== "item_completed") continue;
    const { item, turn_id: turnId } = row.payload;
    if (item.type === "Reasoning") continue; // Do not expose private reasoning or encrypted payloads.
    if (typeof item.id !== "string") throw new Error("Missing item identity");
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error("Invalid item time");
    const base = { id: "recovered-" + item.id, codexItemId: item.id, turnId, timestamp, isStreaming: false };
    let message;
    if (item.type === "UserMessage" || item.type === "AgentMessage") {
      const content = (item.content ?? []).filter(part => typeof part.text === "string").map(part => part.text).join("\n");
      message = { ...base, role: item.type === "UserMessage" ? "user" : "assistant", content };
      if (item.type === "AgentMessage" && item.phase != null) message.phase = item.phase;
      const images = (item.content ?? []).filter(part => part.type === "image").map((part, index) => {
        const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s.exec(part.image_url ?? "");
        if (!match) throw new Error("Unsupported image attachment");
        return { id: item.id + "-image-" + index, mediaType: match[1], data: match[2] };
      });
      if (images.length) message.images = images;
    } else if (item.type === "CommandExecution") {
      message = { ...base, id: "codex-tool-" + item.id, role: "tool_call", content: "", toolName: "Bash",
        toolInput: { command: Array.isArray(item.command) ? item.command.join(" ") : item.command ?? "", description: "cwd: " + (item.cwd ?? "") },
        toolResult: { type: "text", stdout: item.aggregated_output ?? "", ...(item.exit_code != null ? { exitCode: item.exit_code } : {}) },
        toolState: { status: item.status, ...(item.exit_code != null ? { exitCode: item.exit_code } : {}) },
        toolError: item.status === "failed" };
    } else throw new Error("Unsupported visible item type: " + item.type);
    const old = [...existing.values()].find(m => m.codexItemId === item.id || m.id === message.id ||
      (message.role === "user" && m.role === "user" && m.content === message.content && Math.abs(m.timestamp - timestamp) < 10000));
    if (old) { used.add(old.id); message = { ...old, ...message, id: old.id, timestamp: old.timestamp ?? timestamp }; }
    const priorIndex = recoveredItems.get(item.id);
    if (priorIndex !== undefined) result[priorIndex] = { ...result[priorIndex], ...message };
    else { recoveredItems.set(item.id, result.length); result.push(message); }
  }
  if (!result.some(m => m.role === "user")) throw new Error("No recoverable user messages");
  for (const [id, message] of existing) if (!used.has(id)) result.push(message);
  result.sort((a, b) => a.timestamp - b.timestamp);
  if (new Set(result.map(m => m.id)).size !== result.length) throw new Error("Duplicate message IDs");
  for (const id of existing.keys()) if (!result.some(m => m.id === id)) throw new Error("Recovery removed an existing message");
  const lastUser = result.filter(m => m.role === "user").at(-1);
  return { ...header, messages: result, persistenceRevision: (header.persistenceRevision ?? 0) + 1,
    lastMessageAt: lastUser?.timestamp ?? header.lastMessageAt };
}
function applicationRunning(imageName) {
  if (process.platform !== "win32" || !/^[a-zA-Z0-9_.-]+\.exe$/.test(imageName)) throw new Error("Unsupported process guard");
  const output = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq " + imageName, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return output.toLowerCase().includes('"' + imageName.toLowerCase() + '"');
}
async function protectedFiles(root, excluded) {
  const found = new Map();
  async function scan(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && !excluded.has(file)) found.set(file, hash(await fs.readFile(file)));
    }
  }
  await scan(path.join(root, "sessions"));
  for (const entry of await fs.readdir(root)) if (/^usage.*\.json$/.test(entry)) {
    const file = path.join(root, entry); found.set(file, hash(await fs.readFile(file)));
  }
  return found;
}
async function apply(config, isRunning = () => applicationRunning(config.processImage)) {
  if (isRunning()) throw new Error("AstraDock is still running; refusing online recovery");
  for (const id of [config.sessionId, config.projectId]) if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid storage ID");
  const file = path.join(config.dataRoot, "sessions", config.projectId, config.sessionId + ".jsonl");
  const metaFile = file.replace(/\.jsonl$/, ".meta.json");
  const [original, metaBytes, rollout] = await Promise.all([fs.readFile(file), fs.readFile(metaFile), fs.readFile(config.rolloutPath)]);
  const recovered = reconstruct(original.toString("utf8"), rollout.toString("utf8"), config);
  const protectedBefore = await protectedFiles(config.dataRoot, new Set([file, metaFile]));
  const run = path.join(config.backupRoot, "apply-" + Date.now()); await fs.mkdir(run, { recursive: true });
  await Promise.all([fs.writeFile(path.join(run, "original.jsonl"), original), fs.writeFile(path.join(run, "original.meta.json"), metaBytes), fs.writeFile(path.join(run, "rollout.jsonl"), rollout)]);
  const { messages, ...header } = recovered;
  const text = [JSON.stringify({ ...header, type: "header" }), ...messages.map(msg => JSON.stringify({ type: "msg", msg }))].join("\n") + "\n";
  const sidecar = { ...JSON.parse(metaBytes.toString("utf8")), persistenceRevision: header.persistenceRevision, lastMessageAt: header.lastMessageAt };
  const temporary = file + ".recovery-" + crypto.randomUUID();
  const temporaryMeta = metaFile + ".recovery-" + crypto.randomUUID();
  try {
    await fs.writeFile(temporary, text, { flag: "wx" }); await fs.writeFile(temporaryMeta, JSON.stringify(sidecar), { flag: "wx" });
    if (isRunning() || hash(await fs.readFile(file)) !== hash(original) || hash(await fs.readFile(metaFile)) !== hash(metaBytes)
      || hash(await fs.readFile(config.rolloutPath)) !== hash(rollout)) throw new Error("Source changed during recovery; nothing installed");
    await fs.rename(temporary, file); await fs.rename(temporaryMeta, metaFile);
    if (await fs.readFile(file, "utf8") !== text) throw new Error("Recovery readback failed");
    for (const [protectedFile, before] of protectedBefore) if (hash(await fs.readFile(protectedFile)) !== before) throw new Error("Unrelated file changed during recovery: " + protectedFile);
    const report = { status: "restored", sessionId: config.sessionId, count: messages.length,
      users: messages.filter(m => m.role === "user").length, assistants: messages.filter(m => m.role === "assistant").length,
      tools: messages.filter(m => m.role === "tool_call").length, protectedFilesVerified: protectedBefore.size,
      sourceHash: hash(rollout), restoredHash: hash(Buffer.from(text)), backup: run };
    await fs.writeFile(path.join(config.backupRoot, "status.json"), JSON.stringify(report, null, 2)); return report;
  } finally { await fs.unlink(temporary).catch(() => {}); await fs.unlink(temporaryMeta).catch(() => {}); }
}
async function main() {
  const configPath = process.argv[2]; if (!configPath) throw new Error("Usage: node recover-codex-session.cjs config.json [--wait]");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (process.argv.includes("--wait")) {
    await fs.writeFile(path.join(config.backupRoot, "status.json"), JSON.stringify({ status: "waiting-for-app-exit", sessionId: config.sessionId }));
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (applicationRunning(config.processImage)) { if (Date.now() > deadline) throw new Error("Timed out waiting for app exit"); await new Promise(resolve => setTimeout(resolve, 2000)); }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  console.log(JSON.stringify(await apply(config)));
}
module.exports = { reconstruct, apply };
if (require.main === module) main().catch(async error => { console.error(error); process.exitCode = 1;
  try { const config = JSON.parse(await fs.readFile(process.argv[2], "utf8")); await fs.writeFile(path.join(config.backupRoot, "status.json"), JSON.stringify({ status: "failed", error: error.message })); } catch {} });
