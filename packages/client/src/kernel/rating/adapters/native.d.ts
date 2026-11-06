import type { RatingAmbient, RatingCapabilities } from '../contract/capabilities.ts';
/** Only this adapter reaches native time, randomness and the command/effect libraries. */
export declare function createNativeRatingCapabilities(ambient?: Partial<RatingAmbient>): RatingCapabilities;
