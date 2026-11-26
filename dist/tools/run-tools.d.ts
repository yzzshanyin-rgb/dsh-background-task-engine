/**
 * Execution tools: task_run / task_run_begin / task_step_report /
 * task_run_finish / task_run_history / task_resume (PRD 5.3–5.6, 6.3, FR-005..FR-008).
 */
import type { ToolDefinitionLike } from '../host.js';
import type { TaskEngine } from '../services/engine.js';
export declare function createRunTools(engine: () => TaskEngine): ToolDefinitionLike[];
/** Progress text helper exported for the diagnostics tool. */
export declare function describeRunProgress(run: {
    status: string;
    progress: number;
    requiredCompleted: number;
    requiredTotal: number;
}): string;
