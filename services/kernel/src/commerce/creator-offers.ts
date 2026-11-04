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
import { contentEditionTermsView, decodeCapturedContentEdition } from './benefit.ts';
import { recordedMoneyUnit, type StripeMoneyUnit } from './money.ts';
import pageRead from './creator-offers.sql';

/** Captured seller terms, independent of current target disclosure or sale eligibility. */
export type CreatorOffer = {
  id: string;
  targetSubjectId: string;
  title: string;
  currency: string;
  moneyUnit: StripeMoneyUnit | null;
  taxBehavior: 'exclusive' | null;
  unitAmountMinor: number;
  taxCode: string;
  royaltyBasisPoints: number;
  state: 'active' | 'delisted';
  revision: number;
  contentEdition: ReturnType<typeof contentEditionTermsView>;
};

export async function listCreatorOffers(
  pool: Pool,
  tokens: KeyRing,
  actor: Actor,
  check: AccessCheck,
  input: { cursor?: string; limit?: number; deadline: number; seen: readonly SessionComponent[] },
): Promise<{ offers: CreatorOffer[]; next: string | null }> {
  if (actor.kind !== 'account') throw new ProblemError('authentication_required');
  const route = routeOf(actor.accountId);
  if (route === null) throw new ProblemError('forbidden');
  const size = input.limit ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new ProblemError('invalid_request');
  const home = partitionOf(route);
  const binding = {
    operation: 'offer.list',
    parameters: { accountId: actor.accountId, route, view: 'seller-terms-v1', order: 'offer-id-desc' },
  };
  let after = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  let epoch: number | undefined;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(tokens, binding, input.cursor);
    if (
      !cursor.ok ||
      cursor.after.length !== 1 ||
      typeof cursor.after[0] !== 'string' ||
      routeOf(cursor.after[0]) !== route
    )
      throw new ProblemError('invalid_cursor');
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
      // The mounted metadata prepares the sole native formula on the actual acting account.
      if (!(await check(client))) throw new ProblemError('forbidden');
      const partition = await source();
      const rows = await pageRead.run(client, { route, creator_account_id: actor.accountId, after, limit: size + 1 });
      const offers: CreatorOffer[] = rows.slice(0, size).map((row) => {
        const amount = Number(row.unitAmountMinor);
        if (!Number.isSafeInteger(amount)) throw new ProblemError('dependency_unavailable');
        return {
          ...row,
          moneyUnit: row.moneyUnit === null ? null : recordedMoneyUnit(JSON.parse(row.moneyUnit)),
          taxBehavior: row.taxBehavior as 'exclusive' | null,
          unitAmountMinor: amount,
          contentEdition: contentEditionTermsView(decodeCapturedContentEdition(row.contentEdition)),
        };
      });
      await client.query('COMMIT');
      committed = true;
      // Leave the snapshot before the final current account/formula and native source fence.
      if (!(await check(client))) throw new ProblemError('forbidden');
      epoch = partition.epoch;
      await source();
      requireAccessDeadline(input.deadline);
      const last = offers.at(-1);
      return {
        offers,
        next:
          rows.length > size && last
            ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.id] })
            : null,
      };
    } catch (error) {
      if (!committed) await connection.query('ROLLBACK');
      throw error;
    }
  });
}
