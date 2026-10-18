import { memo, useState } from "react";
import { ArrowRightLeft, ChevronDown, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { EngineId, InstalledAgent, ModelInfo } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { ENGINE_ICONS, getAgentIcon } from "@/lib/engine-icons";
import { useI18n } from "@/lib/i18n";
import { getHighestEffort, type SessionTransferTarget } from "@/lib/session/session-transfer";
import { TOOLBAR_BTN } from "./constants";

export interface TransferSessionMenuProps {
  agents: InstalledAgent[];
  /** Cached Claude model catalog (shown even when the active session is not Claude). */
  claudeModels: ModelInfo[];
  /** Cached Codex model catalog (id-based), with per-model effort levels. */
  codexModels: Array<{
    id: string;
    isDefault?: boolean;
    supportedReasoningEfforts?: Array<{ reasoningEffort: string; description: string }>;
    defaultReasoningEffort?: string;
  }>;
  /** Current session engine/agent/model, used to flag the active combination. */
  currentEngine?: EngineId;
  currentAgentId?: string | null;
  currentModelId?: string;
  disabled?: boolean;
  busy?: boolean;
  onTransfer: (target: SessionTransferTarget, objective?: string) => void;
}

/**
 * "Transfer session" dropdown: pick a target engine + model and hand the
 * current conversation (exported as Markdown) over to a fresh session.
 */
export const TransferSessionMenu = memo(function TransferSessionMenu({
  agents,
  claudeModels,
  codexModels,
  currentEngine,
  currentAgentId,
  currentModelId,
  disabled,
  busy,
  onTransfer,
}: TransferSessionMenuProps) {
  const { t } = useI18n();
  const [pendingTarget, setPendingTarget] = useState<SessionTransferTarget | null>(null);
  const [objective, setObjective] = useState("");
  const selectTarget = (target: SessionTransferTarget) => {
    setObjective("");
    setPendingTarget(target);
  };
  const acpAgents = agents.filter((agent) => agent.engine === "acp");

  const isCurrent = (engine: EngineId, model?: string, agentId?: string) => {
    if (engine !== currentEngine) return false;
    if (engine === "acp") return !!agentId && agentId === currentAgentId;
    if (!model) return false;
    return model === currentModelId;
  };

  const currentSuffix = (active: boolean) =>
    active ? (
      <span className="ms-auto ps-2 text-[10px] text-muted-foreground">
        {t("transferCurrent")}
      </span>
    ) : null;

  const renderModelItems = (
    engine: "claude" | "codex",
    models: Array<{
      id: string;
      label: string;
      description?: string;
      efforts?: string[];
    }>,
    engineLabel: string,
  ) => {
    if (models.length === 0) {
      return (
        <DropdownMenuItem
          onClick={() =>
            selectTarget({ engine, label: engineLabel })
          }
        >
          {t("transferDefaultModel")}
        </DropdownMenuItem>
      );
    }
    return models.map((m) => {
      const active = isCurrent(engine, m.id);
      const efforts = m.efforts ?? [];
      if (efforts.length === 0) {
        return (
          <DropdownMenuItem
            key={m.id}
            disabled={active}
            onClick={() =>
              selectTarget({ engine, model: m.id, label: `${engineLabel} · ${m.label}` })
            }
          >
            <div className="min-w-0">
              <div className="truncate">{m.label}</div>
              {m.description && (
                <div className="truncate text-[10px] text-muted-foreground">
                  {m.description}
                </div>
              )}
            </div>
            {currentSuffix(active)}
          </DropdownMenuItem>
        );
      }
      const maxEffort = getHighestEffort(efforts);
      return (
        <DropdownMenuSub key={m.id}>
          <DropdownMenuSubTrigger disabled={active}>
            <div className="min-w-0">
              <div className="truncate">{m.label}</div>
              {m.description && (
                <div className="truncate text-[10px] text-muted-foreground">
                  {m.description}
                </div>
              )}
            </div>
            {currentSuffix(active)}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuItem
              onClick={() =>
                selectTarget({
                  engine,
                  model: m.id,
                  effort: maxEffort,
                  label: `${engineLabel} · ${m.label} · ${maxEffort}`,
                })
              }
            >
              {t("transferHighestEffort").replace("{{effort}}", maxEffort ?? "")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {efforts.map((effort) => (
              <DropdownMenuItem
                key={effort}
                onClick={() =>
                  selectTarget({
                    engine,
                    model: m.id,
                    effort,
                    label: `${engineLabel} · ${m.label} · ${effort}`,
                  })
                }
              >
                <span className="capitalize">{effort}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    });
  };

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="xs"
                className={TOOLBAR_BTN}
                disabled={disabled || busy}
                aria-label={t("transferSession")}
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <ArrowRightLeft className="size-3" />
                )}
                {t("transferSession")}
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="max-w-64 text-xs">{t("transferDescription")}</p>
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-64"
          onCloseAutoFocus={(event) => { if (pendingTarget) event.preventDefault(); }}
        >
          <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
            {t("transferDescription")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* Claude models */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AgentIcon icon={ENGINE_ICONS.claude} size={14} className="shrink-0" />
              Claude
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {renderModelItems(
                "claude",
                claudeModels.map((m) => ({
                  id: m.value,
                  label: m.displayName,
                  description: m.description,
                  efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
                })),
                "Claude",
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* Codex models */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <AgentIcon icon={ENGINE_ICONS.codex} size={14} className="shrink-0" />
              Codex
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              {renderModelItems(
                "codex",
                codexModels.map((m) => ({
                  id: m.id,
                  label: m.id + (m.isDefault ? ` (${t("transferDefaultModel")})` : ""),
                  efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
                })),
                "Codex",
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          {/* ACP agents (model comes from the agent's own config) */}
          {acpAgents.length > 0 && <DropdownMenuSeparator />}
          {acpAgents.map((agent) => {
            const active = isCurrent("acp", undefined, agent.id);
            return (
              <DropdownMenuItem
                key={agent.id}
                disabled={active}
                onClick={() =>
                  selectTarget({
                    engine: "acp",
                    agentId: agent.id,
                    cachedConfigOptions: agent.cachedConfigOptions,
                    label: agent.name,
                  })
                }
              >
                <AgentIcon icon={getAgentIcon(agent)} size={14} className="shrink-0" />
                <span className="truncate">{agent.name}</span>
                {currentSuffix(active)}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={pendingTarget !== null} onOpenChange={(open) => { if (!open) setPendingTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="size-4 shrink-0" />
              {t("transferContinueTitle")}
            </DialogTitle>
            <p className="text-sm text-muted-foreground wrap-break-word">{pendingTarget?.label}</p>
            <DialogDescription>{t("transferObjectiveDescription")}</DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">{t("transferObjectiveLabel")}</span>
            <textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              rows={4}
              className="flex w-full resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={t("transferObjectivePlaceholder")}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingTarget(null)}>{t("cancel")}</Button>
            <Button
              disabled={disabled || busy || !pendingTarget}
              onClick={() => {
                if (!pendingTarget || disabled || busy) return;
                const target = pendingTarget;
                setPendingTarget(null);
                onTransfer(target, objective.trim() || undefined);
              }}
            >
              {t("transferStartSession")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
