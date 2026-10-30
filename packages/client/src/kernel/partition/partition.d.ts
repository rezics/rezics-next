import type { Pool, PoolClient } from 'pg';
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
export declare function readPartition(client: Queryable, partitionNo: number): Promise<Partition | null>;
export declare function readPartitions(client: Queryable, partitionNos: readonly number[]): Promise<readonly Partition[]>;
export {};
