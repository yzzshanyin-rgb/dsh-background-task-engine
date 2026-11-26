/**
 * Task template tools: task_create / task_list / task_get / task_update /
 * task_archive (PRD 4.1, 4.2, 5.2, FR-001).
 */
import type { ToolDefinitionLike } from '../host.js';
import type { TaskEngine } from '../services/engine.js';
export declare function createTaskTools(engine: () => TaskEngine): ToolDefinitionLike[];
