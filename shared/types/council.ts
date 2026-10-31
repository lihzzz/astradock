import type { z } from "zod";
import type { councilSchema, councilRunSchema, councilAttemptSchema, councilAssessmentSchema, councilSnapshotSchema, councilCreateSchema, councilStartSchema, councilCommandSchema, councilSupplementSchema, councilMemberSchema } from "../lib/council";
import type { OperationResult } from "./productivity";
import type { CreateTaskInput } from "./tasks";
export type Council = z.infer<typeof councilSchema>;
export type CouncilRun = z.infer<typeof councilRunSchema>;
export type CouncilMember = z.infer<typeof councilMemberSchema>;
export type CouncilAttempt = z.infer<typeof councilAttemptSchema>;
export type CouncilAssessment = z.infer<typeof councilAssessmentSchema>;
export type CouncilSnapshot = z.infer<typeof councilSnapshotSchema>;
export type CouncilCreateInput = z.infer<typeof councilCreateSchema>;
export type CouncilStartInput = z.infer<typeof councilStartSchema>;
export type CouncilCommand = z.infer<typeof councilCommandSchema>;
export type CouncilSupplement = z.infer<typeof councilSupplementSchema>;
export interface CouncilCapability {
  engine: CouncilMember["engine"];
  supported: boolean;
  reason: string;
}
export interface CouncilDelta {
  runId: string;
  attemptId: string;
  text: string;
}
export interface CouncilsApi {
  list(): Promise<OperationResult<CouncilSnapshot>>;
  capabilities(): Promise<OperationResult<CouncilCapability[]>>;
  create(input: CouncilCreateInput): Promise<OperationResult<Council>>;
  start(input: CouncilStartInput): Promise<OperationResult<CouncilRun>>;
  command(input: CouncilCommand): Promise<OperationResult<CouncilRun>>;
  supplement(input: CouncilSupplement): Promise<OperationResult<CouncilRun>>;
  taskBrief(input: {
    runId: string;
    expectedRevision: number;
  }): Promise<OperationResult<CreateTaskInput>>;
  remove(councilId: string): Promise<OperationResult<null>>;
  onChanged(listener: (snapshot: CouncilSnapshot) => void): () => void;
  onDelta(listener: (event: CouncilDelta) => void): () => void;
}
