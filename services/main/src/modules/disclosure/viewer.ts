import type { VerifiedPrincipal } from '../access/admission.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';

/** No Account age-evidence or opt-in owner is present yet. Browser headers and
 * bearer claims cannot manufacture that evidence; unknown age fails rated reads closed. */
export function disclosureViewer(principal: VerifiedPrincipal | null): Viewer {
  return principal ? { ...ANONYMOUS_VIEWER, signedIn: true } : ANONYMOUS_VIEWER;
}
