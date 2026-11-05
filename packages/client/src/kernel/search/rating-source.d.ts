export type PublicRatingFigure = {
    questionId: string;
    populationId: string;
    subjectId: string;
    count: number;
    mean: number | null;
    score: number | null;
    priorEpoch: number | null;
    revision: string;
    asOf: string;
};
export type PublicRatingEpoch = {
    questionId: string;
    populationId: string;
    priorEpoch: number | null;
};
export type PublicRatingSnapshot = {
    partition: number;
    /**
     * The authoritative core.partition.position read in the same repeatable-read snapshot as `figures`. A later source
     * decorator compares this with the semantic snapshot position; it must not combine the figures with another
     * partition position.
     */
    position: bigint;
    figures: ReadonlyMap<string, PublicRatingFigure>;
};
export interface PublicRatingSource {
    /**
     * Read public figures for the standard question and Global population fixed by this source. Each call accepts at
     * most 256 subject ids, requires `partition` to be an integer from 0 through 4095, validates that every id is
     * routable and anchored to `partition`, and reads the figures together with the authoritative partition position
     * in one repeatable-read snapshot. An absent map entry means the native figure is unscored. A missing or unavailable
     * capability, denied read, or failed native read rejects; those conditions must never be represented as an empty
     * map.
     */
    read(partition: number, subjectIds: readonly string[]): Promise<PublicRatingSnapshot>;
    /**
     * Return the current native prior eligibility epoch for this source's standard question and Global population.
     * The epoch is null below 50 counted votes, is not a cached last nonnull epoch, and is never reused.
     */
    epoch(): Promise<PublicRatingEpoch>;
}
/**
 * Pure, bounded validation and copying for an untrusted public Global figure. It performs no I/O and preserves no
 * unlisted data.
 */
export declare function normalizePublicRatingFigure(value: unknown, binding: {
    questionId: string;
    populationId: string;
    subjectId: string;
}): PublicRatingFigure;
