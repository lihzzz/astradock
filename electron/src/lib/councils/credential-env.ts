import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord, isMissingFile } from "../productivity-errors";
// Authentication/provider routing only. Never import hooks, permissions, plugins,
// MCP, apiKeyHelper commands, NODE_OPTIONS, or arbitrary settings environment.
const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"] as const;
export function selectCouncilCredentialEnv(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.env))
    return {};
  const env: Record<string, string> = {};
  for (const key of KEYS) {
    const item = value.env[key];
    if (typeof item === "string" && item.length <= 16000 && !item.includes(String.fromCharCode(0)))
      env[key] = item;
  }
  return env;
}
export async function councilCredentialEnv(): Promise<Record<string, string>> {
  const directory = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const file = path.join(directory, "settings.json");
  try {
    if ((await fs.stat(file)).size > 1024 * 1024)
      throw new Error("Claude user settings exceed the safe read limit");
    return selectCouncilCredentialEnv(JSON.parse(await fs.readFile(file, "utf8")));
  }
  catch (e) {
    if (isMissingFile(e))
      return {};
    throw new Error("Cannot read Claude credential configuration. Fix user settings; no policy fallback was applied.");
  }
}
