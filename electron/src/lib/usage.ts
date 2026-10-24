import fs from "node:fs";
import path from "node:path";
import type { UsageTimings } from "@shared/types/usage";
import { getDataDir } from "./data-dir";
import { writeTextAtomically } from "./atomic-file";
import { UsageTracker } from "./usage-tracker";
import { USAGE_SAMPLE_MS } from "@shared/lib/usage";
import { log } from "./logger";
import { flushTokenUsage, getTokenUsage } from "./token-usage";
import { reportError } from "./error-utils";

let tracker: UsageTracker | undefined;
let loadError: unknown;
let writeQueue: Promise<void> = Promise.resolve();
let savedJson = "";
let timer: ReturnType<typeof setInterval> | undefined;

function isTimings(value: unknown): value is UsageTimings {
  if (!value || typeof value !== "object") return false;
  const data = value as UsageTimings;
  return data.version === 1 && Number.isFinite(data.trackingStartedAt)
    && [data.active, data.agent].every((intervals) => Array.isArray(intervals) && intervals.every(
      (interval) => Array.isArray(interval) && interval.length === 2 && interval.every(Number.isFinite) && interval[0] <= interval[1],
    ));
}

export function getUsageTracker(): UsageTracker {
  if (!tracker) {
    let saved: UsageTimings | undefined;
    try {
      const json = fs.readFileSync(path.join(getDataDir(), "usage-timings.json"), "utf-8");
      const parsed: unknown = JSON.parse(json);
      if (!isTimings(parsed)) throw new Error("Invalid usage timing data");
      saved = parsed;
      savedJson = json;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Keep an unreadable file intact and surface the failure in the dashboard.
        loadError = error;
        log("USAGE_LOAD_ERR", error);
      }
    }
    tracker = new UsageTracker(Date.now(), saved);
  }
  return tracker;
}

export function beginUsageTurn(sessionId: string, turnId = "turn"): void {
  getUsageTracker().begin(sessionId, turnId);
}

export function endUsageTurn(sessionId: string, turnId = "turn"): void {
  getUsageTracker().end(sessionId, turnId);
}

export function stopUsageSession(sessionId: string): void {
  getUsageTracker().stopSession(sessionId);
}

export function getUsageTimings(): UsageTimings {
  const current = getUsageTracker();
  if (loadError) throw loadError;
  current.checkpoint();
  return current.data;
}

function flushUsageTimings(): Promise<void> {
  const current = getUsageTracker();
  if (loadError) return Promise.reject(loadError);
  current.checkpoint();
  const json = JSON.stringify(current.data);
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    if (json === savedJson) return;
    await writeTextAtomically(path.join(getDataDir(), "usage-timings.json"), json);
    savedJson = json;
  });
  return writeQueue;
}

export function flushUsage(): Promise<void> {
  return Promise.all([flushUsageTimings(), flushTokenUsage()]).then(() => undefined);
}

export function startUsageTracking(): void {
  if (timer) return;
  getUsageTracker();
  try { getTokenUsage(); }
  catch (error) { reportError("TOKEN_USAGE_LOAD_ERR", error); }
  void flushUsage().catch((error) => log("USAGE_SAVE_ERR", error));
  timer = setInterval(() => {
    void flushUsage().catch((error) => log("USAGE_SAVE_ERR", error));
  }, USAGE_SAMPLE_MS);
  timer.unref();
}

export function shutdownUsage(): Promise<void> {
  clearInterval(timer);
  timer = undefined;
  return flushUsage();
}
