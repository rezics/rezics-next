export declare const MAX_RATING_STORED_UNITS = 4096;
export declare const MAX_RATING_HISTOGRAM_BINS: number;
export declare const MAX_RATING_CHANGE_PAGE = 100;
export declare const MAX_RATING_POPULATION_DELIVERY_DELTAS: number;
export declare const POSTGRES_BIGINT_MIN = -9223372036854775808n;
export declare const POSTGRES_BIGINT_MAX = 9223372036854775807n;
export declare const MAX_RATING_DELIVERY_COUNT_DELTA: bigint;
export declare const MAX_RATING_DELIVERY_SUM_DELTA: bigint;
export type RatingQuestionScale = Readonly<{
    minimumUnits: number;
    maximumUnits: number;
    stepUnits: number;
}>;
export declare function isStoredRatingUnit(value: unknown): value is number;
export declare function checkedRatingQuestionScale(scale: RatingQuestionScale): RatingQuestionScale & {
    binCount: number;
};
export declare function ratingQuestionHistogramSize(scale: RatingQuestionScale): number;
export declare function ratingQuestionHistogramIndex(scale: RatingQuestionScale, units: unknown): number;
export declare function assertPostgresBigint(value: bigint): bigint;
export declare function assertPopulationDeliveryDelta(count: bigint, sum: bigint): void;
