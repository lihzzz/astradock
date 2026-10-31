import fs from "node:fs/promises";
import path from "node:path";
import { councilSnapshotSchema } from "@shared/lib/council";
import type { CouncilSnapshot } from "@shared/types/council";
import { writeJsonAtomically } from "../atomic-file";
import { isMissingFile, ProductivityError } from "../productivity-errors";
const MAX_BYTES = 32 * 1024 * 1024;
export class CouncilRepository {
  constructor(readonly root: string) {
  }
  async load(): Promise<CouncilSnapshot> {
    const file = path.join(this.root, "catalog.json");
    try {
      if ((await fs.stat(file)).size > MAX_BYTES)
        throw new Error("Council catalog is too large");
      return councilSnapshotSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    }
    catch (e) {
      if (isMissingFile(e))
        return {
          version: 1,
          revision: 0,
          councils: [],
          runs: []
        };
      throw new ProductivityError("CONFIG_INVALID", "Council catalog is damaged or unsupported; original file preserved");
    }
  }
  async save(value: CouncilSnapshot): Promise<void> {
    councilSnapshotSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES)
      throw new ProductivityError("CAPACITY_REACHED", "Council storage limit reached; remove old discussions");
    await fs.mkdir(this.root, { recursive: true });
    await writeJsonAtomically(path.join(this.root, "catalog.json"), value);
  }
}
