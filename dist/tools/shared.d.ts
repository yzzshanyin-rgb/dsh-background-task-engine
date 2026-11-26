/**
 * Shared tool plumbing: uniform error envelope, argument validation, JSON Schema
 * shapes and rendering (PRD 6.3, FR-009, 12.3).
 *
 * Every task_* tool returns `{ success: true, ... }` or
 * `{ success: false, error: { code, message, retryable, relatedRunId? } }`.
 * Tools never throw: an Agent only has to branch on `success`.
 */
import type { ZodTypeAny } from 'zod';
import type { ContentBlock, ToolDefinitionLike } from '../host.js';
import type { TaskEngine } from '../services/engine.js';
import { type RunStepRecord, type StepDefinition } from '../domain/records.js';
/**
 * The JSON Schema subset accepted by `assertSupportedJsonSchema`. Keys outside
 * this set (minLength, pattern, maximum, format) throw at registration, so all
 * range and length rules are enforced in code.
 */
export interface JsonSchemaNode {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    oneOf?: JsonSchemaNode[];
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    enum?: Array<string | number | boolean | null>;
    const?: string | number | boolean | null;
    description?: string;
    title?: string;
    default?: unknown;
    examples?: unknown[];
}
export declare const ERROR_SCHEMA: JsonSchemaNode;
/** Object-rooted output schema with the shared `success` / `error` pair. */
export declare function out(properties: Record<string, JsonSchemaNode>, required?: string[]): JsonSchemaNode;
export declare const STEP_SCHEMA: JsonSchemaNode;
export declare const STEPS_ARRAY_SCHEMA: JsonSchemaNode;
export declare const TASK_FIELDS: Record<string, JsonSchemaNode>;
export declare const RUN_FIELDS: Record<string, JsonSchemaNode>;
export interface TaskLike {
    taskId: string;
    title: string;
    description?: string;
    status: string;
    revision: number;
    steps: StepDefinition[];
    scheduleRef?: {
        scheduleId: string;
        state: string;
        timingKind: string;
        timing: Record<string, unknown>;
    };
    createdAt: string;
    updatedAt: string;
}
export interface RunLike {
    runId: string;
    templateSnapshot?: {
        revision: number;
        title: string;
        steps: StepDefinition[];
    };
    taskId: string;
    taskRevision: number;
    status: string;
    triggerType: string;
    sessionId: string;
    scheduleId?: string;
    occurrenceKey?: string;
    progress: number;
    requiredCompleted: number;
    requiredTotal: number;
    currentStepId?: string;
    startedAt: string;
    finishedAt?: string;
    summary?: string;
    error?: {
        code: string;
        message: string;
    };
    resumesRunId?: string;
    executionToken?: string;
    executionGeneration?: number;
}
export declare function taskView(task: TaskLike): Record<string, unknown>;
export declare function runView(run: RunLike, steps: RunStepRecord[]): Record<string, unknown>;
/** Compact progress block used by list/get/history renderers. */
export declare function progressLine(run: RunLike): string;
/**
 * Render helper for custom presenters: a failed call always renders through the
 * generic error line, so one broken custom renderer cannot hide an error.
 */
export declare function isFailure(value: unknown): value is {
    success: false;
    error: Record<string, unknown>;
};
export declare function renderGeneric(_args: unknown, value: unknown): ContentBlock[];
export interface ToolBuilderInput {
    name: string;
    description: string;
    /** Property schemas; buildTool wraps them in an object root. */
    parameters: Record<string, JsonSchemaNode>;
    /** Names that must be present (standard JSON Schema `required`). */
    requiredParams?: string[];
    /** Zod schema for server-side validation, coercion and defaults. */
    args: ZodTypeAny;
    output: JsonSchemaNode;
    render?: (args: unknown, value: unknown) => ContentBlock[];
    execute: (args: Record<string, unknown>, engine: TaskEngine) => Promise<Record<string, unknown>> | Record<string, unknown>;
}
export declare function buildTool(input: ToolBuilderInput, engine: TaskEngine | null | (() => TaskEngine)): ToolDefinitionLike;
