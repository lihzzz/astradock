/** One-shot retirement helper. Preview by default; never starts the old backend. */
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
function checkedRoot(input) {
  if (!input || !path.isAbsolute(input)) throw Error("An explicit absolute --data-dir is required");
  const root = fs.realpathSync(input);
  if (path.basename(root) !== "openacpui-data") throw Error("Expected the application's openacpui-data directory, not its parent or a SiYuan workspace");
  if (fs.lstatSync(input).isSymbolicLink()) throw Error("Refusing a linked data root");
  return root;
}
function checkTree(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw Error("Target escapes application data");
  let current = root;
  for (const part of relative.split(path.sep)) { current = path.join(current, part); if (!fs.existsSync(current)) return; if (fs.lstatSync(current).isSymbolicLink()) throw Error("Refusing linked cleanup target"); }
  if (!fs.existsSync(target)) return;
  const real = fs.realpathSync(target);
  if (real !== target) throw Error("Target identity changed");
  if (fs.statSync(target).isDirectory()) for (const entry of fs.readdirSync(target)) checkTree(root, path.join(target, entry));
}
function inventory(input) {
  const root = checkedRoot(input);
  const targets = ["hindsight", path.join("memory-secrets", "hindsight.json"), "memory-project-config"].map(p => path.join(root, p));
  for (const target of targets) checkTree(root, target);
  return { root, targets: targets.filter(p => fs.existsSync(p)) };
}
function listening(port) { return new Promise(resolve => { const socket = net.connect({ host: "127.0.0.1", port }); const finish = value => { socket.destroy(); resolve(value); }; socket.setTimeout(1000, () => finish(true)); socket.once("connect", () => finish(true)); socket.once("error", error => finish(error.code !== "ECONNREFUSED")); }); }
async function main(argv) {
  const args = new Map(argv.filter(a => a.startsWith("--")).map(a => { const i = a.indexOf("="); return i < 0 ? [a, true] : [a.slice(0, i), a.slice(i + 1)]; }));
  const info = inventory(args.get("--data-dir"));
  const settingsFile = path.join(info.root, "settings.json");
  checkTree(info.root, settingsFile);
  const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : null;
  const oldSettings = !!settings?.memory && settings.memory.schemaVersion !== 2;
  const preview = { mode: "preview", targets: info.targets, removesOldMemorySettings: oldSettings, excluded: ["SiYuan notes/token/bindings/journal", "shared uv/Python/model caches", "other application data"] };
  if (!args.has("--apply")) { console.log(JSON.stringify(preview, null, 2)); return; }
  if (args.get("--confirm") !== "DELETE-HINDSIGHT" || !args.has("--app-and-legacy-service-stopped")) throw Error("Review preview and archive data first. Apply requires --confirm=DELETE-HINDSIGHT --app-and-legacy-service-stopped");
  const port = Number(args.get("--legacy-port") ?? settings?.memory?.localPort ?? 8888);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || await listening(port)) throw Error("Legacy port is occupied or cannot be verified; no data deleted");
  // Revalidate exact targets immediately before each deletion. Never follow links.
  for (const target of info.targets) { checkTree(info.root, target); fs.rmSync(target, { recursive: fs.statSync(target).isDirectory(), force: false }); console.log("Removed:", target); }
  if (oldSettings) { checkTree(info.root, settingsFile); const latest = JSON.parse(fs.readFileSync(settingsFile, "utf8")); if (latest.memory?.schemaVersion === 2) throw Error("Settings changed during cleanup; stop and review"); delete latest.memory; const temp = settingsFile + ".retirement-" + process.pid; try { fs.writeFileSync(temp, JSON.stringify(latest, null, 2), { flag: "wx", encoding: "utf8" }); fs.renameSync(temp, settingsFile); } finally { fs.rmSync(temp, { force: true }); } }
  console.log("Legacy-only cleanup complete. No shared runtimes or SiYuan data were removed.");
}
module.exports = { inventory, checkedRoot, checkTree };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
