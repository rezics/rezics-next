import type { KeyRing } from '../tokens/seal.ts';
import { type SearchCursorBinding, type SearchSortValue } from './cursor.ts';
/** Supplied from current native standard-question metadata, never request or cursor evidence. */
export type RatingCursorContext = {
    questionId: string;
    populationId: string;
    priorEpoch: number | null;
    realm?: {
        authority: string;
        revision: string;
    };
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
