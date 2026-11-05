import type { Pool } from 'pg';
import type { Static } from 'typebox';
import { type Queryable } from './public-figure.ts';
/** Shared subject-page and search-hit transport; units metadata belongs to the question. */
export declare const PublicFigureSchema: import("typebox").TObject<{
    questionId: import("typebox").TString;
    populationId: import("typebox").TString;
    scale: import("typebox").TObject<{
        min: import("typebox").TInteger;
        max: import("typebox").TInteger;
        displayStep: import("typebox").TInteger;
    }>;
    count: import("typebox").TInteger;
    state: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"insufficient_data">, import("typebox").TLiteral<"updating">]>;
    mean: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
    score: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
}>;
export type PublicFigureView = Static<typeof PublicFigureSchema>;
/** Two Global-only point reads within the caller's REPEATABLE READ READ ONLY snapshot; no transaction control. */
export declare function readPublicFigureViews(client: Queryable, subjectIds: readonly string[]): Promise<ReadonlyMap<string, Readonly<{
    figure: PublicFigureView;
    revision: string;
}>> | null>;
/** Only published Global data and its pending mark enter the consumer snapshot. */
export declare function readSubjectPublicFigure(pool: Pool, subjectId: string, deadline: number): Promise<Readonly<{
    figure: PublicFigureView;
    revision: string;
}> | null>;
