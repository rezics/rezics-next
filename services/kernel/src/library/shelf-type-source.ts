import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { redirectOf } from '../semantic/merges.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { readItemTypes } from '../semantic/subject.ts';

type Client = Pick<PoolClient, 'query'>;
type Source = {
  readPartition(client: Client, partition: number): Promise<Partition | null>;
  readItemTypes(client: Client, ids: readonly string[]): Promise<Map<string, string>>;
  readSurvivor(client: Client, subjectId: string): Promise<string | null>;
};

/** Internal maintenance reads only; visible item types do not establish subject access. */
export function createShelfTypeSource() {
  return { readPartition, readItemTypes, readSurvivor: redirectOf };
}

/** Observe one source binding. Its survivor must be observed separately at its own owner. */
export async function observeShelfType({ pool, source }: { pool: Pool; source: Source }, subjectId: string) {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Subject id must carry a valid route');
  const partition = partitionOf(route);

  return withReadTransaction(pool, async (client) => {
    const owner = await source.readPartition(client, partition);
    if (!owner) throw new CommandUnavailableError('deadline', partition);
    if (owner.writeState === 'moved') throw new CommandUnavailableError('moved', partition, owner.movedTo);
    // Fencing excludes writes, but existing read conventions allow this snapshot.
    const stamp = { partition, epoch: owner.epoch, position: owner.position };
    const types = await source.readItemTypes(client, [subjectId]);
    const survivorId = await source.readSurvivor(client, subjectId);
    return {
      binding: { sourceId: subjectId, stamp },
      source: types.has(subjectId) ? { sourceId: subjectId, type: types.get(subjectId)!, stamp } : null,
      survivorId,
    };
  });
}
