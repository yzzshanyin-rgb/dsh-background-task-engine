/**
 * Cursor pagination for list/history tools (PRD 6.6).
 *
 * Cursors are opaque base64url JSON, never StorageDomain query expressions.
 * Ordering is descending by (sortKey, id) — a stable keyset so concurrent
 * writes cannot cause skipped or duplicated rows.
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export function normaliseLimit(limit) {
    if (limit === undefined || limit === null)
        return DEFAULT_PAGE_LIMIT;
    const value = typeof limit === 'string' ? Number(limit) : limit;
    if (typeof value !== 'number' || !Number.isFinite(value))
        return DEFAULT_PAGE_LIMIT;
    const integer = Math.floor(value);
    if (integer < 1)
        return 1;
    if (integer > MAX_PAGE_LIMIT)
        return MAX_PAGE_LIMIT;
    return integer;
}
export function encodeCursor(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
export function decodeCursor(cursor) {
    if (!cursor)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (typeof parsed.u === 'string' && typeof parsed.i === 'string') {
            return { u: parsed.u, i: parsed.i };
        }
    }
    catch {
        /* fall through: invalid cursor is treated as "start from the beginning" */
    }
    return undefined;
}
/** True when `item` sorts strictly after the cursor position. */
export function isAfterCursor(itemTs, itemId, cursor) {
    if (!cursor)
        return true;
    if (itemTs < cursor.u)
        return true;
    if (itemTs > cursor.u)
        return false;
    return itemId < cursor.i;
}
/**
 * Slice an already-sorted (desc) array. `limit + 1` is inspected so a
 * `nextCursor` is only returned when more rows actually exist.
 */
export function paginate(sorted, options) {
    const filtered = sorted.filter((item) => isAfterCursor(options.tsOf(item), options.idOf(item), options.cursor));
    const window = filtered.slice(0, options.limit + 1);
    const items = window.slice(0, options.limit);
    if (window.length > options.limit && items.length > 0) {
        const last = items[items.length - 1];
        return { items, nextCursor: encodeCursor({ u: options.tsOf(last), i: options.idOf(last) }) };
    }
    return { items };
}
/** Descending comparator over (timestamp, id). */
export function compareDesc(aTs, aId, bTs, bId) {
    if (aTs !== bTs)
        return aTs < bTs ? 1 : -1;
    if (aId === bId)
        return 0;
    return aId < bId ? 1 : -1;
}
/** Normalise a caller-supplied limit against an endpoint-specific ceiling. */
export function clampLimit(limit, fallback, max) {
    if (limit === undefined || !Number.isFinite(limit))
        return fallback;
    const value = Math.floor(limit);
    if (value < 1)
        return 1;
    return value > max ? max : value;
}
