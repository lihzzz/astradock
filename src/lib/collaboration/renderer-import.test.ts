import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SHARED_COLLABORATION = path.join(ROOT, "shared/lib/collaboration.ts");

const NODE_BUILTIN = /^(?:node:)?(?:url|path|fs|os|child_process|stream|crypto|module|buffer|fs\/promises)$/;
const IMPORT_SPEC = /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/g;

describe("collaboration renderer imports", () => {
  it("keeps Node builtins out of the shared module the renderer loads", () => {
    const offenders = nodeBuiltinImports(SHARED_COLLABORATION);
    expect(offenders).toEqual([]);
  });

  it("flags the Node url import that blanked the renderer", () => {
    expect(importSpecifiers('import { fileURLToPath } from "url";\n')).toContain("url");
    expect(importSpecifiers('import path from "path";\n')).toContain("path");
    expect(NODE_BUILTIN.test("node:url")).toBe(true);
  });

  it("keeps Node builtins out of every module reachable from renderer collaboration imports", () => {
    const entries = rendererFilesImportingSharedCollaboration();
    expect(entries.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      offenders.push(...walk(entry, seen));
    }
    expect(offenders).toEqual([]);
  });
});

function rendererFilesImportingSharedCollaboration(): string[] {
  const files: string[] = [];
  walkDir(path.join(ROOT, "src"), (file) => {
    if (!/\.(ts|tsx)$/.test(file) || file.endsWith(".test.ts") || file.endsWith(".test.tsx")) return;
    const source = fs.readFileSync(file, "utf8");
    if (source.includes("@shared/lib/collaboration")) files.push(file);
  });
  return files;
}

function walk(file: string, seen: Set<string>): string[] {
  const resolved = path.resolve(file);
  if (seen.has(resolved) || !fs.existsSync(resolved)) return [];
  seen.add(resolved);
  if (!resolved.startsWith(ROOT + path.sep)) return [];

  const source = fs.readFileSync(resolved, "utf8");
  const offenders: string[] = [];
  for (const spec of importSpecifiers(source)) {
    if (NODE_BUILTIN.test(spec)) {
      offenders.push(`${path.relative(ROOT, resolved)} imports "${spec}"`);
      continue;
    }
    if (spec.startsWith(".")) {
      const next = resolveRelative(path.dirname(resolved), spec);
      if (next) offenders.push(...walk(next, seen));
    }
    if (spec === "@shared/lib/collaboration" || spec.startsWith("@shared/lib/collaboration")) {
      offenders.push(...walk(SHARED_COLLABORATION, seen));
    }
  }
  return offenders;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPEC)].map((match) => match[1] ?? "");
}

function resolveRelative(dir: string, spec: string): string {
  const base = path.resolve(dir, spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? "";
}

function nodeBuiltinImports(file: string): string[] {
  return importSpecifiers(fs.readFileSync(file, "utf8"))
    .filter((spec) => NODE_BUILTIN.test(spec))
    .map((spec) => `${path.relative(ROOT, file)} imports "${spec}"`);
}

function walkDir(dir: string, visit: (file: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkDir(full, visit);
    } else {
      visit(full);
    }
  }
}
