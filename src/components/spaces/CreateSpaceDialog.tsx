import { useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, Folder, Layers, Loader2, MessageSquare, Plus, SlidersHorizontal } from "lucide-react";
import { DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SpaceCustomizer } from "@/components/SpaceCustomizer";
import { SPACE_COLOR_PRESETS } from "@/hooks/useSpaceManager";
import { resolveLucideIcon } from "@/lib/icon-utils";
import { reportError } from "@/lib/analytics/analytics";
import { useI18n } from "@/lib/i18n";
import type { Space } from "@/types";

export type SpaceDetails = Pick<Space, "name" | "icon" | "iconType" | "color">;
const QUICK_ICONS = ["⭐", "💼", "🚀", "🌱", "💡", "🎨", "🧪", "☕"];
const COLOR_LABELS = ["spaceColorNeutral", "spaceColorCoral", "spaceColorAmber", "spaceColorLime", "spaceColorMint", "spaceColorSky", "spaceColorBlue", "spaceColorPurple", "spaceColorPink"];

interface CreateSpaceDialogProps {
  onCreate: (details: SpaceDetails) => Promise<void>;
  onClose: () => void;
}

/** Mounted only while open: cancelled drafts never touch persisted spaces or the active session. */
export function CreateSpaceDialog({ onCreate, onClose }: CreateSpaceDialogProps) {
  const { t } = useI18n();
  const [details, setDetails] = useState<SpaceDetails>({ name: "", icon: "⭐", iconType: "emoji", color: { hue: 260, chroma: 0.15 } });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const submitting = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const Icon = details.iconType === "lucide" ? resolveLucideIcon(details.icon) : null;
  const name = details.name.trim();
  const tint = `oklch(0.65 ${details.color.chroma} ${details.color.hue})`;
  const gradient = details.color.gradientHue === undefined ? tint : `oklch(0.65 ${details.color.chroma} ${details.color.gradientHue})`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await onCreate({ ...details, name });
      onClose();
    } catch (error) {
      reportError("SPACES:CREATE", error);
      setFailed(true);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[680px]"
      showCloseButton={!saving}
      onEscapeKeyDown={(event) => { if (submitting.current) event.preventDefault(); }}
      onInteractOutside={(event) => event.preventDefault()}
      onOpenAutoFocus={(event) => { event.preventDefault(); nameRef.current?.focus(); }}
    >
      <form onSubmit={handleSubmit} aria-busy={saving}>
        <header className="px-7 pt-7 pb-6">
          <div className="mb-4 flex size-10 items-center justify-center rounded-xl border border-border bg-muted/50"><Layers className="size-5 text-muted-foreground" /></div>
          <DialogTitle className="text-xl tracking-tight">{t("newSpace")}</DialogTitle>
          <DialogDescription className="mt-2 text-[13px] leading-relaxed">{t("spaceCreateDescription")}</DialogDescription>
        </header>
        <div className="grid border-t border-border sm:grid-cols-[1fr_260px]">
          <fieldset disabled={saving} className="min-w-0 space-y-6 px-7 py-6 disabled:opacity-60">
            <div className="space-y-2">
              <label htmlFor="new-space-name" className="text-xs font-medium">{t("spaceNameLabel")}</label>
              <Input ref={nameRef} id="new-space-name" value={details.name} maxLength={60} autoComplete="off" placeholder={t("spaceNameExample")}
                onChange={(event) => setDetails((current) => ({ ...current, name: event.target.value }))}
                onKeyDown={(event) => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }}
                className="h-10 rounded-lg bg-muted/20 text-sm" />
            </div>
            <div className="space-y-4">
              <h3 className="text-xs font-medium">{t("spaceAppearance")}</h3>
              <div role="group" aria-label={t("spaceIconLabel")} className="grid grid-cols-8 gap-1">
                {QUICK_ICONS.map((icon) => (
                  <button key={icon} type="button" aria-label={icon} aria-pressed={details.iconType === "emoji" && details.icon === icon}
                    onClick={() => setDetails((current) => ({ ...current, icon, iconType: "emoji" }))}
                    className="flex aspect-square items-center justify-center rounded-lg text-lg transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:ring-1 aria-pressed:ring-ring">
                    {icon}
                  </button>
                ))}
              </div>
              <div role="group" aria-label={t("spaceColorLabel")} className="flex flex-wrap gap-2.5 py-1">
                {SPACE_COLOR_PRESETS.map((color, index) => {
                  const selected = details.color.hue === color.hue && details.color.chroma === color.chroma;
                  return (
                    <button key={color.hue} type="button" aria-label={t(COLOR_LABELS[index])} title={t(COLOR_LABELS[index])} aria-pressed={selected}
                      onClick={() => setDetails((current) => ({ ...current, color: { ...color } }))}
                      className="flex size-5 items-center justify-center rounded-full ring-offset-background transition-shadow hover:ring-2 hover:ring-ring/40 hover:ring-offset-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring aria-pressed:ring-2 aria-pressed:ring-ring aria-pressed:ring-offset-2"
                      style={{ background: `oklch(0.62 ${color.chroma} ${color.hue})` }}>
                      {selected && <Check className="size-3 text-white" strokeWidth={3} />}
                    </button>
                  );
                })}
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="flex items-center gap-1.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                    <SlidersHorizontal className="size-3.5" />{t("spaceMoreAppearance")}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="bottom" align="start" className="max-h-[min(560px,70dvh)] w-80 overflow-y-auto">
                  <SpaceCustomizer icon={details.icon} iconType={details.iconType} color={details.color}
                    onUpdateIcon={(icon, iconType) => setDetails((current) => ({ ...current, icon, iconType }))}
                    onUpdateColor={(color) => setDetails((current) => ({ ...current, color }))} />
                </PopoverContent>
              </Popover>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("spaceEditableLater")}</p>
          </fieldset>
          <aside className="hidden flex-col border-s border-border bg-muted/25 p-6 sm:flex" aria-label={t("spacePreview")}>
            <p className="mb-4 text-[10px] font-medium tracking-[0.16em] text-muted-foreground">{t("spacePreview")}</p>
            <div className="overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              <div className="p-4" style={{ background: `linear-gradient(135deg, color-mix(in oklch, ${tint} 22%, transparent), color-mix(in oklch, ${gradient} 7%, transparent))`, opacity: details.color.opacity ?? 1 }}>
                <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-white/20 bg-background/70 shadow-sm">
                  {Icon ? <Icon className="size-5" /> : <span className="text-2xl">{details.icon}</span>}
                </div>
                <p className="truncate text-sm font-semibold" title={name}>{name || t("newSpace")}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{t("spacePreviewCaption")}</p>
              </div>
              <div className="space-y-3 p-4">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><Folder className="size-3.5 shrink-0" />{t("spacePreviewProject")}</div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70"><MessageSquare className="size-3 shrink-0" />{t("spacePreviewChat")}</div>
                <div aria-hidden="true" className="flex gap-1.5 pt-1"><div className="h-1.5 w-12 rounded-full bg-muted" /><div className="h-1.5 w-7 rounded-full bg-muted" /></div>
              </div>
              <div aria-hidden="true" className="flex items-center justify-between border-t border-border px-4 py-2"><span className="size-2 rounded-full" style={{ background: tint }} /><Plus className="size-3 text-muted-foreground" /></div>
            </div>
            <h3 className="mt-5 text-xs font-medium">{t("spaceReadyTitle")}</h3>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{t("spaceReadyDescription")}</p>
          </aside>
        </div>
        {failed && <p role="alert" className="border-t border-border px-7 pt-4 text-xs text-destructive">{t("spaceCreateFailed")}</p>}
        <footer className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-background px-7 py-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{t("cancel")}</Button>
          <Button type="submit" disabled={!name || saving} className="gap-2 rounded-lg px-5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t(saving ? "spaceCreating" : "createSpaceButton")}
            {!saving && <ArrowRight className="size-3.5" />}
          </Button>
        </footer>
      </form>
    </DialogContent>
  );
}
