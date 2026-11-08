/** Trusted server factories share Resource.eligibility and the one Access formula.
 * Callbacks must perform bounded current domain/revision reads at supplied T;
 * possession of the opaque factory result alone proves no permission.
 */
export { createResourceAnonymousEligibility, createResourcePublicEligibility, type ResourceEligibilityOptions, type ResourceEligibilityPrepareContext, type ResourceEligibilityVerifyContext, } from './eligibility.ts';
