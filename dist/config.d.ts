/**
 * Configuration schema (PRD 4.4 / FR-012).
 *
 * Exported as `Config` so the DSH loader validates profile config before the
 * plugin is applied, and so the Plugins page can render an editable card.
 *
 * ## Why every field is volatile
 *
 * `dsh-settings` only serves a configuration namespace whose schema exposes at
 * least one volatile field (`volatileForm(schema)` returns `undefined` for a
 * schema made only of ordinary fields), and the Plugins page only draws a form
 * for a *served* namespace. A schema of plain fields therefore has no settings
 * UI at all.
 *
 * Volatile also decides what survives a save: the page writes the whole config
 * object back, built from the (volatile-only) form schema. Any ordinary field
 * would be dropped from that object and disappear from the profile on the first
 * save from the UI. Making every field volatile is what keeps the card and the
 * profile config in agreement.
 *
 * Volatile fields arrive at `apply()` as stable references (`{ get() }`) that
 * the host updates in place, so the engine reads the *current* value on every
 * use instead of a value frozen at mount. {@link ConfigRef} keeps the plugin
 * independent of the host's own reference type.
 */
import Schema from '@deepseek-ai/schemastery';
/** A live configuration reference; the value it returns may change in place. */
export interface ConfigRef<T> {
    /** @returns the current value */
    get(): T;
}
/** Engine settings as the plugin consumes them: one live reference per field. */
export interface EngineConfig {
    maxTasksPerOwner: ConfigRef<number>;
    maxStepsPerTask: ConfigRef<number>;
    maxActiveRunsPerOwner: ConfigRef<number>;
    maxParallelRunsPerTask: ConfigRef<number>;
    defaultTimeoutMinutes: ConfigRef<number>;
    staleRunAfterMinutes: ConfigRef<number>;
    historyRetentionDays: ConfigRef<number>;
    maxSummaryChars: ConfigRef<number>;
}
/** Plain numbers, used for defaults, diagnostics and tests. */
export type EngineConfigValues = {
    [K in keyof EngineConfig]: number;
};
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
/** Every configuration key, in declaration order. */
export declare const CONFIG_KEYS: (keyof EngineConfig)[];
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    maxTasksPerOwner: Schema<any, any, "volatile">;
    maxStepsPerTask: Schema<any, any, "volatile">;
    maxActiveRunsPerOwner: Schema<any, any, "volatile">;
    maxParallelRunsPerTask: Schema<any, any, "volatile">;
    defaultTimeoutMinutes: Schema<any, any, "volatile">;
    staleRunAfterMinutes: Schema<any, any, "volatile">;
    historyRetentionDays: Schema<any, any, "volatile">;
    maxSummaryChars: Schema<any, any, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    maxTasksPerOwner: Schema<any, any, "volatile">;
    maxStepsPerTask: Schema<any, any, "volatile">;
    maxActiveRunsPerOwner: Schema<any, any, "volatile">;
    maxParallelRunsPerTask: Schema<any, any, "volatile">;
    defaultTimeoutMinutes: Schema<any, any, "volatile">;
    staleRunAfterMinutes: Schema<any, any, "volatile">;
    historyRetentionDays: Schema<any, any, "volatile">;
    maxSummaryChars: Schema<any, any, "volatile">;
}>>, "plain">;
export declare const DEFAULT_CONFIG: EngineConfigValues;
/**
 * Validate a raw config object and return one live reference per field.
 *
 * Throws (naming the key and the allowed range) instead of clamping, so a
 * misconfigured profile fails loudly.
 */
export declare function resolveConfig(raw?: unknown): EngineConfig;
/**
 * Build references over plain numbers.
 *
 * Used for defaults and tests, and by callers that only have values (an
 * embedded engine). A field left out keeps its default.
 */
export declare function configRefs(values?: Partial<EngineConfigValues>): EngineConfig;
/** Snapshot every field as a plain object (diagnostics, logs, tests). */
export declare function configValues(config: EngineConfig): EngineConfigValues;
