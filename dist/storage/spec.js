/**
 * StorageDomain declaration, migration runner and startup integrity checks
 * (PRD 4.10, 7.3, 7.4, FR-010, FR-012).
 *
 * `ctx.storageDomain` is the only persistence backend. There is deliberately no
 * in-memory fallback: without a StorageDomain the engine refuses to start
 * (PRD FR-012, 16.3).
 */
import { TaskEngineError } from '../errors.js';
import { DOMAIN_NAME, SCHEMA_VERSION, TABLES, globalStateSchema, runRecordSchema, runStepRecordSchema, taskRecordSchema, } from '../domain/records.js';
/**
 * The domain descriptor.
 *
 * Four tables, not three: `meta` holds the schema version, the idempotent
 * migration ledger and recovery/prune timestamps (PRD 7.4 requires the version
 * and an "already applied" marker to be persisted; the PRD 4.10 table list
 * covers the model tables only).
 */
/**
 * Host rule for domain and table names
 * (`@deepseek-ai/dsh-storage` UNIT_NAME_RE). Hyphens are rejected, which is why
 * DOMAIN_NAME uses underscores.
 */
export const UNIT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
export function createDomainSpec() {
    return {
        name: DOMAIN_NAME,
        version: SCHEMA_VERSION,
        tables: {
            [TABLES.tasks]: { valueSchema: taskRecordSchema },
            [TABLES.runs]: { valueSchema: runRecordSchema },
            [TABLES.steps]: { valueSchema: runStepRecordSchema },
            meta: { valueSchema: globalStateSchema },
        },
    };
}
export const META_KEY = 'global';
/**
 * Ordered migrations. v1 has no historical shape to migrate; the runner is in
 * place so a future schema change is a data edit plus one entry here.
 */
export const MIGRATIONS = [];
export function createMigrationContext(domain) {
    const meta = domain.table('meta');
    return {
        domain,
        readMeta: () => meta.get(META_KEY),
        writeMeta: async (state) => {
            await meta.put(META_KEY, globalStateSchema.parse(state));
        },
    };
}
/**
 * Apply pending migrations exactly once each. A failed migration throws: the
 * caller then refuses to open the domain for writes (PRD 7.4).
 */
export async function runMigrations(domain, migrations = MIGRATIONS, now = () => new Date().toISOString()) {
    const context = createMigrationContext(domain);
    const existing = context.readMeta();
    if (existing && existing.schemaVersion > SCHEMA_VERSION) {
        throw new TaskEngineError('TASK_STORAGE_ERROR', `存储版本 ${existing.schemaVersion} 高于插件支持的 ${SCHEMA_VERSION}，请升级插件而不是降级`);
    }
    const state = existing ?? {
        schemaVersion: SCHEMA_VERSION,
        appliedMigrations: {},
    };
    const applied = [];
    const alreadyApplied = [];
    for (const migration of migrations) {
        if (state.appliedMigrations[migration.id]) {
            alreadyApplied.push(migration.id);
            continue;
        }
        try {
            await migration.apply(context);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new TaskEngineError('TASK_STORAGE_ERROR', `迁移 ${migration.id} 失败，已停止写入新结构：${message}`);
        }
        applied.push(migration.id);
        state.appliedMigrations[migration.id] = now();
        // Marker is persisted only after the migration body succeeded, so a crash
        // mid-migration re-runs an idempotent migration instead of skipping it.
        await context.writeMeta({ ...state, schemaVersion: SCHEMA_VERSION });
    }
    if (applied.length === 0) {
        const next = { ...state, schemaVersion: SCHEMA_VERSION };
        if (!existing || existing.schemaVersion !== SCHEMA_VERSION || Object.keys(state.appliedMigrations).length !== Object.keys(existing.appliedMigrations).length) {
            await context.writeMeta(next);
        }
    }
    return { applied, alreadyApplied, schemaVersion: SCHEMA_VERSION };
}
export function readMeta(domain) {
    return domain.table('meta').get(META_KEY);
}
export async function writeMeta(domain, patch) {
    const meta = domain.table('meta');
    const current = meta.get(META_KEY) ?? { schemaVersion: SCHEMA_VERSION, appliedMigrations: {} };
    await meta.put(META_KEY, globalStateSchema.parse({ ...current, ...patch, schemaVersion: current.schemaVersion }));
}
/**
 * Startup verification (PRD 7.3): every run references an existing task and
 * every step belongs to an existing run with a stepId present in the run's
 * template snapshot. Issues are reported, never silently repaired.
 */
export function verifyIntegrity(domain) {
    const tasks = domain.table(TABLES.tasks);
    const runs = domain.table(TABLES.runs);
    const steps = domain.table(TABLES.steps);
    const issues = [];
    let runCount = 0;
    let stepCount = 0;
    let taskCount = 0;
    for (const [taskId, task] of tasks.entries()) {
        taskCount += 1;
        if (task.taskId !== taskId)
            issues.push(`任务记录键不一致: ${taskId} != ${task.taskId}`);
    }
    for (const run of runs.entries()) {
        runCount += 1;
        const [, record] = run;
        if (!tasks.get(record.taskId)) {
            issues.push(`运行 ${record.runId} 引用了不存在的任务 ${record.taskId}`);
        }
        if (!Array.isArray(record.templateSnapshot?.steps) || record.templateSnapshot.steps.length === 0) {
            issues.push(`运行 ${record.runId} 缺少模板快照`);
        }
    }
    const knownStepIds = new Map();
    for (const [runId, run] of runs.entries()) {
        knownStepIds.set(runId, new Set(run.templateSnapshot.steps.map((step) => step.stepId)));
    }
    for (const [key, step] of steps.entries()) {
        stepCount += 1;
        const sep = key.indexOf('/');
        const runId = sep >= 0 ? key.slice(0, sep) : '';
        const allowed = knownStepIds.get(runId);
        if (!allowed) {
            issues.push(`步骤记录 ${key} 引用了不存在的运行`);
            continue;
        }
        if (!allowed.has(step.stepId)) {
            issues.push(`步骤记录 ${key} 的 stepId 不在运行快照内`);
        }
    }
    return { ok: issues.length === 0, runCount, stepCount, taskCount, issues };
}
