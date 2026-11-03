import type { Pool, PoolClient } from 'pg';
export declare const REALM_SUBJECT_RAW_LIMIT = 32;
export type CandidateVersion = Readonly<{
    epoch: number;
    position: string;
}>;
export type RealmSubjectCandidate = Readonly<{
    realm: string;
    original: string;
    terminal: string | null;
    identityEpoch: string | null;
    thread: string;
    opening: string;
    revision: string;
    board: string;
    kind: 'discussion' | 'review';
    active: boolean;
}>;
export type RealmSubjectCoverage = Readonly<{
    generation: string;
    revision: string;
    unresolved: string;
    ownerEpoch: number;
}>;
export type CandidateKey = Readonly<{
    terminal: string;
    original: string;
    thread: string;
}>;
export declare function realmSubjectRoute(id: string): number;
export declare function candidateVersion(value: CandidateVersion): void;
/** A single native home, released before any foreign owner is consulted. */
export declare function realmSubjectHome<T>(pool: Pool, route: number, deadline: number, write: boolean, run: (client: Pick<PoolClient, 'query'>, version: CandidateVersion) => Promise<T>): Promise<T>;
/** Structural locators only. Callers obtain and validate native provenance before writing. */
export declare function createRealmSubjectCandidates(pool: Pool): {
    initialize(realm: string, deadline: number): Promise<void>;
    observe(realm: string, deadline: number): Promise<RealmSubjectCoverage | null>;
    fence(realm: string, thread: string, version: CandidateVersion, deadline: number): Promise<boolean>;
    write(candidate: RealmSubjectCandidate, version: CandidateVersion, mode: 'baseline' | 'live', deadline: number): Promise<boolean>;
    thread(realm: string, thread: string, after: string | null, deadline: number): Promise<Readonly<{
        realm: string;
        original: string;
        terminal: string | null;
        identityEpoch: string | null;
        thread: string;
        opening: string;
        revision: string;
        board: string;
        kind: 'discussion' | 'review';
        active: boolean;
    }>[]>;
    page(realm: string, after: CandidateKey | null, subject: string | null, limit: number, deadline: number): Promise<Readonly<{
        realm: string;
        original: string;
        terminal: string | null;
        identityEpoch: string | null;
        thread: string;
        opening: string;
        revision: string;
        board: string;
        kind: 'discussion' | 'review';
        active: boolean;
    }>[]>;
};
