import type { PoolClient } from 'pg';
import { type Partition } from '../partition/partition.ts';
/** Bind a logical home and retain the exact partition observation used by the read. */
export declare function partitionReadClientObservation<T extends Pick<PoolClient, 'query'>>(client: T, partition: number): Promise<{
    client: T;
    partition: Partition;
}>;
/** Bind a logical home on an already owned physical snapshot. No checkout or SQL join. */
export declare function partitionReadClient<T extends Pick<PoolClient, 'query'>>(client: T, partition: number): Promise<T>;
/** Batch only authoritative partition metadata; every returned logical binding
 * refers to the same real client. Missing/moved homes cannot look like empty facts.
 */
export declare function partitionReadClients<T extends Pick<PoolClient, 'query'>>(client: T, partitions: readonly number[]): Promise<Map<number, T>>;
