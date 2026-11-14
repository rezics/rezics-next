import type { Pool } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { withReadConnection } from './read-connection.ts';

export type ModerationReadAnchor = Readonly<{ partition: number; epoch: number; position: bigint }>;
export type ModerationReadSnapshot<T> = Readonly<{ value: T; anchor: ModerationReadAnchor }>;

/** Keep the complete moderation source snapshot inside its request deadline. */
export function moderationReadSnapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  read: (client: AccessClient, partition: Partition) => Promise<T>,
): Promise<ModerationReadSnapshot<T>> {
  return withReadConnection(pool, deadline, async ({ client, uncertain, discard, retain }) => {
    let beginAttempted = false;
    try {
      beginAttempted = true;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const partitionNo = partitionOf(route);
      const partition = await readPartition(client, partitionNo);
      if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
      if (partition.writeState === 'moved')
        throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
      const value = await read(client, partition);
      await client.query('COMMIT');
      beginAttempted = false;
      return { value, anchor: { partition: partitionNo, epoch: partition.epoch, position: partition.position } };
    } catch (error) {
      retain(error);
      if (beginAttempted) {
        if (uncertain) discard(error);
        else {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            discard(rollbackError);
          }
        }
      }
      throw error;
    }
  });
}
