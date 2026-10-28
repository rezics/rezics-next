import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { grantAccountRole } from '../access/account-role-grant.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessCheck, Actor } from '../request/access.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { TransactionKind } from './model.ts';
import { statementPeriod, royaltyLines, type RoyaltyLine, type StatementTotal } from './royalty.ts';
import { readOrder, readNamedOrderTransactions } from './store.ts';
import record from './payout-record.sql';
import { assertTransactionBound } from './settlement.ts';
import statementRead from './payout-statement-read.sql';
import statementList from './payout-statement-list.sql';
import linesRead from './payout-lines.sql';
import paid from './payout-mark-paid.sql';

export type PayoutStatement = StatementTotal & {
  id: string;
  creatorAccountId: string;
  period: string;
  /** Exact sum of netReceiptsMinor × royaltyBasisPoints, before division. */
  weightedNetMinor: string;
  state: 'open' | 'paid';
  paidAt: string | null;
  paidReference: string | null;
  revision: number;
};
export type PayoutLine = RoyaltyLine & {
  creatorAccountId: string;
  offerId: string;
  royaltyBasisPoints: number;
  period: string;
  statementId: string;
  recordedAt: string;
};
type StatementRow = NonNullable<Awaited<ReturnType<typeof statementRead.run>>>;
type Client = Pick<PoolClient, 'query'>;
export type PayoutPage = { cursor: string | null; limit: number };
class Unchanged extends Error {}
const queryClient = (client: Client): Client => ({ query: client.query.bind(client) });
const notFound = () => new ProblemError('not_found');
function money(value: string | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Statement amount exceeds safe integer range');
  return result;
}
function statement(row: StatementRow): PayoutStatement {
  const creatorShareMinor = money(BigInt(row.weightedNetMinor) / 10000n);
  return {
    ...row,
    grossMinor: money(row.grossMinor),
    taxMinor: money(row.taxMinor),
    feeMinor: money(row.feeMinor),
    disputeFeeMinor: money(row.disputeFeeMinor),
    refundsMinor: money(row.refundsMinor),
    chargebacksMinor: money(row.chargebacksMinor),
    netReceiptsMinor: money(row.netReceiptsMinor),
    creatorShareMinor,
    rezicsShareMinor: money(BigInt(row.netReceiptsMinor) - BigInt(creatorShareMinor)),
    paidAt: row.paidAt === null ? null : new Date(row.paidAt).toISOString(),
  };
}
function requestKey(value: string): string {
  if (!value || value.length > 256) throw new ProblemError('invalid_request');
  return value;
}
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest();
function limit(page: PayoutPage): number {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) throw new ProblemError('invalid_request');
  return page.limit;
}

/** Own-account anchor plus Access: a broad grant can never disclose a different creator's accounting. */
async function ownAccount(pool: Pool, actor: Actor, check: AccessCheck): Promise<{ route: number; id: string }> {
  if (actor.kind !== 'account') throw notFound();
  const route = routeOf(actor.accountId);
  if (route === null || !(await withConnection(pool, check))) throw notFound();
  return { route, id: actor.accountId };
}
export async function readPayoutStatement(pool: Pool, actor: Actor, id: string, check: AccessCheck) {
  const owner = await ownAccount(pool, actor, check);
  if (routeOf(id) !== owner.route) throw notFound();
  const row = await statementRead.run(queryClient(pool), { route: owner.route, id });
  if (!row || row.creatorAccountId !== owner.id) throw notFound();
  return statement(row);
}
async function readPage<T>(
  pool: Pool,
  tokens: KeyRing,
  actor: Actor,
  check: AccessCheck,
  page: PayoutPage,
  statementId: string | null,
  read: (
    client: Client,
    owner: { route: number; id: string },
    after: string | null,
    count: number,
  ) => Promise<{ rows: T[]; last: string | undefined }>,
) {
  const count = limit(page);
  if (actor.kind !== 'account') throw notFound();
  const route = routeOf(actor.accountId);
  if (route === null) throw notFound();
  const owner = { route, id: actor.accountId };
  const binding: CursorBinding = {
    operation: statementId === null ? 'payout_statement.list' : 'payout_statement.lines',
    parameters: statementId === null ? { accountId: owner.id } : { accountId: owner.id, statementId },
  };
  let after: string | null = null,
    epoch: number | null = null;
  if (page.cursor !== null) {
    const cursor = decodeCursor(tokens, binding, page.cursor);
    if (
      !cursor.ok ||
      cursor.after.length !== 1 ||
      typeof cursor.after[0] !== 'string' ||
      (statementId === null ? routeOf(cursor.after[0]) !== route : !/^txn_[A-Za-z0-9]{1,250}$/.test(cursor.after[0]))
    )
      throw new ProblemError('invalid_cursor');
    after = cursor.after[0];
    epoch = cursor.epoch;
  }
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      if (!(await check(client))) throw notFound();
      const partition = await readPartition(client, partitionOf(route));
      if (epoch !== null && epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
      if (statementId !== null) {
        if (routeOf(statementId) !== route) throw notFound();
        const row = await statementRead.run(queryClient(client), { route, id: statementId });
        if (!row || row.creatorAccountId !== owner.id) throw notFound();
      }
      const { rows, last } = await read(client, owner, after, count);
      await client.query('COMMIT');
      return {
        rows: rows.slice(0, count),
        next:
          rows.length > count && last && partition
            ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last] })
            : null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
export async function listPayoutStatements(
  pool: Pool,
  tokens: KeyRing,
  actor: Actor,
  check: AccessCheck,
  page: PayoutPage,
) {
  const result = await readPage(pool, tokens, actor, check, page, null, async (client, owner, after, count) => {
    const rows = await statementList.run(queryClient(client), {
      route: owner.route,
      creator: owner.id,
      after: after ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      limit: count + 1,
    });
    return { rows, last: rows[count - 1]?.id };
  });
  return { payoutStatements: result.rows.map(statement), next: result.next };
}
export async function listPayoutLines(
  pool: Pool,
  tokens: KeyRing,
  actor: Actor,
  id: string,
  check: AccessCheck,
  page: PayoutPage,
) {
  const result = await readPage(pool, tokens, actor, check, page, id, async (client, owner, after, count) => {
    const rows = await linesRead.run(queryClient(client), {
      route: owner.route,
      id,
      after: after ?? '',
      limit: count + 1,
    });
    return { rows, last: rows[count - 1]?.balanceTransactionId };
  });
  const lines: PayoutLine[] = result.rows.map((row) => ({
    ...row,
    kind: row.kind as TransactionKind,
    created: new Date(row.created).toISOString(),
    recordedAt: new Date(row.recordedAt).toISOString(),
    grossMinor: money(row.grossMinor),
    taxMinor: money(row.taxMinor),
    feeMinor: money(row.feeMinor),
    disputeFeeMinor: money(row.disputeFeeMinor),
    netReceiptsMinor: money(row.netReceiptsMinor),
  }));
  return { lines, next: result.next };
}

/** Trusted command ports. No Stripe payout is initiated: paidReference identifies an external payment. */
export function createPayouts({ pool, clock }: { pool: Pool; clock?: (() => Date) | undefined }) {
  async function recordTransactions(orderId: string, transactionIds: readonly string[], key: string) {
    assertTransactionBound(transactionIds);
    const ids = [...new Set(transactionIds)].sort();
    if (!ids.length) return { changed: false };
    const buyerRoute = routeOf(orderId);
    if (buyerRoute === null) return { changed: false };
    // One order anchor and only the event's immutable transaction keys in the buyer's partition.
    const order = await readOrder(pool, buyerRoute, orderId);
    if (!order || order.settlement !== 'paid') return { changed: false };
    const transactions = await readNamedOrderTransactions(pool, buyerRoute, orderId, ids);
    const lines = royaltyLines(order, order.amountTaxMinor ?? null, transactions);
    if (!lines.length) return { changed: false };
    const route = routeOf(order.creatorAccountId)!;
    try {
      return await runCommand(
        pool,
        {
          partition: partitionOf(route),
          clock,
          receipt: {
            actorAccountId: order.creatorAccountId,
            kind: 'commerce.royalty.record',
            key: requestKey(key),
            digest: digest({ orderId, transactionIds: ids }),
          },
        },
        async (tx, command) => {
          const at = authoritativeTimeValue(command.time),
            period = statementPeriod(at);
          const rows = await record.run(tx, {
            route,
            creator: order.creatorAccountId,
            order_id: order.id,
            offer_id: order.offerId,
            basis_points: order.royaltyBasisPoints,
            period,
            at,
            lines: lines.map((line) => ({
              id: line.balanceTransactionId,
              kind: line.kind,
              currency: line.currency,
              gross: line.grossMinor,
              tax: line.taxMinor,
              fee: line.feeMinor,
              dispute_fee: line.disputeFeeMinor,
              net: line.netReceiptsMinor,
              created: line.created,
              statement_id: derivedId(order.creatorAccountId, `${period}:${line.currency}`, route),
            })),
          });
          // Roll back a no-op, including its receipt/outbox position. Old IDs cannot create an empty later statement.
          if (!rows.length) throw new Unchanged();
          await grantAccountRole(tx, {
            account: { route, id: order.creatorAccountId },
            role: 'commerce.payout.owner',
          });
          return {
            value: rows.map(statement),
            events: rows.map((row) => ({
              type: 'com.rezics.commerce.payout_statement.updated.v1',
              subject: row.id,
              data: { statementId: row.id },
            })),
          };
        },
      );
    } catch (error) {
      if (error instanceof Unchanged) return { changed: false };
      throw error;
    }
  }
  async function markPaid(
    actor: Actor,
    id: string,
    paidReference: string,
    key: string,
    authorization: CommandAuthorization,
  ) {
    const route = routeOf(id);
    if (route === null || actor.kind !== 'account') throw notFound();
    if (
      authorization.action !== 'payout_statement:mark_paid' ||
      authorization.resource.route !== 0 ||
      authorization.resource.id !== GLOBAL_CONTEXT
    )
      throw notFound();
    if (!paidReference.trim() || paidReference.length > 256) throw new ProblemError('invalid_request');
    const identity = principalCommandIdentity(actor);
    return runCommand(
      pool,
      {
        ...identity,
        partition: partitionOf(route),
        authorization,
        clock,
        receipt: {
          kind: 'commerce.payout.mark_paid',
          key: requestKey(key),
          digest: digest([identity, id, paidReference]),
        },
      },
      async (tx, command) => {
        const current = await statementRead.run(tx, { route, id });
        if (!current) throw notFound();
        const at = authoritativeTimeValue(command.time),
          period = statementPeriod(at);
        if (current.state !== 'open' || current.period >= period) throw new ProblemError('conflict');
        const row = await paid.run(tx, { route, id, at, period, reference: paidReference });
        if (!row) throw new ProblemError('conflict');
        return {
          value: statement(row),
          events: [{ type: 'com.rezics.commerce.payout_statement.paid.v1', subject: id, data: { statementId: id } }],
        };
      },
    );
  }
  return { recordTransactions, markPaid };
}
