import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingRow } from "@/components/settings/shared";
import { reportError } from "@/lib/analytics/analytics";
import { useI18n } from "@/lib/i18n";
import type { EngineBinaryScanResult, EngineBinarySource } from "@shared/types/settings";

export const ENGINE_BINARY_STRINGS = {
  "en-US": {
    sourceLabel: "Executable source",
    sourceDescription: "Use an existing system installation or choose an executable path. Applies to newly started sessions.",
    systemInstallation: "System installation",
    customPath: "Custom path",
    claudePath: "Custom Claude path",
    codexPath: "Custom Codex path",
    claudePathDescription: "Absolute path to the installed Claude executable (claude, claude.exe, or claude.cmd).",
    codexPathDescription: "Absolute path to the installed Codex executable (codex, codex.exe, or codex.cmd).",
    installations: "System installations",
    scanDescription: "Find installed executables and check their versions. Select a path to use it.",
    scan: "Scan installations",
    scanning: "Scanning…",
    noneFound: "No working installation found. Install the CLI on your system, then scan again, or enter a custom executable path.",
    scanFailed: "Scan failed",
    saveFailed: "Could not save executable path",
    selected: "Currently selected",
    saving: "Saving…",
    unknownVersion: "Version unavailable",
  },
  "zh-CN": {
    sourceLabel: "可执行文件来源",
    sourceDescription: "使用系统中已安装的程序，或指定可执行文件路径。应用于新启动的会话。",
    systemInstallation: "系统安装",
    customPath: "自定义路径",
    claudePath: "自定义 Claude 路径",
    codexPath: "自定义 Codex 路径",
    claudePathDescription: "已安装的 Claude 可执行文件绝对路径（claude、claude.exe 或 claude.cmd）。",
    codexPathDescription: "已安装的 Codex 可执行文件绝对路径（codex、codex.exe 或 codex.cmd）。",
    installations: "系统安装路径",
    scanDescription: "查找已安装的可执行文件并检测版本。选择路径后即可使用。",
    scan: "扫描系统安装",
    scanning: "正在扫描…",
    noneFound: "未找到可用的系统安装。请先在系统中安装 CLI 后重新扫描，或输入自定义可执行文件路径。",
    scanFailed: "扫描失败",
    saveFailed: "保存可执行文件路径失败",
    selected: "当前使用",
    saving: "正在保存…",
    unknownVersion: "版本未知",
  },
};

interface EngineBinaryScannerProps {
  engine: "claude" | "codex";
  source: EngineBinarySource;
  customPath: string;
  onSelectPath: (path: string) => Promise<void>;
}

interface BinarySelectionSnapshot {
  source: EngineBinarySource;
  customPath: string;
  selectedPath: string | null;
}

export const EngineBinaryScanner = memo(function EngineBinaryScanner({
  engine,
  source,
  customPath,
  onSelectPath,
}: EngineBinaryScannerProps) {
  const { language } = useI18n();
  const strings = ENGINE_BINARY_STRINGS[language];
  const [result, setResult] = useState<EngineBinaryScanResult | null>(null);
  const [selection, setSelection] = useState<BinarySelectionSnapshot | null>(null);
  const [scanning, setScanning] = useState(false);
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => () => { requestRef.current += 1; }, []);

  const handleScan = useCallback(async () => {
    const requestId = ++requestRef.current;
    setScanning(true);
    setScanError(null);
    setSaveError(null);
    setResult(null);
    setSelection(null);
    try {
      const next = await (engine === "claude"
        ? window.claude.scanBinaries()
        : window.claude.codex.scanBinaries());
      if (requestId !== requestRef.current) return;
      setResult(next);
      setSelection({ source, customPath, selectedPath: next.selectedPath });
      if (next.error) {
        setScanError(reportError(`${engine.toUpperCase()}_BINARY_SCAN`, new Error(next.error)));
      }
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setScanError(reportError(`${engine.toUpperCase()}_BINARY_SCAN`, error));
    } finally {
      if (requestId === requestRef.current) setScanning(false);
    }
  }, [engine, source, customPath]);

  const handleSelectPath = useCallback(async (path: string) => {
    const requestId = requestRef.current;
    setSavingPath(path);
    setSaveError(null);
    try {
      await onSelectPath(path);
      if (requestId !== requestRef.current) return;
      setSelection({ source: "custom", customPath: path, selectedPath: path });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setSaveError(reportError(`${engine.toUpperCase()}_BINARY_PATH_SAVE`, error));
    } finally {
      if (requestId === requestRef.current) setSavingPath(null);
    }
  }, [engine, onSelectPath]);

  // A resolved path belongs to the saved configuration scanned at that time.
  // Draft input and later settings changes must not reinterpret that result.
  const selectedPath = selection?.source === source && selection.customPath === customPath
    ? selection.selectedPath
    : null;
  const busy = scanning || savingPath !== null;

  return (
    <div>
      <SettingRow label={strings.installations} description={strings.scanDescription}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleScan()}
          disabled={busy}
          aria-label={`${engine === "claude" ? "Claude" : "Codex"}: ${strings.scan}`}
        >
          <RefreshCw className={`h-3 w-3 ${scanning ? "animate-spin" : ""}`} />
          {scanning ? strings.scanning : strings.scan}
        </Button>
      </SettingRow>
      {scanError && <p role="alert" className="mb-2 text-xs text-destructive">{strings.scanFailed}: {scanError}</p>}
      {saveError && <p role="alert" className="mb-2 text-xs text-destructive">{strings.saveFailed}: {saveError}</p>}
      {result && result.candidates.length === 0 && !scanError && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">{strings.noneFound}</p>
      )}
      {result && result.candidates.length > 0 && (
        <ul className="mb-3 max-h-52 space-y-1.5 overflow-y-auto rounded-md border border-foreground/10 p-1.5">
          {result.candidates.map((candidate) => {
            const selected = candidate.path === selectedPath;
            return (
              <li key={candidate.path}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleSelectPath(candidate.path)}
                  disabled={busy}
                  aria-pressed={selected}
                  title={candidate.path}
                  className={`h-auto w-full items-start justify-start gap-2 whitespace-normal px-2 py-2 text-start hover:bg-foreground/5 ${selected ? "bg-foreground/5" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-mono text-xs text-foreground">{candidate.path}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {candidate.version ?? strings.unknownVersion}
                      {selected ? ` · ${strings.selected}` : ""}
                      {savingPath === candidate.path ? ` · ${strings.saving}` : ""}
                    </span>
                  </span>
                  {selected && <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground/70" />}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
