import type { Pool } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import { type ContextAccessPort, type ContextAccessHandle, type ContextActor, type ContextDirectoryEntry, type ContextQueryClient } from './context-access-port.ts';
export type NativeContextMetadata = ContextDirectoryEntry & {
    version: string;
    epoch: number;
    owners: string[];
    actorOwner: boolean;
};
/** Each Source snapshot is released before any foreign Account checkout, including pool max=1. */
export declare function readNativeContextMetadata(pool: Pool, ids: readonly string[], actor: ContextActor, at: string, deadline: number, accessPort?: ContextAccessPort): Promise<NativeContextMetadata[]>;
/** A candidate key is never an allow. Use the mounted Access formula, exact native rows and live owners.
 * Public eligibility is the same existing Context floor, including for an eligible retained tombstone.
 */
export declare function authorizedContextMetadata(deps: {
    pool: Pool;
    access: ContextAccessHandle;
}, input: {
    ids: readonly string[];
    actor: ContextActor;
    deadline: number;
    expected?: ReadonlyMap<string, {
        version: string;
        epoch: number;
    }>;
}, accessPort?: ContextAccessPort): Promise<ContextDirectoryEntry[]>;
/** Shared native lifecycle constraints for viewerActions. Access still decides every action. */
export declare function contextNativeActions(client: ContextQueryClient, ids: readonly string[], actor: ContextActor, time: AuthoritativeTime): Promise<Readonly<Record<string, readonly string[]>>>;
