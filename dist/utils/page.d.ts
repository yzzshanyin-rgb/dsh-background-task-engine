/**
 * Cursor pagination for list/history tools (PRD 6.6).
 *
 * Cursors are opaque base64url JSON, never StorageDomain query expressions.
 * Ordering is descending by (sortKey, id) — a stable keyset so concurrent
 * writes cannot cause skipped or duplicated rows.
 */
export declare const DEFAULT_PAGE_LIMIT = 20;
export declare const MAX_PAGE_LIMIT = 100;
export interface CursorPayload {
    /** sort key (ISO timestamp) */
    u: string;
    /** tie-breaker id */
    i: string;
}
export declare function normaliseLimit(limit: unknown): number;
export declare function encodeCursor(payload: CursorPayload): string;
export declare function decodeCursor(cursor: string | undefined): CursorPayload | undefined;
/** True when `item` sorts strictly after the cursor position. */
export declare function isAfterCursor(itemTs: string, itemId: string, cursor: CursorPayload | undefined): boolean;
export interface PageSlice<T> {
    items: T[];
    nextCursor?: string;
}
/**
 * Slice an already-sorted (desc) array. `limit + 1` is inspected so a
 * `nextCursor` is only returned when more rows actually exist.
 */
export declare function paginate<T>(sorted: T[], options: {
    limit: number;
    cursor: CursorPayload | undefined;
    tsOf: (item: T) => string;
    idOf: (item: T) => string;
}): PageSlice<T>;
/** Descending comparator over (timestamp, id). */
export declare function compareDesc(aTs: string, aId: string, bTs: string, bId: string): number;
