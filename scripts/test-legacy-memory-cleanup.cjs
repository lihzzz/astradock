const test = require("node:test"); const assert = require("node:assert/strict"); const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path"); const { inventory } = require("./cleanup-legacy-memory.cjs");
test("retirement inventory includes only exact legacy-owned entries", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-memory-test-")); const root = path.join(temp, "openacpui-data");
  try { for (const dir of ["hindsight", "siyuan-project-bindings", "sessions", "memory-secrets"]) fs.mkdirSync(path.join(root, dir), { recursive: true }); fs.writeFileSync(path.join(root, "memory-secrets", "hindsight.json"), "fixture");
    const result = inventory(root); assert.equal(result.targets.length, 2); assert.ok(result.targets.every(p => !p.includes("siyuan") && !p.endsWith("sessions"))); assert.ok(fs.existsSync(path.join(root, "hindsight"))); assert.throws(() => inventory(temp));
    fs.symlinkSync(path.join(root, "sessions"), path.join(root, "hindsight", "linked"), "junction"); assert.throws(() => inventory(root), /linked/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
