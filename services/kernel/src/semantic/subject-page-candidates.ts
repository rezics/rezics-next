import type { Pool } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { readPartition } from '../partition/partition.ts';
import { routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { PageCursorError, type PageComponent } from './page.ts';
import { withReadTransaction } from './read.ts';
import candidatesStatement from './subject-page-candidates.sql';

export type SubjectPageCandidateWindow = {
  candidates: { route: number; id: string }[];
  next: string | null;
  component: PageComponent;
};

/** Internal source keys only; these candidates confer no public disclosure authority. */
export async function pageSubjectPageCandidates(
  pool: Pool,
  ring: KeyRing,
  options: { partition: number; size?: number; cursor?: string; clock?: KernelClock },
): Promise<SubjectPageCandidateWindow> {
  const { partition } = options;
  const size = options.size ?? 20;
  const clock = options.clock ?? systemClock;
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096)
    throw new RangeError('Partition must be an integer from 0 to 4095');
  if (!Number.isInteger(size) || size < 1 || size > 1000)
    throw new RangeError('Page size must be an integer from 1 to 1000');

  const binding: CursorBinding = { operation: 'subject-pages.candidates', parameters: { partition, size } };
  let afterRoute = partition * 16;
  let afterId = '00000000-0000-0000-0000-000000000000';
  let cursorEpoch: number | null = null;
  if (options.cursor !== undefined) {
    const decoded = decodeCursor(ring, binding, options.cursor, clock().getTime());
    if (!decoded.ok) throw new PageCursorError(decoded.reason);
    const [route, id] = decoded.after;
    if (
      decoded.after.length !== 2 ||
      typeof route !== 'number' ||
      !Number.isInteger(route) ||
      route < partition * 16 ||
      route >= (partition + 1) * 16 ||
      typeof id !== 'string' ||
      routeOf(id) !== route
    )
      throw new PageCursorError('invalid');
    afterRoute = route;
    afterId = id;
    cursorEpoch = decoded.epoch;
  }

  return withReadTransaction(pool, async (client) => {
    const owner = await readPartition(client, partition);
    if (!owner) throw new CommandUnavailableError('deadline', partition);
    if (owner.writeState === 'moved') throw new CommandUnavailableError('moved', partition, owner.movedTo);
    if (cursorEpoch !== null && cursorEpoch !== owner.epoch) throw new PageCursorError('stale');

    const rows = await candidatesStatement.run(client, {
      partition_no: partition,
      after_route: afterRoute,
      after_id: afterId,
      limit: size + 1,
    });
    const candidates = rows.slice(0, size);
    const last = candidates.at(-1);
    // The extra key has not been processed: the next window must include it.
    const next =
      rows.length > size && last
        ? encodeCursor(ring, binding, { epoch: owner.epoch, after: [last.route, last.id] }, clock().getTime())
        : null;
    return {
      candidates,
      next,
      component: { partition: owner.partitionNo, epoch: owner.epoch, position: owner.position },
    };
  });
}
