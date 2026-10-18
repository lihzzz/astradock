import type { ConfigReadParams } from "@shared/types/codex-protocol/v2/ConfigReadParams";
import type { ThreadStartParams } from "@shared/types/codex-protocol/v2/ThreadStartParams";
import { reportError } from "./error-utils";
import { isRecord } from "./productivity-errors";

// Output encoding and Get-Content's file decoding are independent in Windows
// PowerShell 5.1. Both settings belong inside each executing shell, not its parent.
export const POWERSHELL_UTF8_SETUP = "$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $PSDefaultParameterValues['Get-Content:Encoding'] = 'utf8';";

export const WINDOWS_SHELL_INSTRUCTIONS = [
  "<astradock-windows-shell>",
  "When running PowerShell commands on this Windows host, prevent text encoding corruption:",
  "- For UTF-8 repository text, always specify -Encoding UTF8 on Get-Content (including its gc, cat, and type aliases), e.g. Get-Content -Raw -Encoding UTF8 -LiteralPath 'CLAUDE.md'. Windows PowerShell 5.1 otherwise decodes BOM-less UTF-8 using the legacy ANSI code page.",
  "- Initialize UTF-8 in each PowerShell process before reading text or invoking native commands:",
  POWERSHELL_UTF8_SETUP,
  "- Put this setup inside the actual -Command/-File script, including nested PowerShell launches and shells started with -NoProfile. A parent shell's settings do not configure a new PowerShell process. Setting only chcp or console output encoding does not fix file decoding.",
  "- Respect files explicitly known to use another encoding. Preserve source-file encodings; do not rewrite files to repair garbled terminal output. Do not modify system code pages, user profiles, or global shell settings.",
  "</astradock-windows-shell>",
].join("\n");

/**
 * Codex owns its shell subprocesses, so changing our app-server spawn environment
 * cannot set Get-Content defaults. Add execution guidance to the thread's developer
 * instructions, preserving the effective user/project configuration and mode prompts.
 */
export async function getCodexShellInstructionOverrides(
  rpc: { request(method: "config/read", params: ConfigReadParams): Promise<unknown> },
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Pick<ThreadStartParams, "developerInstructions">> {
  if (platform !== "win32") return {};
  try {
    const response = await rpc.request("config/read", { cwd, includeLayers: false });
    if (!isRecord(response) || !isRecord(response.config)) throw new Error("Missing effective Codex configuration");
    const existing = response.config.developer_instructions;
    if (existing != null && typeof existing !== "string") throw new Error("Invalid Codex developer instructions");
    return {
      developerInstructions: existing?.includes(WINDOWS_SHELL_INSTRUCTIONS)
        ? existing
        : existing ? `${existing}\n\n${WINDOWS_SHELL_INSTRUCTIONS}` : WINDOWS_SHELL_INSTRUCTIONS,
    };
  } catch (error) {
    // Older/custom servers may not support config/read. Do not replace unknown
    // user instructions (or prevent a session from starting) on that path.
    reportError("CODEX_SHELL_INSTRUCTIONS_ERR", error, { cwd });
    return {};
  }
}
