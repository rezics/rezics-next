import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import readStatus from './erasure-status-read.sql';
import acknowledgePage from './erasure-status-ack.sql';

export type RatingErasureStatus = { done: boolean; hadVotes: boolean };

/** One status statement with only indexed existence probes in the voter's partition. */
export async function readRatingErasureDone(deps: { pool: Pool }, accountId: string): Promise<RatingErasureStatus> {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid rating erasure account');
  const row = await withConnection(deps.pool, (client) => readStatus.run(client, { route, voter_id: accountId }));
  if (!row) throw new Error('Rating erasure status returned no result');
  return { done: row.done, hadVotes: row.hadVotes };
}

/** Called only after every target-partition command for this page has committed. */
export async function acknowledgeRatingErasurePage(
  pool: Pool,
  voterId: string,
  pageId: string,
  capabilities?: RatingCapabilities,
): Promise<void> {
  const route = routeOf(voterId);
  if (route === null || routeOf(pageId) === null) throw new TypeError('Invalid rating erasure page');
  const outcome = await (capabilities?.command ?? runCommand)(pool, { partition: partitionOf(route) }, async (tx) => {
    const removed = await acknowledgePage.run(tx, { route, voter_id: voterId, page_id: pageId });
    if (removed === null) return noEffect(null);
    return {
      value: null,
      events: [{ type: 'com.rezics.rating.erasure-page.applied.v1', subject: voterId, data: { voterId, pageId } }],
    };
  });
  if (!outcome) throw new Error('Voter partition is unavailable while acknowledging rating erasure');
}
