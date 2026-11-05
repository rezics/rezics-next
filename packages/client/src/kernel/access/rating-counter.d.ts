import type { AccessClient } from '../request/access.ts';
export type RatingCounter = (client: AccessClient, accountId: string, at: string | Date) => Promise<string>;
/** Trusted kernel composition supplies a stable, private secret shared by all rating workers. */
export declare function createRatingCounter(config: {
    secret: Uint8Array;
}): RatingCounter;
