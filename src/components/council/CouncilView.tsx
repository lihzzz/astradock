import { useRef, useState } from "react";
import type { Project } from "@/types";
import type { CreateTaskInput } from "@shared/types/tasks";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { useCouncil, unwrapCouncil } from "@/hooks/useCouncil";
import { CouncilCreateForm, COUNCIL_FIELD } from "./CouncilCreateForm";
import { CouncilRunPanel } from "./CouncilRunPanel";
import { CouncilTaskDraft } from "./CouncilTaskDraft";
export interface CouncilViewProps {
  projects: Project[];
  sourceMaterials: string;
  onOpenTasks: () => void;
}
export function CouncilView({ projects, sourceMaterials, onOpenTasks }: CouncilViewProps) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const label = (cn: string, en: string) => zh ? cn : en;
  const { snapshot, error: loadError, refresh } = useCouncil();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [creating, setCreating] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [materials, setMaterials] = useState("");
  const [constraints, setConstraints] = useState("");
  const [task, setTask] = useState<CreateTaskInput | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const request = useRef(crypto.randomUUID());
  const perform = async (fn: () => Promise<void>): Promise<boolean> => {
    if (busy.current)
      return false;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await fn();
      return true;
    }
    catch (e) {
      setError(reportError("COUNCIL:ACTION", e));
      await refresh();
      return false;
    }
    finally {
      busy.current = false;
      setPending(false);
    }
  };
  const group = snapshot?.councils.find(g => g.id === groupId);
  const runs = (snapshot?.runs ?? []).filter(r => r.councilId === group?.id).sort((a, b) => b.createdAt - a.createdAt);
  const run = runs.find(r => r.id === runId) ?? runs[0];
  const canStart = group && !runs.some(r => r.status !== "completed" && r.status !== "cancelled");
  return <div className="space-y-4" data-council-view>
  <header className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">{label("多模型讨论组", "Model Councils")}</h2><p className="text-xs text-muted-foreground">{label("独立分析 → 交叉讨论 → 保留分歧的结论 → 用户确认后转任务", "Independent views → discussion → conclusion with dissent → user-reviewed task")}</p></div><div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void refresh()}>{label("刷新", "Refresh")}</Button><Button size="sm" disabled={!snapshot || pending || !projects.length} onClick={() => {
    setCreating(true);
    setTask(null);
  }}>{label("新建讨论组", "New Council")}</Button></div></header>
  {loadError || error ? <p role="alert" className="wrap-break-word rounded border border-destructive/30 p-3 text-sm text-destructive">{loadError || error}</p> : null}
  {!snapshot ? <p role="status">{label("加载中…", "Loading…")}</p> : creating ? <CouncilCreateForm projects={projects} pending={pending} onBack={() => setCreating(false)} onCreate={input => perform(async () => {
      const group = unwrapCouncil(await window.claude.councils.create(input));
      setGroupId(group.id);
      setRunId(null);
      setCreating(false);
      await refresh();
    })}/> : <div className="grid min-w-0 gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
   <aside className="space-y-2"><label className="block text-xs">{label("讨论组（按项目标识）", "Council (project scoped)")}<select className={COUNCIL_FIELD} value={groupId ?? ""} onChange={e => {
      setGroupId(e.target.value);
      setRunId(null);
      setTask(null);
      setDeleteConfirm(false);
      request.current = crypto.randomUUID();
    }}><option value="">{label("选择讨论组", "Select Council")}</option>{snapshot.councils.map(g => <option key={g.id} value={g.id}>{projects.find(p => p.id === g.workspace.projectId)?.name ?? g.workspace.projectId} · {g.title}</option>)}</select></label>
   {group ? <><p className="text-xs text-muted-foreground wrap-break-word">{group.workspace.rootPath}</p><p className="text-xs">{group.members.map(m => m.name + " / " + m.model).join(" · ")}</p><label className="block text-xs">{label("历史议题", "Topics")}<select className={COUNCIL_FIELD} value={run?.id ?? ""} onChange={e => {
      setRunId(e.target.value);
      setTask(null);
    }}>{runs.map(r => <option key={r.id} value={r.id}>{r.objective.slice(0, 60)} · {r.status}</option>)}</select></label><Button size="sm" variant="ghost" disabled={pending} onClick={() => setDeleteConfirm(v => !v)}>{label("删除讨论组", "Delete Council")}</Button>{deleteConfirm ? <div className="space-y-2 rounded border p-2 text-xs"><p>{label("永久删除此组及全部讨论记录；请先停止运行。", "Permanently delete this Council and its records. Stop running calls first.")}</p><Button size="sm" variant="destructive" disabled={pending} onClick={() => void perform(async () => {
      unwrapCouncil(await window.claude.councils.remove(group.id));
      setGroupId(null);
      setRunId(null);
      setDeleteConfirm(false);
      await refresh();
    })}>{label("确认删除", "Confirm delete")}</Button></div> : null}</> : <p className="p-4 text-sm text-muted-foreground">{label("创建或选择一个讨论组。", "Create or select a Council.")}</p>}</aside>
   <div className="min-w-0 space-y-5">{task ? <CouncilTaskDraft key={run?.id} input={task} pending={pending} onBack={() => setTask(null)} onSave={async (input) => {
      await perform(async () => {
        unwrapCouncil(await window.claude.tasks.create(input));
        setTask(null);
        onOpenTasks();
      });
    }}/> : run ? <CouncilRunPanel key={run.id} run={run} pending={pending} onCommand={input => {
      void perform(async () => {
        unwrapCouncil(await window.claude.councils.command(input));
        await refresh();
      });
    }} onSupplement={text => perform(async () => {
      unwrapCouncil(await window.claude.councils.supplement({
        runId: run.id,
        expectedRevision: run.revision,
        id: crypto.randomUUID(),
        text
      }));
    })} onTask={() => void perform(async () => {
      setTask(unwrapCouncil(await window.claude.councils.taskBrief({ runId: run.id, expectedRevision: run.revision })));
    })}/> : null}
   {canStart && !task ? <form className="space-y-3 rounded-lg border p-4" onSubmit={e => {
      e.preventDefault();
      void perform(async () => {
        const result = unwrapCouncil(await window.claude.councils.start({
          requestId: request.current,
          councilId: group.id,
          objective,
          materials,
          constraints
        }));
        setRunId(result.id);
        request.current = crypto.randomUUID();
        setObjective("");
        await refresh();
      });
    }}><h3 className="font-medium">{label("发起新议题", "Start a topic")}</h3><label className="block text-xs">{label("问题 / 目标", "Question / objective")}<textarea required maxLength={12000} className={COUNCIL_FIELD} value={objective} onChange={e => setObjective(e.target.value)}/></label><label className="block text-xs">{label("约束", "Constraints")}<textarea maxLength={12000} className={COUNCIL_FIELD} value={constraints} onChange={e => setConstraints(e.target.value)}/></label><label className="block text-xs">{label("共享材料（发送前请检查敏感信息）", "Shared materials (review sensitive data before sending)")}<textarea maxLength={60000} rows={5} className={COUNCIL_FIELD} value={materials} onChange={e => setMaterials(e.target.value)}/></label><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={!sourceMaterials || sourceMaterials.length > 60000} onClick={() => setMaterials(sourceMaterials)}>{label("导入当前会话可见消息，先预览", "Import current conversation for review")}</Button>{run?.conclusion ? <Button type="button" variant="outline" size="sm" onClick={() => setMaterials(JSON.stringify(run.conclusion, null, 2))}>{label("引用上次结论", "Use prior conclusion")}</Button> : null}<Button disabled={pending}>{label("开始讨论（消耗模型额度）", "Start discussion (uses model quota)")}</Button></div></form> : null}</div>
  </div>}
 </div>;
}
