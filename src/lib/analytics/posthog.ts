/**
 * Compatibility client for PostHogProvider. Renderer delivery stays disabled;
 * all product/error events go through the main-process consent/privacy gate.
 */

import posthog from "posthog-js";

// Same public API key used by the main process (posthog-node).
// PostHog project API keys are client-side safe — designed to be embedded in source.
const POSTHOG_KEY = "phc_lOKFRov0SWy2R71BNJ2t978tmNYc3ND7WwueOteV5vw";
const POSTHOG_HOST = "https://us.i.posthog.com";

/** Initialize the provider without enabling any renderer telemetry. */
export function initPostHog(): void {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    defaults: "2026-01-30",

    // ── Privacy: start opted out until we confirm the user has opted in ──
    opt_out_capturing_by_default: true,

    // ── Electron-specific: disable web-oriented autocapture ──
    // No meaningful pageviews/pageleaves in a single-window Electron app
    capture_pageview: false,
    capture_pageleave: false,
    // Disable all renderer-side automatic capture.
    autocapture: false,
    capture_exceptions: false,
    disable_session_recording: true,
    // All telemetry uses the main-process allowlist. Never send SDK-enriched
    // renderer events (which can contain URLs, stacks, or component content).
    before_send: () => null,

    // ── Persistence ──
    persistence: "localStorage",
  });
}

/** Preserve the existing settings-sync API, but never enable renderer capture. */
export async function syncAnalyticsSettings(): Promise<void> {
  // Main process owns consent and sanitized delivery; renderer stays opted out.
  posthog.opt_out_capturing();
}

export { posthog };
