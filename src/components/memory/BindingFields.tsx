import type { MemoryReadScope } from "@shared/types/memory";
export const parseIds = (text: string): string[] => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
export function formatScopes(scopes: MemoryReadScope[]): string { return scopes.map((s) => s.notebookId + "/" + s.documentId + (s.includeDescendants ? "/*" : "")).join("\n"); }
export function parseScopes(text: string): MemoryReadScope[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const [notebookId, documentId, descendants, ...extra] = line.split("/"); if (!notebookId || !documentId || extra.length || (descendants && descendants !== "*")) throw new Error("范围格式：笔记本ID/文档ID，可追加 /* 包含子文档"); return { notebookId, documentId, includeDescendants: descendants === "*" }; });
}
export function TextField({ label, value, onChange, multiline = false, disabled = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; disabled?: boolean }) {
  const props = { value, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value), className: "mt-1 w-full rounded border bg-background p-2 text-xs", "aria-label": label };
  return <label className="block space-y-1 text-xs">{label}{multiline ? <textarea {...props} rows={3} /> : <input {...props} />}</label>;
}
