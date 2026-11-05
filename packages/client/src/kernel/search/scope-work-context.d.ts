import type { Pool } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import { type MembersPreparationWorkDefinition, type PreparationLocator } from '../library/members-preparation.ts';
import type { Access } from '../request/access.ts';
import { type CollectionKindPreparationLocator, type CollectionKindWorkDefinition } from '../library/collection-kind-work-admission.ts';
import type { NativeCollectionWork } from '../library/collection-source-work.ts';
import { type CollectionPublicationLocator, type CollectionPublicationWorkDefinition } from '../library/collection-publication-work-admission.ts';
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
/** Mint a context only from the live transaction's exact admitted native frame. */
export declare function bindCollectionKindPreparationWorkContext(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, work: NativeCollectionWork): CollectionKindPreparationWorkContext;
/** Accounts consumes the same private original Kind frame, never a structural context. */
export declare function collectionKindPreparationNativeWork(context: CollectionKindPreparationWorkContext): NativeCollectionWork | undefined;
/** SERVER ONLY. Whole-query publication B consumes its own Collection's private working input. */
export type CollectionPublicationWorkContext = Readonly<{
    kind: 'collection-publication';
    tx: OperationalTransaction;
    locator: CollectionPublicationLocator;
}>;
export type ScopeWorkContext = MembersPreparationWorkContext | CollectionKindPreparationWorkContext | CollectionPublicationWorkContext;
type WorkOptions = Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>;
/** Compare owner data, never manufacture an episode, capture, Actor or final command authority. */
export declare function readCollectionPublicationScopeWorkDefinition(work: CollectionPublicationWorkContext, options: WorkOptions): Promise<CollectionPublicationWorkDefinition>;
/** Admission and the whole native result are reread on every use, before any Source I/O. */
export declare function readCollectionKindPreparationWorkDefinition(work: CollectionKindPreparationWorkContext, options: WorkOptions): Promise<CollectionKindWorkDefinition>;
/** Dispatch only; the original native modules remain the sole episode and result authorities. */
export declare function readScopeWorkDefinition(work: ScopeWorkContext, options: WorkOptions): Promise<MembersPreparationWorkDefinition | CollectionKindWorkDefinition | CollectionPublicationWorkDefinition>;
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
