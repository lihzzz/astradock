import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Brain, RefreshCw } from "lucide-react";
import { PanelHeader } from "@/components/PanelHeader";
import { Button } from "@/components/ui/button";
import type { MemoryRecallState, MemoryScope, MemoryStatusResult, MemoryWriteRecord } from "@shared/types/memory";
import { ProjectMemorySettings } from "./ProjectMemorySettings";
interface Props { projectId: string | null; sessionId: string | null; headerControls: ReactNode }
export function MemoryPanel(props: Props) { return <MemoryPanelContent key={(props.projectId ?? "") + ":" + (props.sessionId ?? "")} {...props} />; }
function MemoryPanelContent({ projectId, sessionId, headerControls }: Props) {
  const [status, setStatus] = useState<MemoryStatusResult | null>(null); const [recall, setRecall] = useState<MemoryRecallState | null>(null); const [writes, setWrites] = useState<MemoryWriteRecord[]>([]);
  const [text, setText] = useState(""); const [scope, setScope] = useState<MemoryScope>("project"); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false); const generation = useRef(0); const locked = useRef(false);
  const refresh = useCallback(async () => { const version = ++generation.current; try { const [nextStatus, nextRecall, nextWrites] = await Promise.all([window.claude.memory.getStatus(), sessionId ? window.claude.memory.sessionRecall(sessionId) : null, projectId ? window.claude.memory.writes(projectId) : null]); if (version !== generation.current) return; setStatus(nextStatus); setRecall(nextRecall?.value ?? null); setWrites(nextWrites?.value ?? []); } catch { if (version === generation.current) setMessage("记忆状态读取失败"); } }, [projectId, sessionId]);
  useEffect(() => { setRecall(null); setWrites([]); setText(""); setMessage(""); void refresh(); const timer = setInterval(() => void refresh(), 10000); return () => { clearInterval(timer); generation.current++; }; }, [refresh]);
  async function action(task: () => Promise<string>) { if (locked.current) return; locked.current = true; setBusy(true); try { setMessage(await task()); await refresh(); } catch (error) { setMessage(error instanceof Error ? error.message : "记忆操作失败"); } finally { locked.current = false; setBusy(false); } }
  return <div className="flex h-full min-h-0 flex-col"><PanelHeader icon={Brain} label="思源长期记忆">{headerControls}</PanelHeader><div className="min-h-0 flex-1 overflow-auto space-y-3 p-3 text-xs">
    <div className="flex items-center gap-2"><span role="status">{status?.message ?? "正在检查思源…"}</span><Button variant="ghost" size="sm" onClick={() => void refresh()} aria-label="刷新记忆状态"><RefreshCw className="h-4 w-4" /></Button></div>
    <p className="text-muted-foreground">Agent 在任务完成前自动保存有依据的新结论，不逐条确认。这里显示当次读取与写入记录，思源正文始终为准。</p>
    {projectId ? <>
      <details><summary>项目绑定</summary><ProjectMemorySettings key={projectId} projectId={projectId} /></details>
      {recall && sessionId ? <section className="space-y-2 rounded border p-2"><h3>最近记忆上下文</h3><p>{recall.status}</p><label className="flex gap-2"><input type="checkbox" checked={recall.skipNext} disabled={busy} onChange={(e) => { const skip = e.target.checked; void action(async () => { const result = await window.claude.memory.skipNextRecall(sessionId, skip); if (result.error) throw new Error(result.error); return "仅跳过应用注入，不关闭 Agent 记忆工具"; }); }} />跳过下一次应用注入</label>{recall.items.map((item) => <div key={item.ref} className="whitespace-pre-wrap wrap-break-word"><p>{item.text}</p><small>{item.scope} · {item.blockId} · {new Date(item.readAt).toLocaleTimeString()}</small></div>)}</section> : null}
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void action(async () => { const result = await window.claude.memory.remember(projectId, text, scope); if (result.error) throw new Error(result.error); if (result.value?.state === "verified") setText(""); return result.value?.state === "verified" ? "已保存记忆" : "保存状态：" + result.value?.state + "；请先核对，不要重复提交"; }); }}>
        <select value={scope} disabled={busy} onChange={(e) => setScope(e.target.value === "personal" ? "personal" : "project")} className="rounded border bg-background p-2"><option value="project">项目记忆</option><option value="personal">个人偏好（需要已授权）</option></select>
        <textarea aria-label="记住这条" value={text} disabled={busy} maxLength={2000} onChange={(e) => setText(e.target.value)} className="min-h-24 w-full rounded border bg-background p-2" placeholder="记住这条…" /><Button size="sm" disabled={busy || status?.state !== "ready" || text.trim().length < 3}>保存到思源</Button>
      </form>
      <p role="status" className="whitespace-pre-wrap">{message}</p><h3>最近写入（不保存正文副本）</h3>{writes.map((record) => <div key={record.operationId} className="rounded border p-2 space-y-1 wrap-break-word"><p>{record.kind} · {record.scope} · {record.state}</p><small>{record.blockId ?? record.operationId}</small>{["unknown", "submitted", "prepared", "conflict"].includes(record.state) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async () => { const result = await window.claude.memory.reconcile(projectId, record.operationId); if (result.error) throw new Error(result.error); return "核对结果：" + result.value?.state; })}>核对结果（不重写）</Button> : null}</div>)}
    </> : <p>请打开项目以配置和使用记忆。</p>}
  </div></div>;
}
