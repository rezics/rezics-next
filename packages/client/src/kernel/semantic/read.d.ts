import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
export { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable };
export { withRequestDeadline };
/** Only this executor's live checked-out RR clients qualify; a pool.query facade never does. */
export declare function currentReadSnapshot(pool: Pool): PoolClient | undefined;
/** One physical-pool snapshot across independently bound logical partition reads. */
export declare function withReadTransaction<T>(pool: Pool, read: (client: PoolClient) => Promise<T>, requestDeadline?: number): Promise<T>;
