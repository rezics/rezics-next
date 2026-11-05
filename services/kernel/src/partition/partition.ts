import type { Pool, PoolClient } from 'pg';
import read from './read.sql';
import readBatch from './read-batch.sql';

export type WriteState = 'active' | 'fenced' | 'moved';

export type Partition = {
  partitionNo: number;
  node: string;
  writeState: WriteState;
  movedTo: string | null;
  epoch: number;
  position: bigint;
};

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function readPartition(client: Queryable, partitionNo: number): Promise<Partition | null> {
  const row = await read.run(client, { partition_no: partitionNo });
  if (!row) return null;
  return {
    partitionNo: row.partitionNo,
    node: row.node,
    writeState: row.writeState,
    movedTo: row.movedTo,
    epoch: row.epoch,
    position: BigInt(row.position),
  };
}

export async function readPartitions(
  client: Queryable,
  partitionNos: readonly number[],
): Promise<readonly Partition[]> {
  const partitions = [...new Set(partitionNos)].sort((a, b) => a - b);
  if (partitions.length === 0) return [];
  const rows = await readBatch.run(client, { partitions });
  return rows.map((row) => ({
    partitionNo: row.partitionNo,
    node: row.node,
    writeState: row.writeState,
    movedTo: row.movedTo,
    epoch: row.epoch,
    position: BigInt(row.position),
  }));
}
