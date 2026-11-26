/**
 * Keyed async mutex.
 *
 * The storage domain has no transaction and no conditional insert, so the parts
 * of a flow that must not interleave (read the idempotency row, count the slots,
 * write the run) are serialized in-process per key. `table.update` gives us
 * atomicity for a single row; this gives it for a sequence of rows.
 *
 * It is not a distributed lock and does not pretend to be one: the PRD scopes
 * this to a single engine instance, which is what one profile is.
 */
export declare class KeyedMutex {
    private readonly tails;
    private readonly depth;
    /** Number of callers currently queued or running for `key` (diagnostics). */
    pending(key: string): number;
    runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
}
