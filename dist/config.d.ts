/**
 * Configuration schema (PRD 4.4 / FR-012).
 *
 * Exported as `Config` so the DSH loader validates profile config before the
 * plugin is applied. `resolveConfig` re-validates and fills defaults so the
 * engine never runs with out-of-range numbers even when it is constructed
 * directly (tests, embedded use).
 */
import Schema from '@deepseek-ai/schemastery';
export interface EngineConfig {
    maxTasksPerOwner: number;
    maxStepsPerTask: number;
    maxActiveRunsPerOwner: number;
    maxParallelRunsPerTask: number;
    defaultTimeoutMinutes: number;
    staleRunAfterMinutes: number;
    historyRetentionDays: number;
    maxSummaryChars: number;
}
export declare const CONFIG_LIMITS: {
    readonly maxTasksPerOwner: {
        readonly min: 1;
        readonly max: 1000;
        readonly default: 100;
    };
    readonly maxStepsPerTask: {
        readonly min: 1;
        readonly max: 10;
        readonly default: 10;
    };
    readonly maxActiveRunsPerOwner: {
        readonly min: 1;
        readonly max: 20;
        readonly default: 3;
    };
    readonly maxParallelRunsPerTask: {
        readonly min: 1;
        readonly max: 1;
        readonly default: 1;
    };
    readonly defaultTimeoutMinutes: {
        readonly min: 1;
        readonly max: 1440;
        readonly default: 60;
    };
    readonly staleRunAfterMinutes: {
        readonly min: 1;
        readonly max: 1440;
        readonly default: 30;
    };
    readonly historyRetentionDays: {
        readonly min: 1;
        readonly max: 3650;
        readonly default: 90;
    };
    readonly maxSummaryChars: {
        readonly min: 100;
        readonly max: 10000;
        readonly default: 2000;
    };
};
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    maxTasksPerOwner: Schema<number, number, "defined">;
    maxStepsPerTask: Schema<number, number, "defined">;
    maxActiveRunsPerOwner: Schema<number, number, "defined">;
    maxParallelRunsPerTask: Schema<number, number, "defined">;
    defaultTimeoutMinutes: Schema<number, number, "defined">;
    staleRunAfterMinutes: Schema<number, number, "defined">;
    historyRetentionDays: Schema<number, number, "defined">;
    maxSummaryChars: Schema<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    maxTasksPerOwner: Schema<number, number, "defined">;
    maxStepsPerTask: Schema<number, number, "defined">;
    maxActiveRunsPerOwner: Schema<number, number, "defined">;
    maxParallelRunsPerTask: Schema<number, number, "defined">;
    defaultTimeoutMinutes: Schema<number, number, "defined">;
    staleRunAfterMinutes: Schema<number, number, "defined">;
    historyRetentionDays: Schema<number, number, "defined">;
    maxSummaryChars: Schema<number, number, "defined">;
}>>, "plain">;
export declare const DEFAULT_CONFIG: EngineConfig;
/**
 * Validate a raw config object. Throws (with a message naming the key and the
 * allowed range) instead of clamping, so a misconfigured profile fails loudly.
 */
export declare function resolveConfig(raw?: unknown): EngineConfig;
