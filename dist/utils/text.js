/**
 * Text helpers for summaries, instructions and paginated output.
 */
export const SUMMARY_TRUNCATION_MARK = '…[truncated]';
/**
 * Truncate to `max` characters (PRD FR-006: summaries are bounded, and the
 * caller keeps the Session/file reference instead of copying history).
 */
export function truncateText(input, max) {
    if (input === undefined || input === null)
        return undefined;
    const text = String(input);
    if (text.length <= max)
        return text;
    const budget = Math.max(0, max - SUMMARY_TRUNCATION_MARK.length);
    return `${text.slice(0, budget)}${SUMMARY_TRUNCATION_MARK}`;
}
/** Trim + cap a user supplied title/description without truncation markers. */
export function trimTo(input, max) {
    const text = typeof input === 'string' ? input.trim() : '';
    return text.length > max ? text.slice(0, max) : text;
}
/** One-line preview for list output. */
export function oneLine(input, max = 80) {
    if (!input)
        return '';
    const flat = input.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
/**
 * External text (task titles, step summaries, schedule deliveries) is rendered
 * as untrusted data: strip control characters that could forge UI lines.
 */
export function untrustedText(input, max = 400) {
    if (!input)
        return '';
    const cleaned = String(input)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
/** JSON string used in schedule delivery payloads and prompts. */
export function jsonLiteral(value) {
    return JSON.stringify(value);
}
