import { isDeepStrictEqual } from 'node:util';
import { enrollCommerceCopyIntents } from '../access/live-copy-erasure.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { fenceOperationalAccount } from '../access/account-share.ts';
import { CommandUnavailableError } from '../request/unavailable.ts';
import {
  runOperationalTransaction,
  enqueueIntent,
  hasLiveOperationalTransaction,
  currentOperationalResources,
  type OperationalTransaction,
} from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import type { CreatorSaleView } from './creator-sales.ts';
import { recordedMoneyUnit } from './money.ts';
import sourceRead from './creator-sales-source.sql';
import upsert from './creator-sales-upsert.sql';
import { readCreatorSaleReceiving, enableCreatorSaleReceiving } from './creator-sales-receiving.ts';
import {
  LiveCopyPendingError,
  stageLiveCopy,
  observeLiveCopyDomain,
  liveCopyEventRoles,
  readLiveCopy,
  liveCopyLocator,
  admitLiveCopyRoles,
  observeLiveCopyAdmissions,
  openLiveCopyGate,
  finishLiveCopyGate,
  cancelLiveCopy,
  consumeLiveCopy,
  readLiveCopyResult,
  type LiveCopyLocator,
} from '../access/live-copy.ts';

const TYPES = ['com.rezics.commerce.order.created.v1', 'com.rezics.commerce.order.updated.v1'];
export const CREATOR_SALES_WORKFLOW = 'commerce.creatorSales';
export const CREATOR_SALES_PAGE = 100;
const ZERO = '00000000-0000-0000-0000-000000000000';
type Client = Pick<PoolClient, 'query'>;
type EventRow = {
  event_seq: number;
  id: string;
  type: string;
  subject: string | null;
  data: unknown;
  epoch: string;
  payload_state: string;
};
type Locator = { route: number; orderId: string };
type Sweep = { accounts: []; partition: number; root: string; segment: number };
type NativeSource = Readonly<{
  view: CreatorSaleView;
  creatorAccountId: string;
  revision: number;
  transactionId: string;
  epoch: number;
  position: string;
  eventSeq: number;
  eventId: string;
  generation: string;
}>;
// A plain copied event/source object is never accepted as a fresh native order observation.
const observations = new WeakSet<NativeSource>();

class CreatorSaleSourceUnavailableError extends Error {
  constructor(
    readonly generation: string,
    readonly gap:
      | 'commerce-creator-sale-transaction-provenance-unavailable'
      | 'commerce-creator-sale-revision-event-provenance-unavailable',
  ) {
    super(gap);
    this.name = 'CreatorSaleSourceUnavailableError';
  }
}

function eventOrder(row: EventRow): { orderId: string; revision: number } | null {
  if (!TYPES.includes(row.type) || row.payload_state !== 'present' || !row.data || typeof row.data !== 'object')
    return null;
  const data = row.data as { orderId?: unknown; revision?: unknown };
  const revision = row.type === TYPES[0] ? 1 : data.revision;
  if (
    typeof data.orderId !== 'string' ||
    routeOf(data.orderId) === null ||
    row.subject !== data.orderId ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    return null;
  return { orderId: data.orderId, revision };
}

/** Ordinary actor writes retain their actual principal and original event roles.
 * Internal checkout receipts name the genuine business owner, not a service actor.
 * Neither path reconstructs a human/delegate from requested_by attribution text. */
async function creatorSaleEventRoles(
  client: Client,
  input: { route: number; orderId: string; partition: number; position: string; eventSeq: number },
  extra: Parameters<typeof liveCopyEventRoles>[2],
) {
  const basis = (
    await client.query<{ principal_kind: string; principal_id: string; delegated: boolean }>(
      `SELECT principal_kind,principal_id,requested_by IS NOT NULL AS delegated FROM editorial.write_basis WHERE partition_no=$1 AND position=$2`,
      [input.partition, input.position],
    )
  ).rows[0];
  if (basis)
    return liveCopyEventRoles(
      client,
      { ...input, requireInventory: basis.delegated },
      basis.principal_kind === 'account' ? [...extra, { accountId: basis.principal_id, roles: 1 }] : extra,
    );
  const receipt = (
    await client.query(
      `SELECT 1 FROM core.receipt r JOIN commerce.purchase_order o
    ON o.route=$3 AND o.order_id=$4 AND o.buyer_account_id=r.principal_id
    WHERE r.partition_no=$1 AND r.position=$2 AND r.principal_kind='account'
      AND r.command_kind IN ('commerce.checkout.record','commerce.checkout.refresh','commerce.checkout.apply')`,
      [input.partition, input.position, input.route, input.orderId],
    )
  ).rows[0];
  if (!receipt) throw new LiveCopyPendingError('Commerce original event identity basis unavailable');
  return liveCopyEventRoles(client, input, extra);
}

/** Actual effects admission transaction; copied wake-up JSON supplies only a locator. */
export async function admitCreatorSale(client: Client, event: CloudEvent): Promise<void> {
  const anchor = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(event.source);
  if (!anchor || !/^\d{19}$/.test(event.sequence)) throw new Error('Creator sale event source unavailable');
  const partition = Number(anchor[1]),
    epoch = Number(anchor[2]),
    position = BigInt(event.sequence).toString();
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096 || !Number.isSafeInteger(epoch) || epoch < 1)
    throw new Error('Creator sale event source unavailable');
  const events = await client.query<EventRow>(
    `SELECT event_seq,id,type,subject,
       CASE WHEN id=$3::uuid AND octet_length(data::text)<=1024 THEN data ELSE NULL END AS data,
       epoch::text,payload_state FROM core.outbox
     WHERE partition_no=$1 AND position=$2 ORDER BY event_seq LIMIT 100`,
    [partition, position, event.id],
  );
  const row = events.rows.find(
    (entry) => entry.id === event.id && Number(entry.epoch) === epoch && entry.type === event.type,
  );
  const order = row && eventOrder(row);
  if (!row || !order || partitionOf(routeOf(order.orderId)!) !== partition)
    throw new Error('Creator sale exact committed event proof unavailable');
  const route = routeOf(order.orderId)!;
  const nativeOrder = (
    await client.query<{ buyer_account_id: string; creator_account_id: string; state: string; authn_fenced: boolean }>(
      `SELECT o.buyer_account_id,o.creator_account_id,a.state,a.authn_fenced FROM commerce.purchase_order o
     JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
     WHERE o.route=$1 AND o.order_id=$2 FOR UPDATE OF a FOR SHARE OF o`,
      [route, order.orderId],
    )
  ).rows[0];
  if (!nativeOrder) throw new Error('Creator sale original business role basis unavailable');
  if (nativeOrder.state === 'deleted') {
    // Exact non-personal slot tombstone: never recreate work/order locators after native T.
    await client.query(
      `INSERT INTO commerce.creator_sale_receipt(partition_no,position,event_seq,epoch,event_id,route,order_id,source_revision,state)
      VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,'minimized') ON CONFLICT DO NOTHING`,
      [partition, position, row.event_seq, epoch, row.id, route],
    );
    const previous = (
      await client.query<{ event_id: string; epoch: string; route: number }>(
        `SELECT event_id,epoch::text,route FROM commerce.creator_sale_receipt
       WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
        [partition, position, row.event_seq],
      )
    ).rows[0];
    if (!previous || previous.event_id !== row.id || previous.epoch !== String(epoch) || previous.route !== route)
      throw new Error('Creator sale event receipt provenance conflict');
    return;
  }
  if (nativeOrder.state !== 'active' || nativeOrder.authn_fenced)
    throw new CommandUnavailableError('fenced', partition);
  const receipt = await client.query(
    `INSERT INTO commerce.creator_sale_receipt(partition_no,position,event_seq,epoch,event_id,route,order_id,source_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id`,
    [partition, position, row.event_seq, epoch, row.id, route, order.orderId, order.revision],
  );
  if (!receipt.rows.length) {
    const previous = (
      await client.query(
        `SELECT event_id,epoch::text,route,order_id,source_revision,state FROM commerce.creator_sale_receipt
       WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
        [partition, position, row.event_seq],
      )
    ).rows[0];
    if (
      previous?.state === 'minimized' &&
      previous.event_id === row.id &&
      previous.epoch === String(epoch) &&
      previous.route === route
    )
      return;
    if (
      !previous ||
      previous.event_id !== row.id ||
      previous.epoch !== String(epoch) ||
      previous.route !== route ||
      previous.order_id !== order.orderId ||
      previous.source_revision !== order.revision
    )
      throw new Error('Creator sale event receipt provenance conflict');
    return;
  }
  const roles = await creatorSaleEventRoles(
    client,
    { route, orderId: order.orderId, partition, position, eventSeq: row.event_seq },
    [
      { accountId: nativeOrder.buyer_account_id, roles: 1024 },
      { accountId: nativeOrder.creator_account_id, roles: 2048 },
    ],
  );
  await enrollCommerceCopyIntents(
    client,
    { route, orderId: order.orderId, partition, position, eventSeq: row.event_seq },
    roles,
  );
  await client.query(
    `INSERT INTO commerce.creator_sale_work(route,order_id) VALUES($1,$2)
       ON CONFLICT(route,order_id) DO UPDATE SET generation=commerce.creator_sale_work.generation+1,
         state='pending',gap=NULL,next_run=now()`,
    [route, order.orderId],
  );
}

/** Fresh exact native financial truth. The buyer snapshot is released before any creator write. */
export async function readCreatorSaleSource(pool: Pool, locator: Locator): Promise<NativeSource | null> {
  if (routeOf(locator.orderId) !== locator.route) throw new TypeError('Invalid creator sale source locator');
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await client.query("SET LOCAL statement_timeout='2000ms'");
      const source = await observeCreatorSaleSource(client, locator);
      await client.query('COMMIT');
      return source;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function observeCreatorSaleSource(client: Client, locator: Locator): Promise<NativeSource | null> {
  const home = partitionOf(locator.route),
    partition = await readPartition(client, home);
  if (!partition || partition.writeState !== 'active') throw new CommandUnavailableError('fenced', home);
  const rows = await sourceRead.run(client, { route: locator.route, order_id: locator.orderId });
  const row = rows[0];
  if (!row || row.buyerState === 'deleted') {
    return null;
  }
  const basis = await client.query<{ epoch: string; position: string }>(
    `SELECT COALESCE(b.epoch,r.epoch)::text AS epoch,COALESCE(b.position,r.position)::text AS position
         FROM commerce.purchase_order o LEFT JOIN editorial.write_basis b
           ON b.partition_no=$1 AND b.transaction_id=o.transaction_id
         LEFT JOIN core.receipt r ON r.partition_no=$1 AND r.transaction_id=o.transaction_id
           AND r.principal_kind='account' AND r.principal_id=o.buyer_account_id
           AND r.command_kind IN ('commerce.checkout.record','commerce.checkout.refresh','commerce.checkout.apply')
         WHERE o.route=$3 AND o.order_id=$4 AND o.transaction_id=$2
           AND (b.transaction_id IS NOT NULL OR r.transaction_id IS NOT NULL)
           AND (b.transaction_id IS NULL OR r.transaction_id IS NULL OR (b.epoch,b.position)=(r.epoch,r.position))`,
    [home, row.transactionId, locator.route, locator.orderId],
  );
  const provenance = basis.rows[0];
  if (!provenance || Number(provenance.epoch) > partition.epoch)
    throw new CreatorSaleSourceUnavailableError(
      row.generation,
      'commerce-creator-sale-transaction-provenance-unavailable',
    );
  const events = await client.query<EventRow>(
    `SELECT event_seq,id,type,subject,
           CASE WHEN subject=$3 AND octet_length(data::text)<=1024 THEN data ELSE NULL END AS data,
           epoch::text,payload_state FROM core.outbox
         WHERE partition_no=$1 AND position=$2 ORDER BY event_seq LIMIT 100`,
    [home, provenance.position, row.orderId],
  );
  const event = events.rows.find((entry) => {
    const order = eventOrder(entry);
    return (
      order !== null &&
      order.orderId === row.orderId &&
      order.revision === row.revision &&
      entry.epoch === provenance.epoch
    );
  });
  if (!event)
    throw new CreatorSaleSourceUnavailableError(
      row.generation,
      'commerce-creator-sale-revision-event-provenance-unavailable',
    );
  const amount = Number(row.unitAmountMinor);
  if (!Number.isSafeInteger(amount) || routeOf(row.creatorAccountId) === null)
    throw new Error('Creator sale source terms unavailable');
  const unit = row.moneyUnit === null ? null : recordedMoneyUnit(JSON.parse(row.moneyUnit));
  const source: NativeSource = Object.freeze({
    view: Object.freeze({
      orderId: row.orderId,
      offerId: row.offerId,
      title: row.title,
      targetSubjectId: row.targetSubjectId,
      currency: row.currency,
      unitAmountMinor: amount,
      moneyUnit: unit === null ? null : Object.freeze(unit),
      taxBehavior: row.taxBehavior as 'exclusive' | null,
      settlement: row.settlement as CreatorSaleView['settlement'],
      createdAt: new Date(row.createdAt).toISOString(),
    }),
    creatorAccountId: row.creatorAccountId,
    revision: row.revision,
    transactionId: row.transactionId,
    epoch: Number(provenance.epoch),
    position: provenance.position,
    eventSeq: event.event_seq,
    eventId: event.id,
    generation: row.generation,
  });
  observations.add(source);
  return source;
}

/** Local native DAO, for the real receiving producer to invoke in its fenced operational body.
 * This function does not confer cross-home receiving authority. The default factory invokes it
 * only inside the native live-copy gate, after observing every original-role hold.
 */
export async function writeCreatorSaleProjection(tx: OperationalTransaction, source: NativeSource): Promise<void> {
  if (!hasLiveOperationalTransaction(tx) || !observations.has(source))
    throw new TypeError('Fresh native creator sale source required');
  const route = routeOf(source.creatorAccountId)!;
  if (currentOperationalResources(tx).partition !== partitionOf(route))
    throw new TypeError('Creator sale projection requires its native creator home');
  await fenceOperationalAccount(tx, source.creatorAccountId);
  const row = source.view;
  const existing = await tx.query<{ source_revision: number; source_transaction_id: string }>(
    `SELECT source_revision,source_transaction_id FROM commerce.creator_sale
     WHERE route=$1 AND creator_account_id=$2 AND order_id=$3 FOR UPDATE`,
    [route, source.creatorAccountId, row.orderId],
  );
  const previous = existing.rows[0];
  if (previous && previous.source_revision >= source.revision) {
    if (previous.source_revision === source.revision && previous.source_transaction_id !== source.transactionId)
      throw new Error('Creator sale source revision conflict');
    return;
  }
  const changed = await upsert.run(tx, {
    route,
    creator_account_id: source.creatorAccountId,
    order_id: row.orderId,
    offer_id: row.offerId,
    target_subject_id: row.targetSubjectId,
    title: row.title,
    currency: row.currency,
    unit_amount_minor: row.unitAmountMinor,
    money_unit: row.moneyUnit === null ? '' : JSON.stringify(row.moneyUnit),
    tax_behavior: row.taxBehavior ?? '',
    settlement: row.settlement,
    created_at: row.createdAt,
    source_revision: source.revision,
    source_transaction_id: source.transactionId,
    source_epoch: source.epoch,
    source_position: source.position,
    source_event_seq: source.eventSeq,
    source_event_id: source.eventId,
  });
  if (!changed) throw new Error('Creator sale immutable captured terms conflict');
}

/** No financial terms, permission or Actor are serialized as workflow output. */
export async function advanceCreatorSale(context: WorkContext, locator: Locator): Promise<void> {
  let source: NativeSource | null = null;
  let unavailable: CreatorSaleSourceUnavailableError | undefined;
  try {
    source = await readCreatorSaleSource(context.pool, locator);
  } catch (error) {
    // Missing retained proof is one exact pending obligation, not a failure of every
    // later locator in this sweep. Native fences and infrastructure errors still fail.
    if (!(error instanceof CreatorSaleSourceUnavailableError)) throw error;
    unavailable = error;
  }
  const receiving = readCreatorSaleReceiving(context);
  let receivingGap: string | undefined;
  if (source && receiving.state === 'available') {
    try {
      await deliverCreatorSale(context, locator, source.creatorAccountId);
    } catch (error) {
      // A foreign native home may be fenced before admission, or after a partial
      // admission/receiving commit. Keep that exact generation and every durable
      // hold/result for recovery; this gap neither cancels nor acknowledges it.
      if (!(error instanceof CommandUnavailableError)) throw error;
      receivingGap = 'commerce-creator-sale-live-copy-home-unavailable';
    }
    if (!receivingGap) {
      await runOperationalTransaction(
        context.pool,
        {
          mode: 'work-step',
          partition: partitionOf(locator.route),
          kind: 'commerce.creatorSales.defer',
          accounts: [],
          workClient: context.client,
        },
        async (tx) => {
          await tx.query(
            `UPDATE commerce.creator_sale_work SET next_run=now()+interval '10 minutes'
          WHERE route=$1 AND order_id=$2 AND state='pending' AND generation=$3`,
            [locator.route, locator.orderId, source.generation],
          );
        },
      );
      return;
    }
  }
  await runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: CREATOR_SALES_WORKFLOW,
      accounts: [],
      workClient: context.client,
    },
    async (tx) => {
      await tx.query(
        `UPDATE commerce.creator_sale_work SET observed_revision=$3,observed_transaction_id=$4,gap=$5,
         next_run=now()+interval '10 minutes'
       WHERE route=$1 AND order_id=$2 AND ($6::bigint IS NULL OR generation=$6) AND state='pending'`,
        [
          locator.route,
          locator.orderId,
          source?.revision ?? null,
          source?.transactionId ?? null,
          unavailable?.gap ??
            receivingGap ??
            (source === null
              ? 'commerce-creator-sale-source-unavailable-or-terminal'
              : receiving.state === 'pending'
                ? receiving.gap
                : 'commerce-creator-sale-source-unavailable-or-terminal'),
          source?.generation ?? unavailable?.generation ?? null,
        ],
      );
    },
  );
}

/** Actual default factory path. The source transaction admits its local roles before release. */
export async function prepareCreatorSaleDelivery(
  context: Pick<WorkContext, 'pool' | 'client'>,
  locator: Locator,
  creatorAccountId: string,
) {
  const receiverRoute = routeOf(creatorAccountId)!;
  const receiver = await observeLiveCopyDomain(context.pool, partitionOf(receiverRoute));
  const copy = await runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: 'commerce.creatorSales.admit',
      accounts: [],
      workClient: context.client,
    },
    async (tx) => {
      const source = await observeCreatorSaleSource(tx, locator);
      if (!source || source.creatorAccountId !== creatorAccountId) return null;
      const order = (
        await tx.query<{ buyer_account_id: string }>(
          'SELECT buyer_account_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2 FOR SHARE',
          [locator.route, locator.orderId],
        )
      ).rows[0]!;
      const roles = await creatorSaleEventRoles(
        tx,
        { ...locator, partition: partitionOf(locator.route), position: source.position, eventSeq: source.eventSeq },
        [
          { accountId: order.buyer_account_id, roles: 1024 },
          { accountId: source.creatorAccountId, roles: 2048 },
        ],
      );
      const payload = { ...source };
      await enrollCommerceCopyIntents(
        tx,
        {
          route: locator.route,
          orderId: locator.orderId,
          partition: partitionOf(locator.route),
          position: source.position,
          eventSeq: source.eventSeq,
        },
        roles,
      );
      return stageLiveCopy(tx, {
        route: locator.route,
        module: 'commerce.creator-sale',
        receiverRoute,
        receiver,
        effectKey: {
          orderId: source.view.orderId,
          revision: source.revision,
          transactionId: source.transactionId,
          epoch: source.epoch,
          position: source.position,
          eventSeq: source.eventSeq,
          eventId: source.eventId,
          effectGeneration: source.generation,
        },
        payload,
        roles,
      });
    },
  );
  return copy;
}
async function deliverCreatorSale(context: WorkContext, locator: Locator, creatorAccountId: string) {
  const copy = await prepareCreatorSaleDelivery(context, locator, creatorAccountId);
  if (copy) await recoverCreatorSale(context, liveCopyLocator(copy));
}

/** One maintained legacy creator-home row per step. Current native delivery enrolls
 * its original roles before this frontier can certify historical inverse coverage. */
export async function bootstrapCreatorSalesHome(
  context: Pick<WorkContext, 'pool' | 'client'>,
  partition: number,
): Promise<boolean> {
  const selected = await withReadTransaction(context.pool, async (tx) => {
    const frontier = (
      await tx.query<{
        sales_after_route: number;
        sales_after_creator: string;
        sales_after_order: string;
        sales_covered: boolean;
      }>(
        'SELECT sales_after_route,sales_after_creator,sales_after_order,sales_covered FROM access.live_copy_bootstrap WHERE partition_no=$1',
        [partition],
      )
    ).rows[0];
    if (!frontier) throw new Error('Live copy migration frontier unavailable');
    const row = frontier.sales_covered
      ? null
      : ((
          await tx.query<{ route: number; creator_account_id: string; order_id: string; source_revision: number }>(
            `SELECT route,creator_account_id,order_id,source_revision FROM commerce.creator_sale
       WHERE route BETWEEN $1 AND $2 AND (route,creator_account_id,order_id)>($3,$4::uuid,$5::uuid)
       ORDER BY route,creator_account_id,order_id LIMIT 1`,
            [
              partition * 16,
              partition * 16 + 15,
              frontier.sales_after_route,
              frontier.sales_after_creator,
              frontier.sales_after_order,
            ],
          )
        ).rows[0] ?? null);
    return { frontier, row };
  });
  if (selected.frontier.sales_covered) return false;
  if (selected.row) {
    const row = selected.row,
      route = routeOf(row.order_id)!;
    let copy;
    try {
      copy = await prepareCreatorSaleDelivery(context, { route, orderId: row.order_id }, row.creator_account_id);
    } catch (error) {
      if (!(error instanceof CreatorSaleSourceUnavailableError)) throw error;
      return false;
    }
    if (!copy) {
      // Terminal source cleanup is negative and never needs a new active-account hold.
      // Retained native order identity is read in its own released buyer home first.
      const terminal = await withReadTransaction(
        context.pool,
        async (tx) =>
          (
            await tx.query(
              `SELECT 1 FROM commerce.purchase_order o JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
         WHERE o.route=$1 AND o.order_id=$2 AND o.creator_account_id=$3 AND a.state='deleted' AND a.authn_fenced`,
              [route, row.order_id, row.creator_account_id],
            )
          ).rowCount === 1,
      );
      if (!terminal) return false;
      await runOperationalTransaction(
        context.pool,
        {
          mode: 'work-step',
          partition,
          kind: 'commerce.creatorSales.legacyMinimize',
          accounts: [],
          workClient: context.client,
        },
        async (tx) => {
          await tx.query(
            'DELETE FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3 AND source_revision<=$4',
            [row.route, row.creator_account_id, row.order_id, row.source_revision],
          );
        },
      );
    } else {
      await recoverCreatorSale(context, liveCopyLocator(copy));
      const result = await readLiveCopyResult(context.pool, copy);
      if (!result || result.outcome === 'cancelled') return false;
    }
  }
  const next = selected.row,
    f = selected.frontier;
  await runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition,
      kind: 'commerce.creatorSales.roleCoverage',
      accounts: [],
      workClient: context.client,
    },
    async (tx) => {
      await tx.query(
        `UPDATE access.live_copy_bootstrap SET sales_after_route=$5,sales_after_creator=$6,sales_after_order=$7,sales_covered=$8
      WHERE partition_no=$1 AND (sales_after_route,sales_after_creator,sales_after_order)=($2,$3::uuid,$4::uuid) AND NOT sales_covered`,
        [
          partition,
          f.sales_after_route,
          f.sales_after_creator,
          f.sales_after_order,
          next?.route ?? f.sales_after_route,
          next?.creator_account_id ?? f.sales_after_creator,
          next?.order_id ?? f.sales_after_order,
          !next,
        ],
      );
    },
  );
  return !!next;
}

/** Old producer-owned intents have their own frontiers: a covered creator-row
 * frontier alone cannot certify the personal roles of earlier event receipts. */
export async function bootstrapCreatorSalesIntentsHome(
  context: Pick<WorkContext, 'pool' | 'client'>,
  partition: number,
): Promise<boolean> {
  const advance = async (kind: 'work' | 'receipt') => {
    try {
      return await runOperationalTransaction(
        context.pool,
        {
          mode: 'work-step',
          partition,
          kind: `commerce.creatorSales.${kind}Coverage`,
          accounts: [],
          workClient: context.client,
        },
        async (tx) => {
          const frontier = (
            await tx.query<{
              work_after_route: number;
              work_after_order: string;
              work_covered: boolean;
              receipt_after_position: string;
              receipt_after_event: number;
              receipts_covered: boolean;
            }>(
              `SELECT work_after_route,work_after_order,work_covered,receipt_after_position::text,receipt_after_event,receipts_covered
           FROM access.live_copy_bootstrap WHERE partition_no=$1 FOR UPDATE`,
              [partition],
            )
          ).rows[0];
          if (!frontier) throw new LiveCopyPendingError('Commerce intent role frontier unavailable');
          if (kind === 'work' ? frontier.work_covered : frontier.receipts_covered) return false;
          const row =
            kind === 'work'
              ? (
                  await tx.query<{
                    route: number;
                    order_id: string;
                    position?: string;
                    event_seq?: number;
                    epoch?: string;
                    event_id?: string;
                    source_revision?: number;
                  }>(
                    `SELECT route,order_id FROM commerce.creator_sale_work WHERE route BETWEEN $1 AND $2
           AND (route,order_id)>($3,$4::uuid) ORDER BY route,order_id LIMIT 1`,
                    [partition * 16, partition * 16 + 15, frontier.work_after_route, frontier.work_after_order],
                  )
                ).rows[0]
              : (
                  await tx.query<{
                    route: number;
                    order_id: string | null;
                    position: string;
                    event_seq: number;
                    epoch: string;
                    event_id: string;
                    source_revision: number | null;
                  }>(
                    `SELECT route,order_id,position::text,event_seq,epoch::text,event_id,source_revision FROM commerce.creator_sale_receipt
             WHERE partition_no=$1 AND (position,event_seq)>($2::bigint,$3) ORDER BY position,event_seq LIMIT 1`,
                    [partition, frontier.receipt_after_position, frontier.receipt_after_event],
                  )
                ).rows[0];
          if (row?.order_id) {
            const account = (
              await tx.query<{
                buyer_account_id: string;
                creator_account_id: string;
                state: string;
                authn_fenced: boolean;
              }>(
                `SELECT o.buyer_account_id,o.creator_account_id,a.state,a.authn_fenced FROM commerce.purchase_order o
             JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
             WHERE o.route=$1 AND o.order_id=$2 FOR UPDATE OF a FOR SHARE OF o`,
                [row.route, row.order_id],
              )
            ).rows[0];
            if (!account) throw new LiveCopyPendingError('Commerce original intent business roles unavailable');
            if (account.state === 'deleted') {
              if (
                (
                  await tx.query(
                    `SELECT 1 FROM access.live_copy_transition WHERE route=$1 AND effect_key->>'orderId'=$2
              AND module='commerce.creator-sale' AND state='pending' LIMIT 1`,
                    [row.route, row.order_id],
                  )
                ).rowCount
              )
                throw new LiveCopyPendingError('Commerce original intent transition pending');
              // Native buyer T permits only exact negative minimization, never new work.
              if (kind === 'work')
                await tx.query('DELETE FROM commerce.creator_sale_work WHERE route=$1 AND order_id=$2', [
                  row.route,
                  row.order_id,
                ]);
              else
                await tx.query(
                  `UPDATE commerce.creator_sale_receipt SET order_id=NULL,source_revision=NULL,state='minimized'
              WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
                  [partition, row.position, row.event_seq],
                );
            } else {
              if (account.state !== 'active' || account.authn_fenced)
                throw new LiveCopyPendingError('Commerce original intent buyer fenced');
              let position: string, eventSeq: number;
              if (kind === 'work') {
                const source = await observeCreatorSaleSource(tx, { route: row.route, orderId: row.order_id });
                if (!source) throw new LiveCopyPendingError('Commerce original work source unavailable');
                position = source.position;
                eventSeq = source.eventSeq;
              } else {
                const event = (
                  await tx.query<EventRow>(
                    `SELECT event_seq,id,type,subject,
                CASE WHEN octet_length(data::text)<=1024 THEN data ELSE NULL END AS data,epoch::text,payload_state
                FROM core.outbox WHERE partition_no=$1 AND position=$2 AND event_seq=$3`,
                    [partition, row.position, row.event_seq],
                  )
                ).rows[0];
                const original = event && eventOrder(event);
                if (
                  !event ||
                  !original ||
                  original.orderId !== row.order_id ||
                  original.revision !== row.source_revision ||
                  event.id !== row.event_id ||
                  event.epoch !== row.epoch
                )
                  throw new LiveCopyPendingError('Commerce original receipt event role proof unavailable');
                position = row.position!;
                eventSeq = row.event_seq!;
              }
              const roles = await creatorSaleEventRoles(
                tx,
                { route: row.route, orderId: row.order_id, partition, position, eventSeq },
                [
                  { accountId: account.buyer_account_id, roles: 1024 },
                  { accountId: account.creator_account_id, roles: 2048 },
                ],
              );
              await enrollCommerceCopyIntents(
                tx,
                { route: row.route, orderId: row.order_id, partition, position, eventSeq },
                roles,
              );
            }
          }
          if (kind === 'work')
            await tx.query(
              `UPDATE access.live_copy_bootstrap SET work_after_route=$2,work_after_order=$3,work_covered=$4 WHERE partition_no=$1`,
              [partition, row?.route ?? frontier.work_after_route, row?.order_id ?? frontier.work_after_order, !row],
            );
          else
            await tx.query(
              `UPDATE access.live_copy_bootstrap SET receipt_after_position=$2,receipt_after_event=$3,receipts_covered=$4 WHERE partition_no=$1`,
              [
                partition,
                row?.position ?? frontier.receipt_after_position,
                row?.event_seq ?? frontier.receipt_after_event,
                !row,
              ],
            );
          return !!row;
        },
      );
    } catch (error) {
      if (error instanceof LiveCopyPendingError || error instanceof CreatorSaleSourceUnavailableError) return false;
      throw error;
    }
  };
  if (await advance('work')) return true;
  return advance('receipt');
}

class CreatorReceiverDenied extends Error {}
class CreatorBackfillPending extends Error {}
async function checkpointCreatorSale(
  context: Pick<WorkContext, 'pool' | 'client'>,
  copy: NonNullable<Awaited<ReturnType<typeof readLiveCopy>>>,
) {
  if (!copy.payload) return;
  const original = copy.payload as unknown as NativeSource;
  const result = await readLiveCopyResult(context.pool, copy);
  if (!result || result.outcome === 'cancelled') return;
  await runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(copy.route),
      kind: 'commerce.creatorSales.checkpoint',
      accounts: [],
      workClient: context.client,
    },
    async (tx) => {
      // Exact current financial basis, not a scheduler generation, settles a recovered intent.
      await tx.query(
        `UPDATE commerce.creator_sale_work w SET state='verified',gap=NULL,observed_revision=$3,observed_transaction_id=$4
      FROM commerce.purchase_order o WHERE w.route=$1 AND w.order_id=$2 AND w.state='pending'
      AND (o.route,o.order_id)=(w.route,w.order_id) AND o.revision=$3 AND o.transaction_id=$4 AND w.generation=$5`,
        [copy.route, original.view.orderId, original.revision, original.transactionId, original.generation],
      );
    },
  );
}
/** Same native transition is recovered after a crash, including after receiver commit. */
export async function recoverCreatorSale(context: Pick<WorkContext, 'pool' | 'client'>, locator: LiveCopyLocator) {
  const copy = await readLiveCopy(context.pool, locator);
  if (!copy || copy.module !== 'commerce.creator-sale' || copy.state === 'retired') return;
  if (await readLiveCopyResult(context.pool, copy)) {
    await consumeLiveCopy(context, copy);
    await checkpointCreatorSale(context, copy);
    return;
  }
  if (!copy.payload || !(await admitLiveCopyRoles(context, copy))) {
    await cancelLiveCopy(context, copy);
    await consumeLiveCopy(context, copy);
    return;
  }
  const { generation: _generation, ...original } = copy.payload as unknown as NativeSource;
  let current: NativeSource | null;
  try {
    current = await readCreatorSaleSource(context.pool, { route: copy.route, orderId: original.view.orderId });
  } catch (error) {
    if (!(error instanceof CreatorSaleSourceUnavailableError)) throw error;
    await cancelLiveCopy(context, copy);
    await consumeLiveCopy(context, copy);
    return;
  }
  const comparable = current && (({ generation: _generation, ...basis }) => basis)(current);
  if (!current || !isDeepStrictEqual(comparable, original)) {
    await cancelLiveCopy(context, copy);
    await consumeLiveCopy(context, copy);
    return;
  }
  const proof = await observeLiveCopyAdmissions(context.pool, copy);
  if (!proof) {
    await cancelLiveCopy(context, copy);
    await consumeLiveCopy(context, copy);
    return;
  }
  try {
    await runOperationalTransaction(
      context.pool,
      {
        mode: 'work-step',
        partition: partitionOf(copy.receiver_route),
        kind: 'commerce.creatorSales.receive',
        accounts: [],
        workClient: context.client,
      },
      async (tx) => {
        const terminal = await openLiveCopyGate(tx, copy, proof);
        if (terminal) return;
        const account = (
          await tx.query<{ state: string; authn_fenced: boolean }>(
            'SELECT state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE',
            [copy.receiver_route, current.creatorAccountId],
          )
        ).rows[0];
        if (!account || account.state !== 'active' || account.authn_fenced) throw new CreatorReceiverDenied();
        const prior = (
          await tx.query<{ source_revision: number }>(
            'SELECT source_revision FROM commerce.creator_sale WHERE route=$1 AND creator_account_id=$2 AND order_id=$3 FOR UPDATE',
            [copy.receiver_route, current.creatorAccountId, current.view.orderId],
          )
        ).rows[0];
        await writeCreatorSaleProjection(tx, current);
        await finishLiveCopyGate(
          tx,
          copy,
          prior && prior.source_revision >= current.revision ? 'superseded' : 'applied',
        );
      },
    );
  } catch (error) {
    if (!(error instanceof CreatorReceiverDenied)) throw error;
    await cancelLiveCopy(context, copy);
  }
  await consumeLiveCopy(context, copy);
  await checkpointCreatorSale(context, copy);
}

/** Maintained native partition/key frontier: raw100 locators, never a buyer-history scan on GET. */
export async function backfillCreatorSales(context: WorkContext, partitionNo: number): Promise<boolean> {
  return runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionNo,
      kind: 'commerce.creatorSales.backfill',
      accounts: [],
      workClient: context.client,
    },
    async (tx) => {
      const partition = await readPartition(tx, partitionNo);
      if (!partition || partition.writeState !== 'active') throw new CommandUnavailableError('fenced', partitionNo);
      await tx.query(
        `INSERT INTO commerce.creator_sales_frontier(partition_no,epoch,after_route) VALUES($1,$2,$3)
       ON CONFLICT(partition_no) DO UPDATE SET epoch=EXCLUDED.epoch,after_route=EXCLUDED.after_route,
         after_order=$4,phase='scanning',next_run=now() WHERE commerce.creator_sales_frontier.epoch<>EXCLUDED.epoch`,
        [partitionNo, partition.epoch, partitionNo * 16, ZERO],
      );
      const frontier = (
        await tx.query<{ after_route: number; after_order: string; phase: string; due: boolean }>(
          'SELECT after_route,after_order,phase,next_run<=now() AS due FROM commerce.creator_sales_frontier WHERE partition_no=$1 FOR UPDATE',
          [partitionNo],
        )
      ).rows[0]!;
      if (frontier.phase === 'covered' || !frontier.due) return true;
      const page = await tx.query<{ route: number; order_id: string }>(
        `SELECT route,order_id FROM commerce.purchase_order
       WHERE route BETWEEN $1 AND $2 AND (route,order_id)>($3,$4::uuid) ORDER BY route,order_id LIMIT 100`,
        [partitionNo * 16, partitionNo * 16 + 15, frontier.after_route, frontier.after_order],
      );
      let last: { route: number; order_id: string } | undefined;
      for (const row of page.rows) {
        await tx.query('SAVEPOINT creator_sale_backfill');
        try {
          const account = (
            await tx.query<{
              buyer_account_id: string;
              creator_account_id: string;
              state: string;
              authn_fenced: boolean;
            }>(
              `SELECT o.buyer_account_id,o.creator_account_id,a.state,a.authn_fenced FROM commerce.purchase_order o
             JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
             WHERE o.route=$1 AND o.order_id=$2 FOR UPDATE OF a FOR SHARE OF o`,
              [row.route, row.order_id],
            )
          ).rows[0];
          if (account && account.state !== 'deleted' && (account.state !== 'active' || account.authn_fenced))
            throw new CreatorBackfillPending();
          if (account && account.state === 'active' && !account.authn_fenced) {
            await tx.query(
              'INSERT INTO commerce.creator_sale_work(route,order_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
              [row.route, row.order_id],
            );
            const source = await observeCreatorSaleSource(tx, { route: row.route, orderId: row.order_id });
            if (!source) throw new Error('Native backfill source disappeared under its lock');
            const roles = await creatorSaleEventRoles(
              tx,
              {
                route: row.route,
                orderId: row.order_id,
                partition: partitionNo,
                position: source.position,
                eventSeq: source.eventSeq,
              },
              [
                { accountId: account.buyer_account_id, roles: 1024 },
                { accountId: account.creator_account_id, roles: 2048 },
              ],
            );
            await enrollCommerceCopyIntents(
              tx,
              {
                route: row.route,
                orderId: row.order_id,
                partition: partitionNo,
                position: source.position,
                eventSeq: source.eventSeq,
              },
              roles,
            );
          }
          await tx.query('RELEASE SAVEPOINT creator_sale_backfill');
          last = row;
        } catch (error) {
          if (
            !(error instanceof CreatorSaleSourceUnavailableError) &&
            !(error instanceof CreatorBackfillPending) &&
            !(error instanceof LiveCopyPendingError)
          )
            throw error;
          await tx.query('ROLLBACK TO SAVEPOINT creator_sale_backfill');
          await tx.query('RELEASE SAVEPOINT creator_sale_backfill');
          await tx.query(
            `UPDATE commerce.creator_sales_frontier SET after_route=$2,after_order=$3,next_run=now()+interval '10 minutes'
            WHERE partition_no=$1`,
            [partitionNo, last?.route ?? frontier.after_route, last?.order_id ?? frontier.after_order],
          );
          // Yield this scheduler home, without calling its incomplete frontier covered.
          return true;
        }
      }
      await tx.query(
        `UPDATE commerce.creator_sales_frontier SET after_route=$2,after_order=$3,phase=$4 WHERE partition_no=$1`,
        [
          partitionNo,
          last?.route ?? frontier.after_route,
          last?.order_id ?? frontier.after_order,
          page.rows.length < CREATOR_SALES_PAGE ? 'covered' : 'scanning',
        ],
      );
      return page.rows.length < CREATOR_SALES_PAGE;
    },
  );
}

export async function registerCreatorSales(context: WorkContext): Promise<void> {
  enableCreatorSaleReceiving(context);
  if (!context.addNativeEffects) throw new Error('Creator sales requires native effects admission');
  context.addNativeEffects([
    { name: 'commerce_creator_sales', types: TYPES, delivery: 'native', admit: admitCreatorSale },
  ]);
  // This consumer cannot waive other Commerce financial/custody obligations.
  for (const name of TYPES)
    context.history?.registerOwner({
      name,
      artifactType: 'outbox-event/v1',
      version: 1,
      async readiness(tx, artifact) {
        if (artifact.locator.artifactType !== 'outbox-event/v1')
          throw new TypeError('Invalid creator sale receipt locator');
        const key = artifact.locator;
        const receipt = (
          await tx.query<{ state: string }>(
            'SELECT state FROM commerce.creator_sale_receipt WHERE partition_no=$1 AND position=$2 AND event_seq=$3',
            [key.partitionNo, key.position.toString(), key.eventSeq],
          )
        ).rows[0];
        return {
          ready: false,
          gap: receipt
            ? 'commerce-creator-sale-projection-custody-pending'
            : 'commerce-creator-sale-exact-receipt-unavailable',
        };
      },
    });
  const bootstrap = DBOS.registerStep((partition: number) => backfillCreatorSales(context, partition), {
    name: 'commerce.creatorSales.backfill',
    ...COMMAND_STEP_RETRIES,
  });
  const step = DBOS.registerStep(
    async (input: Sweep): Promise<boolean> => {
      if (
        !input ||
        !Array.isArray(input.accounts) ||
        input.accounts.length !== 0 ||
        !Number.isInteger(input.partition) ||
        input.partition < 0 ||
        input.partition >= 4096
      )
        throw new TypeError('Invalid creator sales sweep locator');
      // One exact pending locator per step, separate from the raw100 backfill page.
      // Actual terms never enter DBOS inputs or step results.
      const pending = await withConnection(context.pool, (tx) =>
        tx.query<{ route: number; order_id: string }>(
          `SELECT route,order_id FROM commerce.creator_sale_work
       WHERE route BETWEEN $1 AND $2 AND state='pending' AND next_run<=now()
       ORDER BY route,next_run,order_id LIMIT 1`,
          [input.partition * 16, input.partition * 16 + 15],
        ),
      );
      for (const row of pending.rows) await advanceCreatorSale(context, { route: row.route, orderId: row.order_id });
      return pending.rows.length > 0;
    },
    { name: 'commerce.creatorSales.page', ...COMMAND_STEP_RETRIES },
  );
  const continueSweep = DBOS.registerStep(
    async (input: Sweep) => {
      await runOperationalTransaction(
        context.pool,
        {
          mode: 'work-step',
          partition: input.partition,
          kind: CREATOR_SALES_WORKFLOW,
          accounts: [],
          workClient: context.client,
        },
        (tx) =>
          enqueueIntent(tx, {
            queue: 'maintenance',
            workflowName: CREATOR_SALES_WORKFLOW,
            workflowId: `${input.root}:${input.segment}`,
            input,
          }),
      );
    },
    { name: 'commerce.creatorSales.continue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (input: Sweep) => {
      const covered = await bootstrap(input.partition);
      const processed = await step(input);
      const partition = covered && !processed ? input.partition + 1 : input.partition;
      if (partition < 4096) await continueSweep({ ...input, partition, segment: input.segment + 1 });
    },
    { name: CREATOR_SALES_WORKFLOW },
  );
  DBOS.registerWorkflow(
    async () => {
      const input: Sweep = { accounts: [], partition: 0, root: DBOS.workflowID!, segment: 0 };
      await continueSweep(input);
    },
    { name: 'commerce.creatorSales.sweep' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'commerce.creatorSales.every-10-minutes',
      workflowName: 'commerce.creatorSales.sweep',
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
