import type { FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { ScopeWork } from '../search/scope-execution.ts';
import { type SearchService } from '../search/service-scope.ts';
import { type WorkAllowance, type WorkReceipt, type WorkDimensions } from './contract/work-dimensions.ts';
import { type OrdinaryCollectionPagePlan } from './ordinary-read-bounds.ts';
export type OwnerQueryDependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
    routeKey?: Uint8Array;
    search?: SearchService;
};
declare class OwnerQueryWorkLedger extends ScopeWork {
    readonly plan: OrdinaryCollectionPagePlan;
    constructor(plan: OrdinaryCollectionPagePlan);
    consume(used: WorkDimensions): void;
}
/** Canonical and Search work settle into the same request reservation, including failed dispatches. */
export declare function ownerQueryWork(limit: number, view?: 'BASIC' | 'FULL'): OwnerQueryWorkLedger;
/** One current native Source and the registered Search service. No owner/client impersonation or GET work. */
export declare function openOwnerQuery(deps: OwnerQueryDependencies, input: {
    actor: Actor;
    collectionId: string;
    deadline: number;
    work: ScopeWork;
    logical?: boolean;
    at?: AuthoritativeTime;
}): Promise<{
    source: import("./collection-source.ts").PreparedCollectionSource;
    native: import("./collection-source.ts").CollectionSource;
    context: {
        actor: Actor;
        at: AuthoritativeTime;
        deadline: number;
    };
    close(): void;
    /** Complete native group, never a point mapping used as alias/population coverage. */
    originals(subjectId: string): Promise<string[]>;
    filter(filter: FilterDocument, releaseDigest: string): Promise<{
        scope: {
            realm: {
                realms(scope: import("../search/realm-scope.ts").PreparedRealmScope): readonly string[];
                prepare(filter: import("@rezics/filter").DiscoveryFilterDocument, allowance: WorkAllowance, expectedReleaseDigest?: string): Promise<Readonly<{
                    scope: import("../search/realm-scope.ts").PreparedRealmScope;
                    work: WorkReceipt;
                }>>;
                sourcePrefix(scope: import("../search/realm-scope.ts").PreparedRealmScope, realm: string, after: string | null, limit: number, allowance: WorkAllowance): Promise<{
                    subjects: readonly string[];
                    after: string | null;
                    exhausted: boolean;
                    basis: string;
                    work: WorkReceipt;
                }>;
                evaluate(scope: import("../search/realm-scope.ts").PreparedRealmScope, subjects: readonly string[], allowance: WorkAllowance): Promise<{
                    basis: string;
                    values: import("../search/source.ts").RelationFacetMatch[];
                    work: WorkReceipt;
                }>;
                refinePrefix(scope: import("../search/realm-scope.ts").PreparedRealmScope, frontier: import("../search/realm-scope.ts").RealmRefinementFrontier | null, allowance: WorkAllowance): Promise<Readonly<{
                    readiness: 'refined_input';
                    basis: string;
                    subjects: readonly string[];
                    frontier: import("../search/realm-scope.ts").RealmRefinementFrontier | null;
                    exhausted: boolean;
                    work: WorkReceipt;
                }>>;
                revalidate(scope: import("../search/realm-scope.ts").PreparedRealmScope, allowance: WorkAllowance): Promise<WorkReceipt>;
                searchBasis: (prepared: import("../search/realm-scope.ts").PreparedRealmScope, request: {
                    text?: string;
                    textQuery?: Record<string, unknown>;
                    textBoost?: string;
                    generation: number;
                    indexUuid: string;
                }) => import("../search/scope-source.ts").ScopeBasis;
                searchPage: (prepared: import("../search/realm-scope.ts").PreparedRealmScope, request: {
                    basis: import("../search/scope-source.ts").ScopeBasis;
                    text?: string;
                    textQuery?: Record<string, unknown>;
                    textBoost?: string;
                    generation: number;
                    indexUuid: string;
                    after: import("../search/scope-ordered.ts").ScopeNameSortTuple | null;
                    quota: number;
                    allowance: WorkAllowance;
                }) => Promise<{
                    status: 'preparing';
                    basis: import("../search/scope-source.ts").ScopeBasis;
                    work: WorkReceipt;
                    hits?: never;
                    subjects?: never;
                    after?: never;
                    exhausted?: never;
                } | {
                    status: 'ready';
                    basis: import("../search/scope-source.ts").ScopeBasis;
                    hits: import("../search/query.ts").SearchHit[];
                    subjects: import("../search/source.ts").IndexedSubject[];
                    after: import("../search/scope-ordered.ts").ScopeNameSortTuple | null;
                    exhausted: boolean;
                    work: WorkReceipt;
                }>;
            };
            work(result: import("../search/scope-source.ts").PreparedSearchScope | import("../search/scope-source.ts").SearchScopeEvaluation): WorkReceipt;
            prepare(filter: FilterDocument, options?: import("../search/scope-source.ts").ScopePrepareOptions): Promise<import("../search/scope-source.ts").PreparedSearchScope>;
            orderedPrefix(prepared: import("../search/scope-source.ts").PreparedSearchScope, request: import("../search/scope-ordered.ts").ScopeOrderedPrefixRequest): Promise<import("../search/scope-ordered.ts").SearchScopeOrderedPrefix>;
            prefix(prepared: import("../search/scope-source.ts").PreparedSearchScope, request: {
                afterSubject: string | null;
                quota: number;
                budget: number;
                allowance?: WorkAllowance;
            }): Promise<import("../search/scope-source.ts").SearchScopePrefix>;
            evaluate(prepared: import("../search/scope-source.ts").PreparedSearchScope, subjects: readonly string[], reservation: import("../search/scope-source.ts").ScopeEvaluationReservation): Promise<import("../search/scope-source.ts").SearchScopeEvaluation>;
            sourcePrefix(prepared: import("../search/scope-source.ts").PreparedSearchScope, request: {
                afterSubjectId: string | null;
                allowance: WorkAllowance;
                candidateLimit?: number;
            }): Promise<{
                kind: 'canonical_subject_prefix';
                candidates: readonly import("./collection-source.ts").CanonicalCollectionCandidate[];
                coveredThrough: string | null;
                exhausted: boolean;
                observation: import("./collection-source.ts").CollectionSourceObservation;
                basis: import("../search/scope-source.ts").ScopeBasis;
                work: WorkReceipt;
            }>;
            ordinalPrefix(prepared: import("../search/scope-source.ts").PreparedSearchScope, request: {
                after: import("./collection-source-order.ts").NativeOrdinalKey | null;
                quota: number;
                allowance: WorkAllowance;
            }): Promise<import("../search/service-scope-order.ts").SearchScopeOrdinalPrefix>;
        };
        prepared: import("../search/scope-source.ts").PreparedSearchScope;
    }>;
}>;
export {};
