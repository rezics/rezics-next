import { type CommandTransaction } from '../command/command.ts';
declare const lockedClaim: unique symbol;
export type LockedRealmClaimApproval = Readonly<{
    readonly [lockedClaim]: true;
    realmId: string;
    requestId: string;
    claimantAccountId: string;
    orphanedAt: string;
    claimEligibleAt: string;
    requestedAt: string;
}>;
export type RealmClaimApprovalResult = Readonly<{
    realmId: string;
    requestId: string;
    claimantAccountId: string;
    state: 'owned';
    orphanedAt: string;
    approvedAt: string;
}>;
/** Source custody only. Accounts owns current platform admission, receipt replay and grants. */
export declare function lockRealmClaimApprovalSource(tx: CommandTransaction, input: Readonly<{
    realmId: string;
    requestId: string;
}>): Promise<LockedRealmClaimApproval | null>;
/** Consume only native locks in this live attempt, after Accounts has installed the owner grant. */
export declare function applyRealmClaimApproval(tx: CommandTransaction, source: LockedRealmClaimApproval): Promise<RealmClaimApprovalResult>;
export {};
