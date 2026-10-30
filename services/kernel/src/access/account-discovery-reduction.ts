import type { Pool } from 'pg';
import { readPartitions } from '../partition/partition.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';

export type AccountDiscoveryReductionHead = Readonly<{
  partition: number;
  epoch: number;
  revision: bigint;
  claimRevision: bigint;
}>;
export type AccountDiscoveryReductionBinding = Readonly<{
  owner: 'accounts';
  heads: readonly AccountDiscoveryReductionHead[];
}>;

/** Native heads only. The registered shared Source owns the fixed full domain,
 * original immutable capture, comparison and independent physical incarnation.
 */
export async function readAccountDiscoveryReductionBinding(
  pool: Pool,
  partitions: readonly number[],
  context: Readonly<{ deadline: number }>,
): Promise<AccountDiscoveryReductionBinding> {
  const requested = [...new Set(partitions)].sort((a, b) => a - b);
  if (requested.length > 100) throw new RangeError('Account discovery reductions accept at most 100 partitions');
  for (const partition of requested) {
    if (!Number.isInteger(partition) || partition < 0 || partition > 4095)
      throw new RangeError('Account discovery partition must be an integer from 0 to 4095');
  }
  if (!Number.isFinite(context.deadline)) throw new TypeError('Account discovery requires a finite deadline');
  requireAccessDeadline(context.deadline);
  try {
    return await withRequestDeadline(context.deadline, () =>
      withReadTransaction(pool, async (client) => {
        const homes = new Map((await readPartitions(client, requested)).map((home) => [home.partitionNo, home]));
        const counters = await client.query<{ partition: number; revision: string; claimRevision: string }>(
          `SELECT partition_no AS partition, revision::text, claim_revision::text AS "claimRevision"
           FROM access.account_discovery_population WHERE partition_no = ANY($1::integer[])`,
          [requested],
        );
        const byPartition = new Map(counters.rows.map((row) => [row.partition, row]));
        const heads = requested.map((partition): AccountDiscoveryReductionHead => {
          const home = homes.get(partition);
          if (!home) throw new CommandUnavailableError('contention', partition);
          if (home.writeState !== 'active')
            throw new CommandUnavailableError(home.writeState === 'moved' ? 'moved' : 'fenced', partition, home.movedTo);
          const counter = byPartition.get(partition);
          if (!counter || BigInt(counter.revision) <= 0n || BigInt(counter.claimRevision) <= 0n)
            throw new CommandUnavailableError('contention', partition);
          return Object.freeze({
            partition,
            epoch: home.epoch,
            revision: BigInt(counter.revision),
            claimRevision: BigInt(counter.claimRevision),
          });
        });
        requireAccessDeadline(context.deadline);
        return Object.freeze({ owner: 'accounts', heads: Object.freeze(heads) });
      }),
    );
  } catch (error) {
    // Preserve moved/fenced routing information, and classify bounded read failures.
    throwAccessUnavailable(error, context.deadline);
    throw error;
  }
}
