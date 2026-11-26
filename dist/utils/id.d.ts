/** `tsk_` + 20 chars: unique per task, stable, copy-pasteable. */
export declare function newTaskId(): string;
/** `run_` + 20 chars. */
export declare function newRunId(): string;
/** `stp_` + 16 chars. */
export declare function newStepId(): string;
/** Shorten an id for display while keeping it copyable in full elsewhere. */
export declare function shortId(id: string): string;
