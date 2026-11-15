import type { PoolClient } from 'pg';
import type { RealmRankOrderCandidate, RealmRankOrderObservation } from './realm-rank.ts';
/** Internal continuation key. Score uses the stored 0–10 arithmetic, even for custom questions. */
export type RealmRankScoredCanonicalKey = Readonly<{
    score: string;
    name: string | null;
    subjectId: string;
}>;
export type RealmRankScoredCanonicalRequest = Readonly<{
    realmId: string;
    questionId: string;
    partition: number;
    after: RealmRankScoredCanonicalKey | null;
    limit: number;
}>;
export type RealmRankScoredCanonicalPage = Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
    generation: string;
    candidates: readonly (RealmRankOrderCandidate & Readonly<{
        name: string | null;
        key: RealmRankScoredCanonicalKey;
    }>)[];
}>;
export declare function copyScoredCanonicalRequest(input: RealmRankScoredCanonicalRequest): RealmRankScoredCanonicalRequest;
/** Called only between the factory's complete before/after authority and publication observations. */
export declare function readScoredCanonicalPartition(client: PoolClient, input: RealmRankScoredCanonicalRequest, observation: RealmRankOrderObservation, home: Readonly<{
    epoch: number;
    position: bigint;
}>): Promise<RealmRankScoredCanonicalPage>;
