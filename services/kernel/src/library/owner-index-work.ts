import { isDeepStrictEqual } from 'node:util';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { LifecycleDeniedError } from '../access/contract/errors.ts';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { CANONICAL_SOURCE_WORKFLOW } from './canonical-source-store.ts';
import { workStepDeadline } from './collection-command-work.ts';
import { readOwnerIndexWorkFrontier, stepOwnerIndex, type OwnerIndexWorkFrontier } from './owner-index.ts';
import {
  applyOwnerPinMeaning,
  loadOwnerPinMeaning,
  nextOwnerPin,
  type OwnerPinMeaning,
} from './owner-index-metadata.ts';

export const OWNER_INDEX_WORKFLOW = 'library.ownerIndex';
export const OWNER_INDEX_SWEEP = 'library.ownerIndexSweep';
export const OWNER_INDEX_SCHEDULE = 'library.ownerIndex.every-10-minutes';
export type OwnerPinCapture = Readonly<{ workflowId: string; accountId: string; meaning: OwnerPinMeaning }>;
const pinCaptures = new WeakMap<WorkContext['pool'], (capture: OwnerPinCapture) => Promise<void>>();
/** Private executor observation: the owner checkout and immutable release checkout have both ended. */
export function observeOwnerPinCapture(pool: WorkContext['pool'], capture: (value: OwnerPinCapture) => Promise<void>) {
  if (pinCaptures.has(pool)) throw new Error('Owner pin capture observer already installed');
  pinCaptures.set(pool, capture);
  return () => pinCaptures.delete(pool);
}
type Locator = { accounts: [string]; frontier: OwnerIndexWorkFrontier | null; metadata: boolean };
type Sweep = { root: string; sequence: number; partition: number; route: number | null; account: string | null };

function owner(input: Locator): string {
  if (
    !input ||
    Object.keys(input).sort().join(',') !== 'accounts,frontier,metadata' ||
    !Array.isArray(input.accounts) ||
    input.accounts.length !== 1 ||
    typeof input.metadata !== 'boolean'
  )
    throw new TypeError('Invalid owner index locator');
  const account = input.accounts[0];
  if (routeOf(account) === null) throw new TypeError('Invalid owner index account');
  if (
    input.frontier &&
    (!['entry', 'session', 'copy', 'label', 'personal', 'label-repair', 'ready'].includes(input.frontier.phase) ||
      (input.frontier.subject !== null && routeOf(input.frontier.subject) === null) ||
      (input.frontier.fact !== null && routeOf(input.frontier.fact) === null))
  )
    throw new TypeError('Invalid frontier');
  return account;
}
function transaction<T>(context: WorkContext, accountId: string, body: (tx: OperationalTransaction) => Promise<T>) {
  return runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(routeOf(accountId)!),
      kind: OWNER_INDEX_WORKFLOW,
      accounts: [accountId],
      workClient: context.client,
      deadline: workStepDeadline(),
      ...(context.clock === undefined ? {} : { clock: context.clock }),
    },
    body,
  );
}
async function enqueue(tx: OperationalTransaction, input: Locator) {
  const account = owner(input),
    f = input.frontier;
  // A parent can be deleted and restored repeatedly at the same child frontier. Each committed
  // repair page owns its intent. The row under the writer lock remains the replay check.
  let suffix = '';
  if (f?.phase === 'label-repair') {
    const { rows } = await tx.query<{ generation: string }>(
      'SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2',
      [routeOf(account), account],
    );
    suffix = `:${rows[0]!.generation}`;
  }
  await enqueueIntent(tx, {
    queue: 'maintenance',
    workflowName: OWNER_INDEX_WORKFLOW,
    workflowId: `${OWNER_INDEX_WORKFLOW}:${account}:${input.metadata ? 'metadata' : 'facts'}:${f?.phase ?? 'start'}:${f?.subject ?? '-'}:${f?.fact ?? '-'}${suffix}`,
    input,
  });
}

/** The same owner transaction releases the existing Source worker once its population and pins are ready. */
async function prepareLogicalEverything(tx: OperationalTransaction, accountId: string) {
  const {
    rows: [source],
  } = await tx.query<{ collection_id: string; generation: string }>(
    `SELECT l.collection_id,l.generation::text FROM library.logical_everything_source l
     WHERE (l.route,l.account_id)=($1,$2) AND EXISTS (SELECT 1 FROM library.owner_member_support m
       WHERE (m.route,m.account_id)=(l.route,l.account_id))
     AND NOT EXISTS (SELECT 1 FROM library.owner_index_pin p
       WHERE (p.route,p.account_id)=(l.route,l.account_id) AND NOT p.meaning_ready)
     AND NOT EXISTS (SELECT 1 FROM library.builtin_collection_reference r
       WHERE (r.route,r.collection_id)=(l.route,l.collection_id))`,
    [routeOf(accountId), accountId],
  );
  if (!source) return;
  await enqueueIntent(tx, {
    queue: 'maintenance',
    workflowName: CANONICAL_SOURCE_WORKFLOW,
    workflowId: `${CANONICAL_SOURCE_WORKFLOW}:${source.collection_id}:owner-ready:${source.generation}`,
    input: { accounts: [accountId], collectionId: source.collection_id },
  });
}

/** Each committed frontier owns its successor intent. Obsolete DBOS step replay has no source effects. */
async function page(context: WorkContext, input: Locator) {
  const accountId = owner(input);
  if (input.metadata) {
    const pin = await withConnection(context.pool, (client) => nextOwnerPin(client, accountId));
    if (pin === undefined) return;
    // The one owner home is released before Global/Definitions checkout.
    const meaning = await loadOwnerPinMeaning(context.pool, accountId, pin);
    await pinCaptures.get(context.pool)?.({ workflowId: DBOS.workflowID!, accountId, meaning });
    await transaction(context, accountId, async (tx) => {
      if (await applyOwnerPinMeaning(tx, accountId, meaning)) await prepareLogicalEverything(tx, accountId);
    });
    // Metadata is swept in bounded pages. No user read schedules or pretends metadata completion.
    return;
  }
  await transaction(context, accountId, async (tx) => {
    const current = await readOwnerIndexWorkFrontier(tx, accountId);
    if (!isDeepStrictEqual(current, input.frontier)) return;
    const next = await stepOwnerIndex(tx, accountId);
    if (!isDeepStrictEqual(next, current)) {
      await enqueue(tx, { accounts: [accountId], frontier: next, metadata: false });
      if (next.phase === 'ready') await prepareLogicalEverything(tx, accountId);
    }
  });
}

/** Default Library composition, existing maintenance queue and schedules; no new scheduler or identity participant. */
export async function registerOwnerIndexWork(context: WorkContext) {
  async function apply(input: Locator) {
    try {
      await page(context, input);
    } catch (error) {
      if (!(error instanceof LifecycleDeniedError)) throw error;
    }
  }
  const step = DBOS.registerStep(apply, { name: 'library.ownerIndexPage', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow((input: Locator) => step(input), { name: OWNER_INDEX_WORKFLOW });
  const sweepPage = DBOS.registerStep(
    async (input: Sweep) => {
      const { rows } = await withConnection(context.pool, (client) =>
        client.query<{ route: number; account: string }>(
          `SELECT route,account_id AS account FROM library.fact_source_head
       WHERE route BETWEEN $1 AND $2 AND ($3::integer IS NULL OR (route,account_id)>($3,$4::uuid))
       ORDER BY route,account_id LIMIT 1`,
          [input.partition * 16, input.partition * 16 + 15, input.route, input.account],
        ),
      );
      const row = rows[0];
      if (!row) return { ...input, partition: input.partition + 1, route: null, account: null };
      const frontier = await withConnection(context.pool, (client) => readOwnerIndexWorkFrontier(client, row.account));
      // This is already a registered step; call the transaction body, never nest DBOS steps.
      await apply({ accounts: [row.account], frontier, metadata: false });
      await apply({ accounts: [row.account], frontier: null, metadata: true });
      return { ...input, route: row.route, account: row.account };
    },
    { name: 'library.ownerIndexSweepPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(
    async (input: Sweep) => {
      await context.client.enqueue(
        {
          workflowName: 'library.ownerIndexSweepSegment',
          queueName: 'maintenance',
          workflowID: `${OWNER_INDEX_SWEEP}:${input.root}:${input.sequence}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'library.ownerIndexSweepContinue', ...COMMAND_STEP_RETRIES },
  );
  async function segment(input: Sweep) {
    let next = input;
    for (let n = 0; n < 100 && next.partition < 4096; n++) next = await sweepPage(next);
    if (next.partition < 4096) await continuation({ ...next, sequence: next.sequence + 1 });
  }
  DBOS.registerWorkflow(segment, { name: 'library.ownerIndexSweepSegment' });
  DBOS.registerWorkflow(
    () => segment({ root: DBOS.workflowID!, sequence: 0, partition: 0, route: null, account: null }),
    { name: OWNER_INDEX_SWEEP },
  );
  await context.client.applySchedules([
    {
      scheduleName: OWNER_INDEX_SCHEDULE,
      workflowName: OWNER_INDEX_SWEEP,
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
