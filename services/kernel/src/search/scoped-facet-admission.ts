import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { ProblemError } from '../http/problem.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { FacetScopeCursorBinding } from './facet-discovery-contract.ts';
import type { FacetDiscovery200Response } from './facet-discovery-contract.ts';
import type { FacetDiscoveryInput } from './facet-discovery-runtime.ts';
import type { FacetDiscoveryProvider } from './facet-discovery-native.ts';
import { authenticateFacetCursors, readFacetDiscovery, validateFacetCursorRelease } from './facet-discovery-runtime.ts';
import { admitFacets, validateScopedFacetRequest, type ScopedFacetRequest } from './facets.ts';
import { scopedFacetIdentityKey, type ScopedFacetAdmission as SearchScopeAdmission } from './scoped-facet-source.ts';

/**
 * Result of the shared Search scope admission. The caller must obtain it through the same verified Actor,
 * current Access, scope and deadline bridge used by scoped search. Its binding covers the exact effective
 * predicate and dynamic authorization/subject observation; this adapter does not authorize references itself.
 */
export type ScopedFacetAdmissionResult = Readonly<
  Omit<FacetDiscoveryInput, 'scopeBinding' | 'facets' | 'scope'> & {
    scope: SearchScopeAdmission;
  }
>;

export type ScopedFacetSearchAdmission = (request: ScopedFacetRequest) => Promise<ScopedFacetAdmissionResult>;

function invalidConditions(): never {
  throw new ProblemError('invalid_request', {
    errors: [{ pointer: '/conditions', code: 'invalid_format' }],
  });
}

function requestBinding(request: ScopedFacetRequest): string {
  const canonical = canonicalize({ scope: request.scope, conditions: request.conditions ?? null });
  if (canonical === undefined) invalidConditions();
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Run the shared scoped-search admission before cursor or producer work, then bind its exact effective query
 * to the existing opaque facet continuation. Every reference in `conditions` reaches the shared admission
 * unchanged, including references beneath NOT or an unrelated true OR branch.
 */
export async function admitScopedFacetRequest(
  rawRequest: unknown,
  admitSearch: ScopedFacetSearchAdmission,
): Promise<FacetDiscoveryInput> {
  const request = validateScopedFacetRequest(rawRequest);
  const admission = await admitSearch(request);

  // Reuse the existing released property grammar and eight-property/page limits after scope authorization.
  admitFacets(request.facets, admission.filter, admission.release);
  const scopeBinding: FacetScopeCursorBinding = {
    request: requestBinding(request),
    admission: scopedFacetIdentityKey(admission.scope.identity),
  };
  return { ...admission, facets: request.facets, scopeBinding };
}

/** Adjacent route adapter: authorization completes before cursor validation and all producer/engine I/O. */
export async function readScopedFacetDiscovery(
  ring: KeyRing,
  provider: FacetDiscoveryProvider,
  request: unknown,
  admitSearch: ScopedFacetSearchAdmission,
): Promise<FacetDiscovery200Response> {
  const input = await admitScopedFacetRequest(request, admitSearch);
  const positions = await authenticateFacetCursors(ring, input);
  validateFacetCursorRelease(positions, input.release, input.scopeBinding);
  return readFacetDiscovery(ring, provider, input, positions);
}
