import type { Pool, PoolClient } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { decodeCursor, encodeCursor, type CursorBinding, type CursorKey } from '../tokens/cursor.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from './read.ts';
import readCandidateVisibility from './candidates-read-visibility.sql';
import { PageCursorError } from './page.ts';
import { SubjectNotFoundError } from './contract/subject-errors.ts';
import type { PageOptions } from './candidate-contract.ts';

const listed = <T>(result: T[] | T | null): T[] => result == null ? [] : Array.isArray(result) ? result : [result];

export async function page<T>(
  pool: Pool,
  ring: KeyRing,
  options: PageOptions,
  binding: CursorBinding,
  validAfter: (after: CursorKey[]) => boolean,
  read: (client: PoolClient, after: CursorKey[] | null) => Promise<{ value: T; after: CursorKey[] | null }>,
) {
  const route = routeOf(options.subject);
  if (route === null) throw new SubjectNotFoundError();
  let cursor: { epoch: number; after: CursorKey[] } | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor);
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    if (!validAfter(decoded.after)) throw new PageCursorError('invalid');
    cursor = decoded;
  }
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    const subject = listed(await readCandidateVisibility.run(client, { route, subject_id: options.subject }))[0];
    if (!partition || subject?.visibility !== 'visible' || !(await options.authorize(client)))
      throw new SubjectNotFoundError();
    if (cursor && cursor.epoch !== partition.epoch) throw new PageCursorError('stale');
    const result = await read(client, cursor?.after ?? null);
    return {
      ...result.value,
      next: result.after ? encodeCursor(ring, binding, { epoch: partition.epoch, after: result.after }) : null,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
}
