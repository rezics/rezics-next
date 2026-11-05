import { DBOS, type GetWorkflowsInput, type WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';

export const AUTH_WORKFLOW_APPLICATION = 'rezics-auth-accounts';

export class WorkflowRetentionConfigurationError extends Error {
  override readonly name = 'WorkflowRetentionConfigurationError';
  constructor() {
    super('Invalid Auth host configuration: AUTH_WORKFLOW_RETENTION_DAYS');
  }
}

export const WORKFLOW_RETENTION_WORKFLOW = 'auth.workflowRetention';
export const WORKFLOW_RETENTION_SCHEDULE = 'auth.workflowRetention.every-10-minutes';
export const WORKFLOW_RETENTION_SCHEDULE_EXPRESSION = '*/10 * * * *';
export const DEFAULT_WORKFLOW_RETENTION_DAYS = 30;
export const MIN_WORKFLOW_RETENTION_DAYS = 7;
export const MAX_WORKFLOW_RETENTION_DAYS = 365;
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every DBOS terminal status has a completion timestamp in 5.4.6. */
export const TERMINAL_WORKFLOW_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
] as const satisfies readonly WorkflowStatusString[];

type Environment = Readonly<Record<string, string | undefined>>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowRetentionSdk = Pick<typeof DBOS, 'listWorkflows' | 'deleteWorkflows'>;

export function readWorkflowRetentionConfig(env: Environment): WorkflowRetentionConfig {
  const raw = env.AUTH_WORKFLOW_RETENTION_DAYS;
  if (raw === undefined) return { retentionDays: DEFAULT_WORKFLOW_RETENTION_DAYS };
  if (!/^\d+$/.test(raw)) throw new WorkflowRetentionConfigurationError();
  const retentionDays = Number(raw);
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new WorkflowRetentionConfigurationError();
  return { retentionDays };
}

function listInput(strictCutoff: string): GetWorkflowsInput {
  return {
    applicationName: AUTH_WORKFLOW_APPLICATION,
    status: [...TERMINAL_WORKFLOW_STATUSES],
    completedBefore: strictCutoff,
    endTime: strictCutoff,
    limit: WORKFLOW_RETENTION_BATCH_SIZE,
    sortDesc: false,
    loadInput: false,
    loadOutput: false,
  };
}

/** Select and delete one bounded batch. The extra millisecond makes the SDK's inclusive cutoffs strict. */
export async function runWorkflowRetentionBatch(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy?: (id: string) => Promise<boolean>,
): Promise<number> {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
  const cutoff = now.getTime() - retentionDays * DAY_MS;
  const strictCutoff = new Date(cutoff - 1).toISOString();
  const statuses = await sdk.listWorkflows(listInput(strictCutoff));
  const selected = statuses
    .filter(
      (status) =>
        (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status.status) &&
        typeof status.completedAt === 'number' &&
        status.completedAt < cutoff,
    )
    .slice(0, WORKFLOW_RETENTION_BATCH_SIZE);
  let retired = 0;
  const ids: string[] = [];
  for (const status of selected) {
    if (!retireCopy || ['auth.maintenance.tick', WORKFLOW_RETENTION_WORKFLOW].includes(status.workflowName))
      ids.push(status.workflowID);
    else if (await retireCopy(status.workflowID)) retired++;
  }
  if (ids.length > 0) await sdk.deleteWorkflows(ids, false);
  return ids.length + retired;
}

/** One scheduled run uses one fixed cutoff and commits at most sixty SDK deletion transactions. */
export async function runWorkflowRetentionSweep(
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy?: (id: string) => Promise<boolean>,
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < WORKFLOW_RETENTION_MAX_BATCHES; batch++) {
    const removed = await runWorkflowRetentionBatch(retentionDays, sdk, now, retireCopy);
    deleted += removed;
    if (removed < WORKFLOW_RETENTION_BATCH_SIZE) break;
  }
  return deleted;
}

/** DBOS creates its system table at launch. Install before accepting requests or applying schedules.
 * The trigger removes request bindings inside the SDK deletion transaction, including on retry/crash.
 * Separate historical system databases cannot run Auth retention. */
export async function installWorkflowRequestRetention(database: Pool): Promise<void> {
  await database.query(`CREATE OR REPLACE TRIGGER auth_workflow_request_retention
    AFTER DELETE ON auth_dbos.workflow_status FOR EACH ROW
    EXECUTE FUNCTION public.auth_delete_workflow_request()`);
}
