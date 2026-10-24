import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { getDataDir } from "../data-dir";
let volatileToken: string | undefined;
export function getMemoryToken(): string {
  if (volatileToken !== undefined) return volatileToken;
  const file = path.join(getDataDir(), "siyuan-token.bin");
  if (!fs.existsSync(file)) return "";
  if (!safeStorage.isEncryptionAvailable()) throw new Error("安全存储不可用，请重新输入思源 Token");
  return safeStorage.decryptString(fs.readFileSync(file));
}
export function setMemoryToken(value: string): { persistent: boolean } {
  const token = value.trim(); if (token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Invalid token");
  const file = path.join(getDataDir(), "siyuan-token.bin");
  if (!token) { fs.rmSync(file, { force: true }); volatileToken = ""; return { persistent: true }; }
  if (!safeStorage.isEncryptionAvailable()) { fs.rmSync(file, { force: true }); volatileToken = token; return { persistent: false }; }
  const temporary = file + "." + randomUUID();
  try { fs.writeFileSync(temporary, safeStorage.encryptString(token), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, file); volatileToken = undefined; }
  finally { fs.rmSync(temporary, { force: true }); }
  return { persistent: true };
}
