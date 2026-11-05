import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';
import type { FacetDiscoveryScope } from './facet-discovery-contract.ts';
import { ScopeWork } from './scope-execution.ts';
import type { PreparedSearchScope } from './scope-source.ts';
import type { createSearchScopeForService } from './service-scope.ts';
import type { PreparedRealmScope } from './realm-scope.ts';
type SearchResourceScope = FacetDiscoveryScope;
/** Identity supplied by the scope admission owner. `source` names the actual native population,
 * `meaning` binds the admitted query, and the observations bind membership and current authorization.
 */
export type ScopedFacetIdentity = Readonly<{
    source: string;
    meaning: string;
    population: string;
    authorization: string;
}>;
/** Internal admitted request. The opaque request stays in memory and is never serialized into a cursor. */
export type ScopedFacetAdmission = Readonly<{
    identity: ScopedFacetIdentity;
    request: unknown;
}>;
export type ScopedFacetObservation = Readonly<{
    status: 'observed';
    identity: ScopedFacetIdentity;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'unready' | 'unavailable';
    cost: PublicFilterCost;
}>;
export type ScopedFacetCandidatePage = Readonly<{
    status: 'progress' | 'complete';
    identity: ScopedFacetIdentity;
    subjects: readonly string[];
    frontier: string;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'changed' | 'unready' | 'unavailable';
    cost: PublicFilterCost;
}>;
export type ScopedFacetMembership = Readonly<{
    status: 'matched';
    identity: ScopedFacetIdentity;
    subjects: readonly Readonly<{
        subject: string;
        member: boolean | 'not_proven';
    }>[];
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'changed' | 'unready' | 'unavailable';
    cost: PublicFilterCost;
}>;
/** Scope owners provide these existing native candidate and current membership reads. A candidate
 * page is the complete next input window for this admitted source; `complete` proves source exhaustion.
 */
export type ScopedFacetPorts = Readonly<{
    observe(request: unknown, context: PublicFilterConsumerContext): Promise<ScopedFacetObservation>;
    readCandidates(request: unknown, after: string | null, inputLimit: number, context: PublicFilterConsumerContext): Promise<ScopedFacetCandidatePage>;
    readMembership(request: unknown, subjects: readonly string[], context: PublicFilterConsumerContext): Promise<ScopedFacetMembership>;
}>;
/** Keep service-bound scope handles in memory; neither owner ports nor native locators enter the facet wire. */
export declare function bindScopedFacetPorts(ports: ScopedFacetPorts, request: unknown): unknown;
export type ScopedFacetPage = Readonly<{
    status: 'progress' | 'complete';
    observation: string;
    subjects: readonly Readonly<{
        partition: number;
        subject: string;
    }>[];
    frontier: string;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'changed' | 'unready' | 'unavailable';
    cost: PublicFilterCost;
}>;
export declare function scopedFacetIdentityKey(identity: ScopedFacetIdentity): string;
/** Bind complete native subject pages to one admitted Realm or Collection observation.
 * A changed/uncertain membership read yields no subjects, so callers cannot fall back to Global.
 */
export declare function createScopedFacetSource(ports?: ScopedFacetPorts): {
    observe: (admission: ScopedFacetAdmission, context: PublicFilterConsumerContext) => Promise<Readonly<{
        status: 'observed';
        identity: ScopedFacetIdentity;
        cost: PublicFilterCost;
    }> | Readonly<{
        status: 'unready' | 'unavailable';
        cost: PublicFilterCost;
    }>>;
    readPage(admission: ScopedFacetAdmission, after: string | null, inputLimit: number, context: PublicFilterConsumerContext): Promise<ScopedFacetPage>;
};
/** Adapt the installed service-bound Collection Scope to the facet owner's finite candidate and current-evaluation ports. */
export declare function createServiceScopeFacetPorts(_resource: SearchResourceScope): ScopedFacetPorts;
export declare function serviceScopeFacetIdentity(resource: SearchResourceScope, prepared: PreparedSearchScope, principal: string, meaning: unknown): ScopedFacetIdentity;
export declare function serviceScopeFacetAdmission(input: Readonly<{
    resource: SearchResourceScope;
    scope: ReturnType<typeof createSearchScopeForService>;
    prepared: PreparedSearchScope;
    work: ScopeWork;
    principal: string;
    meaning: unknown;
}>): ScopedFacetAdmission;
/** Adapt Content Realm population and the shared current Realm/Subject evaluator to retained facets. */
export declare function createServiceRealmScopeFacetPorts(): ScopedFacetPorts;
export declare function serviceRealmScopeFacetAdmission(input: Readonly<{
    resource: SearchResourceScope;
    scope: ReturnType<typeof createSearchScopeForService>;
    prepared: PreparedRealmScope;
    realms: readonly string[];
    work: ScopeWork;
    principal: string;
    meaning: unknown;
}>): ScopedFacetAdmission;
export {};
