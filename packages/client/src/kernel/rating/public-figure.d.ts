import type { Pool, PoolClient } from 'pg';
import type { Effect } from '../events/effects.ts';
export type Queryable = Pick<Pool | PoolClient, 'query'>;
export type PublicFigure = Readonly<{
    questionId: string;
    populationId: string;
    subjectId: string;
    count: number;
    mean: number | null;
    score: number | null;
    m: number | null;
    C: number | null;
    priorEpoch: number | null;
    revision: string;
    asOf: string | null;
    position: string;
}>;
/** Compute consumer readiness from the published count, never from pending votes or shard totals. */
export declare function publicFigureState(figure: Pick<PublicFigure, 'count'> | null, grain: string, pending: boolean): 'ready' | 'insufficient_data' | 'updating';
/** Point-read the pending mark, including an unpublished row; no vote or aggregate data is read. */
export declare function readPublicFigurePending(client: Queryable, input: {
    questionId: string;
    populationId: string;
    subjectId: string;
}): Promise<boolean>;
/** Read up to 256 current, published figures for subjects in their anchor partition with one statement. */
export declare function readPublicFigures(client: Queryable, input: {
    partition: number;
    questionId: string;
    populationId: string;
    subjectIds: readonly string[];
}): Promise<PublicFigure[]>;
/** Page published figures for one question and population in anchor-subject order with one statement. */
export declare function pagePublicFigures(client: Queryable, input: {
    partition: number;
    questionId: string;
    populationId: string;
    after: string | null;
    limit: number;
}): Promise<PublicFigure[]>;
/** Publish at most one event per pending figure in a serial anchor-partition page. */
export declare function drainPublicFigures(pool: Pool, partition: number, limit?: number): Promise<number>;
/** Drain the aggregate partition's pending figures after the aggregate-applied event commits. */
export declare function createPublicFigureDrainEffect(pool: Pool): Effect;
