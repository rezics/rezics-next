## Platform profile

`platformProfile` is the shipped presentation profile, loaded from
`@rezics/composition/profiles/platform.json`. Its generic template is a header slot holding
`SubjectHeader` and the site `actions` slot, then `MoreStatements`. Every other subject template
uses that same header.

`schema:CreativeWork` is a base template: that header, then `Statements` for `schema:author`,
`schema:illustrator`, `schema:translator`, `schema:publisher`, `schema:datePublished`,
`schema:inLanguage`, `schema:genre` and `schema:isPartOf`, then a `SubjectList` of editions
(`schema:exampleOfWork`, limit 12), then `MoreStatements`. `schema:CreativeWorkSeries` is a base
template with that header and those statements, then `SubjectList`s for works in the series
(`wdt:P179`) and parts (`schema:isPartOf`), limit 24 each, then `MoreStatements`.

Type templates place their `SubjectList`s after the header and before `MoreStatements`.
`schema:Person` lists `schema:author`, `schema:illustrator`, `schema:director`, `schema:musicBy`
and `wdt:P725`, limit 12. `schema:Organization` lists `schema:publisher`, `schema:productionCompany`
and `wdt:P178`, limit 12. `skos:Concept` lists `schema:genre`, limit 24. `wd:Q95074` lists
`schema:character`, limit 24. Route `/` is the site home template: a level-1 `Heading`, a `SearchBox`, the
`personal` `Slot`, then one `TypeList` per vertical (Books, Anime, Visual novels and Recipes, in that order), sorted by
`collections` with limit 12. The host fills the `personal` slot for the signed-in viewer; the page read never does. The home plans four searches and no subject read. Each search returns at most 12 subjects, so the
page's read cost is 48 of 128. `setupPresentation` bootstraps the profile once at startup, immediately after
`setupSemantic`. When a profile is already active, that bootstrap is one pointer read.

Build checks in `test/presentation/platform-profile.test.ts`:

- the platform profile is valid and gives every bundled type a default page
- every list in a shipped document is admitted by the bundled release
- setup activates the platform profile once

## Release evidence and scope

The shared [composition format](../../../../packages/composition/README.md) is a closed, inert document with a
generated schema, resolver, appearance tokens and named slots. The platform profile and released definitions cover
the eight launch configurations. This proves configuration and shared renderer mapping, not a separately executed
browser or native matrix for every type; the generic page needs no per-vertical implementation. Global profiles are
immutable, and publish and activate use their explicit grants. The original Zone starters remain inert documents;
they do not implement the later common Zone page runtime.

The six frozen [page outcomes](../../../../specs/pages-outcomes.test.ts) have a real persona/API receipt, and the
[Workers host cases](../../../../apps/web/tests/pages-workers.host.test.ts) have actual workerd HTTP rendering and
aggregate-derived JSON-LD receipts in development history. The [completion audit](../../../../docs/research/search-pages-completion-audit.md#execution-evidence-actually-inspected)
records their revisions and counts: six native cases passed in that receipt and two Workers cases passed in an
earlier receipt, followed by a later Workers run that failed one of two cases. Those receipts are real artifacts,
not absent tests, but they do not establish a final-revision or root-gate pass. The Workers oracle now checks About
prose before facts and tags, and About before Parts and Relations, while preserving real HTTP SSR before JavaScript,
public-body and JSON-LD assertions, authorization checks, both Workers cases and the non-agent routing-GET ceiling
of one. The latest recorded workerd execution predates that correction and failed one of two cases; the corrected
two-case execution is unverified. Release evidence must give the current revision and case counts. A historical 2/2
cannot replace that receipt. Formatting, imports, converter checks, ordinary Bun `renderToString` and root typecheck
alone do not replace the native cases.

The canonical page read has one descriptor aggregate, separate from bounded routing, definitions and control reads;
it does not promise one total site HTTP request. Request probes are reused within the aggregate. A non-agent routing
subject GET is at most one. Verified-agent
address routing retains the [agent contract](../../../../docs/subject-pages.md#agents) and
[address outcomes](../../test/presentation/agent-page-address.test.ts), including the bounded redirect and its
lookup/hop. Automated accounts retain the [SoftwareApplication template and identity](../../../../packages/composition/README.md#subject-views).
Render and JSON-LD use the same current public source bodies. A fixture canary that was never sent is not
native Kernel or Auth privacy proof.

The shared composition limits of 16 descriptors and 128 total distinct output slots apply at publication and at
the actual aggregate executor. They do not bound backend postings, native Access or dependency work, bytes or SQL. A controlled issuer exercising real
Access is distinct from the six-case driver using the real Auth and Access services. Simple-page permissive Access
growth and profile lookup growth do not measure full native route authorization or every descriptor combination.
The Cost qualifications below remain scoped to their named operations.

## Aggregate execution admission

`readPage` admits the whole plan before dispatch. Every descriptor has closed outer fields and owns plain JSON
data; inherited inputs, accessors, serialization hooks, cycles, non-finite numbers and values JSON would discard
are refused. Validation precedes deduplication, so an invalid alias cannot hide behind a valid read. Errors use
sorted, escaped `/reads/...` pointers. The raw descriptor count remains at most `MAX_PAGE_READS` (16), including
aliases. Search continuation cursors are unavailable in page descriptors; other Search grammar and authorization
remain with the standalone route and its per-read result.

Search limits use the standalone positive integer range 1–100 and default 20. Page languages override descriptor
languages when supplied; without them each descriptor keeps its language choice, and an omitted chain keeps every
language. After binding languages and the native limit default, canonical effective reads share one dispatch and
the exact same result for every original key. Sum the distinct reads' output slots using `MAX_PAGE_COST` (128): one
for subject, reaction or account identity, and the validated native limit for list reads. Overflow refuses the whole
plan before any dispatch. Dispatch still runs at most four reads at once, forwards only authorization and session
credentials, retains public statement hydration, and merges all observed session tokens with the caller's token.

A subject `308` can follow once, using the same GET operation, to an exact canonical same-origin
`/v1/subjects/<id>` Location (root-relative or absolute). Credentials in the URL, query strings, fragments, encoded
or normalized path variants and other operations are refused. A refused redirect or the second response is returned
with the existing per-read semantics; observations from both allowed hops remain in the aggregate session.

The declared native page, language and read suites cover admission boundaries, aliases, standalone errors,
credentials and redirect custody. The fixed-plan growth case in `test/presentation/pages.test.ts` measures actual
native subject dispatch, database rows and wire bytes at 64, 512 and 4096 unrelated subjects and revision histories.
This evidence covers aggregate admission and custody, without claiming whole-query privacy or release promotion.

Later Zone common-page execution is separate from inert starters and the original common page format. Its proof
still requires admitted direct/prepared plans, preparation of a second plan after an earlier read, current
LOCAL/FOREIGN query-safety acknowledgments, revocation after that read, finite retained completion, atomic `200`,
`202 {next}` or `503` without a cursor, current session/cursor restart behavior and aggregate native counters.
No old final-256, replay or home-basis gate, cached permission, or unimplemented Source/default-worker/epoch/query-compiler/
preparation port is claimed here.

## Deletion lifecycle

[Deletion](../../../../docs/deletion.md) and [first public scope](../../../../docs/scope.md) apply to the source
records rendered on pages. Presentation stores platform configuration: immutable `presentation.profile` bodies keyed
by `(route, digest)`, and append-only `presentation.profile_activation` rows keyed by `(route, head)` referencing
those bodies. These are composition templates and activation history, not accounts' public profile records or copies
of their posts/private state. `profiles.ts` reuses at most four validated, owned, deeply frozen configurations by digest; page results and planned
reads are assembled per request, not persisted as a second source store.

Publishing retains previous bodies; activation appends a head and selects the latest one without deleting old heads
or profiles. Both record classes currently remain stored without an automatic expiry or physical cleanup job.
The activation foreign key preserves referenced profiles. There is no user soft-delete, restore or purge route for
this immutable platform configuration, and no implemented cleanup bound to claim. Selecting an older profile is a
new activation with the expected current head, not restoration of user data. Configuration retention does not exempt
personal/private source data from deletion policy.

[Semantic](../semantic/README.md), [Content](../content/README.md) and [Accounts](../access/README.md) remain authoritative
for source soft deletion, 30-day restoration, legal holds and account erasure; Collection/library state remains with
[its owner](../library/README.md). Presentation performs no source purge and retains no deleted content for evidence.
`http/pages.ts` probes subjects/accounts through their current standalone routes before resolving their templates;
a non-200 subject probe propagates its result, and an unavailable public account yields no account page. Planned
sub-reads run the same standalone disclosure routes, so page composition cannot authorize a stale search candidate
or revive a deleted source record. Search-derived page lists inherit [Search's current disclosure, readiness and
source/foreign dependency checks](../search/README.md#deletion-lifecycle). The initial public Search wire omits counts, including rating
totals; internal accounting remains private, and a separately proved safe aggregate contract may later admit a
count. Composition adds no Search authorization or safety proof.

Restoring source data uses the source owner's restore command and current eligibility checks. For search-backed
lists it must also advance the source position and emit reindexing changes, producing newer external versions as
[Search documents](../search/README.md#deletion-lifecycle); Presentation has no separate restore cache or reindex job.
No physical cleanup operation is added here. Source cleanup bounds belong to their owners; profile reads/writes and
page dispatch retain the Cost bounds below.

## Cost

Bounds count examined rows, shared index and heap blocks, and SQL statements. `P` is the number of stored profiles and
`H` the number of activation heads in route 0. Profile bodies are bounded by `MAX_PROFILE_BYTES` (1 MiB); body
validation and hashing are linear in that fixed input. Page bounds assume a valid published profile, fixed descriptor
and page limits, and each dispatched route's own Cost bound. These are source-derived bounds, not latency measurements.

### Read a validated immutable profile

- Touches: one partition-0 keyed profile read and at most four retained immutable bodies. Every read, including a
  cache hit from another pool, validates the actual stored body with the platform validator and verifies its digest.
- Bound: unchanged constant SQL statements/rows and logarithmic indexed blocks in `P`; validation/hash work is
  linear in at most `MAX_PROFILE_BYTES` (1 MiB). Least-recently-used eviction retains at most four bodies and at most
  4 MiB of canonical UTF-8 payload, independently of database history. The private cache owns byte accounting once;
  no history scan, authorization, missing-row or active-head state is cached. Cache admission adds no public rejection.
  These are retained payload/cardinality bounds, excluding JavaScript object/Map overhead, caller-held snapshots,
  concurrent reads and transient validation/cloning allocations; they are not physical heap or peak-memory promises.
- Growth check: original native profile reads plus “cold hot evicted and cross-pool profile reads stay bounded at 1x
  8x and 64x history” in `test/presentation/growth-profiles.test.ts`. The frozen native eviction case in
  `test/presentation/profile-cache.test.ts` and the additional cases in `test/presentation/profiles.test.ts` prove LRU
  reuse, concurrent reads, pool snapshot existence, cold/hot malformed-body refusal, error cleanup, owned immutability
  and exact canonical accounting, including four valid 1 MiB multibyte bodies retaining exactly 4 MiB.

### Active profile lookup

- Touches: latest partition-0 activation by `(route, head)` with `LIMIT 1`, then the referenced profile by
  `(route, digest)` on every lookup, including a warm cache. The database remains the active-head and existence authority.
- Bound: two data statements, constant rows and logarithmic indexed blocks in `H` and `P`, independent of earlier
  heads; body validation and retained payload obey the profile-read bounds above.
- Growth check: original “Active profile lookup stays within its bound as P grows” and the 1x/8x/64x retention
  lifecycle case in `test/presentation/growth-profiles.test.ts`; real-Access publication, activation CAS, receipts,
  sessions, explicit Global grants and denials across eviction in `test/presentation/profiles.test.ts`.

### Profile and active-profile HTTP reads

- Touches: authorize the Global Context through Access, then perform the profile or active-profile lookup above.
- Bound: constant rows/statements and logarithmic indexed blocks in profile, activation and unrelated Global Context
  counts, including route authorization. Every stored body is validated/hashed within 1 MiB; retention stays within
  four entries and 4 MiB. These bounds do not establish composed-page, dispatched backend or physical-memory costs.
- Growth check: “Profile routes stay within their bound with Global Context authorization as profiles grow” in
  `test/presentation/growth-profile-routes.test.ts`; original HTTP cases in `test/presentation/profile-routes.test.ts`.

| Operation                                                          | Touches                                                                                                                                                                                                                                                                                                                                                                        | Bound                                                                                                                                                                                                                                                                                                                                                                     | Growth check                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile publish                                                    | Validate and hash one body; insert 0 or 1 `presentation.profile` row through `(route, digest)`. A conflict is a no-op. The receipted command also reads/writes its fixed partition-0 receipt, basis, position and outbox state, authorizes on the Global Context, and emits one event.                                                                                         | Constant rows and statements, logarithmic blocks in profile and fixed command history (`P`, `H`, and command history); validation and hashing are linear in body bytes, capped at 1 MiB.                                                                                                                                                                                  | `test/presentation/growth-profiles.test.ts`: “Profile publish stays within its bound as P grows”                                                                                                                                                                                                                                                                                                                                          |
| Profile activate                                                   | Read 0 or 1 profile by `(route, digest)`, probe the latest activation by `(route, head)`, and conditionally insert one activation row. The receipted command also touches its fixed command state and emits one event.                                                                                                                                                         | Constant rows and statements, logarithmic blocks in `P`, `H`, and fixed command history; no scan of earlier profiles or heads.                                                                                                                                                                                                                                            | `test/presentation/growth-profiles.test.ts`: “Profile activate stays within its bound as P grows”                                                                                                                                                                                                                                                                                                                                         |
| Subject page read                                                  | Authorize the Global Context, resolve the active profile and (for subject or account targets) active release, resolve the template and plan up to 256 nodes. Dispatch at most 16 distinct reads, at most four concurrently; dispatches with the same canonical descriptor share one request. Subject address resolution can follow the bounded redirect into its account page. | Constant profile, release and authorization rows/statements with logarithmic indexed blocks as their populations grow. Planning is linear in at most 256 nodes; sub-read costs compose from their cited rows below and their owning README rows. At most 16 distinct descriptors and 128 total requested output slots; these do not bound backend or authorization work.  | `test/presentation/growth-pages.test.ts`: “Page read stays within its bound as N grows”                                                                                                                                                                                                                                                                                                                                                   |
| Inverse links and public collections page reads                    | Inverse links check visibility and Access, read indexed inverse rows, and fill labels for returned holders. Public collections read the exact count from `subject_listing`, scan indexed subject-collection pairs, then check current visibility of returned Collections.                                                                                                      | Inverse links return at most `limit`; candidates are at most `4 × limit + 1` with a type filter or `limit + 1` without, plus at most 1,000 count candidates. Public collections use `limit` 1–6, scan at most `limit + 1` pairs, and inspect at most `limit` Collections. Rows are bounded by these fixed limits and statements stay constant as the anchor's lists grow. | `test/presentation/page-read-kinds.test.ts`: “inverse links read stays within its bound at 1, 10 and 100 holders”; “public collections read stays within its bound at 1, 10 and 100 collections”                                                                                                                                                                                                                                          |
| Account page, identity, discussions, replies and collections reads | Account pages probe the handle claim and account, then dispatch at most 16 distinct reads with summed published `readCost` at most 128. Identity reads may add one avatar summary. Discussion/review pages read at most `4 × limit` candidates and hydrate returned threads; replies hydrate each reply and containing thread; collections use the BASIC view.                 | Constant rows and statements and logarithmic blocks as unrelated accounts and account activity grow, at fixed limits. Each list does O(limit) candidate and hydration work: thread limit 1–20, reply limit 1–20, and collection limit 1–24.                                                                                                                               | `test/presentation/agent-read-kinds.test.ts`: “account page read stays within its bound at 1, 10 and 100 threads”; “account identity read stays within its bound at 1, 10 and 100 unrelated accounts”; “account discussions read stays within its bound at 1, 10 and 100 threads”; “account replies read stays within its bound at 1, 10 and 100 replies”; “account collections read stays within its bound at 1, 10 and 100 collections” |
| Reaction counts page read                                          | Check subject visibility and Access, then read the subject's reaction-total range; the page does not read the viewer's own reaction.                                                                                                                                                                                                                                           | At most seven reaction-total rows in one statement, independent of contributor count; visibility and authorization add a constant number of point reads and statements with logarithmic blocks.                                                                                                                                                                           | `test/presentation/page-read-kinds.test.ts`: “reaction counts read stays within its bound at 1, 10 and 100 contributors”                                                                                                                                                                                                                                                                                                                  |

The profile-route growth check exercises both HTTP routes with Global Context authorization while profile and unrelated
Context populations grow. It supplies the route-level evidence that the direct profile lookup checks alone did not cover.
