import type { KeyRing } from '../tokens/seal.ts';
import { type SearchCursorBinding, type SearchSortValue } from './cursor.ts';
/** Supplied from current native Global standard-question metadata, never the request or a cached cursor. */
export type RatingCursorContext = {
    questionId: string;
    populationId: string;
    priorEpoch: number | null;
};
export type RatingPhase = 'scored' | 'unscored';
export type RatingCursorResult = {
    ok: true;
    generation: number;
    phase: RatingPhase;
    after: SearchSortValue[];
} | {
    ok: false;
    reason: 'invalid' | 'expired' | 'restart';
};
export declare function encodeRatingCursor(ring: KeyRing, binding: SearchCursorBinding, context: RatingCursorContext, cursor: {
    generation: number;
    phase: RatingPhase;
    after: readonly SearchSortValue[];
}, now?: number): Promise<string>;
export declare function decodeRatingCursor(ring: KeyRing, binding: SearchCursorBinding, context: RatingCursorContext, token: string, now?: number): Promise<RatingCursorResult>;
