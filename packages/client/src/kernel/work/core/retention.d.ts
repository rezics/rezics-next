import { WORKFLOW_RETENTION_BATCH_SIZE, WORKFLOW_RETENTION_MAX_BATCHES } from '../contract/bounds.ts';
export type WorkflowRetentionConfig = Readonly<{
    retentionDays: number;
}>;
export declare function parseWorkflowRetentionDays(raw: string | undefined): number;
export declare function readWorkflowRetentionConfig(env: Readonly<Record<string, string | undefined>>): WorkflowRetentionConfig;
export declare function assertRetentionDays(retentionDays: number): void;
export declare function retentionCutoff(now: Date, retentionDays: number): number;
export declare function clampRetentionBatch(ids: readonly string[]): string[];
export { WORKFLOW_RETENTION_BATCH_SIZE, WORKFLOW_RETENTION_MAX_BATCHES };
