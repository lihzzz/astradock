import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isMac } from "@/lib/utils";
import type { MacBackgroundEffect, ThemeOption } from "@/types";
import type { BackgroundEffectState } from "@shared/types/background-effect";
import { applyBackgroundEffectClasses } from "@shared/lib/background-effect-classes";
import { reportError } from "@/lib/analytics/analytics";

type MacNativeBackgroundEffect = Exclude<MacBackgroundEffect, "off">;

const MAC_BACKGROUND_EFFECT_RESTART_TOAST_ID = "mac-background-effect-restart";

interface UseGlassOrchestratorOptions {
  /** User's desired macOS background effect from settings */
  macBackgroundEffect: MacBackgroundEffect;
  /** Setter to downgrade the effect when liquid glass is unsupported */
  setMacBackgroundEffect: (effect: MacBackgroundEffect) => void;
  /** Whether the user has window transparency enabled */
  transparency: boolean;
  /** Current theme selection (synced to Electron's nativeTheme for Windows Mica) */
  theme: ThemeOption;
}

interface GlassOrchestratorState {
  glassSupported: boolean;
  glassActive: boolean;
  macLiquidGlassSupported: boolean;
  liveMacBackgroundEffect: MacNativeBackgroundEffect;
}

/**
 * Mirrors the main process's effective material, including hardware/accessibility
 * fallback, without overwriting the user's saved transparency preference.
 */
export function useGlassOrchestrator({
  macBackgroundEffect,
  setMacBackgroundEffect,
  transparency,
  theme,
}: UseGlassOrchestratorOptions): GlassOrchestratorState {
  const [state, setState] = useState<BackgroundEffectState | null>(null);

  useEffect(() => {
    let cancelled = false;
    let receivedUpdate = false;
    const unsubscribe = window.claude.onBackgroundEffectChanged((next) => {
      receivedUpdate = true;
      if (!cancelled) setState(next);
    });
    void window.claude.getBackgroundEffect().then((next) => {
      if (!cancelled && !receivedUpdate) setState(next);
    }).catch((error) => reportError("BACKGROUND_EFFECT", error));
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    void window.claude.setTransparency(transparency)
      .catch((error) => reportError("BACKGROUND_EFFECT", error));
  }, [transparency]);

  // Keep Electron's native theme in sync so Windows Mica follows the app theme.
  useEffect(() => {
    window.claude.setThemeSource(theme);
  }, [theme]);

  // Show restart toast when user wants vibrancy but live is liquid-glass.
  useEffect(() => {
    if (!isMac) return;
    if (!state?.requiresRestart) {
      toast.dismiss(MAC_BACKGROUND_EFFECT_RESTART_TOAST_ID);
      return;
    }

    toast("Restart required", {
      id: MAC_BACKGROUND_EFFECT_RESTART_TOAST_ID,
      duration: Infinity,
      description: "Restart AstraDock to switch away from Liquid Glass cleanly.",
      action: {
        label: "Restart",
        onClick: () => {
          void window.claude.relaunchApp();
        },
      },
    });
    return () => { toast.dismiss(MAC_BACKGROUND_EFFECT_RESTART_TOAST_ID); };
  }, [state?.requiresRestart]);

  // Auto-fallback: if this OS doesn't support liquid glass, downgrade to vibrancy.
  useEffect(() => {
    if (!isMac || state?.liquidGlassSupported !== false) return;
    if (macBackgroundEffect !== "liquid-glass") return;
    setMacBackgroundEffect("vibrancy");
  }, [state?.liquidGlassSupported, macBackgroundEffect, setMacBackgroundEffect]);

  // Always remove stale classes when capability is lost, including GPU fallback.
  useEffect(() => {
    if (state) applyBackgroundEffectClasses(document.documentElement.classList, state);
  }, [state]);

  return {
    glassSupported: state?.availableEffect != null,
    glassActive: state !== null && state.effect !== "solid",
    macLiquidGlassSupported: state?.liquidGlassSupported ?? false,
    liveMacBackgroundEffect: state?.effect === "vibrancy" ? "vibrancy" : "liquid-glass",
  };
}
