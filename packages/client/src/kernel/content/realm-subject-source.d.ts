import type { Pool } from 'pg';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { ScopeWork } from '../search/scope-execution.ts';
import { type RealmSubjectCandidate, type RealmSubjectCoverage } from './realm-subject-candidates.ts';
export type { RealmSubjectCandidate, RealmSubjectCoverage } from './realm-subject-candidates.ts';
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
type Current = 'current' | 'changed' | 'concealed' | 'unavailable';
type Context = Readonly<{
    reader: LeafOptions;
    work: ScopeWork;
}>;
/** Supplied by the separate current-disclosure owner. All methods use the caller root;
 * dependencies bind actor, Access, Realm/place, opening, original and terminal identity.
 * Currentness also revalidates every Subject/candidate dependency added during a page.
 * A rejected candidate is not_published; uncertainty must be withheld or unknown.
 */
export interface RealmSubjectDisclosure {
    readonly bounds: Readonly<Record<'resolve' | 'current' | 'candidate' | 'subject', WorkDimensions>>;
    resolve(realm: string, context: Context): Promise<Readonly<{
        state: 'ready';
        dependency: string;
    }> | Readonly<{
        state: 'concealed' | 'unavailable';
    }>>;
    current(realm: string, dependency: string, context: Context): Promise<Current>;
    candidate(candidate: RealmSubjectCandidate, dependency: string, context: Context): Promise<RealmSubjectMembership>;
    subject(subject: string, dependency: string, context: Context): Promise<Readonly<{
        state: 'readable';
        terminal: string;
    }> | Readonly<{
        state: 'withheld' | 'unknown';
    }>>;
}
/** Live maintenance proves every source cut, subsequent writes and identity repairs.
 * A token binds the exact native generation/revision, not just an empty eligible page.
 */
export interface RealmSubjectMaintenance {
    readonly bounds: Readonly<Record<'observe' | 'current', WorkDimensions>>;
    observe(realm: string, coverage: RealmSubjectCoverage, context: Context): Promise<string | null>;
    current(realm: string, coverage: RealmSubjectCoverage, token: string, context: Context): Promise<'current' | 'changed' | 'unavailable'>;
}
export interface RealmSubjectSource {
    resolve(realm: string, reader: LeafOptions, work: ScopeWork): Promise<RealmSubjectResolution>;
    current(observation: RealmSubjectObservation, reader: LeafOptions, work: ScopeWork): Promise<Current>;
    prefix(observation: RealmSubjectObservation, after: string | null, limit: number, reader: LeafOptions, work: ScopeWork): Promise<Readonly<{
        subjects: readonly string[];
        after: string | null;
        exhausted: boolean;
    }>>;
    match(observation: RealmSubjectObservation, subjects: readonly string[], reader: LeafOptions, work: ScopeWork): Promise<readonly RealmSubjectMembership[]>;
}
/** No default evaluator, lifecycle stand-in or production registration. */
export declare function createRealmSubjectSource(input: {
    pool: Pool;
    disclosure?: RealmSubjectDisclosure;
    maintenance?: RealmSubjectMaintenance;
}): RealmSubjectSource;
