import type { Pool, PoolClient } from 'pg';
type Queryable = Pick<Pool | PoolClient, 'query'>;
export type RatingFigure = Readonly<{
    population: string;
    count: number;
    freshness: Readonly<{
        asOf: string | null;
        updating: boolean;
    }>;
}> & (Readonly<{
    mean: number;
    histogram: number[];
    remaining?: never;
}> | Readonly<{
    remaining: number;
    mean?: never;
    histogram?: never;
}> | Readonly<{
    mean?: never;
    histogram?: never;
    remaining?: never;
}>);
export type RatingPopulation = Readonly<{
    population: string;
    count: number;
}>;
export type RatingPopulationPage = Readonly<{
    populations: RatingPopulation[];
    after: string | null;
    hasMore: boolean;
}>;
export type RatingQuestionGrain = 'work' | 'release' | 'episode' | 'character';
/** Trusted internal metadata only; disclosure callers use readVisibleRatingQuestion. */
export declare function readRatingQuestion(client: Queryable, questionId: string): Promise<Readonly<{
    id: string;
    grain: RatingQuestionGrain;
    realmId: string | null;
}> | null>;
/** Read the independently sharded aggregate for one population and apply its grain threshold. */
export declare function readAggregateFigure(client: Queryable, input: {
    questionId: string;
    populationId: string;
    targetId: string;
    grain?: RatingQuestionGrain;
}): Promise<RatingFigure | null>;
/** Page populations that have a positive component for the target, using the target-first partial index. */
export declare function readRatingPopulationPage(client: Queryable, input: {
    questionId: string;
    targetId: string;
    after: string | null;
    limit?: number;
}): Promise<RatingPopulationPage>;
export {};
