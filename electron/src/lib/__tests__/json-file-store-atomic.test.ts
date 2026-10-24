import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const context = vi.hoisted(() => ({ root: "", encryption: true }));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => context.encryption,
  encryptString: (text: string) => Buffer.from("encrypted:" + text), decryptString: (value: Buffer) => value.toString().slice(10) } }));
vi.mock("../data-dir", () => ({ getDataDir: () => context.root }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../error-utils", () => ({ reportError: vi.fn() }));
import { JsonFileStore } from "../json-file-store";
beforeEach(() => { context.root = fs.mkdtempSync(path.join(os.tmpdir(), "astradock-secrets-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(context.root, { recursive: true, force: true }); });
describe.each([true, false])("secret atomic writes (encryption available: %s)", (encryption) => {
  it("preserves the previous credential when replacement fails and removes temporary files", () => {
    context.encryption = encryption;
    const store = new JsonFileStore<{ token: string }>({ subDir: "secret", encrypt: true, label: "test" });
    store.save("key", { token: "old" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk failure"); });
    expect(() => store.save("key", { token: "new" })).toThrow("disk failure");
    rename.mockRestore(); expect(store.load("key")).toEqual({ token: "old" });
    expect(fs.readdirSync(path.join(context.root, "secret"))).toEqual(["key.json"]);
  });
});
