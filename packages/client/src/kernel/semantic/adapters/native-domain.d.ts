import type { Pool } from 'pg';
import type { ContentLifecyclePort, LibraryCustodyPort, RatingReviewPort, SearchCurrentnessPort } from '../contract/domain-ports.ts';
import type { IdentityEpochParticipantPorts } from '../contract/identity-epoch-ports.ts';
import { type SemanticDomain } from '../application/index.ts';
import { nativeFactStore } from './fact-store.ts';
type NativeFactTransaction = Parameters<ReturnType<typeof nativeFactStore>['writeFacts']>[0];
export type NativeSemanticDomain = SemanticDomain<Pool, NativeFactTransaction>;
/** Bind hashing, routing, facts and the installed identity participants. Cross-domain ports come from composition. */
export declare function createNativeSemanticDomain(participants: IdentityEpochParticipantPorts<Pool>, extras?: {
    libraryCustody?: LibraryCustodyPort<Pool>;
    searchCurrentness?: SearchCurrentnessPort<Pool>;
    ratingReview?: RatingReviewPort;
    contentLifecycle?: ContentLifecyclePort;
}): NativeSemanticDomain;
export {};
