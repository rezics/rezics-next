/** Publication admission predicates. Episode data arrives as values; Access and Semantic stay behind ports. */
import type { PublicationAdmissionResult } from '../contract/index.ts';
import type { CollectionSourceObservation } from '../contract/index.ts';
export type PublicationLocator = NonNullable<PublicationAdmissionResult['locator']>;
export declare function classifyPublicationFilter(leaves: readonly ('catalogue' | 'owner')[]): 'catalogue' | 'owner' | 'unavailable';
export declare function exactPublicationLocator(value: unknown): value is PublicationLocator;
export declare function admitPublication(input: {
    locator: PublicationLocator | null;
    privateWorking: boolean;
    observation: CollectionSourceObservation | null;
    episodePresent: boolean;
}): PublicationAdmissionResult;
