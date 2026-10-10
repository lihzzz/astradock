import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TaskDetail } from "../../src/components/tasks/TaskDetail";
import { I18nProvider } from "../../src/lib/i18n";
import { TASKS_EN, TASKS_ZH } from "../../src/components/tasks/strings";
import type { ReviewTaskInput, TaskRun, WorkbenchTask } from "../../shared/types/tasks";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const brief = { title: "Fixture task", objective: "Review fixture evidence", acceptanceCriteria: ["Source checked", "Result checked"] };
const task: WorkbenchTask = { ...brief, id: "task", revision: 2, projectId: "project", workspace: { projectId: "project", rootKind: "project", rootPath: "/fixture", repoCommonDir: null, relativeCwd: "" }, status: "needs_review", latestRunId: "run", createdAt: 1, updatedAt: 2 };
const run: TaskRun = { id: "run", taskId: task.id, engine: "codex", agentId: "codex", conversationId: "conversation", runtimeSessionId: "session", brief, status: "needs_review", review: null, reviewNote: "", error: null, createdAt: 1, updatedAt: 2 };
async function runChecks() {
  const checks: string[] = [];
  const container = document.createElement("main"); document.body.append(container);
  const root = createRoot(container);
  const reviews: ReviewTaskInput[] = [];
  let hasResults = false;
  let currentRun = run;
  let currentTask = task;
  const render = () => flushSync(() => root.render(<StrictMode><I18nProvider><TaskDetail task={currentTask} runs={[currentRun]} deliverables={hasResults ? [{ id: "note", taskId: task.id, runId: run.id, title: "Fixture evidence", kind: "note", content: "Simulated result only", createdAt: 2 }] : []} agents={[]} pending={false} onPrepare={() => { throw new Error("Unexpected prepare"); }} onOpen={() => {}} onAbandon={() => {}} onAdd={async () => true} onReveal={() => {}} onReview={async (input) => { reviews.push(input); return true; }} /></I18nProvider></StrictMode>));
  const button = (key: keyof typeof TASKS_EN) => {
    const found = [...container.querySelectorAll("button")].find((entry) => [TASKS_EN[key], TASKS_ZH[key]].includes(entry.textContent ?? ""));
    assert(found, `Missing ${key}`); return found;
  };
  try {
    render();
    assert(button("tasksAccept").disabled, "No evidence must block acceptance");
    assert(button("tasksRework").disabled, "Rework requires feedback");
    for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) flushSync(() => checkbox.click());
    assert(button("tasksAccept").disabled, "Checklist alone must not permit acceptance");
    checks.push("acceptance requires evidence and explicit checklist");
    hasResults = true; render();
    assert(!button("tasksAccept").disabled, "Evidence refresh must preserve checked criteria");
    flushSync(() => button("tasksAccept").click());
    assert(reviews.length === 1 && reviews[0].decision === "accepted" && reviews[0].checkedCriteria.join() === "0,1", "Explicit acceptance payload");
    checks.push("evidence refresh preserves checklist and submits explicit acceptance");
    const note = container.querySelector<HTMLTextAreaElement>('textarea[maxlength="12000"]'); assert(note, "Review note missing");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set; assert(setter, "Textarea setter missing");
    flushSync(() => { setter.call(note, "Add a source"); note.dispatchEvent(new Event("input", { bubbles: true })); });
    assert(!button("tasksRework").disabled, "Feedback enables rework");
    flushSync(() => button("tasksRework").click());
    assert(reviews.at(-1)?.note === "Add a source", "Feedback retained");
    checks.push("rework submits user feedback");
    currentRun = { ...run, review: "accepted" }; currentTask = { ...task, status: "completed" }; render();
    assert(!container.querySelector('input[type="checkbox"]') && !container.querySelector("form"), "Accepted evidence must be read-only");
    assert(container.textContent?.includes("Simulated result only"), "Accepted evidence must remain visible");
    checks.push("accepted attempt retains evidence without mutation controls");
    currentRun = { ...run, status: "waiting_permission" }; currentTask = { ...task, status: "active" }; render();
    assert(!container.querySelector("form") && !container.querySelector('input[type="checkbox"]'), "Active attempt must not allow review or evidence mutation");
    checks.push("running/approval-waiting attempt cannot be reviewed");
    return checks;
  } finally { flushSync(() => root.unmount()); container.remove(); }
}
Object.assign(window, { runTaskWorkbenchChecks: runChecks });
