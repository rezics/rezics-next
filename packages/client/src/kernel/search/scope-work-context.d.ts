import type { Pool } from 'pg';
import { type AuthoritativeTime } from '../command/command.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import type { Access } from '../request/access.ts';
import type { MembersPreparationWorkDefinition, SearchLibraryScopePort, SearchNativeCollectionWork } from './library-scope-port.ts';
import type { CollectionKindPreparationLocator, CollectionKindWorkDefinition } from '../library/collection-kind-work-admission.ts';
import type { CollectionPublicationWorkDefinition } from '../library/collection-publication-work-admission.ts';
import type { MembersPreparationWorkContext, CollectionKindPreparationWorkContext, CollectionPublicationWorkContext, ScopeWorkContext } from '../library/adapters/index.ts';
export type { MembersPreparationWorkContext, CollectionKindPreparationWorkContext, CollectionPublicationWorkContext, ScopeWorkContext, } from '../library/adapters/index.ts';
/** Mint a context only from the live transaction's exact admitted native frame. */
export declare function bindCollectionKindPreparationWorkContext(tx: OperationalTransaction, locator: CollectionKindPreparationLocator, work: SearchNativeCollectionWork): CollectionKindPreparationWorkContext;
/** Accounts consumes the same private original Kind frame, never a structural context. */
export declare function collectionKindPreparationNativeWork(context: CollectionKindPreparationWorkContext): SearchNativeCollectionWork | undefined;
type WorkOptions = Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
    library?: SearchLibraryScopePort;
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
    library?: SearchLibraryScopePort;
}>): Promise<MembersPreparationWorkDefinition>;
/** Trusted time comes only from the live Core attempt, after native immutable episode admission. */
export declare function admitMembersPreparationWork(work: MembersPreparationWorkContext, options: Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
    library?: SearchLibraryScopePort;
}>): Promise<AuthoritativeTime>;
