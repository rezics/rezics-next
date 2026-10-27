# Zone membership and current disclosure

This is the first-public-scope query/access outcome contract under [scope](scope.md).
Resource lifecycle and presentation are separate from membership. A Zone is a routed site over existing catalogue
scopes and CommonCollection identities. It is neither a catalogue authority nor a second personal library.
[Deletion](deletion.md), [Collections](library-and-collections.md), and
[dynamic Collections](dynamic-collections.md) retain their owner policies.

## Observable membership

For Zone Z, viewer V and the current request, eligible subjects are:

`distinct(union(admitted saved scopes, readable mounted Collection subjects)) intersect current subject Access(V)`.

The Zone itself must first be readable by V. Zone grants and visibility do not confer any source or subject rights.
A mounted Collection contributes only while its owner authorizes its disclosure to that viewer. Public Zone output
cannot reveal private mounts, even if its editor can read them. CommonCollection alone owns curated occurrences
and built-in dynamic membership. Repeated occurrences, overlapping mounts and overlapping saved scopes contribute
a subject once. The Zone stores only bounded source descriptors, never a membership mirror, seen-subject history,
personal state, profile pins, progress, notes, copies or a second list model.

The first scope accepts released saved catalogue filters and curated/built-in dynamic Collections. User-authored
dynamic queries remain deferred. Validate saved references and expanded filters at admission against the current
shared Search/semantic filter registry. Reject unsupported plans with `422 unsupported_query` before executing
source enumeration; do not evaluate arbitrary predicates over all catalogue or library rows. An unknown saved ID
is invalid configuration, not an empty membership source. No local property whitelist replaces shared admission.

## Native routes and projections

- `POST /v1/zones` takes `{configuration,mounts,visibility}`. Configuration is the validated ZoneStarter with
  eight-locale labels, sorted relative pages including home and at most sixteen saved-filter IDs in `scope`;
  mounts contains at most sixteen distinct existing Collection IDs. Resource creation uses Global parent authority
  and ordinary initialized Zone owner grants. Query code must not invent a bypass for that authority.
- `GET /v1/zones/{id}/subjects?limit=P&cursor=...` returns `{subjects,next}` with explicit freshness using the
  shared listing protocol. Each subject has its canonical `id`; other fields obey their owners' DTO contracts.
  No union total is implied. `P` is in 1..100. Underfill, including an empty page with non-null continuation, is legal.
- `GET /v1/zones/{id}/collections` returns `{collections,next}` and shared freshness. Omit unreadable mounts
  entirely, including their IDs, labels, descriptions, counts and source positions. A curated count may be shown
  only under its Collection owner's disclosure; it is not an accessible-subject or Zone-union total.
- `POST /v1/zones/{id}:readPage` accepts `{target:{route}}` or `{target:{subject,view?},languages?}`. It returns
  the shared presentation result plus safe Zone shell metadata. A subject target must satisfy membership and
  current subject Access. Configured routes cannot shadow reserved `subjects` routing. Global subject URLs remain
  canonical. A related reference does not become a Zone target automatically: its owner independently decides
  whether to disclose its link, label and fields.

Unknown, unreadable, deleted and fully withheld Zones or subject targets have the same `404 not_found` problem,
apart from request-specific diagnostics. Do not echo the tested hidden ID, source, label or count. Navigation,
metadata, cursors and any future facets obey the same rule as the primary rows. No public configuration projection
may serialize a hidden mount. Zone facets are not a new first-scope endpoint; should they be added, raw source
facets/totals are insufficient evidence for accessible union counts.

## Mutation, freshness and continuation

Every page rechecks current Zone, source and subject rights. A cursor issued before a source becomes private,
loses a viewer grant, is deleted or withheld cannot preserve access. A subject suppressed after issuance must not
appear in continuation or a direct Zone target read. Restore within the owner's thirty-day policy permits fresh
reads again; it does not promise that a pre-restoration traversal will revisit a key already passed. Takedown is
reversible withholding, never a purge. Public visibility revocation is tested independently of deletion.

For a dynamic Collection, public membership may disclose the curator's adopted subject selection, never the private
facts or predicate that produced it. Changing a private copy note, progress value, label, profile pin or state detail
without changing adopted membership must not change any public Collection-derived fields or counts. A private
fact value cannot be smuggled through a public label, facet bucket, source descriptor or opaque token payload.

A continuation binds operation, Zone identity and configuration revision, admitted scope/filter and release basis,
mount identities and owner query/order generations, requested query/order/page shape, viewer principal and the
shared token expiry/key generation. Appearance-only parameters need not change query semantics; languages and
views bind when they affect the projected page. Changed query basis requires the shared stale/restart response,
not silent reuse under a new query. Access revocation is always checked live, including when the basis is unchanged.
A continuation transferred to another viewer, Zone or query is rejected. Cursor bytes are authenticated and opaque;
never expose raw provider keysets or hidden mount descriptors. Cursor size is bounded independently of membership.

A page ending in filtered or unprovable keys advances past the **last examined** candidate. Unknown proof is not
membership: omit it without substituting a stale fact or claiming an exact count. Temporary owner unavailability
fails closed with the owner availability/restart outcome; it must not manufacture exhaustion. Empty pages with
continuation are successful partial work. Only actual source-range exhaustion permits `next:null`.

Under finite, quiescent source state, repeated continuation eventually exhausts every admitted source, emits every
provably eligible subject exactly once and terminates. This is not a snapshot promise. Concurrent additions,
removals, restore and reorder may require restart or leave changes for a fresh traversal. No exact live union count
or completeness under concurrent mutation is promised.

## Bounded owner adapters

The current Search seam is `createSearchService().search`, with shared filter admission, `sort:'id'`, bounded
candidate windows, current `checkHits` proof and opaque generation-bound continuation. It currently returns a
filtered public page; that alone does not expose all examined candidate work or provide a Zone membership probe.
The term currentSearch means this existing current-evidence path, not a new local search engine.

Search owns the missing Zone adapter: admit a released scope into a bounded native plan; enumerate a capped
candidate window with its last-examined opaque continuation, exhaustion and current proof result; and test a
bounded subject-ID set against that same admitted scope. Report examined candidates including rejected/unknown
proof keys and any overflow probes, not just returned subjects. Preserve fail-closed current disclosure and index
freshness/generation semantics. A provider hit count is not a Zone count.

Commerce owns the missing CommonCollection Zone adapter in `createCollectionReads` and its common members
engine: authorize current metadata, enumerate bounded **unique subject keys**, and probe a bounded subject set
under the same membership/query basis for both curated and built-in dynamic Collections. Existing curated
`collection-reads-members.sql` orders occurrences by `(ordinal_key,member_id)` and returns occurrence notes;
it cannot silently stand in for the unique-subject adapter. Commerce must supply indexed subject-key traversal
or another researched bounded deduplication/probe strategy. Do not sort all occurrences, gather all keys or replace
a dynamic mount with a curated fixture. Dynamic identity resolution is lazy through the existing Collection list
and metadata/members surfaces; exact built-in descriptor resolution is an owner dependency.

Access stays on each owner's partition: bounded source checks and subject points via the real current resource
eligibility predicates. No cross-partition SQL join is admitted. Capture every pool opened by owner commands and
adapters; SQL on a second connection is still work. Search provider work also needs examined-key instrumentation;
PostgreSQL captures alone cannot prove its bound.

### Local budgets and unresolved choices

The existing descriptor caps imply at most 32 sources. A local acceptance envelope uses at most 256 examined
candidate keys per public page, independent of P, catalogue size, Collection degree and other Zones. A lookahead
key counts against this budget. Source checks, proof/probe fanout and owner round trips must be functions only of
these caps, not of how many keys pass. Rows are constant, blocks logarithmic and statements constant as the
population grows. These numbers and the test's finite traversal ceiling are local derivations for review, **not
external standards or claims about an implemented algorithm**.

Global output order, merge scheduling, duplicate ownership, provider window allocation and adapter wire types
remain unresolved pending the union algorithm/owner agreement. One possible shape is a common monotonic subject
key with bounded per-source state, but existing curated occurrence order does not establish that capability.
The acceptance tests compare sets and cross-page uniqueness, never prescribe a merge algorithm. They enforce the
256-key envelope without inventing a global mirror. An implementation must reconcile that envelope with its
actual adapter work before claiming green. Source-order cursors plus only page-local deduplication are insufficient:
a duplicate can recur arbitrarily far later in another source. A growing seen-ID token also violates this contract.

## Acceptance and implementation slices

`test/zones/membership-contract.test.ts` uses native HTTP, real Access, real subject/Collection commands and a
narrow shared fixture. Its named outcomes cover union, overlap and duplicate occurrences; current private,
revoked, deleted and withheld disclosure; empty filtered windows and finite traversal. Additional cases cover
subject target exclusion, cursor transfer, source restoration, unsupported admission and the native built-in
Collection dependency. No absent Zone module is statically imported. Missing Zone routes must first fail at
HTTP creation with expected 201 versus actual 404, not at fixture grant setup.

`test/zones/growth-membership.test.ts` uses the shared capture/checkGrowth classifier with legal 64/512/4096
populations, warmup and repeated samples. Axes are unrelated subjects, degree of one mounted Collection and
unrelated Zones. First pages, continued filtered windows and direct membership checks must succeed before costs
are accepted. Captures include filtered candidates and all owner pools; bounds do not use elapsed-time benchmarks.
The native dynamic test is intentionally red until Commerce supplies real built-in membership and its public
privacy projection. Unknown-proof/provider-only counters still require Search's native adapter evidence; the
PostgreSQL test does not pretend to synthesize a provider's unknown-proof response.

Implementation can land in small owner slices: (1) Search admission/candidate/probe evidence; (2) Commerce common
unique-member adapter including built-ins; (3) Zone bounded union and live Access/opaque continuation; (4) shared
presentation target gate and public shell projection; (5) native provider growth and mutation outcomes. Resource
CRUD/readPage shape is fixed by the shared routing skeleton; no query algorithm or adapter is implemented here.
