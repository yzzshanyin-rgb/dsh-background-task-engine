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
import { type GlobalState } from '../domain/records.js';
/** The host rejects unit and table names that are not `snake_case`. */
export declare const UNIT_NAME_PATTERN: RegExp;
export declare const META_KEY = "global";
export declare function createDomainSpec(): Record<string, unknown>;
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
export declare function createMigrationContext(domain: DomainLike, now: () => Date, log: (message: string) => void): MigrationContext;
export declare function readMeta(domain: DomainLike): GlobalState;
export declare function writeMeta(domain: DomainLike, state: GlobalState): Promise<void>;
/**
 * Bring the stored records forward.
 *
 * Repeatable by construction: each migration writes its ledger entry after it
 * succeeds, and the bodies are written so a second run finds nothing to do. A
 * failing migration stops the boot instead of letting the engine write to a
 * half-migrated domain.
 */
export declare function runMigrations(domain: DomainLike, migrations: readonly Migration[], now: () => Date, log?: (message: string) => void): Promise<{
    applied: string[];
    skipped: string[];
}>;
export declare const MIGRATIONS: readonly Migration[];
export interface IntegrityIssue {
    kind: 'orphan-step' | 'missing-task' | 'missing-snapshot-step' | 'index-drift' | 'active-slot-drift' | 'idempotency-drift' | 'progress-drift' | 'expired-reservation';
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
export declare function verifyIntegrity(domain: DomainLike): IntegrityReport;
