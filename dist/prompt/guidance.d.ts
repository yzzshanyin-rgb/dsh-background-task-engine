/**
 * Prompt fragments owned by the plugin (PRD 9.1, 11.4, FR-011).
 *
 * These strings are the only text the plugin injects into an agent's context.
 * They are plain data: they must never claim elevated authority, never ask the
 * model to skip approvals, and never contain secrets.
 */
/** Shared execution protocol, reused by the run tools' descriptions. */
export declare const EXECUTION_PROTOCOL: string;
export interface SchedulePromptInput {
    taskId: string;
    taskTitle: string;
    scheduleId?: string;
}
/**
 * Prompt stored on the host Schedule. It carries the task id so an arriving
 * delivery can be mapped back to a task even before `task_run_begin` runs.
 */
export declare function buildSchedulePrompt(input: SchedulePromptInput): string;
export interface TriggerEnvelope {
    taskId?: string;
    scheduleId?: string;
    occurrenceKey?: string;
}
/**
 * Best-effort parsing of a schedule delivery (PRD 14.3: the delivered message
 * must be identifiable). Handles both the json-labelled form and the escaped
 * form that appears inside `reminder_prompt_json`.
 */
export declare function parseTriggerMessage(text: string | undefined): TriggerEnvelope;
