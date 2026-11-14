import type { Pool } from 'pg';
import { AccessUnavailableError, classifyUnavailability, throwAccessUnavailable } from '../access/unavailable.ts';
import { CommandUnavailableError } from '../command/command.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';

export type ModerationReadAnchor = Readonly<{ partition: number; epoch: number; position: bigint }>;
export type ModerationReadSnapshot<T> = Readonly<{ value: T; anchor: ModerationReadAnchor }>;

function boundedOptions() {
  return {
    deadlineError: () => new AccessUnavailableError('deadline'),
    mapError(error: unknown) {
      if (error instanceof CommandUnavailableError) return error;
      try {
        throwAccessUnavailable(error);
      } catch (mapped) {
        return mapped;
      }
      return error;
    },
    isUncertainError: (error: unknown) =>
      !(error instanceof CommandUnavailableError) && classifyUnavailability(error) !== undefined,
    isUncertainSettledQueryError: (error: unknown) => !(error instanceof CommandUnavailableError),
  };
}

/** Keep the complete moderation source snapshot inside its request deadline. */
export function moderationReadSnapshot<T>(
  pool: Pool,
  route: number,
  deadline: number,
  read: (client: AccessClient, partition: Partition) => Promise<T>,
): Promise<ModerationReadSnapshot<T>> {
  let readFailed = false;
  let readFailure: unknown;
  const snapshot = withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (native) => {
      try {
        const client = native as AccessClient;
        const partitionNo = partitionOf(route);
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved')
          throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const value = await read(client, partition);
        return { value, anchor: { partition: partitionNo, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        readFailed = true;
        readFailure = error;
        throw error;
      }
    },
    boundedOptions(),
  );
  return snapshot.catch((error: unknown) => {
    if (readFailed) throw readFailure;
    throw error;
  });
}
