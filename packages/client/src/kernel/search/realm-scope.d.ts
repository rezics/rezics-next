import { type DiscoveryFilterDocument, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import type { WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { ScopeWork } from './scope-execution.ts';
import type { RelationFacetMatch } from './source.ts';
/** Content-owned native observation. Every dependency, including private grants/ban,
 * opening revision, placement and original/terminal subject disclosure, fences revision.
 * It is a locator for fresh owner checks, never a permission or a membership verdict.
 */
export type RealmSubjectObservation = Readonly<{
    realm: string;
    revision: string;
}>;
export type RealmSubjectResolution = Readonly<{
    state: 'ready';
    observation: RealmSubjectObservation;
}> | Readonly<{
    state: 'concealed' | 'unavailable';
}>;
export type RealmSubjectMembership = 'discussed' | 'not_published' | 'withheld' | 'unknown';
/** Sole Content port for the subjects-discussed relation, NOT Home Space publication.
 * Implementations authorize current Realm read/ban during resolve AND current, even
 * for public Realms. Prefix is complete native enumeration of linked discussion AND
 * review subjects, not a known-candidate batch or raw subject_thread table read.
 * Match applies current thread/opening/board/place/subject disclosure, including
 * protected-board grants. Only complete native negative coverage is not_published.
 * Every method settles actual work into the supplied caller root, before disclosure.
 */
export interface RealmSubjectSource {
    resolve(id: string, reader: LeafOptions, work: ScopeWork): Promise<RealmSubjectResolution>;
    current(observation: RealmSubjectObservation, reader: LeafOptions, work: ScopeWork): Promise<'current' | 'changed' | 'concealed' | 'unavailable'>;
    prefix(observation: RealmSubjectObservation, after: string | null, limit: number, reader: LeafOptions, work: ScopeWork): Promise<Readonly<{
        subjects: readonly string[];
        after: string | null;
        exhausted: boolean;
    }>>;
    match(observation: RealmSubjectObservation, subjects: readonly string[], reader: LeafOptions, work: ScopeWork): Promise<readonly RealmSubjectMembership[]>;
}
/** Native producer is undelivered. Still resolve ordinary resource authority before
 * refusing enumeration. No metadata, publication, mock batch or empty population fallback.
 */
export declare function unavailableRealmSubjectSource(pool: Pool): RealmSubjectSource;
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
export {};
