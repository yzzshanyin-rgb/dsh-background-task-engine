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
export class KeyedMutex {
    tails = new Map();
    depth = new Map();
    /** Number of callers currently queued or running for `key` (diagnostics). */
    pending(key) {
        return this.depth.get(key) ?? 0;
    }
    async runExclusive(key, task) {
        this.depth.set(key, (this.depth.get(key) ?? 0) + 1);
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        // The tail the next caller waits on: settled by `release` in `finally`.
        this.tails.set(key, previous.then(() => gate).catch(() => undefined));
        try {
            await previous.catch(() => undefined);
            return await task();
        }
        finally {
            release();
            const left = (this.depth.get(key) ?? 1) - 1;
            if (left <= 0)
                this.depth.delete(key);
            else
                this.depth.set(key, left);
        }
    }
}
