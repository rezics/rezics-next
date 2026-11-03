import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type OperationalTransaction } from '../command/operational.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { WorkClient } from '../work/client.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { CollectionSourceObservation } from './collection-source.ts';
import { type OperationalWorkRegistration } from '../history/operational-work.ts';
import type { OperationalWorkOriginal, OperationalWorkTransfer } from '../history/operational-work-budget.ts';
/** Internal admitted meaning, never an HTTP DTO or an execution/disclosure certificate. */
export type PreparationDefinition = Readonly<{
    filter: FilterDocument;
    sort: 'id' | 'ordinal';
    release: Readonly<{
        digest: string;
        value: FilterRelease;
    }>;
}>;
export type PreparationDefinitionBasis = Readonly<{
    definition: PreparationDefinition;
    canonicalBasis: string;
    basisDigest: Uint8Array;
}>;
/** Normalize accepted definitions to their exact shared expansion before native deduplication. */
export declare function preparationDefinitionBases(ownerAccountId: string, collectionId: string, definitions: readonly PreparationDefinition[]): readonly PreparationDefinitionBasis[];
export type PreparationLocator = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    episodeId: string;
}>;
/** Exact retained native episode inputs. Data only; never admission or disclosure authority. */
export type MembersPreparationWorkDefinition = Readonly<{
    definition: PreparationDefinition;
    sourceIdentity: NativeSourceIdentity;
    observation: CollectionSourceObservation;
}>;
export type PreparationIntent = Readonly<{
    queue: 'workflows';
    workflowName: 'library.membersPreparation';
    workflowId: string;
    input: Readonly<{
        accounts: readonly [string];
        route: number;
        episodes: readonly Readonly<{
            collectionId: string;
            episodeId: string;
        }>[];
        cleanup: readonly Readonly<{
            collectionId: string;
            episodeId: string;
        }>[];
    }>;
}>;
export type PreparingEpisode = Readonly<{
    state: 'preparing';
    locator: PreparationLocator;
    workflowId: string;
}>;
export type MembersPreparationHistory = Readonly<{
    registration: OperationalWorkRegistration;
    resolve: OperationalWorkTransfer;
    verify: OperationalWorkTransfer;
    receive: OperationalWorkTransfer;
    replay: OperationalWorkTransfer;
    retirement: OperationalWorkTransfer;
}>;
export interface MembersPreparation {
    /** One Collection's distinct definitions, bounded by the common-page read authority. */
    reserve(actor: Actor, collectionId: string, definitions: readonly PreparationDefinition[], options?: {
        deadline?: number;
        history?: OperationalWorkOriginal;
        runtime?: boolean;
    }): Promise<Readonly<{
        episodes: readonly PreparingEpisode[];
        intent: PreparationIntent | null;
        history?: MembersPreparationHistory;
    }>>;
    /** Only the admitted reader calls this after an actual read; duplicate preparation does not touch LRU. */
    touch(actor: Actor, locator: PreparationLocator, options?: {
        deadline?: number;
    }): Promise<boolean>;
    /** Called inside the registered step's fenced operational transaction; locks survive to its commit. */
    admitStep(tx: OperationalTransaction, locator: PreparationLocator): Promise<boolean>;
    /** Exact retained meaning on the admitted client; never Source or result authority. */
    readRetainedDefinition(tx: OperationalTransaction, locator: PreparationLocator): Promise<PreparationDefinition | null>;
    /** Read-only on the SAME live admitted Core client; null for an obsolete or unbound episode. */
    readWorkDefinition(tx: OperationalTransaction, locator: PreparationLocator): Promise<MembersPreparationWorkDefinition | null>;
}
/** Recover only the exact admitted definition, using the immutable release owned by Semantic.
 * The lookup digest is checked before release I/O; neither it nor the retained bytes grants Source authority.
 */
export declare function restorePreparationDefinition(ownerAccountId: string, collectionId: string, retained: Readonly<{
    canonicalBasis: string;
    basisDigest: Uint8Array;
}>, loadRelease: (digest: string) => Promise<FilterRelease | null>): Promise<PreparationDefinition>;
declare function validLocator(locator: PreparationLocator): boolean;
/** Native private episode admission. Work starts only after Core and Access have admitted the current owner. */
export declare function createMembersPreparation(config: {
    pool: Pool;
    workClient: WorkClient;
    access: Access;
    clock?: KernelClock;
}): MembersPreparation;
/** Canonical definition identity only; never current Source authority. */
export declare function preparationBasis(owner: string, collection: string, definition: PreparationDefinition): string;
export declare const validPreparationLocator: typeof validLocator;
/** Exact native step binding; no Actor or reusable disclosure grant. */
export declare function lockPreparationStep(tx: OperationalTransaction, locator: PreparationLocator): Promise<string | null>;
/** Retained metadata under the SAME actual admission as MembersPreparation.admitStep. No read permission. */
export declare function readPreparationStep(tx: OperationalTransaction, locator: PreparationLocator): Promise<{
    basis: string;
    version: string;
    checkpoint: string | null;
    observation: string | null;
    preparedIncarnation: string | null;
    preparedGeneration: string | null;
    complete: boolean;
    sourceExhausted: boolean;
    generation: string;
    incarnation: string;
} | null>;
/** Current native Scope70 metadata, read on the live admitted owner client; never an allow token. */
export declare function readPreparationScope(tx: OperationalTransaction, locator: PreparationLocator): Promise<IdentityScopeObservation | null>;
/** Current native Source and complete Scope metadata on this live client, independently of selected data. */
export declare function readPreparationSource(tx: OperationalTransaction, locator: PreparationLocator): Promise<{
    source: CollectionSourceObservation;
    scope: Readonly<{
        key: import("../semantic/identity-scope-types.ts").IdentityScopeKey;
        captureId: string;
        committedRevision: bigint;
    }>;
} | null>;
export declare function readPreparationOwnerFence(tx: OperationalTransaction, locator: PreparationLocator, definition: PreparationDefinition): Promise<string | null>;
/** Native association/currentness inside a genuine selected apply, never the expired request handoff.
 * The installed selected producer still refuses final Source/physical completion after the owned body.
 */
export declare function checkMembersPreparationCompletion(tx: OperationalTransaction, locator: PreparationLocator): Promise<Readonly<{
    status: 'obsolete';
}> | Readonly<{
    status: 'unavailable';
    operand: 'selected-runtime-final-source-physical-authority-unavailable';
}>>;
export type PreparationStepState = NonNullable<Awaited<ReturnType<typeof readPreparationStep>>>;
type ReaderDependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
    routeKey?: Uint8Array;
};
type ReadInput = Readonly<{
    actor: Actor;
    collectionId: string;
    definition: PreparationDefinition;
    deadline: number;
}>;
/** Complete observation equality includes excluded and order population. No native capability is deserialized. */
export declare function preparationObservation(source: CollectionSourceObservation, scope: IdentityScopeObservation, ownerFence?: string | null): string;
export type PreparedMembersRead = Readonly<{
    status: 'unavailable';
}> | Readonly<{
    status: 'preparing';
    locator: PreparationLocator | null;
}> | Readonly<{
    status: 'ready';
    locator: PreparationLocator;
    subjects: readonly string[];
    next: string | null;
    revalidate(): Promise<void>;
    release(): void;
}>;
/** Pure retained-result read. Its caller may choose ONE successful-read touch after the whole composed read.
 * Candidate rows supply order only. The native reader revalidates every authority before any complete page.
 */
export declare function readPreparedMembers(deps: ReaderDependencies, input: ReadInput, options?: {
    limit?: number;
    cursor?: string | null;
}): Promise<PreparedMembersRead>;
export {};
