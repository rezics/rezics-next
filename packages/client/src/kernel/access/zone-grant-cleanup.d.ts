import type { CommandTransaction } from '../command/command.ts';
export type ZoneCleanupBranch = 'ordinary-expiry' | 'early-privacy' | 'legal-order' | 'terminal-account';
export type ZoneGrantCleanupSource = Readonly<{
    zone: Readonly<{
        route: number;
        zoneId: string;
        home: Readonly<{
            partition: number;
            epoch: string;
        }>;
    }>;
    revision: string;
    lifecycleRevision: string;
    generation: string;
    progress: string;
    protectionRevision: string;
}>;
declare const admittedZoneCleanup: unique symbol;
declare const zoneCleanupBranchEvidence: unique symbol;
/** Semantic supplies this only after admitting and locking its current Zone branch. */
export type ZoneCleanupBranchEvidence = Readonly<{
    [zoneCleanupBranchEvidence]: true;
}>;
export type ZonePrimaryOwnerEvidence = Readonly<{
    accountId: string;
    revision: string;
    lifecycleRevision: string;
    transactionId: string;
}>;
/** Opaque, transaction-local owner input. There is deliberately no Access-side issuer. */
export type ZoneGrantCleanupAdmission = (Readonly<{
    kind: 'zone-disposition';
    branch: ZoneCleanupBranch;
    source: ZoneGrantCleanupSource;
    branchEvidence: ZoneCleanupBranchEvidence;
}> | Readonly<{
    kind: 'terminal-account-subject';
    branch: 'terminal-account';
    source: ZoneGrantCleanupSource;
    accountId: string;
    barrier: Readonly<{
        version: string;
        at: string;
    }>;
    primaryOwner: ZonePrimaryOwnerEvidence;
}>) & Readonly<{
    [admittedZoneCleanup]: true;
}>;
export type ZoneGrantCleanupCursor = Readonly<{
    scope: Readonly<{
        kind: ZoneGrantCleanupAdmission['kind'];
        branch: ZoneCleanupBranch;
        zone: ZoneGrantCleanupSource['zone'];
        revision: string;
        lifecycleRevision: string;
        generation: string;
        progress: string;
        protectionRevision: string;
        terminal?: Readonly<{
            accountId: string;
            barrierVersion: string;
            barrierAt: string;
            primaryOwner: ZonePrimaryOwnerEvidence;
        }>;
    }>;
    store: 'resource_grant' | 'resource_role_grant';
    afterKey: string;
}>;
export type ZoneGrantCleanupPage = Readonly<{
    disposition: 'progress' | 'complete' | 'rebound';
    candidateKeys: number;
    processedKeys: number;
    removedRows: number;
    next: ZoneGrantCleanupCursor | null;
}>;
/**
 * Minimize one bounded Access grant page inside the Semantic owner's command.
 * Semantic locks/rechecks the Zone parent first and persists `next` with its
 * existing cleanup CAS in this same transaction.
 */
export declare function minimizeZoneGrantPage(tx: CommandTransaction, input: Readonly<{
    admission: ZoneGrantCleanupAdmission;
    cursor: ZoneGrantCleanupCursor | null;
    limit: number;
}>): Promise<ZoneGrantCleanupPage>;
/** Serialize Zone grant additions with its source parent and terminal subject barrier. */
export declare function lockZoneGrantWriterTarget(tx: CommandTransaction, input: Readonly<{
    resource: Readonly<{
        route: number;
        id: string;
    }>;
    subjectAccountId?: string;
    addsGrant: boolean;
}>): Promise<boolean>;
export {};
