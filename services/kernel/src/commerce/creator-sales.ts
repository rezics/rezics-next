import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccessCheck, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
import { recordedMoneyUnit, type StripeMoneyUnit } from './money.ts';
import pageRead from './creator-sales.sql';

/** Historical purchase accounting only. No current benefit, refund finality or payable amount. */
export type CreatorSaleView = {
  orderId: string;
  offerId: string;
  title: string;
  targetSubjectId: string;
  currency: string;
  unitAmountMinor: number;
  moneyUnit: StripeMoneyUnit | null;
  taxBehavior: 'exclusive' | null;
  settlement: 'pending' | 'paid' | 'failed' | 'unknown';
  createdAt: string;
};
export type CreatorSalesPage = {
  sales: CreatorSaleView[];
  next: string | null;
  projectionState: 'ready' | 'preparing';
};
export const CREATOR_SALES_PAGE_BYTES = 256 * 1024;

export async function listCreatorSales(
  pool: Pool,
  tokens: KeyRing,
  actor: Actor,
  check: AccessCheck,
  input: { cursor?: string; limit?: number; deadline: number; seen: readonly SessionComponent[] },
): Promise<CreatorSalesPage> {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('forbidden');
  const size = input.limit ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new ProblemError('invalid_request');
  const home = partitionOf(route);
  const binding = {
    operation: 'commerce_sale.list',
    parameters: { accountId: actor.accountId, route, view: 'creator-sales-v1', order: 'order-id-desc', limit: size },
  };
  let after = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  let epoch: number | undefined;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(tokens, binding, input.cursor);
    if (
      !cursor.ok ||
      cursor.after.length !== 1 ||
      typeof cursor.after[0] !== 'string' ||
      routeOf(cursor.after[0]) === null
    )
      throw new ProblemError('invalid_cursor');
    // Order locators belong to buyer homes, so they need not share the viewer's route.
    after = cursor.after[0];
    epoch = cursor.epoch;
  }
  requireAccessDeadline(input.deadline);
  return withConnection(pool, async (connection) => {
    const client = deadlineClient(connection, input.deadline);
    const source = async () => {
      const partition = await readPartition(client, home);
      if (!partition || partition.writeState !== 'active')
        throw new CommandUnavailableError(
          partition?.writeState === 'moved' ? 'moved' : 'fenced',
          home,
          partition?.movedTo,
        );
      if (epoch !== undefined && epoch !== partition.epoch) throw new ProblemError('stale_cursor');
      const seen = input.seen.find((entry) => entry.partition === home);
      if (
        seen &&
        (seen.epoch > partition.epoch || (seen.epoch === partition.epoch && seen.position > partition.position))
      )
        throw new CommandUnavailableError('fenced', home);
      return partition;
    };
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let committed = false;
    try {
      if (!(await check(client))) throw new ProblemError('forbidden');
      const partition = await source();
      const rows = await pageRead.run(client, { route, creator_account_id: actor.accountId, after, limit: size + 1 });
      const sales = rows.slice(0, size).map((row): CreatorSaleView => {
        const amount = Number(row.unitAmountMinor);
        if (!Number.isSafeInteger(amount)) throw new ProblemError('dependency_unavailable');
        return {
          orderId: row.orderId,
          offerId: row.offerId,
          title: row.title,
          targetSubjectId: row.targetSubjectId,
          currency: row.currency,
          unitAmountMinor: amount,
          moneyUnit: row.moneyUnit === null ? null : recordedMoneyUnit(JSON.parse(row.moneyUnit)),
          taxBehavior: row.taxBehavior as 'exclusive' | null,
          settlement: row.settlement as CreatorSaleView['settlement'],
          createdAt: new Date(row.createdAt).toISOString(),
        };
      });
      if (Buffer.byteLength(JSON.stringify(sales)) > CREATOR_SALES_PAGE_BYTES)
        throw new ProblemError('dependency_unavailable');
      await client.query('COMMIT');
      committed = true;
      if (!(await check(client))) throw new ProblemError('forbidden');
      epoch = partition.epoch;
      await source();
      requireAccessDeadline(input.deadline);
      const last = sales.at(-1);
      return {
        sales,
        next:
          rows.length > size && last
            ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.orderId] })
            : null,
        // No shared producer currently certifies full live-order coverage/copy custody.
        // Exhausting local rows or a backfill frontier cannot manufacture that proof.
        projectionState: 'preparing',
      };
    } catch (error) {
      if (!committed) await connection.query('ROLLBACK');
      throw error;
    }
  });
}
