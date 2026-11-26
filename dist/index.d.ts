/**
 * dsh-background-task-engine — DSH Host plugin entry.
 *
 * Registers 12 model-facing `task_*` tools over DSH native capabilities:
 *   - `ctx.storageDomain` for durable task/run/step records (required)
 *   - `ctx.schedule` for optional native timing (never reimplemented)
 *   - `ctx.tools` for the tool surface
 *
 * Missing StorageDomain is a startup failure with an explicit diagnostic
 * (PRD FR-012, 16.3): the plugin never degrades to in-memory storage.
 *
 * @module dsh-background-task-engine
 */
import type { HostContextLike } from './host.js';
import { TaskEngine } from './services/engine.js';
export declare const name = "dsh-background-task-engine";
/** Hard dependencies: tools to register on, StorageDomain to persist through. */
export declare const inject: string[];
export { Config } from './config.js';
export { TaskEngine } from './services/engine.js';
export { TaskEngineError, TASK_ERROR_CODES, toErrorPayload, sanitizeMessage } from './errors.js';
export { resolveConfig, CONFIG_LIMITS, DEFAULT_CONFIG } from './config.js';
export type { EngineConfig } from './config.js';
export { SCHEMA_VERSION, DOMAIN_NAME, RUN_STATUSES, STEP_STATUSES, TASK_STATUSES, TRIGGER_TYPES, } from './domain/records.js';
export { createDomainSpec, runMigrations, verifyIntegrity, MIGRATIONS } from './storage/spec.js';
export { parseTriggerMessage, EXECUTION_PROTOCOL } from './prompt/guidance.js';
/**
 * Mount the plugin.
 *
 * @param ctx - Cordis context carrying `tools` and `storageDomain`.
 * @param rawConfig - Profile config validated by {@link Config}.
 */
export declare function apply(ctx: HostContextLike, rawConfig?: unknown): void;
/** Internal accessor used by tests and diagnostics. */
export declare function engineOf(ctx: object): TaskEngine | undefined;
declare const _default: {
    name: string;
    inject: string[];
    Config: import("@deepseek-ai/schemastery").default<Schemastery.ObjectS<NoInfer<{
        maxTasksPerOwner: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxStepsPerTask: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxActiveRunsPerOwner: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxParallelRunsPerTask: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        defaultTimeoutMinutes: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        staleRunAfterMinutes: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        historyRetentionDays: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxSummaryChars: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
    }>>, Schemastery.ObjectT<NoInfer<{
        maxTasksPerOwner: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxStepsPerTask: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxActiveRunsPerOwner: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxParallelRunsPerTask: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        defaultTimeoutMinutes: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        staleRunAfterMinutes: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        historyRetentionDays: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
        maxSummaryChars: import("@deepseek-ai/schemastery").default<any, any, "volatile">;
    }>>, "plain">;
    apply: typeof apply;
};
export default _default;
