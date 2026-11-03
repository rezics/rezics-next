import type { PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerContext } from './public-filter-consumer-contract.ts';
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
export declare function createScopedFacetSource(ports: ScopedFacetPorts): {
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
