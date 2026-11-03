# Scoped subject suggestions

`GET /v1/subjects:suggest` accepts the existing `q`, `limit` and ordered `languages` fields plus an optional
`filter` query value containing the complete JSON `FilterDocument`. Realm and Collection leaves stay inside that
filter beside authored `and`, `or` and `not` clauses. The route derives the actor from the authenticated request;
the filter identifies a resource to check and never supplies an actor or an authorization grant. Other scope kinds
remain unavailable. A malformed or missing native scope cannot fall through to Global suggestions.

The cookie-backed `GET /api/search/suggestions` BFF carries `filter` and repeated `language` values, prepares the
existing session, forwards its current credential to Kernel, uses the request `AbortSignal`, and returns private,
no-store responses. `HeaderSearch` and the default `ShellSearch` caller install the scoped loader. Chip text and
images are display-only. The removable chip's native Realm or Collection id must match the request-only scope leaf.
The owner key includes the observed session, locale, query, scope and authored filter/language fields; replacement
cancels the old request and retires its displayed rows. Removing the scope changes the owner and starts a fresh
Global request.

The service admits the complete filter against the active release. It captures native prefix candidates through the
existing public suggestion consumer, then applies the same current Search disclosure checks and service-bound
Realm or Collection admission/evaluation used by scoped Search. The suggestion capture itself remains request-only:
it retains the prefix and native disclosure dependencies, while the complete authored predicate is evaluated by
current Source and scope readers. Current summaries finish before final Source, membership, authority, disclosure,
release and generation revalidation. A reader, scope, dependency or generation change retires the response.

Readiness is explicit: a fully checked result, including an actually exhausted empty result, is `200`; invalid
prefix/filter input is correctable `400`; refused access is `403`; a changed owner or generation is `409
search_restart_required`; missing native evidence, bounded work without proof of exhaustion, or uncertain scope
authority is `503 index_not_ready` with the native retry hint. A bounded partial batch never becomes an empty result.
The existing Global prefix producer and public subject pickers keep their original bool-prefix query. Global header
requests carry display-language preferences only; scoped requests carry the complete filter. Storybook uses recorded
public Search subjects as explicitly constructed scoped responses and does not claim native access or permission
evidence.

Decision: scoped suggestions retain native score-descending prefix order with routed subject id as the stable refill
tie-breaker.

## Cost Touches, Bound and Growth

- **Touches:** one active generation/release capture; at most three count-free prefix query rounds against that
  retained observation; the existing native current-summary/projection and execution-status reads; one current
  Search Source check per returned candidate batch plus the final displayed rows; one admitted scope preparation and
  bounded evaluation when the filter contains a Realm or Collection leaf; current summary hydration before final
  disclosure. Refill uses the existing `PublicFilterConsumerRefill` locator and root observation.
- **Bound:** for output limit `s` in 1..10, each indexed query is at most `2s+1` raw candidates and the collector
  examines at most `min(600, 6s+3)` raw candidates across three rounds. It counts every excluded, duplicate and
  lookahead candidate. A complete empty native seek proves no matches; otherwise failure to fill before the bound
  returns preparation. Scope work remains within the Search `ScopeWork` reservation (700 candidate keys and its
  existing native row, point, statement and byte ceilings); no new permissions catalogue, fitted result cap or
  refill protocol is introduced.
- **Growth check:** `test/search/scoped-suggestion.test.ts` checks that a denied first batch is consumed and refilled
  before a later permitted prefix match is returned, and that an authority change during summary hydration restarts
  without disclosure. Its raw-candidate assertions enforce the `6s+3` bound as `s` changes.
  `apps/web/tests/search-scoped-suggestions.test.tsx` checks the BFF fields, cookie session transport, no-store
  response and explicit refusal of a missing or unsupported scope.
