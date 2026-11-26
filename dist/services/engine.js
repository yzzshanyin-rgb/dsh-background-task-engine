/**
 * TaskEngine: composition root for the plugin (PRD 8.2, 8.4, FR-012).
 *
 * Startup sequence (all failures are explicit, never silent):
 *   1. open the StorageDomain declared in src/storage/spec.ts
 *   2. run idempotent migrations from the persisted ledger
 *   3. verify record integrity (runs reference tasks, steps belong to runs)
 *   4. recover stale `queued`/`running` rows into `interrupted`
 *   5. prune terminal runs older than `historyRetentionDays`
 *
 * If step 1 fails the `ready` promise rejects and every tool returns
 * TASK_STORAGE_ERROR — the plugin does not fall back to in-memory storage
 * (PRD 16.3).
 */
import { optionalService } from '../host.js';
import { TaskEngineError } from '../errors.js';
import { SCHEMA_VERSION, globalStateSchema, runRecordSchema, runStepRecordSchema, taskRecordSchema } from '../domain/records.js';
import { Repository } from '../storage/repository.js';
import { MIGRATIONS, UNIT_NAME_PATTERN, createDomainSpec, runMigrations, verifyIntegrity, } from '../storage/spec.js';
import { AuditTrail } from './audit.js';
import { ScheduleAdapter } from './schedule-adapter.js';
import { TaskService } from './task-service.js';
import { RunService } from './run-service.js';
import { nowIso } from '../utils/time.js';
export class TaskEngine {
    ctx;
    now;
    config;
    ready;
    domain;
    repo;
    audit;
    schedules;
    tasks;
    runs;
    initError;
    disposed = false;
    diagnostics = {
        storageAvailable: false,
        scheduleAvailable: false,
        activeRunCount: 0,
        schemaVersion: SCHEMA_VERSION,
        taskCount: 0,
        runCount: 0,
        staleRunsInterrupted: 0,
        integrity: null,
        migrations: null,
    };
    constructor(ctx, config, now = nowIso) {
        this.ctx = ctx;
        this.now = now;
        this.config = config;
        const schedule = optionalService(ctx, 'schedule');
        this.schedules = new ScheduleAdapter(schedule, { warn: (...args) => ctx.logger?.warn?.(...args) });
        this.diagnostics.scheduleAvailable = this.schedules.available;
        this.ready = this.init();
    }
    async init() {
        const facility = this.ctx.storageDomain;
        if (!facility || typeof facility.open !== 'function') {
            throw new TaskEngineError('TASK_STORAGE_ERROR', '未挂载 ctx.storageDomain：dsh-background-task-engine 拒绝启动，也不会降级为内存存储。请确认宿主已启用 StorageDomain（base bundle 配置 storage-domain backend=json）。');
        }
        try {
            const spec = createDomainSpec();
            // Fail loudly before touching the backend if the declaration itself is
            // invalid for this host version (cheap, and names the exact field).
            for (const unitName of [spec.name, ...Object.keys(spec.tables)]) {
                if (!UNIT_NAME_PATTERN.test(unitName)) {
                    throw new TaskEngineError('TASK_STORAGE_ERROR', `存储单元名 ${unitName} 不合法：宿主要求 /^[a-z][a-z0-9_]*$/（不允许连字符）`);
                }
            }
            const domain = await facility.open(spec);
            this.domain = domain;
            this.repo = new Repository(domain, this.now);
            this.audit = new AuditTrail(this.ctx, this.ctx.logger);
            this.tasks = new TaskService(this.repo, this.config, this.audit, this.schedules, this.now);
            this.runs = new RunService(this.repo, this.config, this.audit, this.now);
            this.diagnostics.migrations = await runMigrations(domain, MIGRATIONS, this.now);
            this.diagnostics.integrity = verifyIntegrity(domain);
            this.diagnostics.storageAvailable = true;
            this.diagnostics.taskCount = this.repo.listTasks().length;
            this.diagnostics.runCount = this.repo.listRuns().length;
            const recovery = await this.runs.recoverStale();
            this.diagnostics.lastRecoveryScanAt = this.now();
            this.diagnostics.staleRunsInterrupted = recovery.interrupted.length;
            this.ctx.logger?.info?.(`[background-task-engine] startup scan: stale runs=${recovery.scanned} interrupted=${recovery.interrupted.length}`);
            const pruned = await this.runs.prune();
            this.diagnostics.lastPruneAt = this.now();
            if (pruned.runs > 0 || pruned.steps > 0) {
                this.ctx.logger?.info?.(`[background-task-engine] prune removed ${pruned.runs} runs / ${pruned.steps} step records`);
            }
            this.diagnostics.activeRunCount = this.repo.listActiveRunsByOwner('').length;
        }
        catch (error) {
            const taskError = error instanceof TaskEngineError ? error : new TaskEngineError('TASK_STORAGE_ERROR', `存储初始化失败：${error instanceof Error ? error.message : String(error)}`);
            this.initError = taskError;
            this.diagnostics.lastError = taskError.message;
            throw taskError;
        }
    }
    /** Wait for startup to finish; throws a TaskEngineError when storage is unavailable. */
    async waitReady() {
        await this.ready;
    }
    get taskService() {
        if (!this.tasks) {
            throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未完成存储初始化，无法执行任务操作');
        }
        return this.tasks;
    }
    get runService() {
        if (!this.runs) {
            throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未完成存储初始化，无法执行运行操作');
        }
        return this.runs;
    }
    /** TaskService may be used for schedule-only operations; storage must be ready. */
    get scheduleAdapter() {
        if (!this.schedules)
            throw new TaskEngineError('TASK_STORAGE_ERROR', '插件尚未初始化');
        return this.schedules;
    }
    async diagnosticsFor(sessionId) {
        const current = {
            ...this.diagnostics,
            activeRunCount: this.repo ? this.repo.listActiveRunsByOwner(sessionId).length : 0,
        };
        return current;
    }
    /** Release the domain handle. User data is never deleted. */
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        try {
            await this.domain?.close();
        }
        catch (error) {
            this.ctx.logger?.warn?.(`[background-task-engine] 关闭 StorageDomain 失败：${String(error)}`);
        }
        this.ctx.logger?.info?.('[background-task-engine] disposed (user data preserved)');
    }
}
/** Domain record schemas, re-exported for diagnostics and tests. */
export const domainSchemas = {
    tasks: taskRecordSchema,
    runs: runRecordSchema,
    steps: runStepRecordSchema,
    meta: globalStateSchema,
};
