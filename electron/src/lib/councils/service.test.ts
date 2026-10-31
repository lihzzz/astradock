import { describe, it, expect, vi } from "vitest";
import type { CouncilSnapshot, CouncilCreateInput, CouncilAssessment } from "@shared/types/council";
import { CouncilService, type CouncilRuntime } from "./service";
import { buildCouncilContext, conclusionKind } from "./context";
const workspace = {
  projectId: "project",
  rootKind: "project" as const,
  rootPath: "/workspace",
  repoCommonDir: null,
  relativeCwd: ""
};
const members = [{
    id: "a",
    name: "A",
    engine: "claude" as const,
    agentId: "claude-code",
    model: "sonnet",
    role: "Architect"
  }, {
    id: "b",
    name: "B",
    engine: "claude" as const,
    agentId: "claude-code",
    model: "opus",
    role: "Reviewer"
  }];
const moderator = {
  ...members[0],
  id: "host",
  name: "Host",
  role: "Moderator"
};
const config: CouncilCreateInput = {
  requestId: "create",
  title: "Design",
  workspace,
  members,
  moderator,
  settings: {
    mode: "consensus",
    maxRounds: 3,
    concurrency: 2,
    timeoutMs: 1000,
    maxCalls: 24
  }
};
const assessment: CouncilAssessment = {
  summary: "Summary",
  recommendation: "Use a tested design",
  agreements: ["Keep tests"],
  disagreements: [],
  movements: members.map(m => ({
    memberId: m.id,
    stance: "converged",
    note: "Agrees"
  })),
  converged: true,
  acceptanceCriteria: ["Tests pass"]
};
const position = JSON.stringify({
  statement: "Independent evidence",
  agreesWithPriorAssessment: true,
  dissent: []
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return {
    promise,
    resolve,
    reject
  };
}
function fixture(execute?: CouncilRuntime["execute"], saved?: CouncilSnapshot) {
  let disk: CouncilSnapshot = saved ?? {
    version: 1,
    revision: 0,
    councils: [],
    runs: []
  };
  let blocked = false;
  const runtime = { validate: vi.fn(async () => {
    }), execute: vi.fn(execute ?? (async (input) => ({
      text: input.member.id === "host" ? JSON.stringify(assessment) : position,
      tokens: 10,
      cost: null
    }))) };
  const store = { load: vi.fn(async () => structuredClone(disk)), save: vi.fn(async (s: CouncilSnapshot) => {
      disk = structuredClone(s);
    }) };
  const release = vi.fn();
  const lease = vi.fn(async () => ({ assertActive: () => {
      if (blocked)
        throw Error("Deleted");
    }, release }));
  const report = vi.fn();
  const service = new CouncilService({
    store,
    runtime,
    validateWorkspace: async (w) => w,
    projectBlocked: () => blocked,
    lease,
    report
  });
  async function start(overrides: Partial<CouncilCreateInput["settings"]> = {}) {
    const group = await service.create({ ...config, settings: { ...config.settings, ...overrides } });
    return service.start({
      requestId: "start",
      councilId: group.id,
      objective: "Solve it",
      materials: "Shared facts",
      constraints: "No edits"
    });
  }
  async function read(id: string) {
    return (await service.list()).runs.find(r => r.id === id)!;
  }
  async function settled(id: string) {
    await vi.waitFor(async () => {
      expect(["running", "pausing"]).not.toContain((await read(id)).status);
    }, { timeout: 4000 });
    return read(id);
  }
  return {
    service,
    start,
    read,
    settled,
    runtime,
    store,
    release,
    lease,
    report,
    disk: () => structuredClone(disk),
    block: () => {
      blocked = true;
    }
  };
}
describe("Council coordination", () => {
  it("freezes clean-room round one, converges only after explicit second-round agreement", async () => {
    const f = fixture();
    const start = await f.start();
    const r = await f.settled(start.id);
    expect(r.status).toBe("completed");
    expect(r.round).toBe(2);
    expect(r.conclusion?.kind).toBe("consensus");
    expect(f.runtime.execute).toHaveBeenCalledTimes(6);
    const first = f.runtime.execute.mock.calls.filter(([i]) => i.member.id !== "host").slice(0, 2);
    for (const [i] of first) {
      expect(i.prompt).not.toContain("Independent evidence");
      expect(i.prompt).toContain('"statements":[]');
    }
    expect(r.attempts.every(a => a.contextHash.length === 64)).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(6);
  });
  it("parallel mode with an exact call budget still commits the final assessment", async () => {
    const f = fixture();
    const r = await f.settled((await f.start({
      mode: "parallel",
      maxRounds: 1,
      maxCalls: 3
    })).id);
    expect(r.status).toBe("completed");
    expect(r.conclusion?.kind).toBe("recommendation_with_dissent");
    expect(f.runtime.execute).toHaveBeenCalledTimes(3);
  });
  it("host declarations cannot turn an explicit dissent into consensus", async () => {
    const f = fixture(async (i) => ({
      text: i.member.id === "host" ? JSON.stringify(assessment) : JSON.stringify({
        statement: "No",
        agreesWithPriorAssessment: false,
        dissent: ["Unverified premise"]
      }),
      tokens: null,
      cost: null
    }));
    const r = await f.settled((await f.start()).id);
    expect(r.round).toBe(3);
    expect(r.conclusion?.kind).toBe("recommendation_with_dissent");
  });
  it("deduplicates creation and start requests, rejects changed payloads", async () => {
    const f = fixture();
    const g = await f.service.create(config);
    expect((await f.service.create(config)).id).toBe(g.id);
    await expect(f.service.create({ ...config, title: "different" })).rejects.toThrow("Request ID reused");
    const input = {
      requestId: "same",
      councilId: g.id,
      objective: "Goal",
      materials: "",
      constraints: ""
    };
    const [a, b] = await Promise.all([f.service.start(input), f.service.start(input)]);
    expect(a.id).toBe(b.id);
    await f.settled(a.id);
    expect((await f.service.list()).runs).toHaveLength(1);
  });
  it("pauses dispatch, waits for in-flight work, and resumes without replay", async () => {
    const gate = deferred<{
      text: string;
      tokens: null;
      cost: null;
    }>();
    let calls = 0;
    const f = fixture(async (i) => {
      calls++;
      if (calls === 1)
        return gate.promise;
      return {
        text: i.member.id === "host" ? JSON.stringify(assessment) : position,
        tokens: null,
        cost: null
      };
    });
    const r = await f.start({
      concurrency: 1,
      mode: "parallel",
      maxRounds: 1
    });
    await vi.waitFor(() => expect(calls).toBe(1));
    const current = await f.read(r.id);
    await f.service.command({
      runId: r.id,
      expectedRevision: current.revision,
      action: "pause"
    });
    expect((await f.read(r.id)).status).toBe("pausing");
    gate.resolve({
      text: position,
      tokens: null,
      cost: null
    });
    const paused = await f.settled(r.id);
    expect(paused.status).toBe("paused");
    expect(calls).toBe(1);
    await f.service.command({
      runId: r.id,
      expectedRevision: paused.revision,
      action: "resume"
    });
    expect((await f.settled(r.id)).status).toBe("completed");
    expect(calls).toBe(3);
  });
  it("keeps a missing member visible and permits explicit skip, never false unanimity", async () => {
    const f = fixture(async (i) => {
      if (i.member.id === "b")
        throw Error("Unavailable");
      return {
        text: i.member.id === "host" ? JSON.stringify(assessment) : position,
        tokens: null,
        cost: null
      };
    });
    let r = await f.settled((await f.start({ mode: "parallel", maxRounds: 1 })).id);
    expect(r.status).toBe("waiting_user");
    const failed = r.attempts.find(a => a.status === "failed")!;
    await f.service.command({
      runId: r.id,
      expectedRevision: r.revision,
      action: "skip",
      attemptId: failed.id
    });
    r = await f.settled(r.id);
    expect(r.conclusion?.kind).toBe("partial");
    expect(f.runtime.execute.mock.calls.filter(([i]) => i.member.id === "a")).toHaveLength(1);
  });
  it("retries only the failed seat, preserves its prior attempt", async () => {
    let failed = false;
    const f = fixture(async (i) => {
      if (i.member.id === "b" && !failed) {
        failed = true;
        throw Error("Transient");
      }
      return {
        text: i.member.id === "host" ? JSON.stringify(assessment) : position,
        tokens: null,
        cost: null
      };
    });
    let r = await f.settled((await f.start({ mode: "parallel", maxRounds: 1 })).id);
    await f.service.command({
      runId: r.id,
      expectedRevision: r.revision,
      action: "retry",
      attemptId: r.attempts.find(a => a.status === "failed")!.id
    });
    r = await f.settled(r.id);
    expect(r.status).toBe("completed");
    expect(r.attempts.filter(a => a.memberId === "b")).toHaveLength(2);
    expect(f.runtime.execute.mock.calls.filter(([i]) => i.member.id === "a")).toHaveLength(1);
  });
  it("repairs invalid moderator JSON once, then waits for user", async () => {
    const f = fixture(async (i) => ({
      text: i.member.id === "host" ? "not-json" : position,
      tokens: null,
      cost: null
    }));
    const r = await f.settled((await f.start({ mode: "parallel", maxRounds: 1 })).id);
    expect(r.status).toBe("waiting_user");
    expect(r.attempts.filter(a => a.memberId === "host")).toHaveLength(2);
    expect(r.conclusion).toBeNull();
  });
  it("records an inconclusive budget result rather than exceeding the cap", async () => {
    const f = fixture(async (i) => ({
      text: i.member.id === "host" ? "invalid" : position,
      tokens: null,
      cost: null
    }));
    const r = await f.settled((await f.start({ maxCalls: 3 })).id);
    expect(r.conclusion?.kind).toBe("inconclusive");
    expect(f.runtime.execute).toHaveBeenCalledTimes(3);
  });
  it("queues user materials at a symmetric round boundary", async () => {
    const gate = deferred<{
      text: string;
      tokens: null;
      cost: null;
    }>();
    let hostCalls = 0;
    const f = fixture(async (i) => {
      if (i.member.id === "host" && ++hostCalls === 1)
        return gate.promise;
      return {
        text: i.member.id === "host" ? JSON.stringify(assessment) : position,
        tokens: null,
        cost: null
      };
    });
    let r = await f.start();
    await vi.waitFor(() => expect(hostCalls).toBe(1));
    r = await f.read(r.id);
    await f.service.supplement({
      runId: r.id,
      expectedRevision: r.revision,
      id: "supplement",
      text: "NEW_FACT"
    });
    gate.resolve({
      text: JSON.stringify(assessment),
      tokens: null,
      cost: null
    });
    r = await f.settled(r.id);
    const second = r.attempts.filter(a => a.round === 2 && a.phase === "participant");
    expect(second).toHaveLength(2);
    expect(second.every(a => a.prompt.includes("NEW_FACT") && a.materialVersion === 2)).toBe(true);
    expect(r.attempts.filter(a => a.round === 1).every(a => !a.prompt.includes("NEW_FACT"))).toBe(true);
  });
  it("ignores late successful completion after cancellation", async () => {
    const gate = deferred<{
      text: string;
      tokens: null;
      cost: null;
    }>();
    const f = fixture(async () => gate.promise);
    let r = await f.start({ concurrency: 1 });
    await vi.waitFor(() => expect(f.runtime.execute).toHaveBeenCalledTimes(1));
    r = await f.read(r.id);
    await f.service.command({
      runId: r.id,
      expectedRevision: r.revision,
      action: "cancel"
    });
    gate.resolve({
      text: "late",
      tokens: null,
      cost: null
    });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalled());
    r = await f.read(r.id);
    expect(r.status).toBe("cancelled");
    expect(r.conclusion).toBeNull();
    expect(r.attempts[0].status).toBe("cancelled");
    expect(f.runtime.execute).toHaveBeenCalledTimes(1);
  });
  it("recovers uncertain dispatch without replay and requires explicit confirmation", async () => {
    const f = fixture();
    const original = await f.settled((await f.start({ mode: "parallel", maxRounds: 1 })).id);
    const state = f.disk();
    const r = state.runs[0];
    r.status = "running";
    r.phase = "participants";
    r.round = 1;
    r.conclusion = null;
    r.assessments = [];
    r.attempts = r.attempts.slice(0, 2);
    r.attempts[1].status = "dispatching";
    r.attempts[1].text = "";
    const recovered = fixture(undefined, state);
    let run = (await recovered.service.list()).runs[0];
    expect(run.status).toBe("interrupted");
    expect(run.attempts[1].status).toBe("dispatch_unknown");
    expect(recovered.runtime.execute).not.toHaveBeenCalled();
    await expect(recovered.service.command({
      runId: run.id,
      expectedRevision: run.revision,
      action: "retry",
      attemptId: run.attempts[1].id
    })).rejects.toThrow("Confirm");
    await recovered.service.command({
      runId: run.id,
      expectedRevision: run.revision,
      action: "retry",
      attemptId: run.attempts[1].id,
      confirmUnknown: true
    });
    run = await recovered.settled(original.id);
    expect(run.status).toBe("completed");
    expect(recovered.runtime.execute.mock.calls.filter(([i]) => i.member.id === "a")).toHaveLength(0);
  });
  it("blocks stale mutations and project-deleted new dispatch", async () => {
    const f = fixture();
    const r = await f.settled((await f.start()).id);
    await expect(f.service.command({
      runId: r.id,
      expectedRevision: 0,
      action: "cancel"
    })).rejects.toThrow("Discussion changed");
    f.block();
    await expect(f.service.start({
      requestId: "next",
      councilId: r.councilId,
      objective: "next",
      constraints: "",
      materials: ""
    })).rejects.toThrow("unavailable");
  });
  it("task conversion produces only a reviewable brief with source hash", async () => {
    const f = fixture();
    const r = await f.settled((await f.start()).id);
    const before = f.runtime.execute.mock.calls.length;
    const brief = await f.service.taskBrief({ runId: r.id, expectedRevision: r.revision });
    expect(brief.objective).toContain(r.conclusion!.hash);
    expect(brief.workspace).toEqual(workspace);
    expect(f.runtime.execute).toHaveBeenCalledTimes(before);
  });
  it("removes project data after stopping owned calls", async () => {
    const f = fixture(async (i) => new Promise((_, reject) => i.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })));
    await f.start();
    await vi.waitFor(() => expect(f.runtime.execute).toHaveBeenCalledTimes(2));
    f.block();
    await f.service.removeProject("project");
    const state = await f.service.list();
    expect(state.runs).toEqual([]);
    expect(state.councils).toEqual([]);
  });
  it("does not dispatch if durable preparation fails", async () => {
    const f = fixture();
    const g = await f.service.create(config);
    f.store.save.mockRejectedValueOnce(Error("Disk full"));
    await expect(f.service.start({
      requestId: "start",
      councilId: g.id,
      objective: "Goal",
      materials: "",
      constraints: ""
    })).rejects.toThrow("Disk full");
    expect(f.runtime.execute).not.toHaveBeenCalled();
    expect((await f.service.list()).runs).toHaveLength(0);
  });
  it("context limits reject rather than silently truncate", async () => {
    const f = fixture();
    const r = await f.settled((await f.start()).id);
    r.round = 3;
    r.materials = "x".repeat(60000);
    for (const a of r.attempts.filter(a => a.round === 2 && a.phase === "participant"))
      a.text = "x".repeat(64000);
    expect(() => buildCouncilContext(r, r.members[0], "participant")).toThrow("No content was silently truncated");
  });
  it("unstructured participant outputs never prove consensus", async () => {
    const f = fixture(async (i) => ({
      text: i.member.id === "host" ? JSON.stringify(assessment) : "Looks good",
      tokens: null,
      cost: null
    }));
    const r = await f.settled((await f.start()).id);
    expect(conclusionKind(r, assessment)).toBe("recommendation_with_dissent");
  });
  it("times out a blocked member and releases its runtime lease", async () => {
    const f = fixture(async (i) => new Promise((_, reject) => i.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })));
    const r = await f.settled((await f.start({ concurrency: 1 })).id);
    expect(r.status).toBe("waiting_user");
    expect(r.attempts.every(a => a.status === "failed" && a.error === "Call timed out")).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("marks an already received result as uncertain if its commit fails", async () => {
    const f = fixture();
    let fail = true;
    const save = f.store.save.getMockImplementation()!;
    f.store.save.mockImplementation(async (state) => {
      if (fail && state.runs.some(r => r.attempts.some(a => a.status === "completed"))) {
        fail = false;
        throw Error("disk full at final commit");
      }
      await save(state);
    });
    const r = await f.settled((await f.start({ concurrency: 1 })).id);
    expect(r.status).toBe("waiting_user");
    expect(r.attempts.some(a => a.status === "dispatch_unknown")).toBe(true);
  });
  it("rejects group removal while a just-started run owns dispatch", async () => {
    const f = fixture(async (i) => new Promise((_, reject) => i.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })));
    const r = await f.start();
    await expect(f.service.remove(r.councilId)).rejects.toThrow("Cancel running");
    await f.service.shutdown();
  });
  it("can start again if application shutdown was cancelled", async () => {
    const f = fixture();
    const r = await f.settled((await f.start({ mode: "parallel", maxRounds: 1 })).id);
    await f.service.shutdown();
    const next = await f.service.start({
      requestId: "after-shutdown",
      councilId: r.councilId,
      objective: "Next",
      materials: "",
      constraints: ""
    });
    expect((await f.settled(next.id)).status).toBe("completed");
  });

  it("does not claim consensus for a newly changed unreviewed moderator recommendation", async () => {
    let rounds=0;
    const f=fixture(async i=>({text:i.member.id==="host"?JSON.stringify({...assessment,recommendation:"Changed recommendation "+(++rounds)}):position,tokens:null,cost:null}));
    const r=await f.settled((await f.start()).id);
    expect(r.round).toBe(3);expect(r.conclusion?.kind).toBe("recommendation_with_dissent");
  });
  it("explicit retry still runs after summarize-now encounters a failed seat", async () => {
    let failed=false;
    const f=fixture(async i=>{if(i.member.id==="a"&&!failed){failed=true;throw Error("once");}return {text:i.member.id==="host"?JSON.stringify(assessment):position,tokens:null,cost:null};});
    let r=await f.settled((await f.start({mode:"parallel",maxRounds:1})).id);
    await f.service.command({runId:r.id,expectedRevision:r.revision,action:"summarize"});r=await f.settled(r.id);
    await f.service.command({runId:r.id,expectedRevision:r.revision,action:"retry",attemptId:r.attempts.find(a=>a.status==="failed")!.id});
    r=await f.settled(r.id);expect(r.status).toBe("completed");expect(f.runtime.execute.mock.calls.filter(([i])=>i.member.id==="a")).toHaveLength(2);
  });
});
