import type { Static } from 'typebox';
/** Native encoding limits, independent of provider revisions and record populations. */
export declare const SOURCE_FIGURE_MAX_BINS = 10;
export declare const SOURCE_FIGURE_MAX_BYTES = 4096;
export declare const SOURCE_OBSERVATION_MAX_BYTES = 32768;
export declare const SOURCE_STATISTICS_MAX_BODY_BYTES = 65536;
/** Only the permitted Bangumi converter may supply these original provider units.
 * Missing fields are unavailable. A partial distribution never asserts coverage.
 */
export declare const SourceFiguresSchema: import("typebox").TObject<{
    schemaVersion: import("typebox").TLiteral<1>;
    distribution: import("typebox").TOptional<import("typebox").TObject<{
        unit: import("typebox").TLiteral<"ratings">;
        completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
        bins: import("typebox").TArray<import("typebox").TObject<{
            score: import("typebox").TInteger;
            count: import("typebox").TInteger;
        }>>;
    }>>;
    rank: import("typebox").TOptional<import("typebox").TObject<{
        unit: import("typebox").TLiteral<"subjects">;
        position: import("typebox").TInteger;
        population: import("typebox").TOptional<import("typebox").TInteger>;
    }>>;
}>;
export type SourceFigures = Static<typeof SourceFiguresSchema>;
/** Shape validation runs before serialization, so arrays/keys and byte work are bounded.
 * Canonical ascending keys avoid two encodings of the same histogram. Neither a
 * missing bin nor a missing rank denominator is synthesized by the reader.
 */
export declare function validSourceFigures(source: string, figures: unknown, count: number): figures is SourceFigures;
