import type { RatingCapabilityOptions } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import { type SubjectCanonicalPopulation, type SubjectCanonicalNameKey } from '../semantic/subject-source-key-pages.ts';
import { type KeyRing } from '../tokens/seal.ts';
import { type RatingQuestionView } from './question-directory.ts';
export type RealmRankRequest = Readonly<{
    realmId: string;
    questionId: string;
    partition: number;
    sort: 'score_desc';
    limit: number;
    cursor?: string;
}>;
export type RealmRankCandidate = Readonly<{
    subjectId: string;
    count: number;
    mean: number;
    score: number;
    priorEpoch: number;
    revision: string;
    asOf: string;
    updating: boolean;
}>;
export type RealmRankQuestion = Readonly<RatingQuestionView>;
export type RealmRankPage = Readonly<{
    question: RealmRankQuestion;
    candidates: readonly RealmRankCandidate[];
    next: string | null;
}>;
/** Scored-only compatibility port; it is not Search's complete Realm order provider. */
export interface RealmRankSource {
    page(actor: Actor, request: RealmRankRequest, context: {
        deadline: number;
    }): Promise<RealmRankPage>;
}
export type RealmRankOrderObservation = Readonly<{
    populationId: string;
    questionPublication: string;
    questionProvenance: string;
    populationHome: Readonly<{
        partition: number;
        epoch: number;
        position: string;
    }>;
    question: RealmRankQuestion;
    questionIdentity: string;
    questionRevision: number;
    priorGeneration: string;
    priorEpoch: number | null;
    priorIdentity: string | null;
    priorActive: boolean;
    priorUpdating: boolean;
    realmAuthority: string;
    realmRevision: string;
    publicationGeneration: string;
    canonicalPopulation: SubjectCanonicalPopulation;
}>;
export type RealmRankOrderCandidate = RealmRankCandidate & Readonly<{
    securityRevision: number;
}>;
export type RealmRankFigureValue = Readonly<{
    subjectId: string;
    count: number;
    mean: number | null;
    score: number | null;
    priorEpoch: number | null;
    revision: string;
    asOf: string;
}>;
export type RealmRankFigureProof = Readonly<{
    subjectId: string;
    scored: boolean;
    figure: RealmRankFigureValue | null;
    updating: boolean;
}>;
export interface RealmRankOrderSource {
    observe(actor: Actor, input: Readonly<{
        realmId: string;
        questionId: string;
    }>, context: {
        deadline: number;
    }): Promise<RealmRankOrderObservation>;
    /** Bounded raw canonical-name candidates, with complete native figure proofs.
     * Scored rows remain explicit; a consumer must account for them when walking the complement.
     * These internal keys do not replace current Subject disclosure or predicate admission.
     */
    readCanonicalPartition(actor: Actor, input: Readonly<{
        realmId: string;
        questionId: string;
        partition: number;
        after: SubjectCanonicalNameKey | null;
        limit: number;
    }>, observation: RealmRankOrderObservation, context: {
        deadline: number;
    }): Promise<Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
        candidates: readonly (SubjectCanonicalNameKey & Readonly<{
            securityRevision: number;
            proof: RealmRankFigureProof;
        }>)[];
    }>>;
    listScoredPartitions(actor: Actor, input: Readonly<{
        realmId: string;
        questionId: string;
    }>, observation: RealmRankOrderObservation, context: {
        deadline: number;
    }): Promise<readonly number[]>;
    readScoredPartition(actor: Actor, input: Readonly<{
        realmId: string;
        questionId: string;
        partition: number;
        after: Readonly<{
            score: string;
            subjectId: string;
        }> | null;
        limit: number;
    }>, observation: RealmRankOrderObservation, context: {
        deadline: number;
    }): Promise<Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
        generation: string;
        candidates: readonly RealmRankOrderCandidate[];
    }>>;
    proveFigures(actor: Actor, input: Readonly<{
        realmId: string;
        questionId: string;
        partition: number;
        subjectIds: readonly string[];
    }>, observation: RealmRankOrderObservation, context: {
        deadline: number;
    }): Promise<Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
        figures: readonly RealmRankFigureProof[];
    }>>;
}
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    deadlineNow?: () => number;
} & RatingCapabilityOptions;
export declare class RealmRankQuestionUnavailableError extends Error {
    readonly reason: 'unavailable' | 'retired';
    constructor(reason: 'unavailable' | 'retired');
}
/** Production native Search port. No caller-supplied eligibility or disclosure flags are accepted. */
export declare function createRealmRankSource(deps: Dependencies): RealmRankSource;
/** Native observations, canonical population/name candidates and scored/figure primitives.
 * Search still needs canonical scored ties and admitted predicate composition before complete ordering.
 * The compatibility page remains scored-only.
 */
export declare function createRealmRankOrderSource(deps: Dependencies): RealmRankOrderSource;
export {};
