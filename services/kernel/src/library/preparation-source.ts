import type { Pool } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readItemIdentityVersion } from '../semantic/item-identity.ts';
import { readItemTypes } from '../semantic/subject.ts';
import { withReadTransaction } from '../semantic/read.ts';

export interface PreparationSourceExecution {
  transaction<T>(read: () => Promise<T>): Promise<T>;
  read<T>(client: import('pg').PoolClient, subjectId: string, full: boolean, read: () => Promise<T>): Promise<T>;
}
type PreparationSourceContext = { pool: Pool; deadline?: number | undefined; execution?: PreparationSourceExecution };

async function observe({ pool, deadline, execution }: PreparationSourceContext, subjectId: string, full: boolean) {
  const route = routeOf(subjectId);
  if (route === null) throw new TypeError('Invalid preparation source');
  const partition = partitionOf(route);
  const transaction = () =>
    withReadTransaction(
      pool,
      async (client) => {
        const read = async () => {
          const owner = await readPartition(client, partition);
          if (!owner) throw new CommandUnavailableError('deadline', partition);
          if (owner.writeState === 'moved') throw new CommandUnavailableError('moved', partition, owner.movedTo);
          const version = await readItemIdentityVersion(client, subjectId);
          const stamp = { partition, epoch: owner.epoch, position: owner.position };
          const identity = version ? { sourceId: subjectId, partition, epoch: owner.epoch, ...version } : null;
          // Metadata revalidation never invokes the full Type reader.
          const type = full ? ((await readItemTypes(client, [subjectId])).get(subjectId) ?? null) : null;
          return { stamp, identity, type };
        };
        return execution ? execution.read(client, subjectId, full, read) : read();
      },
      deadline,
    );
  return execution ? execution.transaction(transaction) : transaction();
}
export function observePreparationSource(context: PreparationSourceContext, subjectId: string) {
  return observe(context, subjectId, true);
}
export async function observePreparationIdentity(context: PreparationSourceContext, subjectId: string) {
  const { stamp, identity } = await observe(context, subjectId, false);
  return { stamp, identity };
}
