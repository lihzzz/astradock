import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import type { Project } from "@/types";
import { AppDialogContent, AppField, AppSelect, appInputClass } from "./AppFields";
import { unwrapAppResult } from "./app-utils";

export function ProjectAppManifest({ mode, initialContent, projects, activeSpaceId, onClose, onImported }: { mode: "import" | "export"; initialContent: string; projects: Project[]; activeSpaceId: string; onClose: () => void; onImported: () => void }) {
  const { t } = useI18n();
  const [content, setContent] = useState(initialContent);
  const [projectId, setProjectId] = useState(projects.find((p) => (p.spaceId ?? "default") === activeSpaceId)?.id ?? projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const importConfig = async () => {
    setBusy(true); setError(null);
    try { unwrapAppResult(await window.claude.projectApps.importConfig({ content, projectId: projectId || null, spaceId: activeSpaceId })); onImported(); }
    catch (cause) { setError(reportError("project-apps:import", cause)); }
    finally { setBusy(false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "harnss-apps.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}><AppDialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{t(mode === "import" ? "appsImport" : "appsExport")}</DialogTitle><DialogDescription>{t(mode === "import" ? "appsImportHint" : "appsExportHint")}</DialogDescription></DialogHeader>
    {mode === "import" && <><AppField label={t("appsImportProject")}>{(id) => <AppSelect id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">{t("appsNoLocalTarget")}</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</AppSelect>}</AppField><input ref={fileInput} type="file" className="hidden" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setError(t("appsManifestTooLarge")); return; } void file.text().then(setContent).catch((cause) => setError(reportError("project-apps:read-manifest", cause))); }} /><Button variant="outline" onClick={() => fileInput.current?.click()}>{t("appsChooseFile")}</Button></>}
    <AppField label={t("appsManifest")}>{(id) => <textarea id={id} readOnly={mode === "export"} className={`${appInputClass} max-h-[50vh] font-mono text-xs`} rows={14} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />}</AppField>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose} disabled={busy}>{t("appsClose")}</Button>{mode === "import" ? <Button disabled={busy || !content.trim()} onClick={() => void importConfig()}>{t(busy ? "appsImporting" : "appsImport")}</Button> : <><Button variant="outline" onClick={() => { void window.claude.writeClipboardText(content).then((result) => { if (result.error) throw new Error(result.error); setCopied(true); }).catch((cause) => setError(reportError("project-apps:copy-manifest", cause))); }}>{t(copied ? "appsCopied" : "appsCopy")}</Button><Button onClick={download}>{t("appsDownload")}</Button></>}</div>
  </AppDialogContent></Dialog>;
}
