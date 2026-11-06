import { DBOS, type WorkflowStatusString } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { examineWorkflowRetentionPage, type WorkflowRetentionCandidate } from './retention-store.ts';

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
/** Raw keys, including foreign applications, live copies and pending consumers. */
export const WORKFLOW_RETENTION_BATCH_SIZE = 1000;
export const WORKFLOW_RETENTION_MAX_BATCHES = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TERMINAL_WORKFLOW_STATUSES = [
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
] as const satisfies readonly WorkflowStatusString[];

type Environment = Readonly<Record<string, string | undefined>>;
export type WorkflowRetentionConfig = Readonly<{ retentionDays: number }>;
export type WorkflowRetentionSdk = Pick<typeof DBOS, 'deleteWorkflows'>;
export type WorkflowCopyRetirement = (id: string) => Promise<boolean>;
/** Counts only: native keys, source custody and SDK payloads never enter step output. */
export type WorkflowRetentionPage = Readonly<{
  cutoff: number;
  examined: number;
  eligible: number;
  retired: number;
  pending: number;
  done: boolean;
}>;

function assertRetentionDays(retentionDays: number) {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_WORKFLOW_RETENTION_DAYS ||
    retentionDays > MAX_WORKFLOW_RETENTION_DAYS
  )
    throw new RangeError('Invalid workflow retention period');
}

export function readWorkflowRetentionConfig(env: Environment): WorkflowRetentionConfig {
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

async function retireCandidates(
  candidates: readonly WorkflowRetentionCandidate[],
  sdk: WorkflowRetentionSdk,
  retireCopy: WorkflowCopyRetirement,
): Promise<{ eligible: number; retired: number; pending: number }> {
  let eligible = 0;
  let retired = 0;
  let pending = 0;
  const technical: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.eligible) continue;
    eligible++;
    if (candidate.technical) technical.push(candidate.id);
    else if (await retireCopy(candidate.id)) retired++;
    else pending++;
  }
  // Only the two closed counts-only maintenance workflows bypass personal custody.
  if (technical.length) await sdk.deleteWorkflows(technical, false);
  return { eligible, retired: retired + technical.length, pending };
}

/** One raw-PK page. The store checkpoints only after the entire retirement body succeeds.
 * A lost response can repeat exact SDK retirement, but never infers consumption from age.
 */
export async function runWorkflowRetentionPage(
  database: Pool,
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy: WorkflowCopyRetirement,
): Promise<WorkflowRetentionPage> {
  assertRetentionDays(retentionDays);
  return examineWorkflowRetentionPage(
    database,
    now.getTime() - retentionDays * DAY_MS,
    WORKFLOW_RETENTION_BATCH_SIZE,
    (candidates) => retireCandidates(candidates, sdk, retireCopy),
  );
}

/** Compatibility count for callers that do not need continuation statistics. */
export async function runWorkflowRetentionBatch(
  database: Pool,
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy: WorkflowCopyRetirement,
): Promise<number> {
  return (await runWorkflowRetentionPage(database, retentionDays, sdk, now, retireCopy)).retired;
}

/** Administrative bounded drain. Scheduled maintenance uses one page per tick.
 * Stop on raw exhaustion, never on a short deletion count or a pending consumer.
 * A capped drain leaves the same cutoff and cursor for the next invocation.
 */
export async function runWorkflowRetentionSweep(
  database: Pool,
  retentionDays: number,
  sdk: WorkflowRetentionSdk = DBOS,
  now = new Date(),
  retireCopy: WorkflowCopyRetirement,
): Promise<number> {
  let retired = 0;
  for (let batch = 0; batch < WORKFLOW_RETENTION_MAX_BATCHES; batch++) {
    const page = await runWorkflowRetentionPage(database, retentionDays, sdk, now, retireCopy);
    retired += page.retired;
    if (page.done) break;
  }
  return retired;
}

/** Install after DBOS launch. The owner function removes only source-authorized request
 * bindings inside SDK deletion, including rollback. No SDK schema/index/API is replaced.
 */
export async function installWorkflowRequestRetention(database: Pool): Promise<void> {
  await database.query(`CREATE OR REPLACE TRIGGER auth_workflow_request_retention
    AFTER DELETE ON auth_dbos.workflow_status FOR EACH ROW
    EXECUTE FUNCTION public.auth_delete_workflow_request()`);
}
