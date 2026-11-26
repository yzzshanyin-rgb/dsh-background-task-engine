import { randomBytes } from 'node:crypto';
/** Lower-case base32 alphabet without look-alike characters (crockford-ish). */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
function randomToken(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return out;
}
/** `tsk_` + 20 chars: unique per task, stable, copy-pasteable. */
export function newTaskId() {
    return `tsk_${randomToken(20)}`;
}
/** `run_` + 20 chars. */
export function newRunId() {
    return `run_${randomToken(20)}`;
}
/** `stp_` + 16 chars. */
export function newStepId() {
    return `stp_${randomToken(16)}`;
}
/** Shorten an id for display while keeping it copyable in full elsewhere. */
export function shortId(id) {
    if (id.length <= 12)
        return id;
    return `${id.slice(0, 8)}…${id.slice(-4)}`;
}
