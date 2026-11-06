import type { ZoneConfiguration } from '@rezics/composition';
import type { CommandTransaction } from '../command/command.ts';
import head from './resource-head.sql.d.ts';
/** Internal authoritative head. This type must never be serialized as a public response. */
export type ZoneHead = Omit<NonNullable<Awaited<ReturnType<typeof head.run>>>, 'configuration' | 'visibility' | 'mounts'> & {
    configuration: ZoneConfiguration | null;
    visibility: 'private' | 'unlisted' | 'public';
    mounts: string[] | null;
};
export declare function zoneHeadFromRow(row: NonNullable<Awaited<ReturnType<typeof head.run>>>): ZoneHead;
/** Caller owns the command transaction; locks the exact resource head, never starts or commits a transaction. */
export declare function lockZoneHead(tx: CommandTransaction, route: number, id: string): Promise<ZoneHead | null>;
export declare function insertZone(tx: CommandTransaction, input: {
    route: number;
    id: string;
    ownerId: string;
    visibility: ZoneHead['visibility'];
    configuration: ZoneConfiguration;
    mounts: string[];
    releaseDigest: string;
    at: string;
    transactionId: string;
}): Promise<ZoneHead>;
/** Sole payload/state writer. Supply the locked head; both resource and lifecycle revisions fence the update.
 * Lifecycle callers share their command transaction with receipts/outbox and preserve independent evidence.
 */
export declare function compareAndSetZone(tx: CommandTransaction, before: ZoneHead, next: Pick<ZoneHead, 'ownerId' | 'state' | 'visibility' | 'configuration' | 'mounts' | 'releaseDigest' | 'deletedAt' | 'restoreUntil' | 'writeFenced' | 'withholding' | 'held'>, context: {
    at: string;
    transactionId: string;
}): Promise<ZoneHead | null>;
