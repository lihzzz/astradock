import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { MemoryProjectConfig } from "@shared/types/memory";
import { TextField, formatScopes, parseScopes, parseIds } from "./BindingFields";
export function ProjectMemorySettings({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<MemoryProjectConfig | null>(null); const [scopes, setScopes] = useState(""); const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { let active = true; setConfig(null); setMessage(""); void window.claude.memory.getProjectConfig(projectId).then((result) => { if (!active) return; if (result.error) setMessage(result.error); else if (result.value) { setConfig(result.value); setScopes(formatScopes(result.value.readScopes)); setSummary(result.value.summaryBlockIds.join("\n")); } }).catch(() => { if (active) setMessage("无法读取项目记忆配置"); }); return () => { active = false; }; }, [projectId]);
  async function save() { if (!config || busy) return; setBusy(true); try { const result = await window.claude.memory.setProjectConfig(projectId, { ...config, summaryBlockIds: parseIds(summary), readScopes: parseScopes(scopes) }); if (result.error) throw new Error(result.error); if (result.value) setConfig(result.value); setMessage("项目绑定已保存。启用后 Agent 自动追加，不逐条确认。"); } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { setBusy(false); } }
  return <section className="space-y-3 rounded border p-3"><h3 className="text-sm font-medium">项目记忆绑定</h3>{config ? <>
    <label className="flex gap-2 text-xs"><input type="checkbox" checked={config.enabled} disabled={busy} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />启用项目长期记忆与自动追加</label>
    <TextField label="指定写入文档 ID（只追加，不修改已有笔记）" value={config.writeDocumentId} onChange={(writeDocumentId) => setConfig({ ...config, writeDocumentId })} disabled={busy} />
    <TextField label="只读范围：每行 笔记本ID/文档ID；追加 /* 包含子文档" value={scopes} onChange={setScopes} multiline disabled={busy} />
    <TextField label="摘要块 ID（每行一个；必须位于读取范围或写入文档中）" value={summary} onChange={setSummary} multiline disabled={busy} />
    <label className="flex gap-2 text-xs"><input type="checkbox" checked={config.includePersonalMemory} disabled={busy} onChange={(e) => setConfig({ ...config, includePersonalMemory: e.target.checked })} />允许使用全局已授权的个人记忆</label>
    <Button size="sm" disabled={busy} onClick={() => void save()}>保存项目绑定</Button></> : null}<p role="status" className="text-xs whitespace-pre-wrap">{message}</p></section>;
}
