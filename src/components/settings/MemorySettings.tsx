import { useI18n } from "@/lib/i18n";
import { intelligenceDefaults } from "@shared/lib/memory-entry";
import { memo, useEffect, useRef, useState } from "react";
import { Brain, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/analytics/analytics";
import type { AppSettings } from "@/types";
import type { MemoryStatusResult } from "@shared/types/memory";
import { MEMORY_DEFAULTS } from "@shared/lib/memory";
interface Props { appSettings: AppSettings | null; onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void> }
export const MemorySettings = memo(function MemorySettings({ appSettings, onUpdateAppSettings }: Props) {
  const { t } = useI18n();
  const memory = appSettings?.memory ?? MEMORY_DEFAULTS;
  const [baseUrl, setBaseUrl] = useState(memory.baseUrl);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<MemoryStatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const locked = useRef(false);
  useEffect(() => { setBaseUrl(memory.baseUrl); }, [memory.baseUrl]);
  useEffect(() => {
    let active = true;
    void window.claude.memory.getStatus().then(value => { if (active) setStatus(value); }).catch(error => {
      reportError("MEMORY_STATUS", error); if (active) setMessage("记忆状态读取失败，请重新连接");
    });
    return () => { active = false; };
  }, [memory.enabled, memory.managedNotebookId]);
  async function act(task: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setMessage("");
    try { await task(); }
    catch (error) { reportError("MEMORY_SETTINGS", error); setMessage(error instanceof Error ? error.message : "记忆连接失败"); }
    finally { locked.current = false; setBusy(false); }
  }
  async function connect() {
    if (token.trim()) {
      const saved = await window.claude.memory.setToken(token.trim());
      if (saved.error) throw new Error(saved.error);
      setToken("");
      if (saved.value && !saved.value.persistent) setMessage("安全存储不可用，Token 仅在本次进程有效。");
    }
    const result = await window.claude.memory.connect(baseUrl);
    if (result.error) throw new Error(result.error);
    if (result.value) await onUpdateAppSettings({ memory: result.value });
    setStatus(await window.claude.memory.getStatus());
  }
  return <div className="space-y-5 overflow-auto p-4">
    <div className="flex items-center gap-2"><Brain className="size-5" /><h2 className="text-lg font-semibold">长期记忆</h2></div>
    <p className="text-sm text-muted-foreground">一个固定的大脑，跨会话、项目和模型持续积累。启用后自动创建或复用专用记忆库，无需手动绑定。</p>
    <section className="space-y-4 rounded-lg border p-4">
      <label className="flex items-center justify-between gap-3 text-sm font-medium">启用长期记忆
        <input type="checkbox" role="switch" aria-label="启用长期记忆" checked={memory.enabled} disabled={busy || !appSettings} onChange={event => {
          const enabled = event.target.checked;
          void act(async () => {
            if (enabled) await connect();
            else { await onUpdateAppSettings({ memory: { ...memory, enabled: false } }); setMessage("已暂停长期记忆，已有内容保留在思源中。"); setStatus(await window.claude.memory.getStatus()); }
          });
        }} />
      </label>
      <div className="space-y-1 text-sm"><p role="status">{busy ? "正在连接并核对记忆库…" : !memory.enabled ? "长期记忆未启用" : status?.message ?? "正在检查连接…"}</p>
        <p className="text-muted-foreground">存储位置：AstraDock 记忆（自动管理）</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || status?.state !== "ready" || !memory.managedNotebookId} onClick={() => void act(async () => { const result = await window.claude.memory.openBrain(); if (result.error) throw new Error(result.error); })}><ExternalLink className="me-1 size-4" />查看记忆</Button>
        <Button size="sm" variant="outline" disabled={busy || !appSettings} onClick={() => void act(connect)}><RefreshCw className="me-1 size-4" />{memory.managedNotebookId ? "重新连接" : "连接并启用"}</Button>
      </div>
    </section>
    <details className="space-y-3 rounded-lg border p-4">
      <summary className="cursor-pointer text-sm">连接设置</summary>
      <p className="text-xs text-muted-foreground">默认连接本机思源。仅在地址不同或需要认证时修改。重新连接不会更换已有记忆库。</p>
      <label className="block space-y-1 text-xs"><span>本机地址</span><input aria-label="思源本机地址" className="w-full rounded border bg-background p-2" value={baseUrl} disabled={busy} onChange={e => setBaseUrl(e.target.value)} /></label>
      <label className="block space-y-1 text-xs"><span>API Token（可选）</span><input aria-label="思源 API Token" type="password" autoComplete="off" className="w-full rounded border bg-background p-2" value={token} disabled={busy} placeholder={status?.hasToken ? "已保存；留空保留" : "无需认证时留空"} onChange={e => setToken(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || !appSettings} onClick={() => void act(connect)}>保存并连接</Button>
        {status?.hasToken ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(async () => { const result = await window.claude.memory.setToken(""); if (result.error) throw new Error(result.error); setStatus(await window.claude.memory.getStatus()); setMessage("已清除保存的 Token。"); })}>清除 Token</Button> : null}</div>
    </details>
    <details className="space-y-3 rounded-lg border p-4"><summary className="text-sm">{t("Memory intelligence (experimental)")}</summary><p className="text-xs text-muted-foreground">{t("No extra model service or content copy. Off by default; real model quality requires environment-specific acceptance.")}</p>{([['enabled',"Structured extraction, multi-query recall and feedback"],['briefing',"Progressive briefing at session start"],['persistTrace',"Keep 7 days of process metadata (no content or queries)"]] as const).map(([key,label])=><label key={key} className="flex items-center justify-between gap-2 text-xs"><span>{t(label)}</span><input type="checkbox" checked={(memory.intelligence ?? intelligenceDefaults)[key]} disabled={busy||!appSettings} onChange={e=>{const enabled=e.target.checked;void act(()=>onUpdateAppSettings({memory:{...memory,intelligence:{...(memory.intelligence ?? intelligenceDefaults),[key]:enabled}}}));}} /></label>)}</details>
    {message ? <p role="status" className="whitespace-pre-wrap text-xs">{message}</p> : null}
    {memory.enabled && !memory.managedNotebookId ? <p className="text-xs text-muted-foreground">旧版手动绑定不会自动搬迁或删除。点击「连接并启用」后，新记忆统一存入专用库；原笔记仍保留在思源。</p> : null}
    <p className="text-xs text-muted-foreground">助手自动保存有依据的结论与明确偏好，不逐条询问。项目知识与通用偏好自动分类，只访问专用库，不读取其他笔记本。思源未运行时记忆暂时不可用，聊天仍可继续。</p>
  </div>;
});
