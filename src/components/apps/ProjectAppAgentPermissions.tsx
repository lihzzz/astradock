import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import type { ProjectAppAgentPermissionRequest } from "@shared/types/project-app-agent";
import { AppDialogContent } from "./AppFields";
import { unwrapAppResult } from "./app-utils";

/** Mounted once by AppLayout; its IPC and countdown never update the chat tree. */
export function ProjectAppAgentPermissions() {
  const { t } = useI18n();
  const [requests, setRequests] = useState<ProjectAppAgentPermissionRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [reload, setReload] = useState(0);
  const resolved = useRef(new Set<string>());
  const generation = useRef(0);
  useEffect(() => {
    const currentGeneration = ++generation.current;
    const startedAt = Date.now();
    const accept = (request: ProjectAppAgentPermissionRequest) => {
      if (resolved.current.has(request.requestId) || request.expiresAt <= Date.now()) return;
      setRequests((previous) => previous.some((item) => item.requestId === request.requestId) ? previous : [...previous, request].sort((a, b) => a.createdAt - b.createdAt));
    };
    const unsubscribe = window.claude.projectApps.onAgentPermission((event) => {
      if (event.kind === "requested") accept(event.request);
      else { resolved.current.add(event.requestId); setRequests((previous) => previous.filter((request) => request.requestId !== event.requestId)); }
    });
    void window.claude.projectApps.pendingAgentPermissions().then(unwrapAppResult).then((pending) => {
      if (generation.current !== currentGeneration) return;
      const liveIds = new Set(pending.map((request) => request.requestId));
      // Keep event-delivered requests newer than this fetch as well.
      setRequests((previous) => previous.filter((request) => liveIds.has(request.requestId) || request.createdAt >= startedAt));
      pending.forEach(accept); setError(null);
    }).catch((cause) => { if (generation.current === currentGeneration) setError(reportError("project-apps:pending-permissions", cause)); });
    return () => { generation.current += 1; unsubscribe(); };
  }, [reload]);
  const request = requests[0] ?? null;
  useEffect(() => {
    if (!requests.length) return;
    setNow(Date.now());
    const timer = setInterval(() => { const time = Date.now(); setNow(time); setRequests((previous) => previous.filter((item) => item.expiresAt + 3000 > time)); }, 1000);
    return () => clearInterval(timer);
  }, [requests.length]);
  const remaining = request ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000)) : 0;
  const respond = async (allow: boolean) => {
    if (!request || busy || allow && request.expiresAt <= Date.now()) return;
    setBusy(true); setError(null);
    try {
      unwrapAppResult(await window.claude.projectApps.respondAgentPermission({ requestId: request.requestId, sessionId: request.sessionId, allow }));
      resolved.current.add(request.requestId); setRequests((previous) => previous.filter((item) => item.requestId !== request.requestId));
    } catch (cause) { setError(reportError("project-apps:respond-permission", cause)); }
    finally { setBusy(false); }
  };
  if (!request) return error ? <div role="alert" className="fixed bottom-4 end-4 z-50 max-w-sm rounded-lg border bg-background p-3 text-xs shadow-lg"><p className="wrap-break-word text-destructive">{error}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => setReload((value) => value + 1)}>{t("appsRefresh")}</Button><Button size="sm" variant="ghost" onClick={() => setError(null)}>{t("appsClose")}</Button></div> : null;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) void respond(false); }}><AppDialogContent key={request.requestId} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" onPointerDownOutside={(event) => event.preventDefault()}><DialogHeader><DialogTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />{t("appsPermissionsTitle")}</DialogTitle><DialogDescription>{t("appsPermissionsDescription")}</DialogDescription></DialogHeader>
    <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm"><p><span className="text-muted-foreground">{t("appsPermissionSession")}: </span><span className="font-mono text-xs">{request.sessionId}</span></p><p><span className="text-muted-foreground">{t("appsProject")}: </span>{request.projectId}</p><p className="wrap-break-word"><span className="text-muted-foreground">{t("appsWorkspace")}: </span>{request.cwd}</p><p><span className="text-muted-foreground">{t("appsPermissionTool")}: </span><strong>{request.tool}</strong></p></div>
    {"before" in request.args && "after" in request.args && <div className="space-y-3">
      <p className="text-xs">{t("appsPermissionChangedFields")}: {Array.isArray(request.args.changedFields) ? request.args.changedFields.filter((field): field is string => typeof field === "string").join(", ") : "—"}</p>
      <div className="grid gap-3 sm:grid-cols-2">{(["before", "after"] as const).map((side) => <div key={side}><h3 className="mb-2 text-xs font-medium">{t(side === "before" ? "appsPermissionBefore" : "appsPermissionAfter")}</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border p-3 text-xs" tabIndex={0}>{JSON.stringify(request.args[side], null, 2)}</pre></div>)}</div>
    </div>}
    <div><h3 className="mb-2 text-xs font-medium">{t("appsPermissionArguments")}</h3><pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border bg-muted/20 p-3 font-mono text-xs" tabIndex={0}>{JSON.stringify(request.args, null, 2)}</pre></div>
    <div className="flex justify-between text-xs text-muted-foreground"><span>{requests.length} {t("appsPermissionPending")}</span><span>{remaining > 0 ? `${t("appsPermissionExpires")} ${remaining}s` : t("appsPermissionExpired")}</span></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => void respond(false)}>{t("appsDeny")}</Button><Button disabled={busy || remaining === 0} onClick={() => void respond(true)}>{t("appsApproveOnce")}</Button></div>
  </AppDialogContent></Dialog>;
}
