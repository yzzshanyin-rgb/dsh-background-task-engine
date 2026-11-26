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
export const CONFIG_LIMITS = {
    maxTasksPerOwner: { min: 1, max: 1000, default: 100 },
    maxStepsPerTask: { min: 1, max: 10, default: 10 },
    maxActiveRunsPerOwner: { min: 1, max: 20, default: 3 },
    maxParallelRunsPerTask: { min: 1, max: 1, default: 1 },
    defaultTimeoutMinutes: { min: 1, max: 1440, default: 60 },
    staleRunAfterMinutes: { min: 1, max: 1440, default: 30 },
    historyRetentionDays: { min: 1, max: 3650, default: 90 },
    maxSummaryChars: { min: 100, max: 10000, default: 2000 },
};
/** Every configuration key, in declaration order. */
export const CONFIG_KEYS = Object.keys(CONFIG_LIMITS);
/**
 * A field the Plugins page may edit.
 *
 * `.volatile()` is the schemastery spelling of "hand this field back as a
 * live reference"; it is what makes the namespace served by `dsh-settings`.
 */
function editable(schema) {
    return schema.volatile();
}
export const Config = Schema.object({
    maxTasksPerOwner: editable(Schema.number()
        .min(CONFIG_LIMITS.maxTasksPerOwner.min)
        .max(CONFIG_LIMITS.maxTasksPerOwner.max)
        .default(CONFIG_LIMITS.maxTasksPerOwner.default)
        .description('每个 Session 允许保留的未归档任务上限（1–1000）。')),
    maxStepsPerTask: editable(Schema.number()
        .min(CONFIG_LIMITS.maxStepsPerTask.min)
        .max(CONFIG_LIMITS.maxStepsPerTask.max)
        .default(CONFIG_LIMITS.maxStepsPerTask.default)
        .description('单个任务的步骤上限，V1.0 固定为线性 1–10 步。')),
    maxActiveRunsPerOwner: editable(Schema.number()
        .min(CONFIG_LIMITS.maxActiveRunsPerOwner.min)
        .max(CONFIG_LIMITS.maxActiveRunsPerOwner.max)
        .default(CONFIG_LIMITS.maxActiveRunsPerOwner.default)
        .description('每个 Session 同时处于 queued/running 的 TaskRun 上限（1–20）。')),
    maxParallelRunsPerTask: editable(Schema.number()
        .min(CONFIG_LIMITS.maxParallelRunsPerTask.min)
        .max(CONFIG_LIMITS.maxParallelRunsPerTask.max)
        .default(CONFIG_LIMITS.maxParallelRunsPerTask.default)
        .description('同一任务允许的并行运行数，V1.0 固定为 1。')),
    defaultTimeoutMinutes: editable(Schema.number()
        .min(CONFIG_LIMITS.defaultTimeoutMinutes.min)
        .max(CONFIG_LIMITS.defaultTimeoutMinutes.max)
        .default(CONFIG_LIMITS.defaultTimeoutMinutes.default)
        .description('运行默认超时（分钟）；超时只标记待核验，不自动重启。')),
    staleRunAfterMinutes: editable(Schema.number()
        .min(CONFIG_LIMITS.staleRunAfterMinutes.min)
        .max(CONFIG_LIMITS.staleRunAfterMinutes.max)
        .default(CONFIG_LIMITS.staleRunAfterMinutes.default)
        .description('启动扫描时，多久没有心跳的 queued/running 运行判定为 interrupted（分钟）。')),
    historyRetentionDays: editable(Schema.number()
        .min(CONFIG_LIMITS.historyRetentionDays.min)
        .max(CONFIG_LIMITS.historyRetentionDays.max)
        .default(CONFIG_LIMITS.historyRetentionDays.default)
        .description('终态运行记录保留天数（默认 90）。清理永不删除活动运行与任务模板。')),
    maxSummaryChars: editable(Schema.number()
        .min(CONFIG_LIMITS.maxSummaryChars.min)
        .max(CONFIG_LIMITS.maxSummaryChars.max)
        .default(CONFIG_LIMITS.maxSummaryChars.default)
        .description('运行/步骤摘要最大字符数（默认 2000），超长截断。')),
}).description('dsh-background-task-engine 配置（所有数值均有下界/上界校验）。');
export const DEFAULT_CONFIG = {
    maxTasksPerOwner: CONFIG_LIMITS.maxTasksPerOwner.default,
    maxStepsPerTask: CONFIG_LIMITS.maxStepsPerTask.default,
    maxActiveRunsPerOwner: CONFIG_LIMITS.maxActiveRunsPerOwner.default,
    maxParallelRunsPerTask: CONFIG_LIMITS.maxParallelRunsPerTask.default,
    defaultTimeoutMinutes: CONFIG_LIMITS.defaultTimeoutMinutes.default,
    staleRunAfterMinutes: CONFIG_LIMITS.staleRunAfterMinutes.default,
    historyRetentionDays: CONFIG_LIMITS.historyRetentionDays.default,
    maxSummaryChars: CONFIG_LIMITS.maxSummaryChars.default,
};
/** Read a field that may be a live reference or a plain value. */
function unwrap(source) {
    if (source !== null && typeof source === 'object' && typeof source.get === 'function') {
        return source.get();
    }
    return source;
}
/**
 * Coerce one field to a validated integer.
 *
 * `strict` is the load-time pass: an out-of-range profile value must fail the
 * plugin load instead of being silently clamped (PRD FR-012). The non-strict
 * pass runs on every read, where a value can only be wrong if the profile was
 * edited by hand after load — then the default is safer than throwing inside a
 * tool call.
 */
function coerce(source, key, strict) {
    const limits = CONFIG_LIMITS[key];
    const raw = unwrap(source);
    if (raw === undefined || raw === null)
        return limits.default;
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        if (strict)
            throw new Error(`配置项 ${key} 必须是整数，收到 ${JSON.stringify(raw)}`);
        return limits.default;
    }
    if (value < limits.min || value > limits.max) {
        if (strict)
            throw new Error(`配置项 ${key} 超出允许范围 ${limits.min}–${limits.max}，收到 ${value}`);
        return limits.default;
    }
    return value;
}
/**
 * Validate a raw config object and return one live reference per field.
 *
 * Throws (naming the key and the allowed range) instead of clamping, so a
 * misconfigured profile fails loudly.
 */
export function resolveConfig(raw) {
    if (raw === undefined || raw === null)
        return configRefs();
    if (typeof raw !== 'object')
        throw new Error('配置必须是对象');
    const source = raw;
    const config = {};
    for (const key of CONFIG_KEYS) {
        const field = source[key];
        // Load-time validation: a bad profile value fails the plugin, not a later tool call.
        coerce(field, key, true);
        config[key] = { get: () => coerce(field, key, false) };
    }
    return config;
}
/**
 * Build references over plain numbers.
 *
 * Used for defaults and tests, and by callers that only have values (an
 * embedded engine). A field left out keeps its default.
 */
export function configRefs(values = {}) {
    const config = {};
    for (const key of CONFIG_KEYS) {
        const value = values[key] ?? CONFIG_LIMITS[key].default;
        coerce(value, key, true);
        config[key] = { get: () => value };
    }
    return config;
}
/** Snapshot every field as a plain object (diagnostics, logs, tests). */
export function configValues(config) {
    const values = {};
    for (const key of CONFIG_KEYS)
        values[key] = config[key].get();
    return values;
}
