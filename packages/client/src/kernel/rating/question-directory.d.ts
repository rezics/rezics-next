import type { Pool, PoolClient } from 'pg';
import { type Access, type Actor } from '../request/access.ts';
import questionRead from './question-read.sql';
import type { QuestionGrain } from './question-authoring.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
};
export type QuestionMetadata = NonNullable<Awaited<ReturnType<typeof questionRead.run>>>;
export type RatingQuestionView = {
    id: string;
    revision: number;
    label: string;
    grain: QuestionGrain;
    scale: {
        min: number;
        max: number;
        displayStep: number;
    };
    realmId?: string;
    meaning?: string;
    canonicalLabel?: string;
    labelRevision?: number;
};
/** Keep the legacy wire shape exact. Realm definitions add explicit provenance and
 * meaning; ownerId is the authoring account and is never used as a Realm selector. */
export declare function ratingQuestionView(row: {
    id: string;
    revision: number;
    label: string;
    grain: string;
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
    realmId?: string | null;
    meaning?: string | null;
    presentationLabel?: string | null;
    labelRevision?: number | null;
}): RatingQuestionView;
/** Existing Global definitions authority, with no held connection during preparation. */
export declare function requireGlobalQuestionRead(deps: Dependencies, actor: Actor, deadline: number): Promise<void>;
/** Native Realm readability includes protected grants, host state and current bans.
 * Failure/unavailability propagates; it must never become an empty selection. */
export declare function requireRealmQuestionRead(deps: Dependencies, actor: Actor, realmId: string, deadline: number): Promise<void>;
/** Exactly one question-home observation followed by one current authority check.
 * The metadata connection is released before Access prepares any native evidence.
 * No row, label or grain crosses the boundary until its provenance is readable. */
export declare function readVisibleRatingQuestion(deps: Dependencies, actor: Actor, questionId: string, deadline: number, globalAuthority?: boolean): Promise<QuestionMetadata | null>;
/** One indexed seek and one unconsumed lookahead, authorized by the caller.
 * Explicit Realm selection prevents protected rows entering the Global directory.
 * Consumed raw keys drive progress even if a later visibility observation denies. */
export declare function readRatingQuestionDirectory(client: Pick<PoolClient, 'query'>, input: {
    after: string | null;
    limit: number;
    realmId?: string;
}): Promise<{
    ratingQuestions: RatingQuestionView[];
    after: string | null;
    hasMore: boolean;
}>;
/** Selection is explicit, never inferred from owner_id or from a filtered page.
 * Every Realm page has at most 21 raw rows, 20 metadata views and two native Realm
 * reads, with all checkouts released between metadata and authority observations. */
export declare function readSelectedQuestionDirectory(deps: Dependencies, actor: Actor, input: {
    after: string | null;
    limit: number;
    realmId?: string;
}, deadline: number): Promise<{
    ratingQuestions: RatingQuestionView[];
    after: string | null;
    hasMore: boolean;
}>;
/** Exact released measurement identity; labels do not change the measurement. */
export declare function ratingQuestionIdentity(question: {
    revision: number;
    grain: string;
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
}): string;
/** The released vote/event contract admits integer units in 0..20. */
export declare function realmRankQuestionEligible(question: {
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
}): boolean;
export {};
