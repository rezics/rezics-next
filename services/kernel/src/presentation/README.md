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

## Deletion lifecycle

[Deletion](../../../../docs/deletion.md) and [first public scope](../../../../docs/scope.md) apply to the source
records rendered on pages. Presentation stores platform configuration: immutable `presentation.profile` bodies keyed
by `(route, digest)`, and append-only `presentation.profile_activation` rows keyed by `(route, head)` referencing
those bodies. These are composition templates and activation history, not accounts' public profile records or copies
of their posts/private state. `profiles.ts` caches validated, frozen configuration by digest; page results and planned
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
or revive a deleted source record. Search-derived page lists inherit [Search's disclosure checks and count-policy
gap](../search/README.md#deletion-lifecycle), including pending runtime source/composition proof; composition adds no
immediate count-privacy guarantee.

Restoring source data uses the source owner's restore command and current eligibility checks. For search-backed
lists it must also advance the source position and emit reindexing changes, producing newer external versions as
[Search documents](../search/README.md#deletion-lifecycle); Presentation has no separate restore cache or reindex job.
No physical cleanup operation is added here. Source cleanup bounds belong to their owners; profile reads/writes and
page dispatch retain the Cost bounds below.

## Cost

These bounds follow `profiles.ts`, its SQL, and the presentation profile migration and schema dump; they are derivations, not measurements.
Let P be the number of stored profiles and H the activation head count. A body is at most `MAX_PROFILE_BYTES` (1 MiB); growth checks hold that size fixed.
Rows means rows examined, including filtered rows, not just returned rows; blocks means shared blocks accessed, including index, heap, and payload blocks.
A primary-key probe examines O(1) rows and O(log size) blocks. Logarithms mean `log(2 + size)`. No operation scans earlier profiles.
Publish and activate are receipted commands on partition 0. K denotes the seven framework statements of one fresh attempt; add one receipt read when a receipt is configured.

### Page read execution

- Touches: `readPage` dispatches each distinct descriptor through its standalone route: `Anchored subject read` in `src/semantic/README.md`, `Search planning and engine page` in `src/search/README.md`, or one of the account reads below. A subject `308` adds one subject route.
- Bound: For k <= 16 descriptors, equal canonical JSON descriptors share a dispatch, so there are at most k distinct dispatches, with at most four running at once. SQL rows, blocks and statements are the sum of those route costs, plus any followed subject route; this executor issues no SQL. Cost is independent of N, P and H beyond those routes. Session merging is O(k x 32) components.
- Growth check: `test/presentation/reads.test.ts`: `a page holds at most sixteen valid reads, runs at most four at a time and dispatches identical reads once`; dispatches stay at most k at every page size.

### Page read languages

The optional `languages` chain uses the search request's 1–8 unique language tags. A site sends the reader's locale and
that locale's sibling scripts in priority order, without appending `en`; search label choice falls back to the work's
original language and then `en`.

- **Touches:** nothing new; the existing search reads carry one more body field.
- **Bound:** the page read's reads, statements and engine requests are unchanged. Label choice is linear in at most 8 ranges per hit, inside the search read.
- **Growth check:** none; no read changes. `test/presentation/page-languages.test.ts`, "a page read passes the reader's language chain to its search reads", proves the behaviour.

### Page read

A subject target follows its merge survivor, then resolves current verification through Access's public agent lookup.
For a verified active account it answers `308` directly to the account's handle page, preserving the view,
languages and query. The JSON body is `{ redirect: { from: subjectId, to: handle } }`; `Location` names
`/v1/pages:read` with an encoded JSON `target` query parameter replacing the POST body's target when followed.
Never verified, pending, suspended, released, revoked and deleted accounts do not redirect or disclose an account handle.
When no active verified account resolves, the subject page clears the account reference in its embedded subject read.
Subject reads and account reads retain their existing behavior.

An account without a named subject uses `schema:Organization` for an organization, `schema:SoftwareApplication` for
an automated account, and `schema:Person` for a person. Automation and its `operatorId` come from the public account
identity, as in `GET /v1/accounts?ids=`, and remain available in the account identity read on the page.

A subject or account target may name a `view`; the page is then that view's document, planned and read the same way, and
`views` lists the views the page's templates define. A view no template defines, and a `view` on a route target, are
refused (`404` and `400`).

- Touches: `POST /v1/pages:read`: one Global Context authorization, then one `activeProfile` lookup and, for a subject or account target, one `activeRelease` lookup. Each lookup is a primary-key probe cached by digest. `resolveTemplate` is O(log T) for T <= 128. `planReads` runs once and is linear in at most 256 nodes. At most 16 sub-reads return at most 128 subjects, each costing its standalone route (`Anchored subject read`, `Search planning and engine page`, or an account read below). The subject and account probes are reused. This request releases its admission slot before those sub-reads; each sub-read takes its own.
- Bound: Rows and statements constant in N; blocks logarithmic. Template resolution and planning add no SQL. Sub-read rows, blocks and statements are those of their own README rows.
- Growth check: `test/presentation/growth-pages.test.ts`: `Page read stays within its bound as N grows`

### Page read for a subject address

- Touches: the existing subject probe plus one indexed public agent lookup by subject id in the subject's partition. Access confirms the current verification against the account authority.
- Bound: one extra indexed point lookup per subject page read; statements and rows constant, blocks O(log N).
- Growth check: `test/presentation/agent-page-address.test.ts` grows verified agents and unrelated subjects at three scales and measures subject and handle page reads.

### Account page read

- Touches: one handle claim and one account row (the account probe), one subject probe when the account is verified, then at most 16 distinct reads in one `readPage` call.
- Bound: two probes plus the planned reads, whose summed `readCost` is at most 128 (checked at publish). Nothing grows with the number of accounts or with the account's activity beyond each list's `limit`.
- Growth check: `test/presentation/agent-read-kinds.test.ts`, "account page read stays within its bound at 1, 10 and 100 threads", scales [1, 10, 100].

### Page inverse links read

- Touches: One `GET /v1/subjects/:id/links` property-page call. The standalone route checks subject visibility and Access, reads the indexed inverse page, returns its exact property count or bounded type-filter count, and fills labels for returned holders.
- Bound: At most `limit` holders are returned. With a type filter, the established route scans at most `4 × limit + 1` page candidates and samples at most 1,000 count candidates; without a type filter the page scan is at most `limit + 1`. Label work is bounded by the returned holders. Rows stay within those fixed limits and statements remain constant as the anchor's in-degree grows.
- Growth check: `test/presentation/page-read-kinds.test.ts`: `inverse links read stays within its bound at 1, 10 and 100 holders`.

### Page public collections read

- Touches: One `GET /v1/subjects/:id/collections` call with a limit of 1–6. The standalone route resolves the subject, reads its public collection count from `subject_listing`, scans at most `limit + 1` indexed pairs, then checks at most `limit` Collection rows for current public visibility.
- Bound: The count is one primary-key probe and remains exact. Pair and Collection work is bounded by `limit + 1` and `limit`, respectively. At the fixed preview limit, rows and statements grow only until six collections are considered, then stay constant as the subject's public collection count grows.
- Growth check: `test/presentation/page-read-kinds.test.ts`: `public collections read stays within its bound at 1, 10 and 100 collections`.

### Page reaction counts read

- Touches: One `GET /v1/subjects/:id/reactions` call. The standalone route checks subject visibility and Access, then uses the existing reaction-total read for the subject id; it does not read or return the viewer's own reaction.
- Bound: The reaction-total range returns at most seven rows in one statement, independent of reaction contributors. Subject visibility and authorization add a constant number of point reads and statements.
- Growth check: `test/presentation/page-read-kinds.test.ts`: `reaction counts read stays within its bound at 1, 10 and 100 contributors`.

### Page account identity read

- Touches: One `GET /v1/accounts?handle=<h>` call. The standalone public profile read probes the handle claim and then the account identity, and adds one avatar summary read only when an avatar exists.
- Bound: Constant rows and statements, logarithmic blocks in account and handle-claim counts; at most one account identity is returned. Unknown handles stop after the claim probe and answer `accounts: []`.
- Growth check: `test/presentation/agent-read-kinds.test.ts`: `account identity read stays within its bound at 1, 10 and 100 unrelated accounts`.

### Page account threads read

- Touches: One `GET /v1/accounts/{accountId}/threads?kind=discussion|review&limit=&cursor=` call. Discussion reads the account's discussions; review reads its reviews. Content checks the account's public-view flag, reads at most `4 × limit` author-item candidates, then hydrates candidates through the existing thread disclosure route.
- Bound: At most `limit` thread summaries are returned. Candidate and hydration work is O(limit) for `limit` 1–20, independent of the account's thread count; statements remain constant as activity grows for a fixed limit.
- Growth check: `test/presentation/agent-read-kinds.test.ts`: `account discussions read stays within its bound at 1, 10 and 100 threads`.

### Page account posts read

- Touches: One `GET /v1/accounts/{accountId}/posts?limit=&cursor=` call. Content checks the account's public posts view, reads at most `4 × limit` author-item candidates, then hydrates each reply and its containing thread. A hidden thread title remains null in the returned reply context.
- Bound: At most `limit` replies are returned. Candidate and hydration work is O(limit) for `limit` 1–20, independent of the account's reply count; statements remain constant as activity grows for a fixed limit.
- Growth check: `test/presentation/agent-read-kinds.test.ts`: `account replies read stays within its bound at 1, 10 and 100 replies`.

### Page account collections read

- Touches: One `GET /v1/accounts/{accountId}/collections?view=BASIC&limit=&cursor=` call. The standalone Commerce route checks public-view visibility and reads the account's public collections in its existing order.
- Bound: At most `limit` collections are returned for `limit` 1–24; indexed page work is bounded by that limit and independent of the account's collection count. The page read always selects BASIC to keep the result bounded.
- Growth check: `test/presentation/agent-read-kinds.test.ts`: `account collections read stays within its bound at 1, 10 and 100 collections`.

### Profile publish

- Touches: `publishProfile` validates and hashes one body (linear in at most 1 MiB, once per publish, before a connection is checked out) and inserts 0 or 1 `presentation.profile` row through `profile_pkey(route, digest)`; a conflict does nothing. The receipted command emits one `com.rezics.presentation.profile.published.v1` event even when the digest exists. Grow P and H; fix body size and authorization evidence.
- Bound: Rows O(1), blocks O(log P + log H), one body statement, nine including the command; no scan of earlier profiles.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Profile publish stays within its bound as P grows`

### Profile activate

- Touches: `activateProfile` reads 0 or 1 body through `profile_pkey`, then reads the latest head through a backward `profile_activation_pkey(route, head)` probe and inserts 0 or 1 activation when that head is the expected head, with a profile foreign-key probe. A stale head writes nothing and rolls back. A missing digest raises `ProfileNotFoundError` after authorization. Grow P and H; fix body size and authorization evidence.
- Bound: Rows O(1), blocks O(log P + log H), two body statements, ten including the command; no scan of earlier profiles.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Profile activate stays within its bound as P grows`

### Profile read

- Touches: `readProfile`: a malformed digest does no SQL; otherwise one `profile_pkey` probe reads 0 or 1 body, including on a cache hit. A cold body is validated once, its digest verified with `profileDigest`, frozen and cached by digest. Grow P and H; fix body size.
- Bound: Rows O(1), blocks O(log P + log H), zero or one data statement; no scan of earlier profiles.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Profile read stays within its bound as P grows`

### Active profile lookup

- Touches: `activeProfile`: a backward `profile_activation_pkey` probe with LIMIT 1 reads 0 or 1 head; a cache miss adds Profile read, which has its own growth check. Grow P and H; fix the active body size. The check runs the default warm-up at each scale and takes the median of the default repetitions, measuring the warm lookup.
- Bound: Rows O(1), blocks O(log P + log H), one or two data statements; no scan of earlier profiles.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Active profile lookup stays within its bound as P grows`

### Profile bootstrap

- Touches: `bootstrapProfile`: one latest-head probe when a profile is active, returning that digest. When none is active, one command repeats the probe, publishes 0 or 1 profile, inserts the first activation and emits two events, without a receipt or basis. Grow P and H; fix body size, including the already-active path.
- Bound: Rows O(1), blocks O(log P + log H), one statement when active, otherwise eleven including the command; a race may add one head lookup after rollback. No scan of earlier profiles.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Profile bootstrap stays within its bound as P grows`

### Profile read route

- Touches: `GET /v1/presentation/profiles/:digest`: one Global Context authorization, then Profile read above; the route adds no SQL of its own.
- Bound: Profile read plus one Global Context authorization: rows O(1), blocks O(log P + log H), constant statement count.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Profile read stays within its bound as P grows`. This check measures the lookup without the route or its Global Context authorization.

### Active profile route

- Touches: `GET /v1/presentation/active`: one Global Context authorization, then Active profile lookup above; the route adds no SQL of its own.
- Bound: Active profile lookup plus one Global Context authorization: rows O(1), blocks O(log P + log H), constant statement count.
- Growth check: `test/presentation/growth-profiles.test.ts`: `Active profile lookup stays within its bound as P grows`. This check measures the lookup without the route or its Global Context authorization.
