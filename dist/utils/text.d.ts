/**
 * Text helpers for summaries, instructions and paginated output.
 */
export declare const SUMMARY_TRUNCATION_MARK = "\u2026[truncated]";
/**
 * Truncate to `max` characters (PRD FR-006: summaries are bounded, and the
 * caller keeps the Session/file reference instead of copying history).
 */
export declare function truncateText(input: string | undefined, max: number): string | undefined;
/** Trim + cap a user supplied title/description without truncation markers. */
export declare function trimTo(input: unknown, max: number): string;
/** One-line preview for list output. */
export declare function oneLine(input: string | undefined, max?: number): string;
/**
 * External text (task titles, step summaries, schedule deliveries) is rendered
 * as untrusted data: strip control characters that could forge UI lines.
 */
export declare function untrustedText(input: string | undefined, max?: number): string;
/** JSON string used in schedule delivery payloads and prompts. */
export declare function jsonLiteral(value: unknown): string;
