import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { readMembershipRouteKey } from '../access/membership-work-config.ts';
import { runCommand } from '../command/command.ts';
import { stepLibraryIdentityEpoch } from '../library/identity-epoch-participant.ts';
import { createSearchIdentityEpochParticipant } from '../search/identity-epoch-participant.ts';
import { createOpenSearch } from '../search/opensearch.ts';
import { readSearchConfig } from '../search/work.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { stepIdentityEpochAdmission } from './identity-epoch-admission.ts';
import type {
  IdentityEpochParticipants,
  IdentityJobRef,
  IdentityStepName,
  IdentityStepProgress,
  IdentityStepReceipt,
  ResumeIdentityEpochJob,
  WaitIdentityEpochPublished,
} from './identity-epoch-contract.ts';
import { stepIdentityEpochMapping } from './identity-epoch-mapping.ts';
import { identityEpochStore, identityJobPartition, IdentityEpochStoreError } from './identity-adapters/index.ts';
import control from './identity-epoch-coordinator-control.sql';
import { withReadTransaction } from './read.ts';

const workflowName = 'semantic.identityEpoch';
const segmentPages = 100;
const waitIntervalMs = 100;
type JobLocator = Readonly<{ jobId: string; epoch: string }>;
type ReceiptLocator = Readonly<{
  job: JobLocator;
  step: IdentityStepName;
  version: 1;
  native: Readonly<{ partition: number; epoch: number; position: string; transactionId: string }>;
}>;
type Next = 'preparing' | 'cancelling' | 'cancelled' | 'published' | IdentityStepName | 'publish';
type WorkflowState = Readonly<{ status: string; nextSegment: number | null }> | null;
type Installation = Readonly<{
  client: WorkContext['client'];
  participants: IdentityEpochParticipants | null;
  read: (job: JobLocator) => Promise<Next>;
  status: (id: string) => Promise<WorkflowState>;
}>;

// Only immutable deployment wiring is retained here. Native job, frontier and ACK truth is always reread.
const installations = new WeakMap<Pool, Installation>();
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
const invalidProgress = () =>
  new IdentityEpochStoreError('identity_step_receipt_invalid', 'Identity producer returned an invalid scoped locator');
const noProgress = () =>
  new IdentityEpochStoreError(
    'identity_epoch_no_progress',
    'Native identity work did not advance its committed receipt',
  );
const sameJob = (a: IdentityJobRef, b: IdentityJobRef) => a.jobId === b.jobId && a.epoch === b.epoch;

function locator(job: IdentityJobRef): JobLocator {
  identityJobPartition(job);
  if (typeof job.epoch !== 'bigint' || job.epoch <= 0n) throw new TypeError('Invalid native identity epoch');
  return { jobId: job.jobId, epoch: job.epoch.toString() };
}
function nativeJob(job: JobLocator): IdentityJobRef {
  if (!/^[1-9][0-9]*$/.test(job.epoch)) throw new TypeError('Invalid durable identity epoch');
  const ref = { jobId: job.jobId, epoch: BigInt(job.epoch) };
  locator(ref);
  return ref;
}
const workflowId = (job: JobLocator) => `semantic:identity:${job.jobId}:${job.epoch}`;

async function readWorkflowState(client: WorkContext['client'], id: string): Promise<WorkflowState> {
  const workflow = await client.getWorkflow(id);
  if (!workflow) return null;
  const output = workflow.output;
  const nextSegment =
    output && typeof output === 'object' && 'nextSegment' in output && typeof output.nextSegment === 'number'
      ? output.nextSegment
      : null;
  return { status: workflow.status, nextSegment };
}

/** Observe only this job's native control home, releasing the snapshot before another command or engine. */
async function readNext(pool: Pool, ref: IdentityJobRef): Promise<Next> {
  return withReadTransaction(pool, async (tx) => {
    const job = await identityEpochStore.readJob(tx, ref);
    if (!job) throw unavailable('Native identity job or its current owner is unavailable');
    const row = (await tx.query(control.sql, [identityJobPartition(ref)])).rows[0];
    if (!row) throw unavailable('Native identity control is unavailable');
    if (job.state === 'published') {
      if (BigInt(row.published_epoch) < ref.epoch || row.pending_job === ref.jobId)
        throw unavailable('Native publication and control custody disagree');
      return 'published';
    }
    if (job.state === 'cancelled' || job.state === 'cancelling') return job.state;
    if (row.pending_job !== ref.jobId || BigInt(row.pending_epoch ?? -1) !== ref.epoch)
      throw unavailable('Native identity job no longer owns its control reservation');
    if (job.state === 'preparing') return 'preparing';
    if (job.mapping?.state !== 'complete') return 'mapping';
    if (job.participants['search-canonical-index']?.state !== 'complete') return 'search-canonical-index';
    if (job.participants['library-private-follow-counts']?.state !== 'complete') return 'library-private-follow-counts';
    return 'publish';
  });
}

function receiptLocator(ref: IdentityJobRef, step: IdentityStepName, progress: IdentityStepProgress): ReceiptLocator {
  const receipt = progress.receipt;
  if (
    !sameJob(progress.job, ref) ||
    !sameJob(receipt.job, ref) ||
    receipt.step !== step ||
    receipt.version !== 1 ||
    !['more', 'complete'].includes(progress.state) ||
    progress.frontier.after.length > 8 ||
    Buffer.byteLength(JSON.stringify(progress.frontier)) > 2048 ||
    progress.work.rows > 100 ||
    Object.values(progress.work).some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw invalidProgress();
  if (progress.state === 'more' && progress.work.rows + progress.work.points + progress.work.engineRequests === 0)
    throw noProgress();
  return {
    job: locator(ref),
    step,
    version: 1,
    native: { ...receipt.native, position: receipt.native.position.toString() },
  };
}
function nativeReceipt(receipt: ReceiptLocator): IdentityStepReceipt {
  return {
    ...receipt,
    job: nativeJob(receipt.job),
    native: { ...receipt.native, position: BigInt(receipt.native.position) },
  };
}

function installed(pool: Pool): Installation {
  const binding = installations.get(pool);
  if (!binding?.participants)
    throw unavailable('Fixed identity participants or trusted Search configuration are unavailable');
  return binding;
}

/** Trusted registration only; there is no caller-selected participant list or mutable installation setter. */
export function registerIdentityEpochCoordinator(context: WorkContext): void {
  if (installations.has(context.pool)) throw new Error('Identity epoch coordinator is already registered');
  const config = readSearchConfig(context.env);
  const routeKey = config && context.env.KERNEL_ROUTE_KEY ? readMembershipRouteKey(context.env) : null;
  const participants: IdentityEpochParticipants | null =
    config && routeKey
      ? Object.freeze({
          version: 1,
          'search-canonical-index': createSearchIdentityEpochParticipant({
            search: createOpenSearch(config.url),
            prefix: config.prefix,
            routeKey,
          }),
          'library-private-follow-counts': stepLibraryIdentityEpoch,
        })
      : null;
  const read = DBOS.registerStep(async (job: JobLocator) => readNext(context.pool, nativeJob(job)), {
    name: `${workflowName}.read`,
    ...COMMAND_STEP_RETRIES,
  });
  const status = DBOS.registerStep(async (id: string) => readWorkflowState(context.client, id), {
    name: `${workflowName}.status`,
    ...COMMAND_STEP_RETRIES,
  });
  const admission = DBOS.registerStep(
    async (job: JobLocator) => {
      const result = await stepIdentityEpochAdmission(context.pool, nativeJob(job));
      if (result.state === 'preparing' && result.work.rows === 0) throw noProgress();
    },
    { name: `${workflowName}.admission`, ...COMMAND_STEP_RETRIES },
  );
  const produce = DBOS.registerStep(
    async (job: JobLocator, step: IdentityStepName) => {
      const ref = nativeJob(job);
      const binding = installed(context.pool);
      // The producer rereads its saved frontier and commits locally. Its home has been released on return.
      const progress = await (step === 'mapping' ? stepIdentityEpochMapping : binding.participants![step])(
        context.pool,
        ref,
      );
      return { receipt: receiptLocator(ref, step, progress), state: progress.state };
    },
    { name: `${workflowName}.produce`, ...COMMAND_STEP_RETRIES },
  );
  const reconcile = DBOS.registerStep(
    async (receipt: ReceiptLocator) => {
      // The Store independently rereads the committed local record, scope and receiving effect custody.
      await identityEpochStore.reconcileStepReceipt(context.pool, nativeReceipt(receipt));
    },
    { name: `${workflowName}.reconcile`, ...COMMAND_STEP_RETRIES },
  );
  const publish = DBOS.registerStep(
    async (job: JobLocator) => {
      const ref = nativeJob(job);
      // The command rechecks native ACKs and current control ownership even after a lost local result.
      await runCommand(context.pool, { partition: identityJobPartition(ref) }, (tx) =>
        identityEpochStore.publish(tx, ref),
      );
    },
    { name: `${workflowName}.publish`, ...COMMAND_STEP_RETRIES },
  );
  const continueWork = DBOS.registerStep(
    async (job: JobLocator, segment: number) => {
      if (!Number.isSafeInteger(segment) || segment < 1) throw new TypeError('Invalid identity workflow segment');
      const id = `${workflowId(job)}:segment:${segment}`;
      await context.client.enqueue(
        { workflowName, workflowID: id, workflowIDReusePolicy: 'return-existing', queueName: 'maintenance' },
        job,
        segment,
      );
      return id;
    },
    { name: `${workflowName}.continue`, ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (job: JobLocator, segment: number = 0) => {
      let previous: ReceiptLocator | null = null;
      for (let page = 0; page < segmentPages; page++) {
        const next = await read(job);
        if (next === 'published' || next === 'cancelled') return { nextSegment: null };
        if (next === 'preparing' || next === 'cancelling') {
          await admission(job);
        } else if (next === 'publish') {
          await publish(job);
        } else {
          const result = await produce(job, next);
          if (previous && JSON.stringify(previous) === JSON.stringify(result.receipt)) throw noProgress();
          previous = result.receipt;
          if (result.state === 'complete') await reconcile(result.receipt);
        }
      }
      // Each workflow contains at most 100 pages. Only the saved job and segment locator cross the boundary;
      // each producer rereads its native frontier. Release this queue slot before the next segment runs.
      await DBOS.sleep(waitIntervalMs);
      await continueWork(job, segment + 1);
      return { nextSegment: segment + 1 };
    },
    { name: workflowName },
  );
  installations.set(context.pool, Object.freeze({ client: context.client, participants, read, status }));
}

/** Enqueue only the original saved identity. Returning from enqueue is never publication completion. */
export const resumeIdentityEpochJob: ResumeIdentityEpochJob = async (pool, job) => {
  const input = locator(job);
  const next = await readNext(pool, job);
  if (next === 'published' || next === 'cancelled') return;
  const binding = installed(pool);
  const id = workflowId(input);
  const handle = await binding.client.enqueue(
    { workflowName, workflowID: id, workflowIDReusePolicy: 'return-existing', queueName: 'maintenance' },
    input,
  );
  // Enqueue's return-existing behavior must not silently turn a terminal SDK failure into successful resumption.
  if ((await handle.getStatus())?.status === 'ERROR')
    throw unavailable('Native identity publication workflow failed; its original job remains pending');
};

/** Wait for native job AND published control custody, never an SDK result or ordinary projection checkpoint. */
export const waitIdentityEpochPublished: WaitIdentityEpochPublished = async (pool, job) => {
  const input = locator(job);
  let segment = 0;
  for (;;) {
    const binding = installations.get(pool);
    const next = await (DBOS.isInWorkflow() && !DBOS.isInStep() && binding ? binding.read(input) : readNext(pool, job));
    if (next === 'published') return;
    if (next === 'cancelled' || next === 'cancelling')
      throw new IdentityEpochStoreError('identity_effect_stale', 'Cancelled native identity work cannot publish');
    const current = installed(pool);
    const id = segment === 0 ? workflowId(input) : `${workflowId(input)}:segment:${segment}`;
    const workflow = await (DBOS.isInWorkflow() && !DBOS.isInStep()
      ? current.status(id)
      : readWorkflowState(current.client, id));
    if (!workflow) throw unavailable('Native identity publication work has not been enqueued');
    if (
      workflow.status === 'ERROR' ||
      workflow.status === 'SUCCESS' ||
      workflow.status === 'CANCELLED' ||
      workflow.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'
    ) {
      // Publication can commit between the preceding native read and the SDK status read (or its lost result).
      const actual = await (DBOS.isInWorkflow() && !DBOS.isInStep() ? current.read(input) : readNext(pool, job));
      if (actual === 'published') return;
      if (workflow.status === 'SUCCESS') {
        if (workflow.nextSegment !== segment + 1 || !Number.isSafeInteger(workflow.nextSegment)) throw noProgress();
        segment++;
      } else {
        throw unavailable(
          'Native identity publication workflow stopped before publication; the original job remains pending',
        );
      }
    }
    if (DBOS.isInStep()) throw unavailable('Identity publication must wait outside a durable step');
    if (DBOS.isInWorkflow()) await DBOS.sleep(waitIntervalMs);
    else await Bun.sleep(waitIntervalMs);
  }
};
