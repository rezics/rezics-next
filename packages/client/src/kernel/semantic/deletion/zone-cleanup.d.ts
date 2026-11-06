import { type ZoneGrantCleanupAdmission, type ZoneGrantCleanupCursor, type ZoneGrantCleanupPage, type ZonePrimaryOwnerEvidence } from '../../access/zone-grant-cleanup.ts';
import type { CommandTransaction } from '../../command/command.ts';
import type { ZoneHead } from '../../zones/resource-head.ts';
export type ZoneCleanupIntent = 'ordinary-expiry' | 'early-privacy' | 'legal-order' | 'terminal-account';
export type ZoneCleanupAdmission = Readonly<{
    branch: ZoneCleanupIntent;
    zoneId: string;
    route: number;
    revision: string;
    lifecycleRevision: string;
    generation: string;
    protectionRevision: string;
    grants: ZoneGrantCleanupAdmission;
}>;
/** Issue Access's opaque grant admission only after the Zone parent is locked in this command. */
export declare function admitZoneCleanup(tx: CommandTransaction, row: ZoneHead, input: Readonly<{
    at: string;
    accountId?: string;
    primaryOwner?: ZonePrimaryOwnerEvidence;
    resume?: ZoneGrantCleanupCursor;
}>): Promise<ZoneCleanupAdmission | null>;
export declare function advanceZoneCleanupGrants(tx: CommandTransaction, admission: ZoneCleanupAdmission, cursor: ZoneGrantCleanupCursor | null, limit: number): Promise<ZoneGrantCleanupPage>;
