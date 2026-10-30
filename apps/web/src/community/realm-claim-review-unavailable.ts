import type { RealmClaimReviewAdapter } from './realm-claim-review';

/** Replace this consumer-local binding with the generated native list reader when it is delivered.
 * Never substitute a Realm read, participation, viewer role or an empty queue for this producer.
 */
export const unavailableRealmClaimReview: RealmClaimReviewAdapter['read'] = async () => ({ kind: 'unavailable' });
