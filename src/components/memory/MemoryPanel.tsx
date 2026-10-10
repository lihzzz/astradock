import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Brain, RefreshCw } from "lucide-react";
import { PanelHeader } from "@/components/PanelHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import type { MemoryDocument, MemoryFact, MemoryProjectConfig } from "@shared/types/memory";

interface Props { projectId: string | null; headerControls: ReactNode }
export function MemoryPanel({ projectId, headerControls }: Props) {
  const { t } = useI18n();
  const [scope, setScope] = useState<"project" | "user">("project");
  const [bank, setBank] = useState("");
  const [config, setConfig] = useState<MemoryProjectConfig | null>(null);
  const [documents, setDocuments] = useState<MemoryDocument[]>([]);
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [text, setText] = useState("");
  const [edit, setEdit] = useState<MemoryFact | null>(null);
  const [editText, setEditText] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    setReady(false); setDocuments([]); setFacts([]); setSources({}); setMessage("");
    try {
      if (!projectId) return;
      const [status, binding, nextConfig] = await Promise.all([window.claude.memory.getStatus(), window.claude.memory.projectBank(projectId), window.claude.memory.getProjectConfig(projectId)]);
      if (version !== generation.current) return;
      if (binding.error || !binding.bankId) throw new Error(binding.error ?? "Project unavailable");
      if ("error" in nextConfig) throw new Error(nextConfig.error);
      setConfig(nextConfig);
      if (!status.enabled || !status.healthy) throw new Error(t("Enable and configure long-term memory in Settings first."));
      if (scope === "user" && nextConfig.memoryIsolated) throw new Error(t("This project is isolated from personal memory."));
      const bankId = scope === "user" ? "harnss-user" : binding.bankId;
      const [docs, units] = await Promise.all([window.claude.memory.listDocuments(bankId), window.claude.memory.listMemories(bankId)]);
      if (version !== generation.current) return;
      if (docs.error || units.error) throw new Error(docs.error || units.error);
      setBank(bankId); setDocuments(docs.documents ?? []); setFacts(units.memories ?? []); setReady(true);
    } catch (error) {
      const detail = reportError("MEMORY_PANEL_LOAD", error);
      if (version === generation.current) setMessage(detail);
    }
  }, [projectId, scope, t]);
  useEffect(() => { setEdit(null); setDeleting(null); void refresh(); }, [refresh]);
  const loadSource = async (id: string) => {
    const version = generation.current;
    try {
      const result = await window.claude.memory.getDocument(bank, id);
      if (result.error) throw new Error(result.error);
      if (version === generation.current) setSources((current) => ({ ...current, [id]: result.text ?? "" }));
    } catch (error) {
      const detail = reportError("MEMORY_SOURCE", error);
      if (version === generation.current) setMessage(detail);
    }
  };
  const perform = async (operation: () => Promise<{ error?: string }>, saved = false) => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    try {
      const result = await operation();
      if (result.error) throw new Error(result.error);
      if (!mounted.current) return;
      if (saved) setText("");
      setEdit(null); setDeleting(null);
      await refresh();
    } catch (error) {
      const detail = reportError("MEMORY_PANEL_ACTION", error);
      if (mounted.current) setMessage(detail);
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <PanelHeader icon={Brain} label={t("Long-term memory")}>{headerControls}</PanelHeader>
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs">
      <p className="text-muted-foreground">{t("Memory extraction may send text to your configured model provider. Memory is context, not an instruction.")}</p>
      {!projectId ? <p>{t("Open a project to manage memory.")}</p> : <>
        <div className="flex gap-2"><select aria-label={t("Memory scope")} className="min-w-0 flex-1 rounded border bg-background p-2" value={scope} disabled={busy || !!text.trim() || !!edit} onChange={(event) => setScope(event.target.value === "user" ? "user" : "project")}><option value="project">{t("Project memory")}</option><option value="user" disabled={config?.memoryIsolated}>{t("Personal memory (shared across projects)")}</option></select><Button size="sm" variant="ghost" aria-label={t("Refresh")} disabled={busy} onClick={() => void refresh()}><RefreshCw className="h-3.5 w-3.5" /></Button></div>
        {config ? <label className="block">{t("Project memory mode")}<select className="ms-2 rounded border bg-background p-1" value={config.memoryMode} disabled={busy} onChange={(event) => { const mode = event.target.value; if (mode === "auto" || mode === "manual" || mode === "off") void perform(async () => { const result = await window.claude.memory.setProjectConfig(projectId, { memoryMode: mode }); return "error" in result ? result : {}; }); }}><option value="manual">{t("Manual")}</option><option value="auto">{t("Automatic")}</option><option value="off">{t("Off")}</option></select></label> : null}
        <form onSubmit={(event) => { event.preventDefault(); void perform(() => window.claude.memory.retainProject(projectId, text, scope), true); }} className="space-y-2">
          <textarea aria-label={t("Remember this")} placeholder={t("Remember this")} className="min-h-24 w-full rounded border bg-background p-2" maxLength={20000} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
          <Button size="sm" disabled={busy || !ready || config?.memoryMode === "off" || text.trim().length < 3}>{t(busy ? "Saving…" : "Save memory")}</Button>
        </form>
        {message ? <p role="alert" className="whitespace-pre-wrap wrap-break-word text-destructive">{message}</p> : null}
        <Input aria-label={t("Filter loaded memories")} placeholder={t("Filter loaded memories")} value={query} onChange={(event) => setQuery(event.target.value)} />
        <p className="text-muted-foreground">{t("Showing up to 100 documents and 100 facts in this scope. Refresh after external changes.")}</p>
        {ready && !facts.length && !documents.length ? <p>{t("No memories yet.")}</p> : null}
        {facts.filter((fact) => fact.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((fact) => <article key={fact.id} className="space-y-2 rounded border p-2">
          {edit?.id === fact.id ? <><textarea aria-label={t("Edit memory")} className="min-h-20 w-full rounded border bg-background p-2" maxLength={20000} value={editText} onChange={(event) => setEditText(event.target.value)} /><Button size="sm" disabled={busy || !editText.trim()} onClick={() => void perform(() => window.claude.memory.updateMemory(bank, fact.id, { text: editText }))}>{t("Save")}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setEdit(null)}>{t("Cancel")}</Button></> : <p className="whitespace-pre-wrap wrap-break-word">{fact.text}</p>}
          <p className="wrap-break-word text-muted-foreground">{fact.factType} · {fact.updatedAt} · {fact.documentId}</p>
          {fact.sourceMemoryIds?.length ? <p className="wrap-break-word">{t("Source facts")}: {fact.sourceMemoryIds.join(", ")}</p> : null}
          {fact.factType !== "observation" && !edit ? <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => { setEdit(fact); setEditText(fact.text); }}>{t("Edit memory")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(() => window.claude.memory.updateMemory(bank, fact.id, { state: "invalidated", reason: "User invalidated from memory panel" }))}>{t("Invalidate")}</Button></div> : null}
        </article>)}
        <h3 className="font-semibold">{t("Source documents")}</h3>
        {documents.filter((doc) => (doc.originalText ?? doc.id).toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((doc) => <details key={doc.id} onToggle={(event) => { if (event.currentTarget.open && sources[doc.id] === undefined) void loadSource(doc.id); }} className="rounded border p-2"><summary className="cursor-pointer wrap-break-word">{doc.id}</summary><p className="my-2 max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word">{sources[doc.id] ?? t("Loading source…")}</p><p>{doc.createdAt}</p>{deleting === doc.id ? <div><p>{t("Delete this source document and its associated memories?")}</p><Button size="sm" variant="destructive" disabled={busy} onClick={() => void perform(() => window.claude.memory.deleteDocument(bank, doc.id))}>{t("Confirm delete")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>{t("Cancel")}</Button></div> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleting(doc.id)}>{t("Delete")}</Button>}</details>)}
      </>}
    </div>
  </div>;
}
