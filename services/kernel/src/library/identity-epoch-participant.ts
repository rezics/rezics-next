import type { Pool } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { currentCommand, noEffect, registerCommandCallback, runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import type { IdentityEpochStep, IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import {
  bindSemanticProducerRoles,
  identityEpochStore,
  identityErasureRoles,
  identityJobPartition,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from '../semantic/identity-adapters/index.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
} from '../semantic/identity-source-consumer-maintenance.ts';
import type { IdentitySourceConsumerMaintenanceContext } from '../semantic/identity-source-consumer-maintenance.ts';
import {
  lookupIdentityReceivingEffect,
  prepareIdentityReceivingEffect,
  recordIdentityReceivingEffect,
  reconcileIdentityReceivingEffect,
  type IdentityReceivingEffect,
  type IdentityReceivingSelection,
} from '../semantic/identity-receiving-effects.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { IDENTITY_EPOCH_ADMITTED } from '../semantic/events.ts';
import { WORK_STEP_DEADLINE_MS, workStepDeadline } from './command-support.ts';
import {
  libraryIdentityInvalidationRole,
  libraryIdentityRoles,
  registerLibraryOwnerIdentityScope,
  type LibraryIdentityRole,
} from './owner-identity.ts';
import {
  libraryIdentityCommand,
  libraryIdentityPlanKey,
  readLibraryIdentityEffectOperationWithWork,
} from './identity-native-planner.ts';
import {
  verifyLibraryScopeEffectsSeal,
  readLibraryScopeEffectsPageWithWork,
  type LibraryScopeEffectsKey,
  type LibraryExpectedEffectAfter,
} from './identity-scope-effects.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';
import { applyLibraryIdentityCandidate } from './owner-identity.ts';
import { applyFollowIdentityPage, type FollowIdentityCursor, type FollowIdentityHandoff } from './follow-identity.ts';
import {
  beginCanonicalSourceRepair,
  observeCanonicalSource,
  publishCanonicalSourceRepair,
  readCanonicalSourceState,
  repairCanonicalSourceStep,
  type CanonicalAllowance,
  type CanonicalWork,
} from './canonical-source-store.ts';
import { CANONICAL_SOURCE_REPAIR_STEP, canonicalSourceCallAllowance } from './canonical-source-bounds.ts';
import type { WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
import invalidate from './identity-epoch-participant-invalidate.sql';
import scanSql from './identity-epoch-participant-scan.sql';
import completeSql from './identity-epoch-participant-complete.sql';

const step = 'library-private-follow-counts';
const stale = (detail: string) => new IdentityEpochStoreError('identity_effect_stale', detail);
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);
function bounded<T>(run: (deadline: number) => Promise<T>): Promise<T> {
  const deadline = Math.min(workStepDeadline(), Date.now() + WORK_STEP_DEADLINE_MS);
  return withRequestDeadline(deadline, () => run(deadline));
}
type QueuedEffect = {
  original: string;
  effect_key: string;
  role: LibraryIdentityRole | 'follow';
  receiving_partition: number;
  receiving_epoch: number;
  receiving_position: string;
  receiving_transaction_id: string;
  source_route: number | null;
  source_id: string | null;
  plan_key: string | null;
  disposition: IdentityReceivingSelection['disposition'] | null;
  follow_partition: number | null;
  follow_after: string | null;
  follow_complete: boolean;
  handed_off: boolean;
};
function effectOf(job: IdentityJobRef, row: QueuedEffect): IdentityReceivingEffect {
  return {
    kind: 'receiving',
    job,
    original: row.original,
    effectKey: row.effect_key,
    receipt: {
      partition: row.receiving_partition,
      epoch: row.receiving_epoch,
      position: BigInt(row.receiving_position),
      transactionId: row.receiving_transaction_id,
    },
  };
}
function wake(job: IdentityJobRef) {
  return {
    type: IDENTITY_EPOCH_ADMITTED,
    data: { jobId: job.jobId, epoch: job.epoch.toString(), partition: identityJobPartition(job) },
  };
}

/** Normal Source writer handoff. Selection keys alone never register native work.
 * Source read/hold, expected control obligation and receiving record precede this queue.
 * A crash before queue insertion leaves the expected obligation pending; retry the same selection.
 */
export async function prepareLibraryIdentitySourceInvalidation(
  pool: Pool,
  selection: IdentityReceivingSelection,
): Promise<IdentityReceivingEffect> {
  return bounded(async () => {
    libraryIdentityInvalidationRole(selection.scope);
    const effect = await prepareIdentityReceivingEffect(pool, selection);
    await registerLibraryIdentitySourceInvalidation(pool, effect);
    return effect;
  });
}

/** A retained actual receiving locator also recovers a lost preparation result.
 * No Source factory, arbitrary effect callback, supplied native success or participant ACK.
 */
export async function registerLibraryIdentitySourceInvalidation(
  pool: Pool,
  effect: IdentityReceivingEffect,
): Promise<void> {
  return bounded(async (deadline) => {
    const observed = await runCommand(pool, { partition: effect.receipt.partition, deadline }, async (tx) =>
      noEffect(await lookupIdentityReceivingEffect(tx, effect)),
    );
    const record = observed.value;
    if (!record) throw stale('Missing native Library source receiving record');
    const role = libraryIdentityInvalidationRole(record.source.scope);
    if (record.source.home !== record.source.receivingHome)
      throw unavailable('Cross-home Library identity Source holds remain unbound');
    const home = identityJobPartition(effect.job);
    const ownerRoute = routeOf(record.owner);
    if (ownerRoute === null || partitionOf(ownerRoute) !== home || record.source.receivingHome !== home)
      throw unavailable('Library control-copy custody requires the actual same-home account fence');
    await runCommand(pool, { partition: home, deadline }, async (tx) => {
      await shareAccount(tx, record.owner);
      // All supported homes coincide, so revalidate the real receiving owner/gate locally after the released read.
      const current = await lookupIdentityReceivingEffect(tx, effect);
      if (!current || current.owner !== record.owner || current.plan.transactionId !== record.plan.transactionId)
        throw stale('Library source receiving custody changed before registration');
      // Registration serializes with publication/cancellation on this saved job, never a global lock.
      const job = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_job
       WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state='pending' FOR UPDATE`,
        [home, effect.job.jobId, effect.job.epoch.toString()],
      );
      if (job.rowCount !== 1) throw stale('Library source registration needs the pending admitted job');
      const plan = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_receiving_plan
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND transaction_id=$5
         AND binding->>'original'=$6 AND binding->>'owner'=$7
         AND binding->'source'->>'id'=$8 AND binding->'source'->>'scope'=$9`,
        [
          home,
          effect.job.jobId,
          effect.job.epoch.toString(),
          effect.effectKey,
          record.plan.transactionId,
          effect.original,
          record.owner,
          record.source.id,
          record.source.scope,
        ],
      );
      if (plan.rowCount !== 1) throw stale('Missing exact native Library source control plan');
      const prior = await tx.query<QueuedEffect>(
        `SELECT original,effect_key,role,receiving_partition,receiving_epoch,
              receiving_position::text,receiving_transaction_id::text,source_route,source_id::text,
              plan_key,disposition,follow_partition,follow_after::text,follow_complete,handed_off
       FROM library.identity_epoch_participant_work
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4`,
        [home, effect.job.jobId, effect.job.epoch.toString(), effect.effectKey],
      );
      const row = prior.rows[0];
      if (row) {
        if (
          row.original !== effect.original ||
          row.role !== role ||
          row.receiving_partition !== effect.receipt.partition ||
          row.receiving_epoch !== effect.receipt.epoch ||
          BigInt(row.receiving_position) !== effect.receipt.position ||
          row.receiving_transaction_id !== effect.receipt.transactionId
        )
          throw stale('Conflicting native Library source receiving locator');
        return noEffect(null);
      }
      await tx.query(
        `INSERT INTO library.identity_epoch_participant_work
        (partition_no,job_id,job_epoch,effect_key,original,owner_id,role,receiving_partition,
         receiving_epoch,receiving_position,receiving_transaction_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          home,
          effect.job.jobId,
          effect.job.epoch.toString(),
          effect.effectKey,
          effect.original,
          record.owner,
          role,
          effect.receipt.partition,
          effect.receipt.epoch,
          effect.receipt.position.toString(),
          effect.receipt.transactionId,
        ],
      );
      return { value: null, events: [wake(effect.job)] };
    });
  });
}

/** Semantic's live Source frame as Library receives it from the binding's caller. Library never imports
 * the frame module; the caller supplies the accessor and every function below runs on the resolved pair.
 */
export type LibrarySourceFrame = Readonly<{
  libraryWork(
    pool: Pool,
    token: IdentitySourceConsumerMaintenanceContext['identityConsumerWork'],
    deadline: number,
  ): NativeCollectionWork | null;
}>;
/** The command runner used for this frame's durable and ordinary Library steps; the default is runCommand. */
export type LibraryCommandRunner = typeof runCommand;
/** `run` is the command runner for this frame's durable and ordinary Library steps. It defaults to runCommand. */
export type LiveLibrarySource = Readonly<{
  context: IdentitySourceConsumerMaintenanceContext;
  work: NativeCollectionWork;
  run: typeof runCommand;
}>;
export function resolveLiveLibrarySource(
  frame: LibrarySourceFrame,
  pool: Pool,
  context: IdentitySourceConsumerMaintenanceContext,
  run: typeof runCommand = runCommand,
): LiveLibrarySource {
  const work = frame.libraryWork(pool, context.identityConsumerWork, context.deadline);
  if (!work) throw unavailable("Library identity receiver requires Semantic's exact live Source maintenance frame");
  return Object.freeze({ context, work, run });
}

function roleOfDriver(value: unknown): LibraryIdentityRole {
  if (typeof value !== 'string' || !libraryIdentityRoles.includes(value as LibraryIdentityRole))
    throw unavailable('Native Library manifest contains an unbound driver');
  return value as LibraryIdentityRole;
}

/** Prepare one actual sealed six-driver selection, then retain its exact source-plan locator.
 * The operation is reread from the sealed native manifest; caller-supplied raw facts are ignored.
 */
export async function prepareLibraryIdentityNativeEffect(
  pool: Pool,
  selection: IdentityReceivingSelection,
  source: LiveLibrarySource,
): Promise<IdentityReceivingEffect> {
  const { context, work } = source;
  const capture = selection.capture;
  if (!capture) throw stale('A native Library plan effect requires its retained Source capture');
  const sourceIdentity: NativeSourceIdentity = capture.identity;
  const key: LibraryScopeEffectsKey = {
    job: selection.job,
    sourceIdentity,
    scope: selection.scope,
  };
  const operation = await readLibraryIdentityEffectOperationWithWork(
    pool,
    key,
    { effectKey: selection.effectKey, disposition: selection.disposition },
    work,
  );
  if (!operation || typeof operation !== 'object') throw stale('Missing sealed Library native operation');
  const native = operation as {
    job?: { jobId?: unknown; epoch?: unknown };
    scope?: unknown;
    raw?: { driver?: unknown; storedSubjectId?: unknown; factId?: unknown };
    change?: { original?: unknown };
    disposition?: unknown;
    sourceIdentity?: { collectionId?: unknown; incarnation?: unknown; accountId?: unknown };
  };
  const role = roleOfDriver(native.raw?.driver);
  if (
    native.job?.jobId !== selection.job.jobId ||
    String(native.job.epoch) !== selection.job.epoch.toString() ||
    native.scope !== selection.scope ||
    native.change?.original !== selection.original ||
    native.disposition !== selection.disposition ||
    native.sourceIdentity?.collectionId !== sourceIdentity.collectionId ||
    native.sourceIdentity?.incarnation !== sourceIdentity.incarnation ||
    native.sourceIdentity?.accountId !== selection.owner ||
    typeof native.raw?.storedSubjectId !== 'string' ||
    typeof native.raw?.factId !== 'string'
  )
    throw stale('Sealed Library operation differs from its exact receiving selection');

  const effect = await prepareIdentityReceivingEffect(pool, selection);
  await registerLibraryIdentityNativeEffect(
    pool,
    effect,
    {
      role,
      sourceRoute: sourceIdentity.route,
      sourceId: sourceIdentity.collectionId,
      planKey: libraryIdentityPlanKey(key),
      disposition: selection.disposition,
      deadline: context.deadline,
    },
    source.run,
  );
  return effect;
}

export type LibraryIdentityNativeScopeProgress = Readonly<{
  state: 'more' | 'scope-complete' | 'unavailable';
  after: LibraryExpectedEffectAfter | null;
  effect: IdentityReceivingEffect | null;
  work: ReturnType<NativeCollectionWork['receipt']>;
}>;

/** Advance one prepaid page of an actual sealed native Source manifest.
 * The page is read here (limit one under a Source frame), each selection is resolved again from
 * the sealed manifest before receiving admission, and its cursor/exhaustion is retained locally.
 */
export async function advanceLibraryIdentityNativeScope(
  pool: Pool,
  key: LibraryScopeEffectsKey,
  after: LibraryExpectedEffectAfter | null,
  source: LiveLibrarySource,
): Promise<LibraryIdentityNativeScopeProgress> {
  const { context, work } = source;
  // Public output authority is owned by its publication producer, which has no account owner
  // locator for the private Library receiving cursor.
  if (key.sourceIdentity.scope === 'public_output')
    return { state: 'unavailable', after, effect: null, work: work.receipt() };
  // Narrowed here, outside the transaction callbacks, which lose property-path narrowing.
  const accountId = key.sourceIdentity.accountId;
  if (key.job.epoch <= 0n || identityJobPartition(key.job) !== partitionOf(key.sourceIdentity.route))
    throw stale('Library native scope crossed its admitted source partition');
  const planKey = libraryIdentityPlanKey(key);
  const partition = identityJobPartition(key.job);
  const savedCursor = await libraryIdentityCommand(pool, work, partition, async (tx) => {
    const row = (
      await tx.query<{ after_effect_key: string; after_disposition: string; exhausted: boolean }>(
        `SELECT after_effect_key,after_disposition,exhausted FROM library.identity_epoch_participant_scope
         WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND source_route=$4 AND source_id=$5
           AND owner_id=$6 AND plan_key=$7`,
        [
          partition,
          key.job.jobId,
          key.job.epoch.toString(),
          key.sourceIdentity.route,
          key.sourceIdentity.collectionId,
          accountId,
          planKey,
        ],
      )
    ).rows[0];
    return noEffect(row ?? null);
  });
  const retainedAfter = savedCursor
    ? savedCursor.after_effect_key
      ? {
          effectKey: savedCursor.after_effect_key,
          disposition: savedCursor.after_disposition as LibraryExpectedEffectAfter['disposition'],
        }
      : null
    : null;
  if (
    (savedCursor?.after_effect_key === '' && savedCursor.after_disposition !== '') ||
    (savedCursor?.after_effect_key !== undefined &&
      !!savedCursor.after_effect_key !== !!savedCursor.after_disposition) ||
    JSON.stringify(after) !== JSON.stringify(retainedAfter)
  )
    throw stale('Library native scope cursor differs from its retained page frontier');
  if (savedCursor?.exhausted)
    return { state: 'scope-complete', after: retainedAfter, effect: null, work: work.receipt() };
  const page = await readLibraryScopeEffectsPageWithWork(
    pool,
    { ...key, after, limit: 1, deadline: context.deadline },
    work,
  );
  if (page.status !== 'sealed') return { state: 'unavailable', after, effect: null, work: work.receipt() };

  await libraryIdentityCommand(pool, work, partition, async (tx) => {
    await tx.query(
      `INSERT INTO library.identity_epoch_participant_scope
       (partition_no,job_id,job_epoch,source_route,source_id,owner_id,plan_key)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        partition,
        key.job.jobId,
        key.job.epoch.toString(),
        key.sourceIdentity.route,
        key.sourceIdentity.collectionId,
        accountId,
        planKey,
      ],
    );
    return noEffect(null);
  });

  let effect: IdentityReceivingEffect | null = null;
  for (const selection of page.rows) {
    effect = await prepareLibraryIdentityNativeEffect(pool, selection, source);
  }
  const afterPage = page.after;
  if (page.exhausted) {
    const verified = await libraryIdentityCommand(pool, work, partition, async (tx) =>
      noEffect(await verifyLibraryScopeEffectsSeal(tx, key, page.seal)),
    );
    if (!verified) throw stale('Library native scope lost its exhaustive sealed manifest');
  }
  await libraryIdentityCommand(pool, work, partition, async (tx) => {
    const updated = await tx.query(
      `UPDATE library.identity_epoch_participant_scope
       SET after_effect_key=$8,after_disposition=$9,exhausted=$10
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND source_route=$4 AND source_id=$5 AND owner_id=$6 AND plan_key=$7
         AND after_effect_key=$11 AND after_disposition=$12 AND NOT exhausted
       RETURNING plan_key`,
      [
        partition,
        key.job.jobId,
        key.job.epoch.toString(),
        key.sourceIdentity.route,
        key.sourceIdentity.collectionId,
        accountId,
        planKey,
        afterPage?.effectKey ?? '',
        afterPage?.disposition ?? '',
        page.exhausted,
        savedCursor?.after_effect_key ?? '',
        savedCursor?.after_disposition ?? '',
      ],
    );
    if (updated.rowCount !== 1) throw stale('Library native scope cursor lost its retained plan');
    return { value: null, events: [wake(key.job)] };
  });
  return { state: page.exhausted ? 'scope-complete' : 'more', after: afterPage, effect, work: work.receipt() };
}

async function registerLibraryIdentityNativeEffect(
  pool: Pool,
  effect: IdentityReceivingEffect,
  locator: Readonly<{
    role: LibraryIdentityRole;
    sourceRoute: number;
    sourceId: string;
    planKey: string;
    disposition: IdentityReceivingSelection['disposition'];
    deadline: number;
  }>,
  run: typeof runCommand,
): Promise<void> {
  const { deadline } = locator;
  await withRequestDeadline(deadline, async () => {
    const observed = await run(pool, { partition: effect.receipt.partition, deadline }, async (tx) =>
      noEffect(await lookupIdentityReceivingEffect(tx, effect)),
    );
    const record = observed.value;
    if (!record || record.source.scope !== 'collection-source' || record.source.home !== record.source.receivingHome)
      throw stale('Native Library plan receiving record is missing or crossed homes');
    if (
      record.source.id !== locator.sourceId ||
      record.source.disposition !== locator.disposition ||
      routeOf(locator.sourceId) !== locator.sourceRoute ||
      partitionOf(locator.sourceRoute) !== identityJobPartition(effect.job) ||
      routeOf(record.owner) === null ||
      partitionOf(routeOf(record.owner)!) !== identityJobPartition(effect.job)
    )
      throw unavailable('Native Library effect needs an exact same-home owner handoff');
    const home = identityJobPartition(effect.job);
    await run(pool, { partition: home, deadline }, async (tx) => {
      const current = await lookupIdentityReceivingEffect(tx, effect);
      if (!current || current.owner !== record.owner || current.plan.transactionId !== record.plan.transactionId)
        throw stale('Library receiving custody changed before participant registration');
      const job = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_job
         WHERE partition_no=$1 AND job_id=$2 AND epoch=$3 AND state='pending' FOR UPDATE`,
        [home, effect.job.jobId, effect.job.epoch.toString()],
      );
      if (job.rowCount !== 1) throw stale('Library native scope needs the pending admitted job');
      const plan = await tx.query(
        `SELECT 1 FROM semantic.identity_epoch_receiving_plan
         WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND transaction_id=$5
           AND binding->>'original'=$6 AND binding->>'owner'=$7
           AND binding->'source'->>'id'=$8 AND binding->'source'->>'scope'='collection-source'
           AND binding->'source'->>'disposition'=$9`,
        [
          home,
          effect.job.jobId,
          effect.job.epoch.toString(),
          effect.effectKey,
          record.plan.transactionId,
          effect.original,
          record.owner,
          record.source.id,
          record.source.disposition,
        ],
      );
      if (plan.rowCount !== 1) throw stale('Missing exact Library Source receiving plan');
      const prior = await tx.query<QueuedEffect>(
        `SELECT original,effect_key,role,receiving_partition,receiving_epoch,
                receiving_position::text,receiving_transaction_id::text,source_route,source_id::text,
                plan_key,disposition,follow_partition,follow_after::text,follow_complete,handed_off
         FROM library.identity_epoch_participant_work
         WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4`,
        [home, effect.job.jobId, effect.job.epoch.toString(), effect.effectKey],
      );
      const row = prior.rows[0];
      if (row) {
        if (
          row.original !== effect.original ||
          row.role !== locator.role ||
          row.source_route !== locator.sourceRoute ||
          row.source_id !== locator.sourceId ||
          row.plan_key !== locator.planKey ||
          row.disposition !== locator.disposition ||
          row.receiving_partition !== effect.receipt.partition ||
          row.receiving_epoch !== effect.receipt.epoch ||
          BigInt(row.receiving_position) !== effect.receipt.position ||
          row.receiving_transaction_id !== effect.receipt.transactionId
        )
          throw stale('Conflicting Library plan effect receiving locator');
        return noEffect(null);
      }
      await tx.query(
        `INSERT INTO library.identity_epoch_participant_work
         (partition_no,job_id,job_epoch,effect_key,original,owner_id,role,receiving_partition,
          receiving_epoch,receiving_position,receiving_transaction_id,source_route,source_id,plan_key,disposition,
          follow_complete)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           NOT ($15::text IN ('OLD','NEW','first-apply') AND NOT EXISTS(
             SELECT 1 FROM library.identity_epoch_participant_work w
             WHERE w.partition_no=$1 AND w.job_id=$2 AND w.job_epoch=$3 AND w.original=$5
               AND w.disposition=$15::text)))`,
        [
          home,
          effect.job.jobId,
          effect.job.epoch.toString(),
          effect.effectKey,
          effect.original,
          record.owner,
          locator.role,
          effect.receipt.partition,
          effect.receipt.epoch,
          effect.receipt.position.toString(),
          effect.receipt.transactionId,
          locator.sourceRoute,
          locator.sourceId,
          locator.planKey,
          locator.disposition,
        ],
      );
      return { value: null, events: [wake(effect.job)] };
    });
  });
}

/** One source-local effect. Invalidation retains partial/ready bases, never private fact values.
 * This scope is separate from OLD/NEW canonical rekeys, follow effects and publication fences.
 */
async function applySourceInvalidation(
  pool: Pool,
  job: IdentityJobRef,
  row: QueuedEffect,
  deadline: number,
  run: typeof runCommand,
) {
  const effect = effectOf(job, row);
  await run(pool, { partition: effect.receipt.partition, deadline }, async (tx) => {
    const record = await lookupIdentityReceivingEffect(tx, effect);
    if (!record || libraryIdentityInvalidationRole(record.source.scope) !== row.role)
      throw stale('Library source invalidation scope changed');
    // Resolve committed local effects BEFORE admission/mutation: replay cannot invalidate a newer build.
    if (record.applied) return noEffect(null);
    const sourceRoute = routeOf(record.source.id);
    const ownerRoute = routeOf(record.owner);
    if (
      sourceRoute === null ||
      ownerRoute === null ||
      partitionOf(sourceRoute) !== effect.receipt.partition ||
      partitionOf(ownerRoute) !== effect.receipt.partition ||
      record.source.home !== effect.receipt.partition
    )
      throw unavailable('Library source invalidation requires actual same-home source/account custody');
    // Same native account barrier: terminal T cannot create a late private directory/basis.
    const role = await registerLibraryOwnerIdentityScope(tx, effect);
    const source = await tx.query(
      `SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND curator_account_id=$3 FOR SHARE`,
      [sourceRoute, record.source.id, record.owner],
    );
    if (source.rowCount !== 1) throw unavailable('Missing actual owner Collection source for identity invalidation');
    const retained = await tx.query<{ ready_generation: string | null; working_generation: string | null }>(
      invalidate.sql,
      [
        sourceRoute,
        record.source.id,
        effect.receipt.partition,
        job.jobId,
        job.epoch.toString(),
        effect.effectKey,
        record.owner,
      ],
    );
    const basis = retained.rows[0];
    if (!basis) throw unavailable('Canonical Source state is uninstalled; absence cannot prove coverage');
    await recordIdentityReceivingEffect(tx, effect, {
      frontier: {
        after: [
          role,
          record.source.id,
          record.source.incarnation,
          record.source.disposition,
          basis.ready_generation,
          basis.working_generation,
        ],
        segment: 0,
      },
    });
    return { value: null, events: [wake(job)] };
  });
  // Release effect home BEFORE control custody, and Source ACK BEFORE dequeue.
  // Lost results reuse the exact committed receiving locator and frontier.
  await reconcileIdentityReceivingEffect(pool, effect);
  await run(pool, { partition: identityJobPartition(job), deadline }, async (tx) => {
    const custody = await tx.query(
      `SELECT 1 FROM semantic.identity_epoch_receiving_custody
       WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
      [identityJobPartition(job), job.jobId, effect.effectKey],
    );
    if (custody.rowCount !== 1) throw stale('Library receiving effect has no actual control custody');
    const updated = await tx.query(
      `UPDATE library.identity_epoch_participant_work SET custodied=true
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND NOT custodied
         AND receiving_partition=$5 AND receiving_epoch=$6 AND receiving_position=$7
         AND receiving_transaction_id=$8 RETURNING effect_key`,
      [
        identityJobPartition(job),
        job.jobId,
        job.epoch.toString(),
        effect.effectKey,
        effect.receipt.partition,
        effect.receipt.epoch,
        effect.receipt.position.toString(),
        effect.receipt.transactionId,
      ],
    );
    return updated.rowCount ? { value: null, events: [wake(job)] } : noEffect(null);
  });
}

async function retainOwnerHandoff(
  tx: Parameters<typeof registerLibraryOwnerIdentityScope>[0],
  input: Readonly<{
    job: IdentityJobRef;
    effectKey: string;
    owner: string;
    role: LibraryIdentityRole | 'follow';
    reason: 'foreign-owner' | 'frozen-output' | 'public-output' | 'owner-unready';
    locator: unknown;
  }>,
) {
  const ownerRoute = routeOf(input.owner);
  if (ownerRoute === null) throw stale('Owner handoff lost its native owner');
  const partition = identityJobPartition(input.job);
  const locator = json(input.locator);
  await tx.query(
    `INSERT INTO library.identity_epoch_participant_handoff
     (partition_no,job_id,job_epoch,effect_key,owner_id,owner_partition,role,reason,locator)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING`,
    [
      partition,
      input.job.jobId,
      input.job.epoch.toString(),
      input.effectKey,
      input.owner,
      partitionOf(ownerRoute),
      input.role,
      input.reason,
      locator,
    ],
  );
  const saved = await tx.query<{ locator: unknown }>(
    `SELECT locator FROM library.identity_epoch_participant_handoff
     WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND owner_id=$5 AND role=$6 AND reason=$7`,
    [partition, input.job.jobId, input.job.epoch.toString(), input.effectKey, input.owner, input.role, input.reason],
  );
  if (!saved.rows[0] || JSON.stringify(saved.rows[0].locator) !== JSON.stringify(JSON.parse(locator)))
    throw stale('Conflicting Library owner handoff locator');
}

/** Applies one sealed raw role under its retained receiving hold. Candidate changes and the immutable
 * receiving frontier share one local commit; Source/control reconciliation happens only after release.
 */
async function applyLibraryPlanEffect(
  pool: Pool,
  job: IdentityJobRef,
  row: QueuedEffect,
  deadline: number,
  work: NativeCollectionWork,
  run: typeof runCommand,
): Promise<void> {
  if (row.source_route === null || !row.source_id || !row.plan_key || !row.disposition)
    throw stale('Library native effect lost its sealed source-plan locator');
  const effect = effectOf(job, row);
  const observed = await run(pool, { partition: effect.receipt.partition, deadline }, async (tx) =>
    noEffect(await lookupIdentityReceivingEffect(tx, effect)),
  );
  const retained = observed.value;
  if (!retained || retained.source.scope !== 'collection-source')
    throw stale('Library native effect has no retained Collection Source record');
  const sourceIdentity = retained.source.native.identity as NativeSourceIdentity;
  const scopeKey: LibraryScopeEffectsKey = { job, sourceIdentity, scope: retained.source.scope };
  if (
    sourceIdentity.route !== row.source_route ||
    sourceIdentity.collectionId !== row.source_id ||
    libraryIdentityPlanKey(scopeKey) !== row.plan_key ||
    retained.source.disposition !== row.disposition
  )
    throw stale('Library native effect source incarnation changed');
  const operation = await readLibraryIdentityEffectOperationWithWork(
    pool,
    scopeKey,
    { effectKey: effect.effectKey, disposition: row.disposition },
    work,
  );
  if (!operation || typeof operation !== 'object') throw stale('Sealed Library native operation is no longer current');
  const saved = operation as {
    job?: { jobId?: unknown; epoch?: unknown };
    raw?: { driver?: unknown; storedSubjectId?: unknown; factId?: unknown };
    change?: { original?: unknown; previousTerminal?: unknown; terminal?: unknown };
    disposition?: unknown;
    sourceIdentity?: { scope?: unknown; incarnation?: unknown; collectionId?: unknown };
  };
  const raw = saved.raw;
  const change = saved.change;
  const factId = raw?.factId;
  const previousTerminal = change?.previousTerminal;
  const terminal = change?.terminal;
  const role = roleOfDriver(raw?.driver);
  if (
    row.role !== role ||
    saved.job?.jobId !== job.jobId ||
    String(saved.job.epoch) !== job.epoch.toString() ||
    change?.original !== row.original ||
    saved.disposition !== row.disposition ||
    saved.sourceIdentity?.collectionId !== row.source_id ||
    saved.sourceIdentity?.incarnation !== retained.source.incarnation ||
    typeof raw?.storedSubjectId !== 'string' ||
    typeof factId !== 'string' ||
    typeof previousTerminal !== 'string' ||
    typeof terminal !== 'string'
  )
    throw stale('Library effect operation differs from its exact retained selection');

  const applied = await run(pool, { partition: effect.receipt.partition, deadline }, async (tx) => {
    const record = await lookupIdentityReceivingEffect(tx, effect);
    if (!record) throw stale('Library native receiving record disappeared');
    if (record.applied) return noEffect<'custody' | 'handoff'>('custody');
    const sourceRoute = routeOf(record.source.id);
    const ownerRoute = routeOf(record.owner);
    if (
      sourceRoute === null ||
      ownerRoute === null ||
      partitionOf(sourceRoute) !== effect.receipt.partition ||
      partitionOf(ownerRoute) !== effect.receipt.partition ||
      record.source.home !== effect.receipt.partition ||
      record.source.disposition !== row.disposition
    )
      throw unavailable('Library owner effect needs a precise foreign-home handoff');
    await registerLibraryOwnerIdentityScope(tx, effect, role);
    const source = await tx.query(
      `SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND curator_account_id=$3 FOR SHARE`,
      [sourceRoute, record.source.id, record.owner],
    );
    if (source.rowCount !== 1) throw unavailable('Library owner Source disappeared before its admitted effect');
    const retainedBasis = await tx.query<{ ready_generation: string | null; working_generation: string | null }>(
      invalidate.sql,
      [
        sourceRoute,
        record.source.id,
        effect.receipt.partition,
        job.jobId,
        job.epoch.toString(),
        effect.effectKey,
        record.owner,
      ],
    );
    const basis = retainedBasis.rows[0];
    if (!basis) throw unavailable('Canonical Source basis is missing; absence cannot prove role coverage');

    const canonical = row.disposition === 'OLD' ? previousTerminal : terminal;
    const candidate = await applyLibraryIdentityCandidate(tx, {
      partition: effect.receipt.partition,
      owner: record.owner,
      canonical,
      original: row.original,
      source: record.source.id,
      incarnation: record.source.incarnation,
      role,
      fact: factId,
      disposition: row.disposition,
      sourceScope: String(saved.sourceIdentity?.scope ?? ''),
    });
    if (candidate.state !== 'applied') {
      const reason =
        saved.sourceIdentity?.scope === 'public_output'
          ? 'public-output'
          : saved.sourceIdentity?.scope === 'frozen_output'
            ? 'frozen-output'
            : candidate.state === 'unready'
              ? 'owner-unready'
              : 'foreign-owner';
      await retainOwnerHandoff(tx, {
        job,
        effectKey: effect.effectKey,
        owner: record.owner,
        role,
        reason,
        locator: {
          sourceRoute,
          sourceId: record.source.id,
          incarnation: record.source.incarnation,
          planKey: row.plan_key,
          original: row.original,
          canonical,
          driver: role,
          factId,
          disposition: row.disposition,
        },
      });
      await tx.query(
        `UPDATE library.identity_epoch_participant_work SET handed_off=true
         WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4`,
        [identityJobPartition(job), job.jobId, job.epoch.toString(), effect.effectKey],
      );
      return { value: 'handoff' as const, events: [wake(job)] };
    }
    await recordIdentityReceivingEffect(tx, effect, {
      frontier: {
        after: [
          role,
          row.source_id,
          row.plan_key,
          row.original,
          row.disposition,
          basis.ready_generation,
          basis.working_generation,
        ],
        segment: 0,
      },
    });
    return { value: 'custody' as const, events: [wake(job)] };
  });
  if (applied.value === 'handoff') return;
  await reconcileIdentityReceivingEffect(pool, effect);
  await run(pool, { partition: identityJobPartition(job), deadline }, async (tx) => {
    const custody = await tx.query(
      `SELECT 1 FROM semantic.identity_epoch_receiving_custody
       WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
      [identityJobPartition(job), job.jobId, effect.effectKey],
    );
    if (custody.rowCount !== 1) throw stale('Library native effect lacks independent control custody');
    const updated = await tx.query(
      `UPDATE library.identity_epoch_participant_work SET custodied=true
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND NOT custodied
         AND source_route=$5 AND source_id=$6 AND plan_key=$7 AND disposition=$8
         AND receiving_partition=$9 AND receiving_epoch=$10 AND receiving_position=$11
         AND receiving_transaction_id=$12 RETURNING effect_key`,
      [
        identityJobPartition(job),
        job.jobId,
        job.epoch.toString(),
        effect.effectKey,
        row.source_route,
        row.source_id,
        row.plan_key,
        row.disposition,
        effect.receipt.partition,
        effect.receipt.epoch,
        effect.receipt.position.toString(),
        effect.receipt.transactionId,
      ],
    );
    return updated.rowCount ? { value: null, events: [wake(job)] } : noEffect(null);
  });
}

export type LibraryIdentitySourceProgress = Readonly<{
  /** 'closed' means native, scope, follow, canonical and handoff proof are all closed in this frame. */
  state:
    | 'progress'
    | 'source-scopes'
    | 'follow-progress'
    | 'canonical-progress'
    | 'canonical-blocked'
    | 'owner-handoff'
    | 'closed';
  effectKey: string | null;
  work: ReturnType<NativeCollectionWork['receipt']>;
}>;

/** Follow obligations ride on native OLD, NEW and first-apply rows. The planner attaches one obligation per
 * (job, original, disposition), so six drivers never repeat the same follower page six times.
 */
type FollowWorkRow = Readonly<{
  effect_key: string;
  original: string;
  disposition: 'OLD' | 'NEW' | 'first-apply';
  follow_partition: number | null;
  follow_after: string | null;
  operation: { change: { previousTerminal: string; terminal: string } };
}>;

/** Records a follow page's handoff against the follower account. The table's reasons do not name a target home,
 * so a foreign target is retained as a foreign owner with its target partition in the locator.
 */
async function retainFollowHandoff(
  tx: Parameters<typeof applyFollowIdentityPage>[0],
  job: IdentityJobRef,
  effectKey: string,
  handoff: FollowIdentityHandoff,
): Promise<void> {
  const accountRoute = routeOf(handoff.accountId);
  if (accountRoute === null) throw new TypeError('Library follow handoff requires a native account ID');
  await tx.query(
    `INSERT INTO library.identity_epoch_participant_handoff
     (partition_no,job_id,job_epoch,effect_key,owner_id,owner_partition,role,reason,locator)
     VALUES($1,$2,$3,$4,$5,$6,'follow','foreign-owner',$7::jsonb) ON CONFLICT DO NOTHING`,
    [
      identityJobPartition(job),
      job.jobId,
      job.epoch.toString(),
      effectKey,
      handoff.accountId,
      partitionOf(accountRoute),
      JSON.stringify({
        kind: handoff.reason,
        targetPartition: handoff.reason === 'foreign-target' ? handoff.ownerPartition : null,
      }),
    ],
  );
}

/** Advances ONE retained follow obligation by ONE bounded follower page (at most 100 followers).
 * The cursor, completion and handoffs commit with the follow pair/support/total/fence effects in one command,
 * so a crash resumes from the saved cursor and a lost result re-reads the same locator. Returns false when no
 * open obligation remains; an empty queue alone is never reported as completion proof.
 */
export async function advanceLibraryIdentityFollowPage(
  pool: Pool,
  job: IdentityJobRef,
  deadline: number,
  run: typeof runCommand,
): Promise<boolean> {
  const partition = identityJobPartition(job);
  const picked = await run(pool, { partition, deadline }, async (tx) => {
    const result = await tx.query<FollowWorkRow>(
      `SELECT w.effect_key, w.original::text AS original, w.disposition,
              w.follow_partition, w.follow_after::text AS follow_after, e.operation
       FROM library.identity_epoch_participant_work w
       JOIN library.identity_scope_effect e
         ON e.route=w.source_route AND e.collection_id=w.source_id AND e.plan_key=w.plan_key
        AND e.effect_key=w.effect_key AND e.disposition=w.disposition
       WHERE w.partition_no=$1 AND w.job_id=$2 AND w.job_epoch=$3
         AND NOT w.follow_complete AND NOT w.handed_off
       ORDER BY w.effect_key LIMIT 1`,
      [partition, job.jobId, job.epoch.toString()],
    );
    return noEffect(result.rows[0] ?? null);
  });
  const row = picked.value;
  if (!row) return false;
  const cursor: FollowIdentityCursor =
    row.follow_partition === null || row.follow_after === null
      ? null
      : { partition: row.follow_partition, accountId: row.follow_after };
  const { previousTerminal, terminal } = row.operation.change;

  await run(pool, { partition, deadline }, async (tx) => {
    const page = await applyFollowIdentityPage(tx, {
      partition,
      original: row.original,
      previousTerminal,
      terminal,
      disposition: row.disposition,
      after: cursor,
      limit: 100,
    });
    for (const handoff of page.handoffs) await retainFollowHandoff(tx, job, row.effect_key, handoff);
    const saved = await tx.query(
      `UPDATE library.identity_epoch_participant_work
       SET follow_partition=$6::integer, follow_after=$7::uuid, follow_complete=$8
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND effect_key=$4 AND NOT follow_complete
         AND follow_partition IS NOT DISTINCT FROM $5::integer AND follow_after IS NOT DISTINCT FROM $9::uuid
       RETURNING effect_key`,
      [
        partition,
        job.jobId,
        job.epoch.toString(),
        row.effect_key,
        row.follow_partition,
        page.after?.partition ?? null,
        page.after?.accountId ?? null,
        page.exhausted,
        row.follow_after,
      ],
    );
    if (saved.rowCount !== 1) throw stale('Library follow obligation cursor changed during its page');
    return { value: null, events: [] };
  });
  return true;
}

/** Per-call ceiling for one canonical store call. The store opens a fresh ledger per call, so each call is
 * reserved from the prepaid frame at this ceiling before dispatch and settled from the usage it returns.
 */
function canonicalCallCeiling(): Readonly<{
  allowance: ReturnType<typeof canonicalSourceCallAllowance>;
  dimensions: WorkDimensions;
}> {
  const allowance = canonicalSourceCallAllowance(CANONICAL_SOURCE_REPAIR_STEP());
  return Object.freeze({
    allowance,
    dimensions: Object.freeze({
      candidateKeys: allowance.rawKeys,
      nativeRows: allowance.nativeRows,
      identityMetadataRows: allowance.identityMetadataRows,
      emptySeeks: allowance.emptySeeks,
      nativePoints: allowance.nativePoints,
      witnessKeys: 0,
      statements: allowance.statements,
      bytes: allowance.bytes,
    }),
  });
}

function canonicalUsage(used: CanonicalWork): WorkDimensions {
  return Object.freeze({
    candidateKeys:
      used.candidateKeys + used.aliasKeys + used.duplicateKeys + used.lookaheadKeys + used.internalDriverKeys,
    nativeRows: used.nativeRows,
    identityMetadataRows: used.identityMetadataRows,
    emptySeeks: used.emptySeeks,
    nativePoints: used.nativePoints,
    witnessKeys: 0,
    statements: used.statements,
    bytes: used.bytes,
  });
}

/** One canonical store call, composed under the frame at its declared ceiling. The receipt settles the prepaid
 * partition with the store's actual usage; no call runs outside the frame's remaining balance.
 */
async function chargedCanonicalCall<T extends { readonly work: CanonicalWork }>(
  frame: NativeCollectionWork,
  call: (allowance: CanonicalAllowance) => Promise<T>,
): Promise<T> {
  const ceiling = canonicalCallCeiling();
  const settled = await frame.compose(async (allowance) => {
    const result = await call({ ...ceiling.allowance, reservationId: allowance.reservationId });
    const receipt: WorkReceipt = { reservationId: allowance.reservationId, used: canonicalUsage(result.work) };
    return { result, work: receipt };
  }, ceiling.dimensions);
  return settled.result;
}

type CanonicalStageState = 'done' | 'progress' | 'blocked';

/** One bounded canonical unit for the job's collections, in saved scope order. Each collection whose head already
 * publishes the observed admitted basis is skipped; the first other collection gets one begin, one page or one
 * publish. A basis that is not admitted, or a store not-ready result, is 'blocked' and never completion.
 */
async function advanceLibraryIdentityCanonicalStage(
  pool: Pool,
  job: IdentityJobRef,
  source: LiveLibrarySource,
): Promise<CanonicalStageState> {
  const partition = identityJobPartition(job);
  const deadline = source.context.deadline;
  const collections = await source.run(pool, { partition, deadline }, async (tx) =>
    noEffect(
      (
        await tx.query<{ source_route: number; source_id: string }>(
          `SELECT DISTINCT source_route,source_id::text AS source_id
           FROM library.identity_epoch_participant_scope
           WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3
           ORDER BY source_route,source_id::text LIMIT 100`,
          [partition, job.jobId, job.epoch.toString()],
        )
      ).rows,
    ),
  );
  let blocked = false;
  for (const collection of collections.value) {
    const ref = { route: collection.source_route, collectionId: collection.source_id, deadline };
    const observed = await chargedCanonicalCall(source.work, (allowance) =>
      observeCanonicalSource(pool, { ...ref, allowance }),
    );
    if (observed.state !== 'admitted') {
      blocked = true;
      continue;
    }
    const head = await chargedCanonicalCall(source.work, (allowance) =>
      readCanonicalSourceState(pool, { ...ref, allowance }),
    );
    if (head.state === 'ready' && head.basis.digest === observed.basis.digest) continue;
    const begun = await chargedCanonicalCall(source.work, (allowance) =>
      beginCanonicalSourceRepair(pool, { ...ref, allowance, basis: observed.basis }),
    );
    if (begun.state !== 'working') {
      blocked = true;
      continue;
    }
    const stepped = await chargedCanonicalCall(source.work, (allowance) =>
      repairCanonicalSourceStep(pool, { ...ref, allowance, basis: observed.basis, repair: begun.repair }),
    );
    if (stepped.state === 'working') return 'progress';
    if (stepped.state !== 'complete') {
      blocked = true;
      continue;
    }
    const published = await chargedCanonicalCall(source.work, (allowance) =>
      publishCanonicalSourceRepair(pool, { ...ref, allowance, basis: observed.basis, repair: stepped.repair }),
    );
    if (published.state !== 'published') blocked = true;
    return published.state === 'published' ? 'progress' : 'blocked';
  }
  return blocked ? 'blocked' : 'done';
}

/** Exact callable for Semantic's existing Source maintenance frame. It drains at most one
 * retained Library receiving effect per call and reports unfinished Source/follow proof instead
 * of manufacturing the fixed participant receipt. The ordinary coordinator ABI remains stable.
 */
export async function stepLibraryIdentityEpochWithSource(
  pool: Pool,
  job: IdentityJobRef,
  source: LiveLibrarySource,
): Promise<LibraryIdentitySourceProgress> {
  const { context, work } = source;
  if (routeOf(job.jobId) === null || job.epoch <= 0n) throw new TypeError('Invalid native identity job');
  const deadline = Math.min(context.deadline, workStepDeadline());
  const saved = await withReadTransaction(pool, (tx) => identityEpochStore().readJob(tx, job));
  if (!saved || saved.state !== 'pending') throw stale('Library native receiver requires the pending admitted job');
  const pending = await source.run(pool, { partition: identityJobPartition(job), deadline }, async (tx) => {
    const result = await tx.query<QueuedEffect>(
      `SELECT original,effect_key,role,receiving_partition,receiving_epoch,
              receiving_position::text,receiving_transaction_id::text,source_route,source_id::text,
              plan_key,disposition,follow_partition,follow_after::text,follow_complete,handed_off
       FROM library.identity_epoch_participant_work
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT custodied AND NOT handed_off
       ORDER BY effect_key LIMIT 1`,
      [identityJobPartition(job), job.jobId, job.epoch.toString()],
    );
    return noEffect(result.rows[0] ?? null);
  });
  if (pending.value) {
    const row = pending.value;
    if (row.source_route === null) await applySourceInvalidation(pool, job, row, deadline, source.run);
    else await applyLibraryPlanEffect(pool, job, row, deadline, work, source.run);
    return { state: 'progress', effectKey: row.effect_key, work: work.receipt() };
  }
  const status = await source.run(pool, { partition: identityJobPartition(job), deadline }, async (tx) => {
    const [scopes, handoffs] = await Promise.all([
      tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM library.identity_epoch_participant_scope
         WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT exhausted`,
        [identityJobPartition(job), job.jobId, job.epoch.toString()],
      ),
      tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM library.identity_epoch_participant_handoff
         WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT resolved`,
        [identityJobPartition(job), job.jobId, job.epoch.toString()],
      ),
    ]);
    return noEffect({ scopes: BigInt(scopes.rows[0]!.count), handoffs: BigInt(handoffs.rows[0]!.count) });
  });
  if (status.value.scopes) return { state: 'source-scopes', effectKey: null, work: work.receipt() };
  // Follow pages run before canonical and handoff reporting: a blocked or foreign item never stops supported work.
  if (await advanceLibraryIdentityFollowPage(pool, job, deadline, source.run))
    return { state: 'follow-progress', effectKey: null, work: work.receipt() };
  const canonical = await advanceLibraryIdentityCanonicalStage(pool, job, source);
  if (canonical === 'progress') return { state: 'canonical-progress', effectKey: null, work: work.receipt() };
  if (canonical === 'blocked') return { state: 'canonical-blocked', effectKey: null, work: work.receipt() };
  return {
    state: status.value.handoffs ? 'owner-handoff' : 'closed',
    effectKey: null,
    work: work.receipt(),
  };
}

const sixDriverPending =
  'ALL-Library identity remains pending: complete six-driver Source rebuild/OLD/NEW manifests, ' +
  'owner candidate/winner and first-apply coverage, follow pair/support/total/outgoing/negative/fences, ' +
  'cross-home owner custody and public/frozen output authority are not bound';

/** Fixed ALL-Library entry point. Empty-home coverage seals after a committed 16-route original scan
 * with no building plans and no members of this job's originals. Homes with collections still require
 * Source manifests through the live frame; empty registration is not an ACK.
 */
export const stepLibraryIdentityEpoch: IdentityEpochStep = (pool, job) =>
  bounded(async (deadline) => {
    if (routeOf(job.jobId) === null || typeof job.epoch !== 'bigint' || job.epoch <= 0n)
      throw new TypeError('Library identity work requires a native job ID and positive bigint epoch');
    const saved = await withReadTransaction(pool, (tx) => identityEpochStore().readJob(tx, job));
    if (!saved || (saved.state !== 'pending' && saved.state !== 'published'))
      throw stale('Library identity work requires an admitted native job');
    const previous = saved.participants[step];
    if (previous) {
      const receipt = previous.receipt;
      if (
        previous.state !== 'complete' ||
        previous.job.jobId !== job.jobId ||
        previous.job.epoch !== job.epoch ||
        receipt.job.jobId !== job.jobId ||
        receipt.job.epoch !== job.epoch ||
        receipt.step !== step ||
        receipt.version !== 1
      )
        throw new IdentityEpochStoreError('identity_step_receipt_invalid', 'Library identity receipt scope is invalid');
      return identityEpochStore().reconcileStepReceipt(pool, receipt);
    }
    if (saved.state !== 'pending') throw stale('Published identity job is missing its ALL-Library receipt');
    const home = identityJobPartition(job);
    const pending = await runCommand(pool, { partition: home, deadline }, async (tx) => {
      const result = await tx.query<QueuedEffect>(
        `SELECT original,effect_key,role,receiving_partition,receiving_epoch,
              receiving_position::text,receiving_transaction_id::text,source_route,source_id::text,
              plan_key,disposition,follow_partition,follow_after::text,follow_complete,handed_off
       FROM library.identity_epoch_participant_work
       WHERE partition_no=$1 AND job_id=$2 AND job_epoch=$3 AND NOT custodied AND NOT handed_off
       ORDER BY effect_key LIMIT 1`,
        [home, job.jobId, job.epoch.toString()],
      );
      return noEffect(result.rows[0] ?? null);
    });
    if (pending.value) {
      if (pending.value.source_route !== null)
        throw unavailable("Native six-driver Library effects require Semantic's live prepaid Source receiver");
      await applySourceInvalidation(pool, job, pending.value, deadline, runCommand);
    }
    const funded = activeIdentitySourceConsumerMaintenance(pool);
    if (funded) {
      const source = resolveLiveLibrarySource({ libraryWork: identitySourceConsumerLibraryWork }, pool, funded);
      const advanced = await stepLibraryIdentityEpochWithSource(pool, job, source);
      if (advanced.state !== 'closed') throw unavailable(`${sixDriverPending} (${advanced.state})`);
    }
    const coverage = await withReadTransaction(
      pool,
      async (tx) =>
        (await tx.query<{ building: boolean; affected: boolean }>(scanSql.sql, [home, job.jobId, job.epoch.toString()]))
          .rows[0],
      deadline,
    );
    if (!coverage || coverage.building || coverage.affected) throw unavailable(sixDriverPending);
    const scope = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await tx.query<{ scope_digest: string }>(
            `SELECT scope_digest FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2 AND epoch=$3`,
            [home, job.jobId, job.epoch.toString()],
          )
        ).rows[0]?.scope_digest,
      deadline,
    );
    if (!scope) throw unavailable('ALL-Library completion lost the admitted job scope');
    const roles = await identityErasureRoles(pool, job.jobId);
    const frontier = { after: ['directory', 16], segment: 0 };
    const work = { rows: 16, points: 16, statements: 3, bytes: 4096, engineRequests: 0 };
    const sealed = await runCommand(pool, { partition: home, deadline }, async (tx) => {
      bindSemanticProducerRoles(tx, roles);
      recordIdentityEpochNativeCommit(tx, step);
      registerCommandCallback(tx, async (id) => {
        const inserted = await tx.query(completeSql.sql, [
          currentCommand(tx).partition,
          id,
          job.jobId,
          job.epoch.toString(),
          scope,
          json(frontier),
          json(work),
        ]);
        if (inserted.rowCount !== 1) throw unavailable('ALL-Library completion lost its native step');
      });
      return { value: null, events: [wake(job)] };
    });
    return {
      job,
      frontier,
      state: 'complete' as const,
      receipt: {
        job,
        step,
        version: 1 as const,
        native: {
          partition: sealed.partition,
          transactionId: sealed.transactionId,
          epoch: sealed.epoch,
          position: sealed.position,
        },
      },
      work,
    };
  });
