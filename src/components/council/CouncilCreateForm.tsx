import { useEffect, useRef, useState } from "react";
import type { Project } from "@/types";
import type { CouncilCapability, CouncilCreateInput, CouncilMember } from "@shared/types/council";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { unwrapCouncil } from "@/hooks/useCouncil";
export const COUNCIL_FIELD = "w-full rounded-md border border-border bg-background p-2 text-sm";
export function CouncilCreateForm({ projects, pending, onCreate, onBack }: {
  projects: Project[];
  pending: boolean;
  onCreate: (input: CouncilCreateInput) => Promise<boolean>;
  onBack: () => void;
}) {
  const { language } = useI18n();
  const zh = language === "zh-CN";
  const label = (cn: string, en: string) => zh ? cn : en;
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [workspaces, setWorkspaces] = useState<WorkspaceBinding[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState(0);
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"parallel" | "consensus">("consensus");
  const [rounds, setRounds] = useState(3);
  const [capabilities, setCapabilities] = useState<CouncilCapability[]>([]);
  const [error, setError] = useState("");
  const [members, setMembers] = useState<CouncilMember[]>([
    {
      id: "architect",
      name: label("架构师", "Architect"),
      engine: "claude",
      agentId: "claude-code",
      model: "sonnet",
      role: "Propose a maintainable design; explain assumptions and tradeoffs."
    },
    {
      id: "reviewer",
      name: label("审查员", "Reviewer"),
      engine: "claude",
      agentId: "claude-code",
      model: "opus",
      role: "Challenge the proposal; identify failure paths and verifiable tests."
    },
  ]);
  const [moderator, setModerator] = useState("sonnet");
  const request = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    setWorkspaces([]);
    setWorkspaceIndex(0);
    setError("");
    if (projectId)
      void window.claude.projectApps.workspaces(projectId).then(r => {
        if (active)
          setWorkspaces(unwrapCouncil(r));
      }).catch(e => {
        const message = reportError("COUNCIL:WORKSPACE", e);
        if (active)
          setError(message);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    void window.claude.councils.capabilities().then(r => {
      if (active)
        setCapabilities(unwrapCouncil(r));
    }).catch(e => {
      const message = reportError("COUNCIL:CAPABILITIES", e);
      if (active)
        setError(message);
    });
    return () => {
      active = false;
    };
  }, []);
  const update = (index: number, patch: Partial<CouncilMember>) => setMembers(old => old.map((m, i) => i === index ? { ...m, ...patch } : m));
  return <form className="max-w-3xl space-y-4" onSubmit={e => {
      e.preventDefault();
      const workspace = workspaces[workspaceIndex];
      if (!workspace)
        return;
      void onCreate({
        requestId: request.current,
        title,
        workspace,
        members,
        moderator: {
          id: "moderator",
          name: label("主持人", "Moderator"),
          engine: "claude",
          agentId: "claude-code",
          model: moderator,
          role: "Synthesize evidence, preserve dissent, and propose measurable next steps. Do not pretend absent members agreed."
        },
        settings: {
          mode,
          maxRounds: mode === "parallel" ? 1 : rounds,
          concurrency: 2,
          timeoutMs: 180000,
          maxCalls: 24
        }
      });
    }}>
  <Button type="button" variant="ghost" onClick={onBack}>{label("返回", "Back")}</Button>
  <h3 className="font-medium">{label("新建讨论组", "New Council")}</h3>
  <p className="text-xs text-muted-foreground">{label("材料讨论模式：只讨论你提交的内容，不读取工作区、不调用工具、不写记忆。各成员和主持人使用独立调用。模型服务仍会接收材料并消耗额度。", "Material-only: no workspace reads, tools, or memory writes. Each seat uses an isolated call. Materials are sent to your model provider and consume quota.")}</p>
  <label className="block text-xs">{label("名称", "Name")}<input required maxLength={160} className={COUNCIL_FIELD} value={title} onChange={e => setTitle(e.target.value)}/></label>
  <label className="block text-xs">{label("项目", "Project")}<select className={COUNCIL_FIELD} value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
  <label className="block text-xs">{label("执行任务将绑定的工作区", "Workspace for future tasks")}<select className={COUNCIL_FIELD} value={workspaceIndex} onChange={e => setWorkspaceIndex(Number(e.target.value))}>{workspaces.map((w, i) => <option key={w.rootPath} value={i}>{w.rootKind}: {w.rootPath}</option>)}</select></label>
  <div className="flex gap-3"><label className="flex-1 text-xs">{label("讨论模式", "Mode")}<select className={COUNCIL_FIELD} value={mode} onChange={e => setMode(e.target.value === "parallel" ? "parallel" : "consensus")}><option value="parallel">{label("并行会诊", "Parallel")}</option><option value="consensus">{label("共识讨论", "Consensus")}</option></select></label><label className="text-xs">{label("最多轮数", "Round cap")}<input type="number" min={1} max={3} disabled={mode === "parallel"} className={COUNCIL_FIELD} value={rounds} onChange={e => setRounds(Number(e.target.value))}/></label></div>
  {capabilities.filter(c => !c.supported).map(c => <p className="rounded bg-muted p-2 text-xs" key={c.engine}>{c.engine}: {label("未开放：尚无经验证的无工具隔离。普通会话不受影响。", c.reason)}</p>)}
  {members.map((m, i) => <fieldset key={m.id} className="space-y-2 rounded-lg border p-3"><legend className="px-1 text-xs">{label("成员", "Member")} {i + 1} · {m.engine}</legend><div className="flex gap-2"><input aria-label={label("成员名称", "Member name")} required maxLength={80} className={COUNCIL_FIELD} value={m.name} onChange={e => update(i, { name: e.target.value })}/><input aria-label={label("模型 ID", "Model ID")} required maxLength={200} className={COUNCIL_FIELD} value={m.model} onChange={e => update(i, { model: e.target.value })}/>{members.length > 2 ? <Button type="button" variant="ghost" onClick={() => setMembers(old => old.filter((_, n) => n !== i))}>{label("移除", "Remove")}</Button> : null}</div><textarea aria-label={label("职责", "Role")} required maxLength={2000} className={COUNCIL_FIELD} value={m.role} onChange={e => update(i, { role: e.target.value })}/></fieldset>)}
  <Button type="button" variant="outline" disabled={members.length >= 4} onClick={() => setMembers(old => [...old, {
      id: crypto.randomUUID(),
      name: label("验证员", "Verifier"),
      engine: "claude",
      agentId: "claude-code",
      model: "sonnet",
      role: "Identify unsupported assumptions and propose concrete validation steps."
    }])}>{label("添加成员（最多 4 位）", "Add member (up to 4)")}</Button>
  <label className="block text-xs">{label("主持人模型（独立上下文）", "Moderator model (independent context)")}<input required maxLength={200} className={COUNCIL_FIELD} value={moderator} onChange={e => setModerator(e.target.value)}/></label>
  {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  <Button disabled={pending || !workspaces.length || !capabilities.some(c => c.supported)}>{label("创建讨论组", "Create Council")}</Button>
 </form>;
}
