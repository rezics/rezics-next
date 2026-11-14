import type { Pool } from 'pg';
import { withFeedReadConnection, type FeedReadClient } from './feed-read-connection.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf } from '../route/route.ts';
import { ProblemError } from '../http/problem-error.ts';

/** Exactly one backend/home snapshot, released before any other home is entered. */
export function feedSnapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  read: (client: FeedReadClient) => Promise<T>,
): Promise<T> {
  return withFeedReadConnection(pool, deadline, async (client) => {
    const home = await readPartition(client, partitionOf(route));
    if (!home || home.writeState === 'moved') throw new ProblemError('partition_unavailable');
    return read(client);
  });
}
