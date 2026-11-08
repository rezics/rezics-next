/** Native specialization of the Library port. No Search implementation or vocabulary is imported. */
import type { PreparationWorkCapability, ScopeWorkCapability } from '../contract/index.ts';
import type { Pool } from 'pg';
import type { OperationalTransaction } from '../../command/operational.ts';
import type { Access } from '../../request/access.ts';
import type { WorkContext } from '../../work/registry.ts';
import type { NativeCollectionWork } from '../collection-native-work.ts';
import type { NativeSourceIdentity } from '../native-source-custody.ts';
import type { PreparationDefinition, PreparationLocator, MembersPreparationWorkDefinition } from '../members-preparation.ts';
import type { CollectionKindPreparationLocator, CollectionKindWorkDefinition } from '../collection-kind-work-admission.ts';
import type { CollectionPublicationLocator, CollectionPublicationWorkDefinition } from '../collection-publication-work-admission.ts';
/** These server-only frames are native locators, never reader Actors or persisted request values. */
export type MembersPreparationWorkContext = Readonly<{
    kind: 'members-preparation';
    tx: OperationalTransaction;
    locator: PreparationLocator;
}>;
export type CollectionKindPreparationWorkContext = Readonly<{
    kind: 'collection-kind-preparation';
    tx: OperationalTransaction;
    locator: CollectionKindPreparationLocator;
}>;
export type CollectionPublicationWorkContext = Readonly<{
    kind: 'collection-publication';
    tx: OperationalTransaction;
    locator: CollectionPublicationLocator;
}>;
export type ScopeWorkContext = MembersPreparationWorkContext | CollectionKindPreparationWorkContext | CollectionPublicationWorkContext;
export type NativePreparationPrefixRequest = Readonly<{
    work: MembersPreparationWorkContext;
    budget: NativeCollectionWork;
    definition: PreparationDefinition;
    sourceIdentity: NativeSourceIdentity;
    checkpoint: string | null;
    access: Access;
    routeKey: Buffer;
    deadline: number;
}>;
export type NativePreparationWork = PreparationWorkCapability<OperationalTransaction, NativeCollectionWork, NativePreparationPrefixRequest>;
export type NativePreparationWorkFactory = (context: WorkContext) => NativePreparationWork;
export type NativeScopeWorkDefinition = MembersPreparationWorkDefinition | CollectionKindWorkDefinition | CollectionPublicationWorkDefinition;
export type NativeScopeWork = ScopeWorkCapability<ScopeWorkContext, Readonly<{
    pool: Pool;
    access: Access;
    deadline: number;
}>, NativeScopeWorkDefinition>;
