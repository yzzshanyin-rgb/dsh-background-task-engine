/**
 * StorageDomain declaration, migration runner and startup integrity checks
 * (PRD 4.10, 7.3, 7.4, FR-010, FR-012).
 *
 * `ctx.storageDomain` is the only persistence backend. There is deliberately no
 * in-memory fallback: without a StorageDomain the engine refuses to start
 * (PRD FR-012, 16.3).
 */
import type { DomainLike } from '../host.js';
import { type GlobalState, type RunRecord, type RunStepRecord, type TaskRecord } from '../domain/records.js';
export interface DomainSpecLike {
    name: string;
    version: number;
    layout?: 'single' | 'per-record';
    compatibleVersions?: readonly number[];
    tables: Record<string, {
        valueSchema: {
            parse(value: unknown): unknown;
            safeParse(value: unknown): {
                success: boolean;
            };
        };
    }>;
}
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
export declare const UNIT_NAME_PATTERN: RegExp;
export declare function createDomainSpec(): DomainSpecLike;
export declare const META_KEY = "global";
export interface DomainTables {
    tasks: {
        get(key: string): TaskRecord | undefined;
    };
    runs: {
        get(key: string): RunRecord | undefined;
    };
    steps: {
        get(key: string): RunStepRecord | undefined;
    };
    meta: {
        get(key: string): GlobalState | undefined;
        put(key: string, value: GlobalState): Promise<void>;
    };
}
export interface MigrationContext {
    domain: DomainLike;
    readMeta(): GlobalState | undefined;
    writeMeta(state: GlobalState): Promise<void>;
}
export interface Migration {
    id: string;
    description: string;
    /** Must be safe to re-run: the ledger marker is written only after success. */
    apply(context: MigrationContext): Promise<void>;
}
/**
 * Ordered migrations. v1 has no historical shape to migrate; the runner is in
 * place so a future schema change is a data edit plus one entry here.
 */
export declare const MIGRATIONS: readonly Migration[];
export declare function createMigrationContext(domain: DomainLike): MigrationContext;
export interface MigrationReport {
    applied: string[];
    alreadyApplied: string[];
    schemaVersion: number;
}
/**
 * Apply pending migrations exactly once each. A failed migration throws: the
 * caller then refuses to open the domain for writes (PRD 7.4).
 */
export declare function runMigrations(domain: DomainLike, migrations?: readonly Migration[], now?: () => string): Promise<MigrationReport>;
export declare function readMeta(domain: DomainLike): GlobalState | undefined;
export declare function writeMeta(domain: DomainLike, patch: Partial<GlobalState>): Promise<void>;
export interface IntegrityReport {
    ok: boolean;
    runCount: number;
    stepCount: number;
    taskCount: number;
    issues: string[];
}
/**
 * Startup verification (PRD 7.3): every run references an existing task and
 * every step belongs to an existing run with a stepId present in the run's
 * template snapshot. Issues are reported, never silently repaired.
 */
export declare function verifyIntegrity(domain: DomainLike): IntegrityReport;
