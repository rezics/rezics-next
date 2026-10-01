import type { VerifiedPrincipal } from '../access/admission.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

// Owner adapters for Content/media retain their caller's trusted evidence.
// Async storage isolates simultaneous readers and restores anonymous delivery
// when the operation ends. No HTTP header or bearer claim sets this context.
const audience = new AsyncLocalStorage<Viewer>();
export const currentDisclosureViewer = () => audience.getStore() ?? ANONYMOUS_VIEWER;
export function withDisclosureViewer<T>(viewer: Viewer, operation: () => T): T {
  return audience.run(viewer, operation);
}

/** No Account age-evidence or opt-in owner is present yet. Browser headers and
 * bearer claims cannot manufacture that evidence; unknown age fails rated reads closed. */
export function disclosureViewer(principal: VerifiedPrincipal | null): Viewer {
  return principal ? { ...ANONYMOUS_VIEWER, signedIn: true } : ANONYMOUS_VIEWER;
}
