import type { PoolClient } from 'pg';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { readPartition, readPartitions, type Partition } from '../partition/partition.ts';

/** Bind a logical home and retain the exact partition observation used by the read. */
export async function partitionReadClientObservation<T extends Pick<PoolClient, 'query'>>(
  client: T,
  partition: number,
): Promise<{ client: T; partition: Partition }> {
  const state = await readPartition(client, partition);
  if (!state) throw new CommandUnavailableError('deadline', partition);
  if (state.writeState === 'moved') throw new CommandUnavailableError('moved', partition, state.movedTo);
  return { client, partition: state };
}

/** Bind a logical home on an already owned physical snapshot. No checkout or SQL join. */
export async function partitionReadClient<T extends Pick<PoolClient, 'query'>>(
  client: T,
  partition: number,
): Promise<T> {
  return (await partitionReadClientObservation(client, partition)).client;
}

/** Batch only authoritative partition metadata; every returned logical binding
 * refers to the same real client. Missing/moved homes cannot look like empty facts.
 */
export async function partitionReadClients<T extends Pick<PoolClient, 'query'>>(
  client: T,
  partitions: readonly number[],
): Promise<Map<number, T>> {
  const requested = [...new Set(partitions)];
  const states = new Map((await readPartitions(client, requested)).map((state) => [state.partitionNo, state]));
  const clients = new Map<number, T>();
  for (const partition of requested) {
    const state = states.get(partition);
    if (!state) throw new CommandUnavailableError('deadline', partition);
    if (state.writeState === 'moved') throw new CommandUnavailableError('moved', partition, state.movedTo);
    clients.set(partition, client);
  }
  return clients;
}
