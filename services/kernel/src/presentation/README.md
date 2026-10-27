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
`personal` `Slot`, then a `LinkGrid` of Books, Anime, Visual novels and Recipes, then one `TypeList` per vertical in
that order, sorted by `collections` with limit 12. The host fills the `personal` slot for the signed-in viewer; the
page read never does. The home plans four searches and no subject read. Each search returns at most 12 subjects, so the
page's read cost is 48 of 128. `setupPresentation` bootstraps the profile once at startup, immediately after
`setupSemantic`. When a profile is already active, that bootstrap is one pointer read.

Build checks in `test/presentation/platform-profile.test.ts`:

- the platform profile is valid and gives every bundled type a default page
- every list in a shipped document is admitted by the bundled release
- setup activates the platform profile once

## Cost

These bounds follow `profiles.ts`, its SQL, and the presentation profile migration and schema dump; they are derivations, not measurements.
Let P be the number of stored profiles and H the activation head count. A body is at most `MAX_PROFILE_BYTES` (1 MiB); growth checks hold that size fixed.
Rows means rows examined, including filtered rows, not just returned rows; blocks means shared blocks accessed, including index, heap, and payload blocks.
A primary-key probe examines O(1) rows and O(log size) blocks. Logarithms mean `log(2 + size)`. No operation scans earlier profiles.
Publish and activate are receipted commands on partition 0. K denotes the seven framework statements of one fresh attempt; add one receipt read when a receipt is configured.

### Page read execution

- Touches: `readPage` dispatches each distinct descriptor through its standalone route: `Anchored subject read` in `src/semantic/README.md` or `Search planning and engine page` in `src/search/README.md`. A subject `308` adds one subject route.
- Bound: For k <= 16 descriptors, equal canonical JSON descriptors share a dispatch, so there are at most k distinct dispatches, with at most four running at once. SQL rows, blocks and statements are the sum of those route costs, plus any followed subject route; this executor issues no SQL. Cost is independent of N, P and H beyond those routes. Session merging is O(k x 32) components.
- Growth check: `test/presentation/reads.test.ts`: `a page holds at most sixteen valid reads, runs at most four at a time and dispatches identical reads once`; dispatches stay at most k at every page size.

### Page read

- Touches: `POST /v1/pages:read`: one Global Context authorization, then one `activeProfile` lookup and, for a subject target, one `activeRelease` lookup. Each lookup is a primary-key probe cached by digest. `resolveTemplate` is O(log T) for T <= 128. `planReads` is linear in at most 256 nodes. At most 16 sub-reads return at most 128 subjects, each costing its standalone route (`Anchored subject read` or `Search planning and engine page`). The subject read that selects the template is reused and is not repeated. This request releases its admission slot before those sub-reads; each sub-read takes its own.
- Bound: Rows and statements constant in N; blocks logarithmic. Template resolution and planning add no SQL. Sub-read rows, blocks and statements are those of their own README rows.
- Growth check: `test/presentation/growth-pages.test.ts`: `Page read stays within its bound as N grows`

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
