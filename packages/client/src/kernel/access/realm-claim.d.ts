import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { RealmClaimApprovalResult } from './contract/index.ts';
export type ApproveRealmClaimInput = Readonly<{
    realmId: string;
    requestId: string;
}>;
export type ApproveRealmClaimContext = Readonly<{
    deadline: number;
    idempotencyKey: string;
}>;
export type RealmClaimApproval = RealmClaimApprovalResult;
export declare function approveRealmClaim(deps: Readonly<{
    pool: Pool;
    access: Access;
    clock?: () => Date;
}>, actor: Actor, input: ApproveRealmClaimInput, context: ApproveRealmClaimContext): Promise<RealmClaimApproval>;
