import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
export { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable };
export { withRequestDeadline };
/** Only this executor's live checked-out RR clients qualify; a pool.query facade never does. */
export declare function currentReadSnapshot(pool: Pool): PoolClient | undefined;
/** A single native SELECT has its own snapshot. Reuse a caller's repeatable-read snapshot when present. */
export declare function withReadStatement<T>(pool: Pool, read: (client: PoolClient) => Promise<T>, deadline?: number): Promise<T>;
/** Keep both native snapshots independent, including the original lifetime of each observation. */
export declare function withIndependentReadSnapshots<A, T>(pool: Pool, initial: () => Promise<A>, recheck: (first: A) => Promise<T>): Promise<T>;
/** One physical-pool snapshot across independently bound logical partition reads. */
export declare function withReadTransaction<T>(pool: Pool, read: (client: PoolClient) => Promise<T>, requestDeadline?: number): Promise<T>;
