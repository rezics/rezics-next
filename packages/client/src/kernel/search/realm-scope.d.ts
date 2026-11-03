import { type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { RelationFacetMatch } from './source.ts';
import { type RealmSubjectSource, type RealmSubjectDisclosure, type RealmSubjectMaintenance } from '../content/realm-subject-source.ts';
export type { RealmSubjectObservation, RealmSubjectResolution, RealmSubjectMembership, RealmSubjectSource, RealmSubjectDisclosure, RealmSubjectMaintenance, } from '../content/realm-subject-source.ts';
/** Native composition belongs to Content. Supplying only structural census or exact
 * candidate disclosure cannot establish live population readiness.
 */
export type RealmSubjectCapabilities = Readonly<{
    disclosure: RealmSubjectDisclosure;
    maintenance: RealmSubjectMaintenance;
}>;
declare const prepared: unique symbol;
export type PreparedRealmScope = Readonly<{
    [prepared]: true;
    /** Population readiness is not a canonical useful Search page. */
    readiness: 'population_ready';
    basis: string;
}>;
/** Additive native preparation/evaluation boundary on the real service-bound Scope.
 * This does not activate public mixed-kind admission or claim ready ordered pages.
 */
export declare function createRealmScopeSource(input: {
    pool: Pool;
    reader?: LeafOptions;
    source?: RealmSubjectSource;
    capabilities?: RealmSubjectCapabilities;
    release: (digest?: string) => Promise<Readonly<{
        digest: string;
        release: FilterRelease;
    }> | null>;
}): {
    prepare(filter: DiscoveryFilterDocument, allowance: WorkAllowance): Promise<Readonly<{
        scope: PreparedRealmScope;
        work: WorkReceipt;
    }>>;
    /** Raw producer input for finite preparation. Never a successful Search result page. */
    sourcePrefix(scope: PreparedRealmScope, realm: string, after: string | null, limit: number, allowance: WorkAllowance): Promise<{
        subjects: readonly string[];
        after: string | null;
        exhausted: boolean;
        basis: string;
        work: WorkReceipt;
    }>;
    /** Preparation-only full catalogue/Realm predicate, using the existing native
     * catalogue evaluator and its ledger. Final Search disclosure still requires the
     * canonical prepared Source observation. Unknown evidence cannot prove NOT.
     */
    evaluate(scope: PreparedRealmScope, subjects: readonly string[], allowance: WorkAllowance): Promise<{
        basis: string;
        values: RelationFacetMatch[];
        work: WorkReceipt;
    }>;
};
