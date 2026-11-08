import type { Pool } from 'pg';
import type { Access, AccessClient } from '../../request/access.ts';
import { type CountDestination, type FollowCountReads, type FollowCountTarget } from '../contract/index.ts';
/** Only composition supplies foreign behavior. Account and Space observations
 * retain the exact borrowed client and native instant used before the migration. */
export interface NativeFollowCountReadPorts {
    account(client: AccessClient, route: number, id: string): Promise<Readonly<{
        state: string;
        fenced: boolean;
        minimumAuthnEpoch: bigint;
    }> | null>;
    accountForAgent(pool: Pool, id: string): Promise<string | null>;
    spaceExists(client: AccessClient, id: string, at: string): Promise<boolean>;
    deadlineClient(client: AccessClient, deadline: number): AccessClient;
    within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
    destination(pool: Pool, target: FollowCountTarget): Promise<CountDestination>;
    isUnavailable(error: unknown): boolean;
}
export declare function createNativeFollowCountReads(pool: Pool, access: Access, ports: NativeFollowCountReadPorts): FollowCountReads;
