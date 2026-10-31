import { z } from "zod";
export const councilId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const text = (max: number) => z.string().max(max).refine(s => !s.includes(String.fromCharCode(0)));
const required = (max: number) => text(max).trim().min(1);
const time = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const councilWorkspaceSchema = z.object({
  projectId: councilId,
  rootKind: z.enum(["project", "worktree"]),
  rootPath: required(4000),
  repoCommonDir: text(4000).nullable(),
  relativeCwd: text(4000)
}).strict();
export const councilMemberSchema = z.object({
  id: councilId,
  name: required(80),
  engine: z.enum(["claude", "codex", "acp"]),
  agentId: councilId,
  model: required(200),
  role: required(2000)
}).strict();
export const councilSettingsSchema = z.object({
  mode: z.enum(["parallel", "consensus"]),
  maxRounds: z.number().int().min(1).max(3),
  concurrency: z.number().int().min(1).max(2),
  timeoutMs: z.number().int().min(1000).max(600000),
  maxCalls: z.number().int().min(3).max(24)
}).strict();
export const councilCreateSchema = z.object({
  requestId: councilId,
  title: required(160),
  workspace: councilWorkspaceSchema,
  members: z.array(councilMemberSchema).min(2).max(4),
  moderator: councilMemberSchema,
  settings: councilSettingsSchema
}).strict().superRefine((v, c) => {
  const ids = [...v.members.map(m => m.id), v.moderator.id];
  if (new Set(ids).size !== ids.length)
    c.addIssue({ code: "custom", message: "Member IDs must be unique (moderator has its own seat)" });
});
export const councilSchema = z.object({
  id: councilId,
  requestId: councilId,
  fingerprint: digest,
  title: required(160),
  workspace: councilWorkspaceSchema,
  members: z.array(councilMemberSchema).min(2).max(4),
  moderator: councilMemberSchema,
  settings: councilSettingsSchema,
  createdAt: time
});
export const councilStartSchema = z.object({
  requestId: councilId,
  councilId,
  objective: required(12000),
  materials: text(60000),
  constraints: text(12000)
}).strict();
export const councilPositionSchema = z.object({
  statement: required(60000),
  agreesWithPriorAssessment: z.boolean(),
  dissent: z.array(required(2000)).max(20)
}).strict();
export const councilAssessmentSchema = z.object({
  summary: required(12000),
  recommendation: required(12000),
  agreements: z.array(required(2000)).max(20),
  disagreements: z.array(z.object({
    kind: z.enum(["fact", "assumption", "framing", "risk", "action"]),
    description: required(2000),
    memberIds: z.array(councilId).max(4)
  }).strict()).max(20),
  movements: z.array(z.object({
    memberId: councilId,
    stance: z.enum(["held", "shifted", "converged", "new-point"]),
    note: required(1000)
  }).strict()).max(4),
  converged: z.boolean(),
  acceptanceCriteria: z.array(required(1000)).min(1).max(20)
}).strict();
export const councilAttemptSchema = z.object({
  id: councilId,
  memberId: councilId,
  round: z.number().int().min(1).max(3),
  phase: z.enum(["participant", "assessment", "repair"]),
  status: z.enum(["dispatching", "completed", "failed", "cancelled", "dispatch_unknown", "skipped"]),
  prompt: text(180000),
  contextHash: digest,
  sourceAttemptIds: z.array(councilId).max(100),
  materialVersion: z.number().int().positive(),
  templateVersion: z.literal(1),
  text: text(64000),
  error: text(2000).nullable(),
  tokens: time.nullable(),
  cost: z.number().nonnegative().nullable(),
  startedAt: time,
  endedAt: time.nullable()
});
export const councilRunSchema = z.object({
  id: councilId,
  councilId,
  requestId: councilId,
  fingerprint: digest,
  revision: time,
  objective: required(12000),
  materials: text(60000),
  constraints: text(12000),
  members: z.array(councilMemberSchema).min(2).max(4),
  moderator: councilMemberSchema,
  settings: councilSettingsSchema,
  workspace: councilWorkspaceSchema,
  status: z.enum(["running", "pausing", "paused", "waiting_user", "interrupted", "completed", "cancelled", "failed"]),
  round: z.number().int().min(1).max(3),
  phase: z.enum(["participants", "assessment"]),
  attempts: z.array(councilAttemptSchema).max(24),
  assessments: z.array(z.object({
    round: z.number().int(),
    attemptId: councilId,
    result: councilAssessmentSchema
  })).max(3),
  supplements: z.array(z.object({
    id: councilId,
    text: required(12000),
    appliedRound: z.number().int().min(1).max(3).nullable()
  })).max(20),
  retryAttemptIds: z.array(councilId).max(24),
  concludeNow: z.boolean(),
  conclusion: z.object({
    kind: z.enum(["consensus", "recommendation_with_dissent", "inconclusive", "partial"]),
    assessment: councilAssessmentSchema,
    sourceAttemptIds: z.array(councilId).max(100),
    materialVersion: z.number().int(),
    hash: digest
  }).nullable(),
  error: text(2000).nullable(),
  createdAt: time,
  updatedAt: time
});
export const councilSnapshotSchema = z.object({
  version: z.literal(1),
  revision: time,
  councils: z.array(councilSchema).max(100),
  runs: z.array(councilRunSchema).max(200)
}).superRefine((v, c) => {
  if (new Set(v.councils.map(g => g.id)).size !== v.councils.length || new Set(v.runs.map(r => r.id)).size !== v.runs.length)
    c.addIssue({ code: "custom", message: "Duplicate Council identity" });
  for (const group of v.councils) {
    const seats = [...group.members.map(m => m.id), group.moderator.id];
    if (new Set(seats).size !== seats.length)
      c.addIssue({ code: "custom", message: "Duplicate Council seat" });
  }
  if (new Set(v.councils.map(g => g.requestId)).size !== v.councils.length || new Set(v.runs.map(r => r.requestId)).size !== v.runs.length)
    c.addIssue({ code: "custom", message: "Duplicate idempotency key" });
  for (const r of v.runs) {
    const group = v.councils.find(g => g.id === r.councilId);
    const seats = new Set(r.members.map(m => m.id));
    const attempts = new Map(r.attempts.map(a => [a.id, a]));
    if (seats.size !== r.members.length || seats.has(r.moderator.id))
      c.addIssue({ code: "custom", message: "Duplicate run seat" });
    if (r.status === "completed" && !r.conclusion)
      c.addIssue({ code: "custom", message: "Completed run has no conclusion" });
    if (new Set(r.supplements.map(s => s.id)).size !== r.supplements.length)
      c.addIssue({ code: "custom", message: "Duplicate supplement" });
    for (const a of r.attempts) {
      if (a.round > r.round || (a.phase === "participant" ? !seats.has(a.memberId) : a.memberId !== r.moderator.id))
        c.addIssue({ code: "custom", message: "Invalid attempt owner or round" });
      if (a.sourceAttemptIds.some(id => !attempts.has(id)))
        c.addIssue({ code: "custom", message: "Missing context source" });
    }
    for (const a of r.assessments)
      if (!attempts.has(a.attemptId) || a.round > r.round)
        c.addIssue({ code: "custom", message: "Invalid assessment reference" });
    if (r.retryAttemptIds.some(id => !attempts.has(id)))
      c.addIssue({ code: "custom", message: "Invalid retry reference" });
    if (!group || group.workspace.projectId !== r.workspace.projectId || new Set(r.attempts.map(a => a.id)).size !== r.attempts.length)
      c.addIssue({ code: "custom", message: "Invalid Council references" });
  }
});
export const councilCommandSchema = z.object({
  runId: councilId,
  expectedRevision: time,
  action: z.enum(["pause", "resume", "cancel", "summarize", "retry", "skip"]),
  attemptId: councilId.optional(),
  confirmUnknown: z.boolean().optional()
}).strict();
export const councilSupplementSchema = z.object({
  runId: councilId,
  expectedRevision: time,
  id: councilId,
  text: required(12000)
}).strict();
export function parseCouncilAssessment(raw: string) {
  const fence = String.fromCharCode(96).repeat(3);
  const trimmed = raw.trim();
  const json = trimmed.startsWith(fence) && trimmed.endsWith(fence) ? trimmed.slice(3, -3).replace(/^json\s*/i, "").trim() : trimmed;
  return councilAssessmentSchema.parse(JSON.parse(json));
}
