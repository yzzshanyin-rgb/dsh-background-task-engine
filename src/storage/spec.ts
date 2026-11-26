/**
 * Domain declaration and schema migrations.
 *
 * The storage domain has no transaction log and no automatic migration runner:
 * `compatibleVersions` only relaxes reading. Everything a new version needs is
 * therefore done by explicit, repeatable migrations that record themselves in
 * the ledger before the next one runs, and that leave rows untouched when they
 * are already at the target shape.
 */

import type { DomainLike, KvTableLike } from '../host.js';
import type { IdempotencyRecord } from '../domain/records.js';
import {
  DOMAIN_NAME,
  SCHEMA_VERSION,
  TABLES,
  globalStateSchema,
  activeRunRecordSchema,
  idempotencyKeyOf,
  idempotencyRecordSchema,
  runIndexKey,
  runIndexRecordSchema,
  runRecordSchema,
  runStepRecordSchema,
  scheduleOpRecordSchema,
  stepKey,
  taskRecordSchema,
  type GlobalState,
  type RunRecord,
} from '../domain/records.js';
import { isTerminalRun, occupiesSlot } from '../domain/state.js';

/** The host rejects unit and table names that are not `snake_case`. */
export const UNIT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export const META_KEY = 'global';

export function createDomainSpec(): Record<string, unknown> {
  const names = Object.values(TABLES);
  for (const name of names) {
    if (!UNIT_NAME_PATTERN.test(name)) {
      throw new Error(`存储单元名不合法：${name}（只允许小写字母、数字与下划线）`);
    }
  }
  return {
    name: DOMAIN_NAME,
    version: SCHEMA_VERSION,
    tables: {
      [TABLES.tasks]: { valueSchema: taskRecordSchema },
      [TABLES.runs]: { valueSchema: runRecordSchema },
      [TABLES.steps]: { valueSchema: runStepRecordSchema },
      [TABLES.idempotency]: { valueSchema: idempotencyRecordSchema },
      [TABLES.activeRuns]: { valueSchema: activeRunRecordSchema },
      [TABLES.runIndex]: { valueSchema: runIndexRecordSchema },
      [TABLES.scheduleOps]: { valueSchema: scheduleOpRecordSchema },
      [TABLES.meta]: { valueSchema: globalStateSchema },
    },
  };
}

export interface Migration {
  id: string;
  description: string;
  apply: (context: MigrationContext) => Promise<void>;
}

export interface MigrationContext {
  domain: DomainLike;
  now: () => Date;
  table: <T>(name: string) => KvTableLike<T>;
  log: (message: string) => void;
}

export function createMigrationContext(
  domain: DomainLike,
  now: () => Date,
  log: (message: string) => void,
): MigrationContext {
  return {
    domain,
    now,
    log,
    table: <T,>(name: string) => domain.table<T>(name),
  };
}

function emptyState(): GlobalState {
  return { schemaVersion: SCHEMA_VERSION, appliedMigrations: {} };
}

export function readMeta(domain: DomainLike): GlobalState {
  const parsed = domain.table(TABLES.meta).get(META_KEY);
  if (parsed === undefined) return emptyState();
  const result = globalStateSchema.safeParse(parsed);
  if (result.success) return result.data;
  return emptyState();
}

export async function writeMeta(domain: DomainLike, state: GlobalState): Promise<void> {
  const table = domain.table<GlobalState>(TABLES.meta);
  const parsed = globalStateSchema.parse(state);
  if (table.get(META_KEY) === undefined) {
    await table.put(META_KEY, parsed);
    return;
  }
  await table.update(META_KEY, () => parsed);
}

/**
 * Bring the stored records forward.
 *
 * Repeatable by construction: each migration writes its ledger entry after it
 * succeeds, and the bodies are written so a second run finds nothing to do. A
 * failing migration stops the boot instead of letting the engine write to a
 * half-migrated domain.
 */
export async function runMigrations(
  domain: DomainLike,
  migrations: readonly Migration[],
  now: () => Date,
  log: (message: string) => void = () => undefined,
): Promise<{ applied: string[]; skipped: string[] }> {
  const before = readMeta(domain);
  if (typeof before.schemaVersion === 'number' && before.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `存储中的数据来自更高版本（schemaVersion ${before.schemaVersion} > ${SCHEMA_VERSION}），请升级插件后再打开。`,
    );
  }
  const applied: string[] = [];
  const skipped: string[] = [];
  let state = before;
  for (const migration of migrations) {
    if (state.appliedMigrations[migration.id] !== undefined) {
      skipped.push(migration.id);
      continue;
    }
    log(`迁移开始：${migration.id} — ${migration.description}`);
    const context = createMigrationContext(domain, now, log);
    try {
      await migration.apply(context);
    } catch (error) {
      throw new Error(
        `迁移 ${migration.id} 失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    state = {
      ...state,
      schemaVersion: SCHEMA_VERSION,
      appliedMigrations: { ...state.appliedMigrations, [migration.id]: now().toISOString() },
    };
    await writeMeta(domain, state);
    applied.push(migration.id);
    log(`迁移完成：${migration.id}`);
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    state = { ...state, schemaVersion: SCHEMA_VERSION };
    await writeMeta(domain, state);
  }
  return { applied, skipped };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * 1.1.x wrote runs without liveness fields. Absence must read as "unknown",
 * not "expired", so this stamps the run's own last activity as its heartbeat
 * and leaves the lease unset: nothing here makes an old run look interrupted.
 */
const v2Liveness: Migration = {
  id: 'v2-run-liveness-defaults',
  description: '为旧运行记录补齐执行代际与心跳基线（不改状态）',
  apply: async ({ table, now }) => {
    const runs = table<RunRecord>(TABLES.runs);
    const stamp = now().toISOString();
    for (const [key, row] of runs.entries()) {
      if (row.schemaVersion >= 2 && row.executionGeneration !== undefined) continue;
      const next: RunRecord = {
        ...row,
        schemaVersion: 2,
        executionGeneration: row.executionGeneration ?? 1,
        lastHeartbeatAt: row.lastHeartbeatAt ?? row.updatedAt ?? stamp,
      };
      await runs.update(key, () => next);
    }
  },
};

/**
 * Build the indexes a v2 domain needs from the rows that already exist.
 * Repeatable: each pass recomputes the same keys from the run table, and rows
 * for runs that no longer exist are dropped.
 */
const v2Indexes: Migration = {
  id: 'v2-build-indexes',
  description: '从运行记录重建幂等表、活动运行索引与按任务运行索引',
  apply: async ({ table }) => {
    const runs = table<RunRecord>(TABLES.runs);
    const idempotency = table(TABLES.idempotency);
    const active = table(TABLES.activeRuns);
    const index = table(TABLES.runIndex);

    const wantedIdempotency = new Map<string, { taskId: string; key: string; owner: string; runId: string; at: string }>();
    const wantedActive = new Map<string, unknown>();
    const wantedIndex = new Map<string, unknown>();

    for (const [, run] of runs.entries()) {
      if (run.idempotencyKey !== undefined && run.idempotencyKey !== '') {
        wantedIdempotency.set(idempotencyKeyOf(run.taskId, run.idempotencyKey), {
          taskId: run.taskId,
          key: run.idempotencyKey,
          owner: run.taskOwnerSessionId,
          runId: run.runId,
          at: run.startedAt,
        });
      }
      if (!isTerminalRun(run.status) && occupiesSlot(run.status)) {
        wantedActive.set(run.runId, {
          runId: run.runId,
          taskId: run.taskId,
          ownerSessionId: run.taskOwnerSessionId,
          sessionId: run.sessionId,
          startedAt: run.startedAt,
          leaseExpiresAt: run.leaseExpiresAt,
        });
      }
      wantedIndex.set(runIndexKey(run.taskId, run.startedAt, run.runId), {
        runId: run.runId,
        taskId: run.taskId,
        ownerSessionId: run.taskOwnerSessionId,
        status: run.status,
        startedAt: run.startedAt,
      });
    }

    for (const key of [...idempotency.keys()]) {
      if (!wantedIdempotency.has(key)) await idempotency.delete(key);
    }
    for (const [key, fact] of wantedIdempotency) {
      const row = idempotencyRecordSchema.parse({
        taskId: fact.taskId,
        idempotencyKey: fact.key,
        ownerSessionId: fact.owner,
        state: 'committed',
        runId: fact.runId,
        createdAt: fact.at,
        updatedAt: fact.at,
      });
      if (idempotency.get(key) === undefined) await idempotency.put(key, row);
      else await idempotency.update(key, () => row);
    }

    for (const key of [...active.keys()]) {
      if (!wantedActive.has(key)) await active.delete(key);
    }
    for (const [key, fact] of wantedActive) {
      if (active.get(key) === undefined) await active.put(key, fact);
      else await active.update(key, () => fact);
    }

    for (const key of [...index.keys()]) {
      if (!wantedIndex.has(key)) await index.delete(key);
    }
    for (const [key, fact] of wantedIndex) {
      if (index.get(key) === undefined) await index.put(key, fact);
      else await index.update(key, () => fact);
    }
  },
};

/**
 * Steps written by 1.1.x carry no retry policy. Fill in the documented default
 * so the resume confirmation logic has one fact to read.
 */
const v2StepPolicies: Migration = {
  id: 'v2-step-retry-policy',
  description: '为旧步骤补齐默认恢复策略 verify_before_retry',
  apply: async ({ table }) => {
    const steps = table<import('../domain/records.js').RunStepRecord>(TABLES.steps);
    for (const [key, row] of steps.entries()) {
      if (row.retryPolicy !== undefined) continue;
      await steps.update(key, () => ({ ...row, retryPolicy: 'verify_before_retry' as const }));
    }
  },
};

export const MIGRATIONS: readonly Migration[] = [v2Liveness, v2Indexes, v2StepPolicies];

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export interface IntegrityIssue {
  kind:
    | 'orphan-step'
    | 'missing-task'
    | 'missing-snapshot-step'
    | 'index-drift'
    | 'active-slot-drift'
    | 'idempotency-drift'
    | 'progress-drift'
    | 'expired-reservation';
  severity: 'auto-fixable' | 'manual';
  detail: string;
  runId?: string;
  stepId?: string;
  taskId?: string;
}

export interface IntegrityReport {
  ok: boolean;
  runCount: number;
  stepCount: number;
  taskCount: number;
  issues: IntegrityIssue[];
}

/**
 * Read-only consistency check.
 *
 * It reports rather than repairs: the caller decides what may be fixed
 * automatically (index rows, progress summaries) and what needs a human
 * (a step whose run no longer exists).
 */
export function verifyIntegrity(domain: DomainLike): IntegrityReport {
  const tasks = domain.table(TABLES.tasks);
  const runs = domain.table<RunRecord>(TABLES.runs);
  const steps = domain.table<import('../domain/records.js').RunStepRecord>(TABLES.steps);
  const active = domain.table(TABLES.activeRuns);
  const index = domain.table(TABLES.runIndex);
  const idempotency = domain.table(TABLES.idempotency);

  const issues: IntegrityIssue[] = [];
  const runIds = new Set<string>();
  // One pass over the step table, bucketed by run: the run loop below must not
  // rescan every step for every run (that is quadratic on the 50k-run dataset).
  const stepsByRun = new Map<string, Array<[string, import('../domain/records.js').RunStepRecord]>>();
  for (const [stepRowKey, step] of steps.entries()) {
    const bucket = stepsByRun.get(step.runId);
    if (bucket === undefined) stepsByRun.set(step.runId, [[stepRowKey, step]]);
    else bucket.push([stepRowKey, step]);
  }

  for (const [key, run] of runs.entries()) {
    runIds.add(run.runId);
    if (key !== run.runId) {
      issues.push({ kind: 'index-drift', severity: 'auto-fixable', runId: run.runId, detail: `运行记录键 ${key} 与 runId 不一致` });
    }
    if (tasks.get(run.taskId) === undefined) {
      issues.push({ kind: 'missing-task', severity: 'manual', runId: run.runId, taskId: run.taskId, detail: '运行引用的任务已不存在' });
    }
    const snapshotIds = new Set(run.templateSnapshot.steps.map((step) => step.stepId));
    const runSteps = stepsByRun.get(run.runId) ?? [];
    for (const [stepRowKey, step] of runSteps) {
      if (stepRowKey !== stepKey(step.runId, step.stepId)) {
        issues.push({ kind: 'index-drift', severity: 'auto-fixable', runId: run.runId, stepId: step.stepId, detail: '步骤记录键与内容不一致' });
      }
      if (!snapshotIds.has(step.stepId)) {
        issues.push({ kind: 'missing-snapshot-step', severity: 'auto-fixable', runId: run.runId, stepId: step.stepId, detail: '步骤不在运行快照内' });
      }
    }
    if (!isTerminalRun(run.status) && occupiesSlot(run.status) && active.get(run.runId) === undefined) {
      issues.push({ kind: 'active-slot-drift', severity: 'auto-fixable', runId: run.runId, detail: '活动运行缺少并发占位记录' });
    }
    if ((isTerminalRun(run.status) || !occupiesSlot(run.status)) && active.get(run.runId) !== undefined) {
      issues.push({ kind: 'active-slot-drift', severity: 'auto-fixable', runId: run.runId, detail: '已结束运行仍占用并发名额' });
    }
    if (index.get(runIndexKey(run.taskId, run.startedAt, run.runId)) === undefined) {
      issues.push({ kind: 'index-drift', severity: 'auto-fixable', runId: run.runId, detail: '缺少按任务的运行索引' });
    }
    if (run.idempotencyKey !== undefined && run.idempotencyKey !== '' && idempotency.get(idempotencyKeyOf(run.taskId, run.idempotencyKey)) === undefined) {
      issues.push({ kind: 'idempotency-drift', severity: 'auto-fixable', runId: run.runId, detail: '运行没有幂等键却存在幂等记录' });
    }
    const required = runSteps.map(([, step]) => step);
    const done = required.filter((step) => step.required && step.status === 'completed').length;
    const total = required.filter((step) => step.required).length;
    const percent = total === 0 ? 100 : Math.floor((done / total) * 100);
    if (percent !== run.progress || done !== run.requiredCompleted) {
      issues.push({ kind: 'progress-drift', severity: 'auto-fixable', runId: run.runId, detail: `进度缓存 ${run.requiredCompleted}/${run.progress}% 与步骤实际 ${done}/${percent}% 不一致` });
    }
  }

  for (const [stepRowKey, step] of steps.entries()) {
    if (!runIds.has(step.runId)) {
      issues.push({ kind: 'orphan-step', severity: 'manual', stepId: step.stepId, runId: step.runId, detail: `孤立步骤记录 ${stepRowKey}` });
    }
  }
  for (const [runId] of active.entries()) {
    if (!runIds.has(runId)) {
      issues.push({ kind: 'active-slot-drift', severity: 'auto-fixable', runId, detail: '并发占位记录指向不存在的运行' });
    }
  }
  for (const [key, row] of (idempotency as KvTableLike<IdempotencyRecord>).entries()) {
    if (row.state === 'reserved') {
      issues.push({ kind: 'expired-reservation', severity: 'auto-fixable', taskId: row.taskId, detail: `未提交的幂等占位 ${key}` });
    }
    if (row.state === 'committed' && (row.runId === undefined || !runIds.has(row.runId))) {
      issues.push({ kind: 'idempotency-drift', severity: 'auto-fixable', taskId: row.taskId, detail: `幂等记录 ${key} 指向不存在的运行` });
    }
  }
  for (const [key] of index.entries()) {
    const parts = key.split('/');
    const runId = parts[2];
    if (runId === undefined || !runIds.has(runId)) {
      issues.push({ kind: 'index-drift', severity: 'auto-fixable', detail: `运行索引 ${key} 指向不存在的运行` });
    }
  }

  return {
    ok: issues.length === 0,
    runCount: runs.size,
    stepCount: steps.size,
    taskCount: tasks.size,
    issues,
  };
}
