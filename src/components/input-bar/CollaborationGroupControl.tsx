import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { InstalledAgent } from "@/types";
import type { CollaborationGroup, SessionCollaboration } from "@shared/types/collaboration";
import { attachCollaboration, createCollaborationGroup } from "@shared/lib/collaboration";
import { useI18n } from "@/lib/i18n";
import { useCollaborationLibrary } from "@/stores/collaboration-store";
import { useCollaborationRunStore } from "@/stores/collaboration-run-store";
import { TOOLBAR_BTN } from "./constants";

interface DraftMember {
  key: string;
  agentId: string;
  model: string;
}

export function CollaborationGroupControl({
  sessionId,
  agents,
  collaboration,
  onCollaborationChange,
}: {
  sessionId: string | null;
  agents: InstalledAgent[];
  collaboration: SessionCollaboration | null;
  onCollaborationChange: (next: SessionCollaboration | null) => void;
}) {
  const { t } = useI18n();
  const groups = useCollaborationLibrary((state) => state.groups);
  const saveGroup = useCollaborationLibrary((state) => state.saveGroup);
  const deleteGroup = useCollaborationLibrary((state) => state.deleteGroup);
  const run = useCollaborationRunStore((state) => (
    state.sessionId === sessionId ? state : null
  ));
  const [editorOpen, setEditorOpen] = useState(false);
  const working = !!run?.members.some((member) => member.status === "working");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className={collaboration
              ? "rounded-lg bg-blue-500/10 font-normal text-blue-500 hover:bg-blue-500/15 hover:text-blue-500"
              : TOOLBAR_BTN}
            aria-label={t("collaborationPull")}
            title={t("collaborationPullHint")}
          >
            {working ? <Loader2 className="size-3.5 animate-spin" /> : <Users className="size-3.5" />}
            <span className="max-w-[9rem] truncate">
              {collaboration?.name ?? t("collaborationPull")}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {collaboration && (
            <>
              <DropdownMenuLabel className="text-[10px] font-medium text-muted-foreground">
                {t("collaborationAttached")}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onCollaborationChange(null)}>
                <X className="size-3.5" />
                {t("collaborationDetach")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-[10px] font-medium text-muted-foreground">
            {t("collaborationMembers")}
          </DropdownMenuLabel>
          {groups.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{t("collaborationNoGroups")}</div>
          ) : groups.map((group) => (
            <DropdownMenuItem
              key={group.id}
              onSelect={() => onCollaborationChange(attachCollaboration(group))}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{group.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {group.members.map((member) => member.model ? `${member.name} · ${member.model}` : member.name).join(", ")}
                </span>
              </span>
              {collaboration?.groupId === group.id && <Check className="size-3.5 shrink-0" />}
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label={t("collaborationDelete")}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  deleteGroup(group.id);
                }}
              >
                <X className="size-3" />
              </button>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditorOpen(true)}>
            <Plus className="size-3.5" />
            {t("collaborationNew")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CollaborationGroupEditor
        open={editorOpen}
        agents={agents}
        onOpenChange={setEditorOpen}
        onSave={(group) => {
          saveGroup(group);
          onCollaborationChange(attachCollaboration(group));
          setEditorOpen(false);
        }}
      />
    </>
  );
}

export function CollaborationGroupStrip({
  sessionId,
  collaboration,
  onCollaborationChange,
}: {
  sessionId: string | null;
  collaboration: SessionCollaboration | null;
  onCollaborationChange: (next: SessionCollaboration | null) => void;
}) {
  const { t } = useI18n();
  const clearRun = useCollaborationRunStore((state) => state.clearRun);
  const run = useCollaborationRunStore((state) => (
    state.sessionId === sessionId ? state : null
  ));
  if (!collaboration) return null;
  const statuses = new Map(run?.members.map((member) => [member.id, member.status]) ?? []);

  return (
    <div className="mx-4 mb-1 flex flex-wrap items-center gap-1">
      <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-600 dark:text-blue-300">
        <Users className="size-3 shrink-0" />
        <span className="truncate">{collaboration.name}</span>
        <button
          type="button"
          className="rounded-full p-0.5 hover:bg-blue-500/15"
          aria-label={t("collaborationDetach")}
          onClick={() => {
            if (sessionId) clearRun(sessionId);
            onCollaborationChange(null);
          }}
        >
          <X className="size-3" />
        </button>
      </span>
      {collaboration.members.map((member) => {
        const status = statuses.get(member.id);
        return (
          <span key={member.id} className="inline-flex max-w-[14rem] items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-muted-foreground">
            {status === "working" && <Loader2 className="size-3 shrink-0 animate-spin" />}
            <span className="truncate">
              {member.name}
              {member.model ? ` · ${member.model}` : ""}
            </span>
            {status === "done" && <span>{t("collaborationDone")}</span>}
            {status === "error" && <span className="text-destructive">{t("collaborationFailed")}</span>}
          </span>
        );
      })}
    </div>
  );
}

function CollaborationGroupEditor({
  open,
  agents,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  agents: InstalledAgent[];
  onOpenChange: (open: boolean) => void;
  onSave: (group: CollaborationGroup) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  useEffect(() => {
    if (!open) return;
    const available = agentsRef.current;
    const first = available[0]?.id ?? "";
    const second = available[1]?.id ?? first;
    setName("");
    setError(null);
    setMembers([
      { key: crypto.randomUUID(), agentId: first, model: "" },
      { key: crypto.randomUUID(), agentId: second, model: "" },
    ]);
  }, [open]);

  const save = () => {
    const draft = members.flatMap((member) => {
      const agent = agents.find((entry) => entry.id === member.agentId);
      if (!agent) return [];
      const model = member.model.trim();
      return [{
        agentId: agent.id,
        engine: agent.engine,
        name: agent.name,
        ...(model ? { model } : {}),
      }];
    });
    const created = createCollaborationGroup(name, draft);
    if (!created.ok) {
      setError(created.error === "name" ? t("collaborationNameRequired") : t("collaborationNeedMembers"));
      return;
    }
    onSave(created.group);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("collaborationNew")}</DialogTitle>
          <DialogDescription>{t("collaborationPullHint")}</DialogDescription>
        </DialogHeader>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("collaborationEmptyAgents")}</p>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">{t("collaborationName")}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                className="h-8 w-full rounded-md border border-border/50 bg-background px-2 text-sm outline-none focus:border-foreground/30"
              />
            </label>
            <div className="space-y-2">
              {members.map((member) => (
                <div key={member.key} className="flex items-center gap-1.5">
                  <select
                    value={member.agentId}
                    onChange={(event) => {
                      const agentId = event.target.value;
                      setMembers((current) => current.map((entry) => (
                        entry.key === member.key ? { ...entry, agentId } : entry
                      )));
                    }}
                    className="h-8 min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 text-xs"
                  >
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </select>
                  <input
                    value={member.model}
                    placeholder={t("collaborationModelOptional")}
                    onChange={(event) => {
                      const model = event.target.value;
                      setMembers((current) => current.map((entry) => (
                        entry.key === member.key ? { ...entry, model } : entry
                      )));
                    }}
                    className="h-8 w-36 rounded-md border border-border/50 bg-background px-2 text-xs outline-none focus:border-foreground/30"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={t("collaborationRemoveMember")}
                    disabled={members.length <= 2}
                    onClick={() => setMembers((current) => current.filter((entry) => entry.key !== member.key))}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={TOOLBAR_BTN}
              onClick={() => setMembers((current) => [
                ...current,
                { key: crypto.randomUUID(), agentId: agents[0]?.id ?? "", model: "" },
              ])}
            >
              <Plus className="size-3.5" />
              {t("collaborationAddMember")}
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button type="button" size="sm" onClick={save}>
                {t("collaborationSavePull")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
