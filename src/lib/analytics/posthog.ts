/** Compatibility API: consent and sanitized delivery are owned by the main process.
 * Do not load a renderer SDK merely to keep it permanently disabled. */
export async function syncAnalyticsSettings(): Promise<void> {}
