import { createNativeBuiltinRuntime } from './builtin-runtime.ts';
import type { Pool, PoolClient } from 'pg';
import type { Access, Actor, AccessContext } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import type { KernelClock } from '../../clock.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import type { ContributionAttribution } from '../../access/contract/index.ts';
import type { SubjectSummary, IdentityMapping } from '../../semantic/contract/index.ts';
import type { LibrarySemanticObservationCapability, LibrarySemanticSummaryObservation } from '../contract/semantic-observation.ts';
import type { createResourcePublicEligibility } from '../../access/adapters/index.ts';
import type { CurrentAccountEligibilityCapability, CurrentObservation, LibraryAccountSummary, LibraryTargetSummary, FollowingSpaceProjection, LibraryCursorCapability, SubjectIdentityCapability, SubjectReferenceObservation, WorkDimensions } from '../contract/index.ts';
export type LibraryPresentationDependencies = {
    routeKey: Uint8Array;
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    clock?: KernelClock;
};
export type LibraryIdentityContext = {
    pool: Pool;
    access: Access;
    actor: Actor;
    context: AccessContext;
    at?: AuthoritativeTime;
};
type SummaryContext = {
    pool: Pool;
    routeKey: Uint8Array;
    access: Access;
    actor: Actor;
    deadline: number;
    work?: AccessWorkAccounting;
};
/** Composition supplies real foreign adapters; this host owns no producer implementation or fallback. */
export type NativeLibraryPresentationPorts = {
    semanticObservations: LibrarySemanticObservationCapability;
    cursors: LibraryCursorCapability<KeyRing>;
    identity: SubjectIdentityCapability<LibraryIdentityContext, IdentityMapping, SubjectReferenceObservation & Readonly<{
        work: WorkDimensions;
    }>>;
    readMappings(pool: Pool, ids: readonly string[]): Promise<import('../contract/semantic-observation.ts').LibrarySemanticObservationResult<readonly IdentityMapping[]>>;
    accountEligibility: CurrentAccountEligibilityCapability<Pick<PoolClient, 'query'>>;
    createResourcePublicEligibility: typeof createResourcePublicEligibility;
    observeSubjects(context: SummaryContext, ids: readonly string[]): Promise<import('../contract/semantic-observation.ts').LibrarySemanticObservationResult<LibrarySemanticSummaryObservation>>;
    observeAccount(pool: Pool, id: string, deadline: number): Promise<CurrentObservation<LibraryAccountSummary | null>>;
    observeAttributions(pool: Pool, ids: readonly string[], deadline: number): Promise<CurrentObservation<ReadonlyMap<string, ContributionAttribution>>>;
    observeSpace(deps: {
        pool: Pool;
        access: Access;
        clock?: KernelClock;
    }, actor: Actor, id: string, type: string, deadline: number, work?: AccessWorkAccounting): Promise<CurrentObservation<LibraryTargetSummary | null>>;
};
export declare function createNativeLibraryPresentation(ports: NativeLibraryPresentationPorts): {
    semanticObservations: LibrarySemanticObservationCapability;
    builtins: (config: Parameters<typeof createNativeBuiltinRuntime>[1]) => {
        read: (actor: Actor, id: string, scope?: "collection:delete" | "collection:read" | "collection:update", deadline?: number) => Promise<import("./builtin-runtime.ts").BuiltinCollectionView | null>;
        discover: (actor: Actor, after?: string | null, limit?: number) => Promise<import("./builtin-runtime.ts").BuiltinCollectionView[]>;
        resolve: (actor: Actor, key: Exclude<import("../builtin-identity.ts").BuiltinCollectionKey, {
            kind: 'liked';
        }>, deadline?: number) => Promise<import("./builtin-runtime.ts").BuiltinCollectionView | null>;
        members: (actor: import("./authorization.ts").LibraryActor, id: string, options?: import("../contract/builtin-presentation.ts").BuiltinMemberOptions<{
            filter: import("@rezics/filter").FilterDocument;
            releaseDigest: string;
        }>) => Promise<{
            members: import("./builtin-runtime.ts").DynamicMemberView[];
            next: string | null;
        }>;
        sourceVersion: (actor: Actor, source: import("./builtin-runtime.ts").BuiltinCollectionView, deadline: number, allowAbsent?: boolean) => Promise<string>;
    };
    builtinOriginalInputs: (pool: Pool, accountId: string, after: string | null, limit: number) => Promise<{
        fact: {
            clear?: {
                sequence: bigint;
            };
            original: string;
            presence: boolean | null;
            families: {
                entry: boolean;
                label: boolean | null;
                session: boolean;
                copy: boolean;
            };
            state: {
                id: string;
                sequence: bigint | null;
                pin: import("@rezics/definitions").LibraryProfilePin | null;
            } | null;
        };
        mapping: IdentityMapping;
    }[]>;
    identity: {
        observe: (context: LibraryIdentityContext, id: string) => Promise<Readonly<{
            resolved: import("../subject-anchor.ts").ResolvedSubject;
            epoch: bigint;
        }> | null>;
        resolve(context: LibraryIdentityContext, id: string): Promise<import("../subject-anchor.ts").ResolvedSubject | null>;
        readable(context: LibraryIdentityContext, ids: readonly string[]): Promise<string[]>;
    };
    readMappings: (pool: Pool, ids: readonly string[]) => Promise<readonly IdentityMapping[]>;
    admitOwner: import("../contract/presentation.ts").BuiltinOwnerAdmission<Pick<PoolClient, "query">>;
    fullMembers(deps: LibraryPresentationDependencies, actor: Actor, id: string, options: {
        cursor?: string;
        limit?: number;
        languages?: readonly string[];
    }, deadline: number): Promise<import("../../search/service-contract.ts").SavedCatalogueMembersPage | {
        members: import("../collection-reads.ts").MemberView[];
        next: string | null;
    } | {
        preparing: true;
    }>;
    fullView<T>(deps: LibraryPresentationDependencies, actor: Actor, view: string | undefined, body: T, options: {
        deadline: number;
        follow?: true;
        withholdChangedSource?: true;
        followingSpaces?: (actor: Actor, ids: readonly string[], deadline: number) => Promise<ReadonlyMap<string, FollowingSpaceProjection>>;
    }): Promise<import("../contract/presentation.ts").LibraryEmbedding<T, SubjectSummary, ContributionAttribution>>;
};
export type NativeLibraryPresentation = ReturnType<typeof createNativeLibraryPresentation>;
export {};
