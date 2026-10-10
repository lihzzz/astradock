import { memo, useCallback, useEffect, useState } from "react";
import { Brain, Database, KeyRound, Pencil, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { SettingRow, SettingsHeader, SettingsSection, SettingsSelect } from "@/components/settings/shared";
import type { AppSettings } from "@/types";
import type { MemoryDocument, MemoryFact, MemoryMode, MemoryProjectConfig, MemoryStatusResult } from "@shared/types/memory";

interface MemorySettingsProps {
  appSettings: AppSettings | null;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  projectId?: string;
}

const USER_BANK_ID = "harnss-user";

export const MemorySettings = memo(function MemorySettings({ appSettings, onUpdateAppSettings, projectId }: MemorySettingsProps) {
  const memory = appSettings?.memory;
  const [status, setStatus] = useState<MemoryStatusResult | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [projectConfig, setProjectConfig] = useState<MemoryProjectConfig | null>(null);
  const [documents, setDocuments] = useState<MemoryDocument[]>([]);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [editingFact, setEditingFact] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  const refreshStatus = useCallback(async () => {
    const next = await window.claude.memory.getStatus();
    setStatus(next);
    if (next.healthy) {
      const bankIds = [...new Set([USER_BANK_ID, ...next.banks])];
      const results = await Promise.all(bankIds.map((bankId) => window.claude.memory.listDocuments(bankId)));
      const nextDocuments = results.flatMap((result) => result.documents ?? []).filter((item): item is MemoryDocument => typeof item === "object" && item !== null && typeof (item as MemoryDocument).id === "string");
      setDocuments(nextDocuments);
      const memoryResults = await Promise.all(bankIds.map((bankId) => window.claude.memory.listMemories(bankId)));
      setFacts(memoryResults.flatMap((result) => result.memories ?? []));
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus, memory?.enabled]);

  useEffect(() => { setConnectionMessage(null); }, [key, memory?.llmProvider, memory?.llmModel, memory?.llmBaseUrl]);

  useEffect(() => {
    if (!projectId) {
      setProjectConfig(null);
      return;
    }
    void window.claude.memory.getProjectConfig(projectId).then((config) => {
      if (!("error" in config)) setProjectConfig(config);
    });
  }, [projectId]);

  const updateMemory = useCallback(async (patch: Partial<NonNullable<AppSettings["memory"]>>) => {
    if (!memory) return;
    await onUpdateAppSettings({ memory: { ...memory, ...patch } });
  }, [memory, onUpdateAppSettings]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = enabled ? await window.claude.memory.daemonStart() : await window.claude.memory.daemonStop();
      await updateMemory({ enabled: !result.error && enabled });
      setMessage(result.error ?? (enabled ? "Memory daemon started." : "Memory daemon stopped."));
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, updateMemory]);

  const installDependencies = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await window.claude.memory.daemonInstallDeps();
      await updateMemory({ enabled: !result.error });
      setMessage(result.error ?? "uv and Hindsight dependencies are ready.");
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshStatus, updateMemory]);

  const saveKey = useCallback(async () => {
    setBusy(true);
    try {
      const result = key.trim() ? await window.claude.memory.setLlmKey(key.trim()) : await window.claude.memory.clearLlmKey();
      setKey("");
      setMessage(result.error ?? (key.trim() ? "API key saved." : "API key cleared."));
      await refreshStatus();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [key, refreshStatus]);

  const testConnection = useCallback(async () => {
    setBusy(true);
    setConnectionMessage("Testing model connection…");
    try {
      const result = await window.claude.memory.testConnection(key.trim() || undefined);
      setConnectionMessage(result.ok ? (key.trim() ? "Model connection succeeded. Save the API key before enabling long-term memory." : "Model connection succeeded. You can now enable long-term memory.") : (result.error ?? "Connection failed."));
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [key]);

  const updateProjectConfig = useCallback(async (patch: Partial<MemoryProjectConfig>) => {
    if (!projectId) return;
    const next = await window.claude.memory.setProjectConfig(projectId, patch);
    if (!("error" in next)) setProjectConfig(next);
  }, [projectId]);

  const deleteDocument = useCallback(async (bankId: string, documentId: string) => {
    const result = await window.claude.memory.deleteDocument(bankId, documentId);
    if (result.error) { setMessage(result.error); return; }
    setFacts((current) => current.filter((fact) => fact.bankId !== bankId || fact.documentId !== documentId));
    setDocuments((current) => current.filter((document) => document.id !== documentId || document.bankId !== bankId));
  }, []);

  const saveFact = useCallback(async (fact: MemoryFact) => {
    const result = await window.claude.memory.updateMemory(fact.bankId, fact.id, { text: editingText });
    if (result.error) {
      setMessage(result.error);
    } else {
      setFacts((current) => current.map((item) => item.id === fact.id && item.bankId === fact.bankId ? { ...item, text: editingText } : item));
      setMessage("Memory updated.");
    }
    setEditingFact(null);
  }, [editingText]);

  const invalidateFact = useCallback(async (fact: MemoryFact) => {
    const result = await window.claude.memory.updateMemory(fact.bankId, fact.id, { state: "invalidated", reason: "Invalidated from Harnss memory browser" });
    if (result.error) setMessage(result.error);
    else setFacts((current) => current.filter((item) => !(item.id === fact.id && item.bankId === fact.bankId)));
  }, []);

  const runGoldenSet = useCallback(async () => {
    setBusy(true);
    const result = await window.claude.memory.runGoldenSet(USER_BANK_ID);
    setMessage(result.report ? `Golden set F1 ${(result.report.f1 * 100).toFixed(0)}% (${result.report.cases.length} cases).` : (result.error ?? "Golden set failed."));
    setBusy(false);
  }, []);

  if (!memory) return <div className="p-6 text-sm text-muted-foreground">Loading memory settings…</div>;

  return (
    <div className="flex h-full flex-col">
      <SettingsHeader title="Long-term memory" description="Local Hindsight memory shared across Claude, ACP, and Codex sessions." />
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-2">
          <SettingsSection icon={Brain} label="Memory daemon" first>
            <SettingRow label="Enable long-term memory" description="Runs Hindsight locally and makes memory tools available to agents.">
              <Switch checked={memory.enabled} onCheckedChange={(checked) => void toggleEnabled(checked)} disabled={busy} />
            </SettingRow>
            <SettingRow label="Status" description={status?.baseUrl ?? `Port ${memory.localPort}`}>
              <div className="flex items-center gap-2"><span className={`text-xs ${status?.healthy ? "text-emerald-600" : "text-muted-foreground"}`}>{status?.healthy ? "Healthy" : status?.running ? "Starting" : "Stopped"}</span>{status && (!status.uv.installed || !status.healthy) && <Button size="sm" variant="outline" onClick={() => void (status.uv.installed ? toggleEnabled(true) : installDependencies())} disabled={busy}>{status.uv.installed ? "Retry" : "Install uv"}</Button>}</div>
            </SettingRow>
            <SettingRow label="Port" description="The local HTTP port used by the Hindsight daemon.">
              <Input className="w-24" type="number" min={1024} max={65535} defaultValue={memory.localPort} onBlur={(event) => void updateMemory({ localPort: Math.max(1024, Math.min(65535, Number(event.target.value) || 8888)) })} />
            </SettingRow>
          </SettingsSection>

          <SettingsSection icon={KeyRound} label="LLM provider">
            <SettingRow label="Provider" description="Provider name understood by Hindsight (for example anthropic or openai).">
              <Input className="w-44" value={memory.llmProvider ?? "anthropic"} onChange={(event) => void updateMemory({ llmProvider: event.target.value })} />
            </SettingRow>
            <SettingRow label="Model" description="Model used for extraction and recall.">
              <Input className="w-56" value={memory.llmModel ?? "claude-sonnet-4-20250514"} onChange={(event) => void updateMemory({ llmModel: event.target.value })} />
            </SettingRow>
            <SettingRow label="Base URL in use" description="The endpoint reported by the daemon status; empty means the provider default.">
              <code className="max-w-[20rem] truncate rounded-sm bg-muted/60 px-2 py-1 text-xs text-foreground/70">{status?.llmBaseUrl || "Provider default"}</code>
            </SettingRow>
            <SettingRow label="Base URL" description="Custom OpenAI-compatible endpoint; leave empty for the provider default.">
              <Input className="w-72" placeholder="https://api.example.com/v1" value={memory.llmBaseUrl ?? ""} onChange={(event) => void updateMemory({ llmBaseUrl: event.target.value.trim() })} />
            </SettingRow>
            <SettingRow label="API key" description={status?.hasLlmKey ? "A key is stored in the encrypted main-process store." : "The key is never exposed to the renderer after saving."}>
              <div className="flex gap-2"><Input className="w-44" type="password" placeholder={status?.hasLlmKey ? "••••••••" : "Paste key"} value={key} onChange={(event) => setKey(event.target.value)} /><Button size="sm" variant="outline" onClick={() => void saveKey()} disabled={busy}>{key ? "Save" : "Clear"}</Button></div>
            </SettingRow>
            <div className="flex justify-end gap-2 pb-2"><Button size="sm" variant="outline" onClick={() => void testConnection()} disabled={busy}><Server className="me-1 h-3.5 w-3.5" /> Test connection</Button><Button size="sm" variant="ghost" onClick={() => void refreshStatus()} disabled={busy}><RefreshCw className="me-1 h-3.5 w-3.5" /> Refresh</Button></div>
            <p className="pb-2 text-xs text-muted-foreground" role="status">{connectionMessage ?? "Test the model connection before enabling long-term memory. Testing does not save the API key."}</p>
          </SettingsSection>

          <SettingsSection icon={Database} label="Recall and retention">
            <SettingRow label="Injection" description="When recalled memories are added to a prompt.">
              <SettingsSelect value={memory.injectionPolicy} onValueChange={(value) => void updateMemory({ injectionPolicy: value })} options={[{ value: "first-turn", label: "First turn" }, { value: "every-turn", label: "Every turn" }, { value: "off", label: "Off" }]} />
            </SettingRow>
            <SettingRow label="Recall budget" description="Higher budgets can return more relevant context at greater latency.">
              <SettingsSelect value={memory.recallBudget} onValueChange={(value) => void updateMemory({ recallBudget: value })} options={[{ value: "low", label: "Low" }, { value: "mid", label: "Medium" }, { value: "high", label: "High" }]} />
            </SettingRow>
            <SettingRow label="Automatic retention" description="Retain completed user and assistant turns for projects in Auto mode.">
              <Switch checked={memory.autoRetain} onCheckedChange={(checked) => void updateMemory({ autoRetain: checked })} />
            </SettingRow>
            <SettingRow label="Client-side secret redaction" description="Redact common API keys and tokens before sending text to Hindsight.">
              <Switch checked={memory.clientSideRedact} onCheckedChange={(checked) => void updateMemory({ clientSideRedact: checked })} />
            </SettingRow>
            <SettingRow label="Hindsight memory defense" description="Server-side handling for detected secrets and prompt injection in retained content.">
              <SettingsSelect value={memory.memoryDefense} onValueChange={(value) => void updateMemory({ memoryDefense: value })} options={[{ value: "redact", label: "Redact" }, { value: "block", label: "Block" }, { value: "off", label: "Off" }]} />
            </SettingRow>
          </SettingsSection>

          {projectId && projectConfig && <SettingsSection label="Current project">
            <SettingRow label="Project memory mode" description="Manual is opt-in through /remember; Auto also retains completed turns.">
              <SettingsSelect<MemoryMode> value={projectConfig.memoryMode} onValueChange={(value) => void updateProjectConfig({ memoryMode: value })} options={[{ value: "manual", label: "Manual" }, { value: "auto", label: "Auto" }, { value: "off", label: "Off" }]} />
            </SettingRow>
            <SettingRow label="Isolate project memories" description="Keep this project out of the shared user memory bank.">
              <Switch checked={projectConfig.memoryIsolated} onCheckedChange={(checked) => void updateProjectConfig({ memoryIsolated: checked })} />
            </SettingRow>
          </SettingsSection>}

          <SettingsSection icon={Database} label="Memory browser">
            <div className="flex justify-end pb-2"><Button size="sm" variant="outline" onClick={() => void runGoldenSet()} disabled={busy || !memory.enabled}>Run golden set</Button></div>
            {documents.length === 0 ? <p className="py-3 text-xs text-muted-foreground">No memories retained yet.</p> : documents.map((document) => <div key={`${document.bankId}:${document.id}`} className="flex items-center gap-3 border-b border-foreground/[0.04] py-2 last:border-0"><div className="min-w-0 flex-1"><p className="truncate text-xs text-foreground/80">{document.originalText ?? document.id}</p><p className="truncate text-[10px] text-muted-foreground">{document.bankId}</p></div><Button size="sm" variant="ghost" className="text-destructive" onClick={() => void deleteDocument(document.bankId, document.id)}>Delete</Button></div>)}
            {facts.length > 0 && <div className="mt-3 border-t border-foreground/[0.06] pt-2"><p className="pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Facts and provenance</p>{facts.map((fact) => <div key={`${fact.bankId}:${fact.id}`} className="border-b border-foreground/[0.04] py-2 last:border-0"><div className="flex items-start gap-2"><div className="min-w-0 flex-1">{editingFact === `${fact.bankId}:${fact.id}` ? <Input value={editingText} onChange={(event) => setEditingText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveFact(fact); if (event.key === "Escape") setEditingFact(null); }} autoFocus /> : <p className="text-xs text-foreground/80">{fact.text}</p>}<p className="mt-1 text-[10px] text-muted-foreground">{fact.bankId} · {fact.factType ?? "fact"}{fact.documentId ? ` · document ${fact.documentId}` : ""}{fact.sourceMemoryIds?.length ? ` · sources ${fact.sourceMemoryIds.join(", ")}` : ""}</p></div>{fact.factType === "observation" ? <span className="text-[10px] text-muted-foreground">Derived</span> : editingFact === `${fact.bankId}:${fact.id}` ? <Button size="sm" variant="outline" onClick={() => void saveFact(fact)}>Save</Button> : <><Button size="icon" variant="ghost" aria-label="Edit memory" onClick={() => { setEditingFact(`${fact.bankId}:${fact.id}`); setEditingText(fact.text); }}><Pencil className="h-3.5 w-3.5" /></Button><Button size="sm" variant="ghost" className="text-destructive" onClick={() => void invalidateFact(fact)}>Invalidate</Button></>}</div></div>)}</div>}
          </SettingsSection>
          {message && <p className="px-1 pb-4 text-xs text-muted-foreground">{message}</p>}
        </div>
      </ScrollArea>
    </div>
  );
});
