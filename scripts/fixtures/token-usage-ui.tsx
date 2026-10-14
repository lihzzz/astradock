import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { UsageDashboard } from "../../src/components/settings/UsageDashboard";
import { I18nProvider } from "../../src/lib/i18n";
import { useSettingsStore } from "../../src/stores/settings-store";
import { buildUsageReport } from "../../shared/lib/usage";
import type { UsageRange, UsageTokenEntry, UsageTokens } from "../../shared/types/usage";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function waitFor(check: () => boolean, message: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 5000) throw new Error(`UI timed out: ${message}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

const now = +new Date(2026, 9, 13, 12);
const timestamp = (daysAgo: number) => +new Date(2026, 9, 13 - daysAgo, 11);
const initialEntries: UsageTokenEntry[] = [
  { timestamp: timestamp(0), engine: "claude", totalTokens: 180, inputTokens: 150, outputTokens: 30, cacheReadTokens: 50, cacheCreationTokens: 20 },
  { timestamp: timestamp(0), engine: "codex", totalTokens: 420, inputTokens: 400, outputTokens: 20, cacheReadTokens: 100, cacheCreationTokens: 0 },
  { timestamp: timestamp(1), engine: "claude", totalTokens: 90, inputTokens: 80, outputTokens: 10, cacheReadTokens: 25, cacheCreationTokens: 5 },
  { timestamp: timestamp(6), engine: "codex", totalTokens: 1000, inputTokens: 900, outputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 0 },
  { timestamp: timestamp(20), engine: "claude", totalTokens: 2000, inputTokens: 1500, outputTokens: 500, cacheReadTokens: 500, cacheCreationTokens: 100 },
];

let cleanup = () => {};

async function runChecks() {
  cleanup();
  localStorage.clear();
  useSettingsStore.getState().setLanguage("en-US");
  const container = document.createElement("main");
  container.className = "@container";
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { flushSync(() => root.unmount()); container.remove(); };
  const requests: UsageRange[] = [];
  let failNext = false;
  let includeAcp = false;
  Object.assign(window, { claude: { usage: {
    get: async (range: UsageRange) => {
      requests.push(range);
      if (failNext) { failNext = false; return { error: "Fixture refresh failed" }; }
      const tokens: UsageTokens = {
        version: 1, trackingStartedAt: timestamp(28), entries: includeAcp ? [...initialEntries,
          { timestamp: timestamp(0), engine: "acp", totalTokens: 80, inputTokens: 40, outputTokens: 30, cacheReadTokens: 10, cacheCreationTokens: 0 },
        ] : initialEntries,
      };
      return { data: buildUsageReport([], { version: 1, trackingStartedAt: timestamp(28), active: [], agent: [] }, range, tokens, now) };
    },
  } } });

  const button = (name: string, scope: ParentNode = container) => {
    const found = [...scope.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
    assert(found, `Missing button ${name}`);
    return found;
  };
  const tokenSection = () => {
    const section = container.querySelector('section[aria-labelledby="usage-token-heading"]');
    assert(section, "Token section missing");
    return section;
  };
  const summary = () => [...tokenSection().querySelectorAll("dl > div > dd")].slice(0, 3).map((item) => item.textContent);
  const rows = () => [...container.querySelectorAll('section[aria-labelledby="usage-token-heading"] tbody tr')];
  const rowValues = (date: string) => {
    const row = rows().find((entry) => entry.querySelector("th")?.textContent === date);
    assert(row, `Missing daily row ${date}`);
    return [...row.querySelectorAll("td")].map((entry) => entry.textContent?.trim());
  };
  const engineCard = (name: string) => {
    const card = [...tokenSection().querySelectorAll('div[aria-label="Usage engine"] > div')]
      .find((entry) => entry.firstElementChild?.textContent?.trim() === name);
    assert(card, `Missing engine card ${name}`);
    return card;
  };
  const click = (target: HTMLElement) => flushSync(() => target.click());
  const checks: string[] = [];
  try {
    flushSync(() => root.render(<StrictMode><I18nProvider><UsageDashboard /></I18nProvider></StrictMode>));
    await waitFor(() => container.querySelectorAll("#usage-token-heading").length === 1, "initial report");
    assert(requests.includes(7), "Initial report must request 7 days");
    assert(summary().join("|") === "1,690|1,530|160", "7-day totals should include only the week’s reported consumption");
    assert(rows().length === 7, "7-day report must list seven dates");
    checks.push("loads 7-day tokens through the actual dashboard and React effects");

    click(button("1 day"));
    await waitFor(() => rows().length === 1 && requests.at(-1) === 1, "1-day report");
    assert(summary().join("|") === "600|550|50", "1-day summary must exclude yesterday’s and earlier tokens");
    assert(rowValues("2026-10-13").join("|") === "600|550|50|150|20", "Daily totals must include cache once, with separate cache details");
    click(button("7 days"));
    await waitFor(() => rows().length === 7 && requests.at(-1) === 7, "7-day report");
    assert(summary()[0] === "1,690", "Returning to 7 days must restore weekly total");
    click(button("30 days"));
    await waitFor(() => rows().length === 30 && requests.at(-1) === 30, "30-day report");
    assert(summary().join("|") === "3,690|3,030|660", "30-day summary must include the older reported use");
    assert(button("90 days"), "Existing 90-day range remains available");
    checks.push("1/7/30-day controls request their ranges and update totals and daily rows");

    const requestCount = requests.length;
    click(button("Claude", tokenSection()));
    assert(summary().join("|") === "2,270|1,730|540", "Claude filter must isolate Claude consumption");
    assert(rowValues("2026-10-13").join("|") === "180|150|30|50|20", "Claude daily cache details must remain separate");
    click(button("Codex", tokenSection()));
    assert(summary().join("|") === "1,420|1,300|120", "Codex filter must isolate Codex consumption");
    assert(rowValues("2026-10-13").join("|") === "420|400|20|100|0", "Codex daily values must match its report");
    assert(rowValues("2026-10-12").every((value) => value === "Not recorded"), "Missing Codex daily report must not be shown as zero");
    assert(requests.length === requestCount, "Engine filters must use the received report without another IPC request");
    checks.push("Claude/Codex filters update summary, input/output and daily cache breakdowns");

    click(button("ACP", tokenSection()));
    assert(summary().every((value) => value === "Not recorded"), "Unreported ACP period must be marked as unrecorded");
    assert(engineCard("ACP").querySelector("p")?.textContent === "Not recorded", "ACP card must distinguish missing report from zero");
    assert(rowValues("2026-10-13").every((value) => value === "Not recorded"), "ACP daily usage must remain unrecorded when the agent reports none");
    assert(tokenSection().textContent?.includes("No token usage reports have been received"), "Missing-report explanation should be visible");
    click(button("All engines", tokenSection()));
    assert(rowValues("2026-09-14").every((value) => value === "Not recorded"), "Dates before tracking must show unrecorded values");
    assert(tokenSection().textContent?.includes("Cache reads and writes are parts of input"), "Cache counting explanation must be shown");
    checks.push("unreported ACP and dates before tracking show Not recorded instead of an accurate zero");

    failNext = true;
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh statistics"]');
    assert(refresh, "Refresh button missing");
    click(refresh);
    await waitFor(() => container.querySelector('[role="alert"]') !== null, "refresh failure");
    assert(summary()[0] === "3,690", "Refresh failure must preserve the last successful summary");
    assert(rows().length === 30, "Refresh failure must preserve the daily detail");
    assert(container.querySelector('[role="alert"]')?.textContent?.includes("last available data"), "Refresh failure should explain that previous statistics remain");
    includeAcp = true;
    click(button("Retry"));
    await waitFor(() => container.querySelector('[role="alert"]') === null && summary()[0] === "3,770", "successful retry");
    click(button("ACP", tokenSection()));
    assert(summary().join("|") === "80|40|30", "ACP must retain its explicit engine-reported total, including additional thought tokens");
    assert(rowValues("2026-10-13").join("|") === "80|40|30|10|0", "Newly reported ACP usage must be visible after retry");
    click(button("All engines", tokenSection()));
    checks.push("failed refresh retains prior results and retry updates them with reported ACP usage");

    flushSync(() => useSettingsStore.getState().setLanguage("zh-CN"));
    assert(container.querySelector("#usage-token-heading")?.textContent === "Token 使用统计", "Chinese token heading missing");
    assert(button("1 天") && button("全部引擎", tokenSection()), "Chinese range and engine controls missing");
    assert(tokenSection().textContent?.includes("总量采用引擎报告值，包含缓存"), "Chinese counting explanation missing");
    assert(tokenSection().textContent?.includes("Token 记录开始于"), "Chinese tracking-start explanation missing");
    assert(rowValues("2026-09-14").every((value) => value === "未记录"), "Chinese unrecorded values missing");
    flushSync(() => useSettingsStore.getState().setLanguage("en-US"));
    assert(container.querySelector("#usage-token-heading")?.textContent === "Token usage", "English token heading missing");
    checks.push("Chinese and English labels, counting notes and missing-data states update without remounting");
    return checks;
  } catch (error) {
    cleanup();
    throw error;
  }
}

Object.assign(window, {
  runTokenUsageChecks: runChecks,
  cleanupTokenUsageChecks: () => cleanup(),
  setTokenUsageLanguage: (language: "zh-CN" | "en-US") => flushSync(() => useSettingsStore.getState().setLanguage(language)),
});
