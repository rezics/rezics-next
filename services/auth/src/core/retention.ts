import {
  DEFAULT_WORKFLOW_RETENTION_DAYS,
  MIN_WORKFLOW_RETENTION_DAYS,
  MAX_WORKFLOW_RETENTION_DAYS,
  WORKFLOW_RETENTION_WORKFLOW,
  DAY_MS,
  WorkflowRetentionConfigurationError,
  type WorkflowRetentionConfig,
  type RetainedWorkflowCopy,
  type WorkflowRetentionCandidate,
} from '../contract/index.ts';

export function assertRetentionDays(retentionDays: number) {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
}

export function readWorkflowRetentionConfig(
  env: Readonly<Record<string, string | undefined>>,
): WorkflowRetentionConfig {
  const raw = env.AUTH_WORKFLOW_RETENTION_DAYS;
  if (raw === undefined) return { retentionDays: DEFAULT_WORKFLOW_RETENTION_DAYS };
  if (!/^\d+$/.test(raw)) throw new WorkflowRetentionConfigurationError();
  const retentionDays = Number(raw);
  try {
    assertRetentionDays(retentionDays);
  } catch {
    throw new WorkflowRetentionConfigurationError();
  }
  return { retentionDays };
}

export function workflowRetentionCutoff(retentionDays: number, now: number): number {
  assertRetentionDays(retentionDays);
  return now - retentionDays * DAY_MS;
}

/** Only these exact, counts-only workflow names bypass personal custody. */
export function workflowRetentionCandidates(copies: readonly RetainedWorkflowCopy[]): WorkflowRetentionCandidate[] {
  return copies.map((copy) => ({
    id: copy.workflowID,
    eligible: true,
    technical: copy.workflowName === 'auth.maintenance.tick' || copy.workflowName === WORKFLOW_RETENTION_WORKFLOW,
  }));
}
