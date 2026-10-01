/**
 * Work addresses. A Work's native IRI is its identity; a `rv:RouteBinding` in
 * the `work` namespace is a separate address for it, and a slug is never an
 * alternate identity.
 *
 * - One binding per normalized slug, for ever: a claim is guarded against any
 *   binding with that slug in any state, so a former address never acquires a
 *   new referent. A Work has at most one Current binding.
 * - A rename marks the old binding Redirected and a merge marks it Merged and
 *   Redirected; both keep its original `targetWork` and store the next Work
 *   identity, never the next slug, so later renames cannot retarget it. A
 *   retired binding answers 410 with its route identity and history intact.
 * - Resolution follows Work identities through at most `MAX_WORK_REDIRECT_HOPS`
 *   bindings read at one graph sequence. A cycle, broken target, moved
 *   snapshot or longer chain is `AddressClaimUnavailable` (503), never a false
 *   404 for a route that exists. Redirects are `no-store`: the canonical slug
 *   can change again.
 * - An exact revision read reports that revision's state and original Work.
 *   A separate typed merge resolution describes its current survivor, without
 *   substituting that Work or changing retained revision bytes.
 * - 308 and `Location` are RFC 9110 §15.4.9's; persistent route identity and
 *   the direct Work lookup are REZICS choices informed by W3C's "Cool URIs
 *   don't change".
 */
export const MAX_WORK_REDIRECT_HOPS = 32;

/**
 * Slugs shaped like a UUID stay unassigned: the web's `/w/{ref}` reads a
 * UUID-shaped segment as a Work ID, so such a slug could never be reached.
 */
export const RESERVED_WORK_SLUG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * R retained route bindings, W current Works, H route revisions and b the
 * fixed-size (64-byte ASCII slug) request and response. The bounds assume
 * predicate-object indexes and the uniqueness invariants above; they are
 * derivations, not measurements.
 */
export const workAddressCostContract = {
  bounds: {
    claim: 'O(log R + log W + b): one current-Work lookup, guarded slug and current-address checks, one native write of a binding, revision, receipt and outbox event',
    rename: 'O(log R + log W + b): reads the old slug and head, guards the new slug, writes two bindings, two revisions, one receipt and one event',
    disposition: 'O(log R + log W + b): reads the source slug and head (and for a merge the target Work and address), writes one head, revision, receipt and event',
    resolve: 'O(log R + log W + b) for a current slug; O(MAX_WORK_REDIRECT_HOPS · (log R + log W) + b) through a redirect chain',
    reverse: 'O(log R + log W + b): the target-Work predicate returns at most one Current binding',
    exact: 'O(log R + log H + log W + b): the supplied revision IRI and its binding',
  },
  /** Main-to-Fuseki request ceilings, asserted by `tests/qa/integration/work-address-api.test.ts`. */
  fusekiRequests: {
    claim: 8, claimReplay: 4, claimConflict: 14, rename: 10, disposition: 7,
    resolve: 1, resolveRenamed: 2, resolveChain: 1 + MAX_WORK_REDIRECT_HOPS, reverse: 1, exact: 1,
    // Identity edges and each visited public Work are fenced separately; route
    // redirects and identity merges consume the same 32-hop allowance.
    resolveMerged: 4 + 2 * MAX_WORK_REDIRECT_HOPS,
    reverseMerged: 5 + 2 * MAX_WORK_REDIRECT_HOPS, exactMerged: 5 + 2 * MAX_WORK_REDIRECT_HOPS,
  },
  unmeasured: 'Native plan work across R and skewed target degree, Account and Access calls, bytes, TDB2 writer contention and latency percentiles. Chains beyond the hop bound need an indexed route structure, not a larger bound.',
} as const;
