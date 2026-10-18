import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexShellInstructionOverrides, POWERSHELL_UTF8_SETUP, WINDOWS_SHELL_INSTRUCTIONS } from "../codex-shell-instructions";
import { reportError } from "../error-utils";

vi.mock("../error-utils", () => ({ reportError: vi.fn(() => "error") }));
beforeEach(() => vi.mocked(reportError).mockClear());

function fixture(config: unknown) {
  return { request: vi.fn<(method: string, params: unknown) => Promise<unknown>>().mockResolvedValue({ config }) };
}

describe("Codex Windows shell instructions", () => {
  it("appends to the effective user/project instructions without mutating configuration", async () => {
    const existing = "Custom project rules\n  Preserve my formatting.\n";
    const config = { developer_instructions: existing, model: "custom-model" };
    const rpc = fixture(config);
    const overrides = await getCodexShellInstructionOverrides(rpc, "C:\\project", "win32");
    expect(rpc.request).toHaveBeenCalledExactlyOnceWith("config/read", { cwd: "C:\\project", includeLayers: false });
    expect(overrides).toEqual({ developerInstructions: `${existing}\n\n${WINDOWS_SHELL_INSTRUCTIONS}` });
    expect(config).toEqual({ developer_instructions: existing, model: "custom-model" });
    expect(overrides.developerInstructions).toContain("Get-Content -Raw -Encoding UTF8");
    expect(overrides.developerInstructions).toContain(POWERSHELL_UTF8_SETUP);
    expect(overrides.developerInstructions).toContain("-NoProfile");
    expect(overrides.developerInstructions).toContain("Preserve source-file encodings");
    expect(reportError).not.toHaveBeenCalled();
  });

  it.each([null, undefined, ""])("handles absent/empty developer instructions (%s)", async (developer_instructions) => {
    const rpc = fixture({ developer_instructions });
    await expect(getCodexShellInstructionOverrides(rpc, "C:\\project", "win32"))
      .resolves.toEqual({ developerInstructions: WINDOWS_SHELL_INSTRUCTIONS });
  });

  it("does not duplicate an already applied block on resume", async () => {
    const existing = `User rules\n\n${WINDOWS_SHELL_INSTRUCTIONS}`;
    await expect(getCodexShellInstructionOverrides(fixture({ developer_instructions: existing }), "C:\\project", "win32"))
      .resolves.toEqual({ developerInstructions: existing });
  });

  it.each(["linux", "darwin"] as const)("does not read or override instructions on %s", async (platform) => {
    const rpc = fixture({ developer_instructions: "User rules" });
    await expect(getCodexShellInstructionOverrides(rpc, "/project", platform)).resolves.toEqual({});
    expect(rpc.request).not.toHaveBeenCalled();
  });

  it("leaves unknown user instructions untouched when config/read is unavailable", async () => {
    const rpc = fixture({});
    const error = new Error("Method not found"); rpc.request.mockRejectedValue(error);
    await expect(getCodexShellInstructionOverrides(rpc, "C:\\project", "win32")).resolves.toEqual({});
    expect(reportError).toHaveBeenCalledWith("CODEX_SHELL_INSTRUCTIONS_ERR", error, { cwd: "C:\\project" });
  });

  it.each([{ config: null }, { config: [] }, { config: { developer_instructions: 42 } }])("does not overwrite malformed/unknown config: $config", async ({ config }) => {
    await expect(getCodexShellInstructionOverrides(fixture(config), "C:\\project", "win32")).resolves.toEqual({});
    expect(reportError).toHaveBeenCalledOnce();
  });
});

describe.skipIf(process.platform !== "win32")("real Windows PowerShell UTF-8 regression", () => {
  it("reads BOM-less Chinese/tree/emoji text with -NoProfile and preserves native pipe input", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harnss-powershell-encoding-"));
    const file = path.join(root, "说明[utf8].md");
    const content = "中文说明\n│   ├── acp.ts\n└── 示例 😀 café";
    const originalBytes = Buffer.from(content, "utf8");
    fs.writeFileSync(file, originalBytes);
    const pipeScript = path.join(root, "pipe.cjs");
    fs.writeFileSync(pipeScript, 'const b=[];process.stdin.on("data",x=>b.push(x));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(b).toString("base64")));');
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = (command: string): unknown => JSON.parse(execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HARNSS_ENCODING_FILE: file, HARNSS_ENCODING_NODE: process.execPath, HARNSS_ENCODING_PIPE: pipeScript },
    }));
    try {
      // Setting console UTF-8 alone must not be mistaken for a file-read fix.
      const baseline = run("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @{ text = (Get-Content -Raw -LiteralPath $env:HARNSS_ENCODING_FILE).ToString(); codePage = [Text.Encoding]::Default.CodePage } | ConvertTo-Json -Compress");
      expect(baseline).toHaveProperty("codePage");
      if (typeof baseline === "object" && baseline !== null && "codePage" in baseline && baseline.codePage !== 65001) {
        expect(baseline).not.toHaveProperty("text", content);
      }
      const script = [
        POWERSHELL_UTF8_SETUP,
        "$text = (Get-Content -Raw -LiteralPath $env:HARNSS_ENCODING_FILE).ToString();",
        "$aliasText = (gc -Raw -LiteralPath $env:HARNSS_ENCODING_FILE).ToString();",
        "$explicitText = (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:HARNSS_ENCODING_FILE).ToString();",
        "$native = $text | & $env:HARNSS_ENCODING_NODE $env:HARNSS_ENCODING_PIPE; if ($LASTEXITCODE -ne 0) { throw 'Native pipe failed' };",
        "@{ text = $text; aliasText = $aliasText; explicitText = $explicitText; native = $native } | ConvertTo-Json -Compress",
      ].join("\n");
      expect(run(script)).toEqual({
        text: content, aliasText: content, explicitText: content,
        native: Buffer.from(content + "\r\n", "utf8").toString("base64"),
      });
      expect(fs.readFileSync(file)).toEqual(originalBytes);
    } finally {
      if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("harnss-powershell-encoding-")) throw new Error("Unexpected fixture directory");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
