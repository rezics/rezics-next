import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { ProblemError } from '../http/problem.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import inversePage from './own-realms-inverse-page.sql';
import confirmMembership from './own-realms-membership.sql';

const PAGE_SIZE = 20;
const SCAN_PAGE_SIZE = 20;
const MAX_INVERSE_ROWS = 4 * PAGE_SIZE;
const START_AFTER = '00000000-0000-0000-0000-000000000000';

export type OwnRealmsDependencies = { pool: Pool; tokens: KeyRing };

type OwnRealm = { realmId: string; name: string; role: 'member' };
type OwnRealmsInput = { cursor?: string };

function binding(actor: AccountActor) {
  return {
    operation: 'community.me.realms',
    parameters: { viewer: actor.accountId },
  };
}

function cursorError(code: 'invalid_cursor' | 'stale_cursor'): ProblemError {
  return new ProblemError(code);
}

/** List only live Realm memberships, treating the account inverse as a bounded candidate index. */
export async function listOwnRealms(
  dependencies: OwnRealmsDependencies,
  actor: AccountActor,
  context: { deadline: number; at: string },
  input: OwnRealmsInput = {},
): Promise<{ items: OwnRealm[]; next: string | null }> {
  const accountRoute = routeOf(actor.accountId);
  if (accountRoute === null) throw new ProblemError('authentication_required');

  return withConnection(dependencies.pool, async (client) => {
    const bounded = deadlineClient(client, context.deadline);
    await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const partition = await readPartition(bounded, partitionOf(accountRoute));
      if (!partition) throw new ProblemError('partition_unavailable');

      let after = START_AFTER;
      if (input.cursor !== undefined) {
        const cursor = decodeCursor(dependencies.tokens, binding(actor), input.cursor);
        if (!cursor.ok) throw cursorError('invalid_cursor');
        if (cursor.after.length !== 1 || typeof cursor.after[0] !== 'string') throw cursorError('invalid_cursor');
        if (cursor.epoch !== partition.epoch) throw cursorError('stale_cursor');
        after = cursor.after[0];
      }

      const items: OwnRealm[] = [];
      let fetched = 0;
      let lastScanned: string | undefined;
      let lastBatchLength = 0;
      let nextExists: boolean | undefined;

      while (fetched < MAX_INVERSE_ROWS && items.length < PAGE_SIZE) {
        const limit = Math.min(SCAN_PAGE_SIZE, MAX_INVERSE_ROWS - fetched);
        const candidates = await inversePage.run(bounded, {
          route: accountRoute,
          account_id: actor.accountId,
          after,
          limit,
        });
        fetched += candidates.length;
        lastBatchLength = candidates.length;
        if (candidates.length === 0) break;

        let completedBatch = true;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          lastScanned = candidate.realmId;
          after = candidate.realmId;
          const realmRoute = routeOf(candidate.realmId);
          if (realmRoute === null) continue;
          const confirmed = await confirmMembership.run(bounded, {
            route: realmRoute,
            realm_id: candidate.realmId,
            account_id: actor.accountId,
            at: context.at,
          });
          if (confirmed) {
            items.push({ realmId: confirmed.realmId, name: confirmed.name, role: confirmed.role as 'member' });
          }
          if (items.length === PAGE_SIZE) {
            completedBatch = index === candidates.length - 1;
            break;
          }
        }

        if (items.length === PAGE_SIZE) {
          if (!completedBatch) {
            nextExists = true;
          } else if (candidates.length < limit) {
            nextExists = false;
          } else if (fetched < MAX_INVERSE_ROWS && lastScanned) {
            const following = await inversePage.run(bounded, {
              route: accountRoute,
              account_id: actor.accountId,
              after: lastScanned,
              limit: 1,
            });
            fetched += following.length;
            nextExists = following.length > 0;
          } else {
            nextExists = candidates.length === limit;
          }
          break;
        }

        if (candidates.length < limit) {
          nextExists = false;
          break;
        }
      }

      if (nextExists === undefined) {
        nextExists = fetched === MAX_INVERSE_ROWS && lastBatchLength === Math.min(SCAN_PAGE_SIZE, MAX_INVERSE_ROWS);
      }
      const next =
        nextExists && lastScanned
          ? encodeCursor(dependencies.tokens, binding(actor), { epoch: partition.epoch, after: [lastScanned] })
          : null;
      await bounded.query('COMMIT');
      return { items, next };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}
