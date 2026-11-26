/**
 * Persisted record schemas (PRD 5.x, 7.3).
 *
 * Everything written to the StorageDomain is validated by these zod schemas
 * before it is stored and again when the domain is opened, so a corrupted or
 * hand-edited record fails loudly instead of silently degrading behaviour.
 */

import { z } from 'zod'

/** Bumped only when the persisted shape changes; drives the migration runner. */
export const SCHEMA_VERSION = 1

/**
 * StorageDomain unit name.
 *
 * The host's `UNIT_NAME_RE` is `/^[a-z][a-z0-9_]*$/` (verified against the
 * installed @deepseek-ai/dsh-storage), so the domain id uses underscores even
 * though the npm package name uses hyphens. The two are deliberately different
 * values: the package name is the npm identity, this is the storage unit.
 */
export const DOMAIN_NAME = 'dsh_background_task_engine'

export const TASK_STATUSES = ['active', 'paused', 'archived'] as const
export const RUN_STATUSES = [
  'queued',
  'running',
  'blocked',
  'succeeded',
  'failed',
  'interrupted',
  'skipped',
] as const
export const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const
export const TRIGGER_TYPES = ['manual', 'schedule'] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]
export type RunStatus = (typeof RUN_STATUSES)[number]
export type StepStatus = (typeof STEP_STATUSES)[number]
export type TriggerType = (typeof TRIGGER_TYPES)[number]

const idSchema = z.string().min(4).max(64)
const timestampSchema = z.string().min(20).max(40)

export const stepErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(2000),
})

export const stepDefinitionSchema = z.object({
  stepId: idSchema,
  title: z.string().min(1).max(120),
  instruction: z.string().min(1).max(8000),
  completionCriteria: z.string().max(2000).optional(),
  order: z.number().int().min(1).max(10),
  required: z.boolean(),
})

export type StepDefinition = z.infer<typeof stepDefinitionSchema>

export const scheduleRefSchema = z.object({
  scheduleId: z.string().min(1).max(128),
  /** Original timing kind requested by the user (at / every / rrule). */
  timingKind: z.string().min(1).max(32),
  timing: z.record(z.unknown()),
  state: z.enum(['active', 'paused', 'unlinked']),
  title: z.string().max(120),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  lastError: stepErrorSchema.optional(),
})

export type ScheduleRef = z.infer<typeof scheduleRefSchema>

export const taskRecordSchema = z.object({
  taskId: idSchema,
  title: z.string().min(2).max(80),
  description: z.string().max(2000).optional(),
  status: z.enum(TASK_STATUSES),
  revision: z.number().int().min(1),
  ownerSessionId: z.string().min(1).max(256),
  steps: z.array(stepDefinitionSchema).min(1).max(10),
  scheduleRef: scheduleRefSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  schemaVersion: z.number().int().min(1),
})

export type TaskRecord = z.infer<typeof taskRecordSchema>

export const templateSnapshotSchema = z.object({
  revision: z.number().int().min(1),
  title: z.string().min(1).max(80),
  steps: z.array(stepDefinitionSchema).min(1).max(10),
})

export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>

export const runRecordSchema = z.object({
  runId: idSchema,
  taskId: idSchema,
  taskRevision: z.number().int().min(1),
  /** Owner of the task; every tool entry point compares this with the caller. */
  taskOwnerSessionId: z.string().min(1).max(256),
  /** Session that started the run (equals owner in V1.0). */
  sessionId: z.string().min(1).max(256),
  status: z.enum(RUN_STATUSES),
  triggerType: z.enum(TRIGGER_TYPES),
  scheduleId: z.string().max(128).optional(),
  occurrenceKey: z.string().max(256).optional(),
  idempotencyKey: z.string().max(300).optional(),
  currentStepId: idSchema.optional(),
  progress: z.number().int().min(0).max(100),
  requiredTotal: z.number().int().min(0).max(10),
  requiredCompleted: z.number().int().min(0).max(10),
  totalSteps: z.number().int().min(1).max(10),
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
  summary: z.string().max(20000).optional(),
  error: stepErrorSchema.optional(),
  resumesRunId: idSchema.optional(),
  templateSnapshot: templateSnapshotSchema,
  schemaVersion: z.number().int().min(1),
})

export type RunRecord = z.infer<typeof runRecordSchema>

export const runStepRecordSchema = z.object({
  runId: idSchema,
  stepId: idSchema,
  taskId: idSchema,
  order: z.number().int().min(1).max(10),
  title: z.string().min(1).max(120),
  required: z.boolean(),
  status: z.enum(STEP_STATUSES),
  attempt: z.number().int().min(0).max(100),
  startedAt: timestampSchema.optional(),
  finishedAt: timestampSchema.optional(),
  summary: z.string().max(20000).optional(),
  error: stepErrorSchema.optional(),
  /** Set when a resume carries a completed step over into the new run. */
  carryOverFromRunId: idSchema.optional(),
  updatedAt: timestampSchema,
})

export type RunStepRecord = z.infer<typeof runStepRecordSchema>

export const globalStateSchema = z.object({
  schemaVersion: z.number().int().min(1),
  /** migrationId -> ISO timestamp; presence means "already applied". */
  appliedMigrations: z.record(z.string()),
  lastRecoveryScanAt: timestampSchema.optional(),
  lastPruneAt: timestampSchema.optional(),
})

export type GlobalState = z.infer<typeof globalStateSchema>

/** Table names, kept in one place so spec and repository cannot drift. */
export const TABLES = {
  tasks: 'tasks',
  runs: 'task_runs',
  steps: 'task_run_steps',
} as const

/** Composite key for one step record: one row per (runId, stepId). */
export function stepKey(runId: string, stepId: string): string {
  return `${runId}/${stepId}`
}
