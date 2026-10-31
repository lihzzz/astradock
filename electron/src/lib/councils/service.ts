import { randomUUID } from "node:crypto";
import { councilCreateSchema, councilStartSchema, councilCommandSchema, councilSupplementSchema, councilId, parseCouncilAssessment } from "@shared/lib/council";
import type { Council, CouncilRun, CouncilSnapshot, CouncilAttempt, CouncilMember, CouncilDelta, CouncilAssessment } from "@shared/types/council";
import type { WorkspaceBinding } from "@shared/types/workspace";
import type { CreateTaskInput } from "@shared/types/tasks";
import { ProductivityError } from "../productivity-errors";
import { buildCouncilContext, conclusionKind, hashCouncil, latestAttempt } from "./context";
export interface CouncilCallResult {
  text: string;
  tokens: number | null;
  cost: number | null;
}
export interface CouncilRuntime {
  validate(member: CouncilMember): Promise<void>;
  execute(input: {
    member: CouncilMember;
    prompt: string;
    signal: AbortSignal;
    onText: (text: string) => void;
  }): Promise<CouncilCallResult>;
}
export interface CouncilDependencies {
  store: {
    load(): Promise<CouncilSnapshot>;
    save(snapshot: CouncilSnapshot): Promise<void>;
  };
  runtime: CouncilRuntime;
  validateWorkspace(binding: WorkspaceBinding): Promise<WorkspaceBinding>;
  projectBlocked(id: string): boolean;
  lease(projectId: string, id: string, stop: () => Promise<void>): Promise<{
    assertActive(): void;
    release(): void;
  }>;
  report(error: unknown): void;
}
const active = (r: CouncilRun) => r.status === "running" || r.status === "pausing";
const terminal = (r: CouncilRun) => ["completed", "cancelled"].includes(r.status);
export class CouncilService {
  private state: CouncilSnapshot | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private workers = new Map<string, {
    controller: AbortController;
    done: Promise<void>;
  }>();
  private listeners = new Set<(state: CouncilSnapshot) => void>();
  private deltaListeners = new Set<(event: CouncilDelta) => void>();
  private closing = false;
  constructor(private readonly deps: CouncilDependencies) {
  }
  onChanged(fn: (state: CouncilSnapshot) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  onDelta(fn: (event: CouncilDelta) => void) {
    this.deltaListeners.add(fn);
    return () => {
      this.deltaListeners.delete(fn);
    };
  }
  private serial<T>(fn: (state: CouncilSnapshot) => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      if (!this.state) {
        const state = await this.deps.store.load();
        let changed = false;
        for (const run of state.runs) {
          if (active(run)) {
            run.status = "interrupted";
            run.error = "Application restarted. Review uncertain calls before continuing.";
            run.revision++;
            changed = true;
          }
          for (const attempt of run.attempts)
            if (attempt.status === "dispatching") {
              attempt.status = "dispatch_unknown";
              attempt.error = "Dispatch or completion was not durably confirmed; no automatic replay.";
              changed = true;
            }
        }
        if (changed) {
          state.revision++;
          await this.deps.store.save(state);
        }
        this.state = state;
      }
      return fn(this.state);
    });
    this.tail = next;
    return next;
  }
  private async commit(state: CouncilSnapshot): Promise<void> {
    state.revision++;
    await this.deps.store.save(state);
    this.state = state;
    for (const fn of this.listeners)
      try {
        fn(structuredClone(state));
      }
      catch (e) {
        this.deps.report(e);
      }
  }
  private run(state: CouncilSnapshot, id: string, revision?: number): CouncilRun {
    const run = state.runs.find(r => r.id === id);
    if (!run)
      throw new ProductivityError("TARGET_GONE", "Discussion no longer exists");
    if (revision !== undefined && revision !== run.revision)
      throw new ProductivityError("REVISION_CONFLICT", "Discussion changed. Refresh and retry.", true);
    return run;
  }
  private touch(run: CouncilRun) {
    run.revision++;
    run.updatedAt = Date.now();
  }
  private available(run: Pick<CouncilRun, "workspace">) {
    if (this.closing || this.deps.projectBlocked(run.workspace.projectId))
      throw new ProductivityError("TARGET_GONE", "Project is unavailable or the application is closing");
  }
  list(): Promise<CouncilSnapshot> {
    return this.serial(async (s) => structuredClone(s));
  }
  create(value: unknown): Promise<Council> {
    const input = councilCreateSchema.parse(value);
    const fingerprint = hashCouncil(input);
    return this.serial(async (s) => {
      const existing = s.councils.find(g => g.requestId === input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ProductivityError("INVALID_ARGUMENT", "Request ID reused with different input");
        return structuredClone(existing);
      }
      this.available(input);
      await Promise.all([...input.members, input.moderator].map(m => this.deps.runtime.validate(m)));
      const workspace = await this.deps.validateWorkspace(input.workspace);
      this.available(input);
      const group: Council = {
        ...input,
        workspace,
        id: randomUUID(),
        fingerprint,
        createdAt: Date.now()
      };
      const next = structuredClone(s);
      next.councils.push(group);
      await this.commit(next);
      return structuredClone(group);
    });
  }
  async start(value: unknown): Promise<CouncilRun> {
    const input = councilStartSchema.parse(value);
    const fingerprint = hashCouncil(input);
    const run = await this.serial(async (s) => {
      const existing = s.runs.find(r => r.requestId === input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new ProductivityError("INVALID_ARGUMENT", "Request ID reused with different input");
        return structuredClone(existing);
      }
      const group = s.councils.find(g => g.id === input.councilId);
      if (!group)
        throw new ProductivityError("TARGET_GONE");
      if (s.runs.some(r => r.councilId === group.id && !terminal(r)))
        throw new ProductivityError("BUSY", "Finish or cancel the previous topic first");
      this.available(group);
      const workspace = await this.deps.validateWorkspace(group.workspace);
      this.available(group);
      await Promise.all([...group.members, group.moderator].map(m => this.deps.runtime.validate(m)));
      this.available(group);
      const now = Date.now();
      const run: CouncilRun = {
        ...input,
        id: randomUUID(),
        fingerprint,
        revision: 1,
        workspace,
        members: structuredClone(group.members),
        moderator: structuredClone(group.moderator),
        settings: { ...group.settings },
        status: "running",
        round: 1,
        phase: "participants",
        attempts: [],
        assessments: [],
        supplements: [],
        retryAttemptIds: [],
        concludeNow: false,
        conclusion: null,
        error: null,
        createdAt: now,
        updatedAt: now
      };
      const next = structuredClone(s);
      next.runs.push(run);
      await this.commit(next);
      return structuredClone(run);
    });
    if (run.status === "running")
      this.launch(run.id);
    return run;
  }
  private launch(id: string): void {
    if (this.workers.has(id) || this.closing)
      return;
    const controller = new AbortController();
    const done = Promise.resolve().then(() => this.drive(id, controller.signal)).catch(async (e) => {
      this.deps.report(e);
      await this.update(id, r => {
        if (!terminal(r)) {
          r.status = "failed";
          r.error = String(e instanceof Error ? e.message : e).slice(0, 2000);
        }
      }).catch(this.deps.report);
    }).finally(() => this.workers.delete(id));
    this.workers.set(id, { controller, done });
  }
  private update(id: string, fn: (r: CouncilRun) => void): Promise<CouncilRun> {
    return this.serial(async (s) => {
      const next = structuredClone(s);
      const r = this.run(next, id);
      fn(r);
      this.touch(r);
      await this.commit(next);
      return structuredClone(r);
    });
  }
  async command(value: unknown): Promise<CouncilRun> {
    const input = councilCommandSchema.parse(value);
    const run = await this.serial(async (s) => {
      const next = structuredClone(s);
      const r = this.run(next, input.runId, input.expectedRevision);
      if (terminal(r))
        throw new ProductivityError("INVALID_STATE", "This topic has ended; start a follow-up topic");
      if (input.action === "cancel") {
        r.status = "cancelled";
        r.error = null;
      }
      else if (input.action === "pause") {
        if (r.status !== "running")
          throw new ProductivityError("INVALID_STATE");
        r.status = "pausing";
      }
      else {
        if (active(r) && input.action !== "summarize")
          throw new ProductivityError("BUSY", "Pause before changing an attempt");
        this.available(r);
        await this.deps.validateWorkspace(r.workspace);
        this.available(r);
        if (input.action === "retry" || input.action === "skip") {
          const a = r.attempts.find(a => a.id === input.attemptId);
          if (!a || a.round !== r.round || !["failed", "cancelled", "dispatch_unknown"].includes(a.status) || latestAttempt(r, a.memberId, a.phase === "participant" ? "participant" : "assessment")?.id !== a.id)
            throw new ProductivityError("INVALID_ARGUMENT", "Select the current failed or uncertain attempt");
          if (a.status === "dispatch_unknown" && !input.confirmUnknown)
            throw new ProductivityError("CONFIRM_REQUIRED", "The original call may have run. Confirm before retrying or skipping.");
          if (input.action === "skip") {
            if (a.phase !== "participant")
              throw new ProductivityError("INVALID_ARGUMENT", "A moderator cannot be skipped");
            a.status = "skipped";
          }
          else {
            if (r.attempts.length >= r.settings.maxCalls)
              throw new ProductivityError("CAPACITY_REACHED", "Call budget exhausted");
            r.retryAttemptIds.push(a.id);
          }
        }
        if (input.action === "resume") r.concludeNow = false;
        if (input.action === "summarize")
          r.concludeNow = true;
        r.status = "running";
        r.error = null;
      }
      this.touch(r);
      await this.commit(next);
      return structuredClone(r);
    });
    if (input.action === "cancel")
      this.workers.get(run.id)?.controller.abort();
    else if (run.status === "running") {
      const worker = this.workers.get(run.id);
      if (worker)
        void worker.done.then(() => this.launch(run.id));
      else
        this.launch(run.id);
    }
    return run;
  }
  supplement(value: unknown): Promise<CouncilRun> {
    const input = councilSupplementSchema.parse(value);
    return this.serial(async (s) => {
      const next = structuredClone(s);
      const r = this.run(next, input.runId);
      const old = r.supplements.find(s => s.id === input.id);
      if (old) {
        if (old.text !== input.text)
          throw new ProductivityError("INVALID_ARGUMENT");
        return structuredClone(r);
      }
      this.run(next, input.runId, input.expectedRevision);
      if (terminal(r) || r.round >= r.settings.maxRounds || r.settings.mode === "parallel")
        throw new ProductivityError("INVALID_STATE", "No next round; start a follow-up topic with these materials");
      r.supplements.push({
        id: input.id,
        text: input.text,
        appliedRound: null
      });
      this.touch(r);
      await this.commit(next);
      return structuredClone(r);
    });
  }
  private async drive(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const s = await this.list();
      const r = this.run(s, id);
      if (r.status === "pausing") {
        await this.update(id, r => {
          r.status = "paused";
        });
        return;
      }
      if (r.status !== "running")
        return;
      this.available(r);
      if (r.phase === "participants") {
        const pending = r.members.filter(m => {
          const a = latestAttempt(r, m.id, "participant");
          return !a || r.retryAttemptIds.includes(a.id);
        });
        const eligible = r.concludeNow ? pending.filter(m => {const a = latestAttempt(r,m.id,"participant");return !!a && r.retryAttemptIds.includes(a.id);}) : pending;
        if (eligible.length) {
          if (r.attempts.length >= r.settings.maxCalls) {
            await this.budgetConclusion(id);
            return;
          }
          await Promise.all(eligible.slice(0, Math.min(r.settings.concurrency, r.settings.maxCalls - r.attempts.length)).map(m => this.call(id, m, "participant", signal)));
          continue;
        }
        const unresolved = r.members.some(m => {
          const a = latestAttempt(r, m.id, "participant");
          return a && !["completed", "skipped"].includes(a.status);
        });
        if (unresolved) {
          await this.update(id, r => {
            r.status = "waiting_user";
            r.error = "A member failed or has uncertain dispatch. Retry, skip, or cancel explicitly.";
          });
          return;
        }
        if (!r.attempts.some(a => a.round === r.round && a.phase === "participant" && a.status === "completed")) {
          await this.update(id, r => {
            r.status = "waiting_user";
            r.error = "No completed statements to summarize.";
          });
          return;
        }
        await this.update(id, r => {
          r.phase = "assessment";
        });
        continue;
      }
      const a = latestAttempt(r, r.moderator.id, "assessment");
      if (!a || r.retryAttemptIds.includes(a.id)) {
        if (r.attempts.length >= r.settings.maxCalls) {
          await this.budgetConclusion(id);
          return;
        }
        await this.call(id, r.moderator, a?.phase === "repair" ? "repair" : "assessment", signal);
        continue;
      }
      if (a.status !== "completed") {
        await this.update(id, r => {
          r.status = "waiting_user";
          r.error = "Moderator failed. Retry explicitly or cancel.";
        });
        return;
      }
      let assessment: CouncilAssessment;
      try {
        assessment = parseCouncilAssessment(a.text);
        const ids = new Set(r.members.map(m => m.id));
        if (assessment.disagreements.some(d => d.memberIds.some(id => !ids.has(id))) || assessment.movements.some(m => !ids.has(m.memberId)) || new Set(assessment.movements.map(m => m.memberId)).size !== assessment.movements.length)
          throw new Error("Unknown or duplicate member ID in assessment");
      }
      catch {
        if (a.phase !== "repair") {
          if (r.attempts.length >= r.settings.maxCalls) {
            await this.budgetConclusion(id);
            return;
          }
          await this.call(id, r.moderator, "repair", signal);
          continue;
        }
        await this.update(id, r => {
          const attempt = r.attempts.find(x => x.id === a.id);
          if (attempt) {
            attempt.status = "failed";
            attempt.error = "Invalid assessment schema after one repair. Raw response preserved.";
          }
          r.status = "waiting_user";
          r.error = "Moderator output is not valid structured data.";
        });
        return;
      }
      await this.update(id, run => {
        if (run.status !== "running" && run.status !== "pausing")
          return;
        run.assessments.push({
          round: run.round,
          attemptId: a.id,
          result: assessment
        });
        const kind = conclusionKind(run, assessment);
        const pendingSupplements = run.supplements.some(s => s.appliedRound === null);
        const finish = run.concludeNow || run.settings.mode === "parallel" || run.round >= run.settings.maxRounds || (kind === "consensus" && !pendingSupplements) || run.attempts.length >= run.settings.maxCalls;
        if (finish) {
          run.conclusion = {
            kind,
            assessment,
            sourceAttemptIds: a.sourceAttemptIds,
            materialVersion: a.materialVersion,
            hash: hashCouncil({
              assessment,
              sources: a.sourceAttemptIds,
              context: a.contextHash
            })
          };
          run.status = "completed";
          run.error = pendingSupplements ? "Queued supplements were not used in this conclusion; start a follow-up topic." : null;
        }
        else {
          run.round++;
          run.phase = "participants";
          for (const s of run.supplements)
            if (s.appliedRound === null)
              s.appliedRound = run.round;
        }
      });
    }
  }
  private async budgetConclusion(id: string): Promise<void> {
    await this.update(id, r => {
      const assessment: CouncilAssessment = {
        summary: "Call budget reached before a valid final assessment.",
        recommendation: "No verified recommendation. Review the preserved statements and unresolved disagreements before acting.",
        agreements: [],
        disagreements: [{
            kind: "action",
            description: "The discussion did not finish within the call budget.",
            memberIds: r.members.map(m => m.id)
          }],
        movements: [],
        converged: false,
        acceptanceCriteria: ["Independently validate the proposal against the current workspace before executing"]
      };
      const sourceAttemptIds = r.attempts.filter(a => a.status === "completed").map(a => a.id);
      r.conclusion = {
        kind: "inconclusive",
        assessment,
        sourceAttemptIds,
        materialVersion: 1 + r.supplements.filter(s => s.appliedRound !== null).length,
        hash: hashCouncil({ assessment, sourceAttemptIds })
      };
      r.status = "completed";
      r.error = "Call budget exhausted; no additional calls sent.";
    });
  }
  private async call(id: string, member: CouncilMember, phase: CouncilAttempt["phase"], parent: AbortSignal): Promise<void> {
    const prepared = await this.serial(async (s) => {
      const next = structuredClone(s);
      const r = this.run(next, id);
      if (r.status !== "running" || parent.aborted || r.attempts.length >= r.settings.maxCalls)
        return null;
      this.available(r);
      const context = buildCouncilContext(r, member, phase);
      const attempt: CouncilAttempt = {
        id: randomUUID(),
        memberId: member.id,
        round: r.round,
        phase,
        status: "dispatching",
        ...context,
        contextHash: hashCouncil(context.prompt),
        templateVersion: 1,
        text: "",
        error: null,
        tokens: null,
        cost: null,
        startedAt: Date.now(),
        endedAt: null
      };
      const old = latestAttempt(r, member.id, phase === "participant" ? "participant" : "assessment");
      if (old)
        r.retryAttemptIds = r.retryAttemptIds.filter(x => x !== old.id);
      r.attempts.push(attempt);
      this.touch(r);
      await this.commit(next);
      return {
        attempt,
        workspace: r.workspace,
        timeoutMs: r.settings.timeoutMs
      };
    });
    if (!prepared)
      return;
    const { attempt, workspace, timeoutMs } = prepared;
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted)
      abort();
    let text = "";
    let last = 0;
    let timedOut = false;
    let responseReceived = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let lease: Awaited<ReturnType<CouncilDependencies["lease"]>> | null = null;
    try {
      lease = await this.deps.lease(workspace.projectId, attempt.id, async () => {
        controller.abort();
      });
      lease.assertActive();
      await this.deps.runtime.validate(member);
      controller.signal.throwIfAborted();
      const result = await this.deps.runtime.execute({
        member,
        prompt: attempt.prompt,
        signal: controller.signal,
        onText: chunk => {
          if (controller.signal.aborted)
            return;
          text = chunk.slice(0, 64000);
          if (chunk.length > 64000) {
            controller.abort();
            return;
          }
          if (Date.now() - last < 80)
            return;
          last = Date.now();
          for (const fn of this.deltaListeners)
            try {
              fn({
                runId: id,
                attemptId: attempt.id,
                text
              });
            }
            catch (e) {
              this.deps.report(e);
            }
        }
      });
      responseReceived = true;
      lease.assertActive();
      controller.signal.throwIfAborted();
      if (!result.text.trim() || result.text.length > 64000)
        throw new Error("Empty or oversized Council response");
      await this.update(id, r => {
        const a = r.attempts.find(a => a.id === attempt.id);
        if (!a || a.status !== "dispatching")
          return;
        if (terminal(r)) {
          a.status = "cancelled";
          a.text = text;
        }
        else {
          a.status = "completed";
          a.text = result.text;
          a.tokens = result.tokens;
          a.cost = result.cost;
        }
        a.endedAt = Date.now();
      });
    }
    catch (e) {
      if (!controller.signal.aborted)
        this.deps.report(e);
      await this.update(id, r => {
        const a = r.attempts.find(a => a.id === attempt.id);
        if (!a || a.status !== "dispatching")
          return;
        a.status = parent.aborted ? "cancelled" : responseReceived ? "dispatch_unknown" : "failed";
        a.text = text;
        a.error = (timedOut ? "Call timed out" : e instanceof Error ? e.message : String(e)).slice(0, 2000);
        a.endedAt = Date.now();
      });
    }
    finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
      lease?.release();
    }
  }
  taskBrief(value: {
    runId: string;
    expectedRevision: number;
  }): Promise<CreateTaskInput> {
    return this.serial(async (s) => {
      const r = this.run(s, councilId.parse(value.runId), value.expectedRevision);
      this.available(r);
      if (!r.conclusion || r.status !== "completed")
        throw new ProductivityError("INVALID_STATE", "No completed conclusion");
      const c = r.conclusion;
      const objective = [c.assessment.recommendation, "Remaining disagreements:", ...c.assessment.disagreements.map(d => d.description), "Council source: " + r.id + "; revision " + r.revision + "; SHA-256 " + c.hash, "This is an AI recommendation, not verified execution or permission. Validate the current workspace first."].join("\n\n");
      if (objective.length > 12000)
        throw new ProductivityError("CAPACITY_REACHED", "Conclusion too long for a task; copy and shorten it manually");
      return {
        title: r.objective.slice(0, 160),
        objective,
        acceptanceCriteria: [...new Set(c.assessment.acceptanceCriteria)],
        workspace: r.workspace
      };
    });
  }
  async remove(value: unknown): Promise<null> {
    const id = councilId.parse(value);
    return this.serial(async (s) => {
      if (s.runs.some(r => r.councilId === id && (active(r) || this.workers.has(r.id))))
        throw new ProductivityError("BUSY", "Cancel running discussions and wait for cleanup first");
      const next = structuredClone(s);
      next.councils = next.councils.filter(g => g.id !== id);
      next.runs = next.runs.filter(r => r.councilId !== id);
      await this.commit(next);
      return null;
    });
  }
  async removeProject(projectId: string): Promise<void> {
    const s = await this.list();
    const ids = s.runs.filter(r => r.workspace.projectId === projectId).map(r => r.id);
    for (const id of ids)
      this.workers.get(id)?.controller.abort();
    await Promise.all(ids.map(id => this.workers.get(id)?.done));
    await this.serial(async (s) => {
      const next = structuredClone(s);
      next.councils = next.councils.filter(g => g.workspace.projectId !== projectId);
      next.runs = next.runs.filter(r => r.workspace.projectId !== projectId);
      await this.commit(next);
    });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    try {
      for (const worker of this.workers.values())
        worker.controller.abort();
      await Promise.all([...this.workers.values()].map(w => w.done));
      await this.serial(async (s) => {
        const next = structuredClone(s);
        for (const r of next.runs)
          if (active(r)) {
            r.status = "interrupted";
            this.touch(r);
          }
        await this.commit(next);
      });
    }
    finally {
      this.closing = false;
    } // A cancelled application quit must not permanently disable Councils.
  }
}
