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
`schema:character`, limit 24. Recipe remains a home TypeList vertical and uses the generic template.
Route `/` is the site home template: a level-1 `Heading`, a `SearchBox`, the
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

Profile commands retain their invocation's digest/head, detached deeply frozen plain-data body and original
callback or live authorization capability before asynchronous work. Validation, hashing and storage use the same
owned body without evaluating accessors or serialization hooks; caller objects remain mutable. Authority is checked
fresh on each attempt and before receipt replay; the executor retains receipt-byte and basis ownership. Trusted
bootstrap captures its potential body before the initial pointer read and defers an invalid-body error until needed,
so an already-active setup still returns after one pointer read without writing. This adds bounded in-memory work
only, with no additional SQL, cache entries, authority decisions or command frames. Commerce catalogue and Access
identity-bridge maps initialize without reading unfinished module bindings so these native files can load; Global
Context identity and bridge behavior stay the same. The connected invocation cases
in `test/presentation/profile-invocation-custody.test.ts` are authored but unrun; native, growth and browser proof
remain deferred for this change. Compiler evidence alone does not establish those outcomes.

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
aliases. Search descriptors accept an opaque top-level `cursor`, which the adapter forwards to the standalone Search body.
`body.cursor` remains closed to callers; other Search grammar and authorization remain with the standalone route
and its per-read result. Public OwnerLeaf filters reject the entire aggregate before dispatch.

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
  Publication cases bind the dedicated receipt-key fixture; the cache file evaluates the commerce catalogue before
  presentation so the well-known Global Context id is initialized.

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

## Selected subject pages and continuation

`pages.read` accepts `target.realm` only with a subject target. The native Realm, publication
and Context readers select one Context for every factual subject/link/relation descriptor.
A genuine null publication selects independently authorized Global facts and exposes only
Global population metadata. Unknown, denied or banned Realms never become a Global success.
After leaves, fresh subject, Context, Realm, publication and protected-ban guards discard
changed output: concealment is 404, changed selection is retryable `dependency_unavailable`.

`ThreadList` and `ReviewList` read the existing `subject_threads.list` operation with the native
`discussion` and `review` kinds. Both use limit six for Global and retain limit five for selected
Realms, using the Realm population ID as place (Global uses the Global Context ID). The unmodified
`{threads,next}` body, original status and merged native session retain current board/post/place disclosure.
No alternate review store, question default, grant, count or order is inferred. Web renders the aggregate
leaves and does not supplement them with Global reads. Scoped producers without a native adapter return
unavailable rather than Global or empty data.

A subject full view may continue one current `paged:true` node with top-level
`continuation: {node,cursor}`. Planning substitutes the opaque native cursor before dedup;
links and forward relations use separate native property streams. Thread cursors retain their
native 4096-character bound; Semantic routes retain their native cursor admission. All leaves
share the existing 16-read/128-slot budget and four dispatch workers. Authority controls are
fixed anchored native reads under the original admission and deadline, with no new retry.

A subject page continuation resolves its current template and Context before planning. It dispatches the selected
node's native links/relations/subject-threads read and retains ordinary subject/control reads. Other links, relations,
Search and subject-thread descriptors return 204 with an empty body; they are unrequested, not empty lists. Clients retain independent group state or
offer a fresh-start link when opening a continued document directly. Full-document planning bounds still apply.

### Document bodies in aggregate pages

`documentRead` describes the configured document-valued properties for the selected subject and Context. The
executor reuses that page's disclosed subject observation and `pageDocumentReferences` selects at most one released
statement per property by rank and reader/original language; equal-rank, equal-language candidates use the smallest
statement UUID in code-unit order. It dispatches the selected unique body IDs through the existing in-process
`GET /v1/documents/{id}` operation. This is the only body disclosure path: locators, history and competing
candidates are not readers.

The subject and optional Context stay bound for the whole operation. After body reads, the HTTP page reader reserves
and performs a final selected-subject read; concealment remains 404, and a changed subject observation discards the
page result as retryable `dependency_unavailable`. The body route retains its own current disclosure checks. A body
404 remains absent for Web to render as unavailable; other body failures retain their failure status. Web receives
only exact id/subject/candidate/language/digest matches with an available validated body.

Each selected body costs one native read and one requested-value slot. The plan admits at most fifteen distinct
bodies (one subject read plus fifteen bodies reaches the existing sixteen-read ceiling) and shares the page's
128-slot budget. The final subject guard and other probes or reads reduce the available body allowance. Admission
rejects an oversized effective plan instead of truncating selected values. Overflow of that fifteen-body ceiling is
admitted from the disclosed observation; a Recipe page selects at most its two document-typed properties and is not
an overflow fixture. Bodies remain request-local and the aggregate page response stays `private, no-store`.

- Touches: the disclosed subject observation, then one standalone `GET /v1/documents/{id}` per selected unique body
  with that body's current Access check. Unrelated authored-field and subject rows in the selected subject's partition
  are not returned.
- Bound: constant native requests, Access checks and response bytes for a fixed selected neighbourhood; constant SQL
  rows and statements; logarithmic indexed blocks as that partition's unrelated history grows.
- Growth check: `test/presentation/public-documents.test.ts`: “fixed public bodies keep native request, SQL, Access and
  byte bounds at unrelated histories 64/512/4096”.

## Configured catalogue lists

`TypeList` accepts an optional public `FilterDocument` in `props.filter`. The shared Filter parser owns its grammar
and limits; planning intersects it with `props.types` without replacing the configured type restriction. The closed
composition schema and editor expose this same document, including saved catalogue filters. Publication admits
TypeList filters against the active semantic release, including saved expansion, and refuses private OwnerLeaf
operands. Runtime resolution admits the selected document again against the current release.
Serialized JSON configuration is also accepted through that same public parser and admission; it cannot introduce
private operands or replace the configured Types.

A TypeList on a route, subject overview, account page or full view may continue by node ID. Its native Search cursor
is attached before deduplication, so identical sibling lists remain independent after one advances. Other Search,
links and relation descriptors are unrequested (204) on that continued response. Full-document admission still uses
16 distinct reads and 128 slots; each configured list retains its published limit of at most 24. `paged:true` is an
optional preview limit of at most 12, and is not needed to reach later pages.

The Web renderer uses only native hit pages and their explicit `next`. More and See all open `/search/list` with the
page target, node and opaque cursor. Each request resolves the current server-owned filter, types, sort, languages
and selected Context through `pages.read`; URLs cannot supply an account override or a replacement filter. The full
list uses the shared cover grid, and unavailable pages offer retry instead of claiming empty or complete results.
Realm populations keep the existing unavailable Search adapter until their native producer supports that scope.

## Common Collection members in compositions

`Members` configures one closed source: `{kind:"collection",id}`, `{kind:"everything"}`, or
`{kind:"state",profileId,stateSetId,stateId}`. State identifiers come from an accepted Library profile.
There is no account selector. `filter` is the ordinary serialized JSON filter from common-members GET;
`sort` is always native `id`. The native owner admits the filter, including owner leaves and retained
preparation. `TypeList` retains the public catalogue filter contract above. Members support `paged`
and independent node continuations.

Presentation binds viewer-self keys through Commerce's native logical-key resolver. This point-discovery
method delegates to the existing built-in read and ID authority; it never scans the viewer's Collection
population. An account target belonging to another viewer conceals these reads. Anonymous viewers also
receive concealment. Bound member requests use the existing common GET with `view=FULL`, exact filter,
limit and opaque cursor. Responses retain native status, body and Retry-After; 202 and unavailable are
never converted into an empty successful list. No Source or owner-query execution is implemented here.

Composed dispatches and viewer-self resolution points share the request's 16-read/128-slot ledger. Each distinct viewer-self descriptor
also admits and charges two reads/slots for native discovery and its final current-owner recheck. The
final rechecks run after leaf/document work, before output. Standalone member execution retains its own
current source/disclosure and preparation guards. Scoped Realm member/search adapters remain explicitly
unavailable until their native producers support the same selected Context.

The Web renderer consumes embedded summaries without per-row hydration. More uses the existing session
BFF. Concealed public-shell member reads hydrate only after the browser establishes a signed-in session,
including private curated sources; their native disclosure still decides the result. More reloads the
current composition with only that node's native continuation. Other member/search nodes return 204 and
retain independent client state. Preparing, stale, invalid, unavailable, empty and concealed results have
distinct behavior; private continuation queries use no browser cache retention.

Relative Zone routes never become Global route continuation targets. Their source-dependent reads remain
at the native Zone readiness boundary until its owner supplies node continuation support.
