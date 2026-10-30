import type { FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type AuthoritativeTime } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import { ScopeWork } from '../search/scope-execution.ts';
import { type SearchService } from '../search/service-scope.ts';
import { type WorkAllowance, type WorkReceipt, type WorkDimensions } from './collection-source.ts';
export type OwnerQueryDependencies = {
    pool: Pool;
    access: Access;
    clock?: KernelClock;
    routeKey?: Uint8Array;
    search?: SearchService;
};
declare class OwnerQueryWork extends ScopeWork {
    consume(used: WorkDimensions): void;
}
/** Canonical and Search work settle into the same request reservation, including failed dispatches. */
export declare function ownerQueryWork(limit: number): OwnerQueryWork;
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
            work(result: import("../search/scope-source.ts").PreparedSearchScope | import("../search/scope-source.ts").SearchScopeEvaluation): WorkReceipt;
            prepare(filter: FilterDocument, options?: import("../search/scope-source.ts").ScopePrepareOptions): Promise<import("../search/scope-source.ts").PreparedSearchScope>;
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
            }): Promise<{
                basis: import("../search/scope-source.ts").ScopeBasis;
                work: WorkReceipt;
                kind: 'canonical_subject_prefix';
                candidates: readonly import("./collection-source.ts").CanonicalCollectionCandidate[];
                coveredThrough: string | null;
                exhausted: boolean;
                observation: import("./collection-source.ts").CollectionSourceObservation;
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
