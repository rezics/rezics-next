import type { Pool } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import { type MembersPreparationWorkDefinition, type PreparationLocator } from '../library/members-preparation.ts';
import type { Access } from '../request/access.ts';
import { type CollectionKindPreparationLocator, type CollectionKindWorkDefinition } from '../library/collection-kind-work-admission.ts';
/** SERVER ONLY. A native lookup, never an Actor, permission, DTO or persisted cursor value. */
export type MembersPreparationWorkContext = Readonly<{
    kind: 'members-preparation';
    tx: OperationalTransaction;
    locator: PreparationLocator;
}>;
/** SERVER ONLY. A distinct native Kind episode, never a curated Members locator. */
export type CollectionKindPreparationWorkContext = Readonly<{
    kind: 'collection-kind-preparation';
    tx: OperationalTransaction;
    locator: CollectionKindPreparationLocator;
}>;
export type ScopeWorkContext = MembersPreparationWorkContext | CollectionKindPreparationWorkContext;
type WorkOptions = Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>;
/** Admission and the whole native result are reread on every use, before any Source I/O. */
export declare function readCollectionKindPreparationWorkDefinition(work: CollectionKindPreparationWorkContext, options: WorkOptions): Promise<CollectionKindWorkDefinition>;
/** Dispatch only; the original native modules remain the sole episode and result authorities. */
export declare function readScopeWorkDefinition(work: ScopeWorkContext, options: WorkOptions): Promise<Readonly<{
    definition: import("../library/members-preparation.ts").PreparationDefinition;
    sourceIdentity: import("../library/native-source-custody.ts").NativeSourceIdentity;
    observation: import("../library/collection-source.ts").CollectionSourceObservation;
}> | Readonly<{
    releaseDigest: string;
    audience: string;
    sourceIdentity: import("../library/native-source-custody.ts").NativeSourceIdentity;
    observation: import("../library/collection-source.ts").CollectionSourceObservation;
    identityObservation: import("../semantic/identity-scope-types.ts").IdentityScopeObservation;
    repairReceipt: import("../semantic/identity-epoch-contract.ts").IdentityNativeReceipt;
    custody: import("../library/native-source-custody.ts").NativeSourceCustody;
}>>;
export declare function admitScopeWork(work: ScopeWorkContext, options: WorkOptions): Promise<AuthoritativeTime>;
/** Read the actual immutable producer inputs on each use, with no retained admission verdict. */
export declare function readMembersPreparationWorkDefinition(work: MembersPreparationWorkContext, options: Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>): Promise<MembersPreparationWorkDefinition>;
/** Trusted time comes only from the live Core attempt, after native immutable episode admission. */
export declare function admitMembersPreparationWork(work: MembersPreparationWorkContext, options: Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>): Promise<AuthoritativeTime>;
export {};
