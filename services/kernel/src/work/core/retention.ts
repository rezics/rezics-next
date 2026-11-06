import {
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  WORKFLOW_RETENTION_BATCH_SIZE,
  WORKFLOW_RETENTION_MAX_BATCHES,
} from '../contract/bounds.ts';

export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;

export function parseWorkflowRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WORKFLOW_RETENTION_DAYS;
  if (!/^\d+$/.test(raw)) throw new RangeError('KERNEL_WORKFLOW_RETENTION_DAYS');
  const retentionDays = Number(raw);
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('KERNEL_WORKFLOW_RETENTION_DAYS');
  return retentionDays;
}

export function readWorkflowRetentionConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowRetentionConfig {
  return { retentionDays: parseWorkflowRetentionDays(env.KERNEL_WORKFLOW_RETENTION_DAYS) };
}

export function assertRetentionDays(retentionDays: number): void {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
}

export function retentionCutoff(now: Date, retentionDays: number): number {
  return now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
}

export function clampRetentionBatch(ids: readonly string[]): string[] {
  return [...ids].slice(0, WORKFLOW_RETENTION_BATCH_SIZE);
}

export { WORKFLOW_RETENTION_BATCH_SIZE, WORKFLOW_RETENTION_MAX_BATCHES };
