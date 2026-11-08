import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, Resource } from '../request/access.ts';
import type { Account } from './account-data.ts';
declare const floorIdentity: unique symbol;
export type CredentialFloorIdentity = {
    readonly [floorIdentity]: true;
};
export declare const floorIdentities: WeakMap<CredentialFloorIdentity, {
    actor: AccountActor;
    account: Account;
    pool: Pool;
}>;
export declare const floorBridges: WeakMap<Access, (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>>;
/** Installed once by the ordinary Access factory; no actor JSON registration. */
export declare function installCredentialFloorBridge(access: Access, bridge: (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>): void;
/** Opaque evidence exists only after exact native consumed-row verification. */
export declare function credentialFloorIdentityClaims(proof: CredentialFloorIdentity, pool: Pool): {
    actor: AccountActor;
    account: Account;
    pool: Pool;
} | undefined;
export {};
