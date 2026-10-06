import type { VerifiedPrincipal } from '../access/admission.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { bindMediaAudience } from '../media/visibility.ts';

// Owner adapters for Content/media retain their caller's trusted evidence.
// Async storage isolates simultaneous readers and restores anonymous delivery
// when the operation ends. No HTTP header or bearer claim sets this context.
const audience = new AsyncLocalStorage<Viewer>();
export const currentDisclosureViewer = () => audience.getStore() ?? ANONYMOUS_VIEWER;
export function withDisclosureViewer<T>(viewer: Viewer, operation: () => T): T {
  return audience.run(viewer, operation);
}

/** Account's live decision supplies both preferences and eligibility. */
export function disclosureViewer(principal: VerifiedPrincipal | null, actingSubject?: string): Viewer {
  if (!principal) return ANONYMOUS_VIEWER;
  const evidence = principal.contentEvidence;
  if (!evidence || !evidence.accountEligible)
    return bindMediaAudience({ ...ANONYMOUS_VIEWER, signedIn: true }, principal, actingSubject);
  return bindMediaAudience({ signedIn: true, age: evidence.age, country: evidence.country,
    optIns: { general: evidence.categories.general, r15: evidence.categories.r15,
      sexual: evidence.adultAvailable && evidence.categories.r18,
      grotesque: evidence.adultAvailable && evidence.categories.r18g } }, principal, actingSubject);
}
