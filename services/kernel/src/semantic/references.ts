import type { Pool, PoolClient } from 'pg';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { SubjectRedirectError } from './merges.ts';
import { withReadTransaction } from './read.ts';
import readReference from './read-subject-reference.sql';
import type { SubjectComponent } from './subject.ts';

/** Authorize the source identity in its snapshot; callers reanchor redirects independently. */
export async function readSubjectReference(
  pool: Pool,
  id: string,
  authorize: (client: PoolClient) => Promise<boolean>,
): Promise<{ id: string; component: SubjectComponent } | null> {
  const route = routeOf(id);
  if (route === null) return null;
  return withReadTransaction(pool, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition) return null;
    const source = await readReference.run(client, { route, subject_id: id });
    if (!source || !(await authorize(client))) return null;
    if (source.redirect) throw new SubjectRedirectError(id, source.redirect);
    return {
      id: source.id,
      component: { partition: partition.partitionNo, epoch: partition.epoch, position: partition.position },
    };
  });
}
