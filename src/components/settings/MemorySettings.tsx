import { memo, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AppSettings } from "@/types";
import type { MemorySettings as MemoryConfig, MemoryStatusResult } from "@shared/types/memory";
import { MEMORY_DEFAULTS } from "@shared/lib/memory";
import { TextField, formatScopes, parseScopes, parseIds } from "@/components/memory/BindingFields";
import { ProjectMemorySettings } from "@/components/memory/ProjectMemorySettings";
interface Props { appSettings: AppSettings | null; onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>; projectId?: string }
export const MemorySettings = memo(function MemorySettings({ appSettings, onUpdateAppSettings, projectId }: Props) {
  const [draft, setDraft] = useState<MemoryConfig>(appSettings?.memory ?? MEMORY_DEFAULTS); const [token, setToken] = useState("");
  const [scopes, setScopes] = useState(""); const [summaries, setSummaries] = useState("");
  const [status, setStatus] = useState<MemoryStatusResult | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { if (appSettings) { setDraft(appSettings.memory); setScopes(formatScopes(appSettings.memory.personalReadScopes)); setSummaries(appSettings.memory.personalSummaryBlockIds.join("\n")); } }, [appSettings]);
  async function act(task: () => Promise<void>) { if (busy) return; setBusy(true); setMessage(""); try { await task(); } catch (error) { setMessage(error instanceof Error ? error.message : "记忆设置操作失败"); } finally { setBusy(false); } }
  const patch = (value: Partial<MemoryConfig>) => setDraft((current) => ({ ...current, ...value }));
  return <div className="space-y-4 p-4 overflow-auto"><h2 className="text-lg font-semibold">思源长期记忆</h2>
    <p className="text-xs text-muted-foreground">仅连接本机思源。当前 Agent 自动总结并追加，不逐条确认；不启用额外总结模型或云端记忆服务。思源未运行时记忆暂时失效。</p>
    <TextField label="本机地址" value={draft.baseUrl} onChange={(baseUrl) => patch({ baseUrl })} disabled={busy} />
    <label className="block text-xs">API Token（可选，仅主进程安全保存）<input aria-label="思源 API Token" type="password" autoComplete="off" className="mt-1 w-full rounded border bg-background p-2" value={token} disabled={busy} onChange={(e) => setToken(e.target.value)} /></label>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(async () => { const result = await window.claude.memory.setToken(token); if (result.error) throw new Error(result.error); setToken(""); setMessage(result.value?.persistent ? "Token 已保存或清除" : "安全存储不可用，Token 仅在本次进程有效"); })}>保存 Token（空值清除）</Button>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(async () => { const result = await window.claude.memory.probe(draft.baseUrl); if (result.error) throw new Error(result.error); if (result.value) { patch({ expectedWorkspacePath: result.value.workspacePath }); setMessage("已检测思源 " + result.value.version + "；请确认工作空间并绑定锚点文档。"); } })}>探测本机连接</Button>
    <TextField label="预期工作空间路径（需与你的思源一致）" value={draft.expectedWorkspacePath} onChange={(expectedWorkspacePath) => patch({ expectedWorkspacePath })} disabled={busy} />
    <TextField label="工作空间身份锚点文档 ID" value={draft.identityAnchorDocumentId} onChange={(identityAnchorDocumentId) => patch({ identityAnchorDocumentId })} disabled={busy} />
    <label className="flex gap-2 text-xs"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(e) => patch({ enabled: e.target.checked })} />启用思源长期记忆</label>
    <details className="rounded border p-3 space-y-3"><summary>个人记忆（跨项目）</summary>
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={draft.personalReadEnabled} disabled={busy} onChange={(e) => patch({ personalReadEnabled: e.target.checked })} />允许读取个人记忆</label>
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={draft.personalAutoWriteEnabled} disabled={busy} onChange={(e) => patch({ personalAutoWriteEnabled: e.target.checked })} />允许自动保存明确的跨项目偏好</label>
      <TextField label="个人记忆写入文档 ID" value={draft.personalWriteDocumentId} onChange={(personalWriteDocumentId) => patch({ personalWriteDocumentId })} disabled={busy} />
      <TextField label="个人只读范围：笔记本ID/文档ID，可加 /*" value={scopes} onChange={setScopes} multiline disabled={busy} />
      <TextField label="个人摘要块 ID（每行一个）" value={summaries} onChange={setSummaries} multiline disabled={busy} />
    </details>
    <Button disabled={busy} onClick={() => void act(async () => { await onUpdateAppSettings({ memory: { ...draft, personalReadScopes: parseScopes(scopes), personalSummaryBlockIds: parseIds(summaries) } }); setStatus(await window.claude.memory.getStatus()); setMessage("配置已保存。已有会话下次发送会重新检查权限。"); })}>保存连接与全局权限</Button>
    <p role="status" className="text-xs whitespace-pre-wrap">{message}{status ? "\n" + status.message : ""}</p>
    {projectId ? <ProjectMemorySettings key={projectId} projectId={projectId} /> : <p className="text-xs">打开项目后可配置项目读写绑定。</p>}
  </div>;
});
