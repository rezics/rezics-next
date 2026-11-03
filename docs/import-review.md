# Provider review queue

The authenticated `/imports/review` page prepares and reads provider suggestions in an explicitly selected
Context. This is derived discovery; acceptance and selection remain separate native editorial operations.

## Cross-media dump seed

`scripts/datasets/cross-media-seed.ts` imports the Steins;Gate, Clannad and Fate families from extracted native
Bangumi and VNDB dumps. Title matching locates franchise entry works; family membership then follows mapped source
relations, capped at 256 works per franchise. Collaboration, catch-all related-to, other character appearances,
staff credits, episodes, releases and `chars.main` / `releases_supersedes.rid` endpoints stay referenced rather
than expanding through unrelated filmography. A synopsis mentioning another franchise does not elect a work. The
command consumes dump records; it does not replace them with live API records or fabricated catalogue examples.

Decision: seed each provider under separate `cross_media` source aliases, match franchise titles only, and report
unmapped source rows as explicit gaps without merging identities by name.

Decision: Bangumi type 3 maps to MusicAlbum and type 6 to Movie or TVSeries by pinned platform codes 6002 (film)
and 1/2/3/6001 (TV), including `Movie`/`TV` labels; unknown live-action platforms stay exact `/platform` gaps.

Extract a [Bangumi Archive](https://github.com/bangumi/Archive) release into a directory containing the original
`subject.jsonlines`, `subject-relations.jsonlines`, `subject-characters.jsonlines`, `subject-persons.jsonlines`,
`person-characters.jsonlines`, `person-relations.jsonlines`, `person.jsonlines`, `character.jsonlines` and
`episode.jsonlines`. Extract the licensed [VNDB database dump](https://vndb.org/d14) into a directory containing
its `db/` tables and matching `.header` files. Use the importer's pinned 2026-10-25 VNDB snapshot: its ordinary
source-statistic conversion uses that date. Retain the original archives, archive digests, README and licences.
Bangumi metadata uses CC BY-SA 3.0; VNDB distinguishes ODbL database terms and DbCL metadata contents. Neither
provider's metadata licence grants cover rights. The native Bangumi archive has no cover acquisition here.

```sh
bun scripts/datasets/cross-media-seed.ts \
  --bangumi .temp/dumps/bangumi \
  --vndb .temp/dumps/vndb \
  --state .temp/cross-media/importer.sqlite \
  --result .temp/cross-media/result.json \
  --api https://api.rezics.example \
  --auth https://auth.rezics.example \
  --account-key .temp/keys/importer.jwk \
  --account 6b147e8d-1762-4717-9a65-aeb435cb843e \
  --client rezics-importer
```

Use an ordinary provisioned automated account, first-party client, owner-only private JWK and the importer
permissions in the [importer runbook](../services/importer/README.md#command-line), plus `subject:read`.
This command does not grant permissions or accept/adopt candidates. The existing importer owns private SQLite
state, source fences, immutable operation keys, metadata attribution, proposal reconciliation and VNDB statistics.
All catalogue writes use the normal import transport. Dedicated `bangumi_cross_media` and `vndb_cross_media`
aliases keep this subset's membership independent of a complete provider import. Reuse the same state file for
idempotent retries; keep both extracted snapshots unchanged during selection. Missing input and invalid conversion
fail before API writes. A later API failure retains the ordinary importer's recoverable state and exits nonzero.

The JSON result includes franchise membership, native subject IDs, readable `/subjects/{id}/{slug}` routes,
per-provider work and entity run counts, actual `GET /v1/subjects/{id}` responses, source-file SHA-256 digests,
explicit `gaps` and resumable `unresolved` edges. Each gap retains its complete original row and names its exact
source columns in `fields`. Create bootstrap facts are selected; later relations remain proposed until an editor
with independent accept/adopt authority reviews them. The command never grants those permissions. `vn_anime.aid`
identifies AniDB; it cannot be treated as a Bangumi subject ID. Cited `bgm.tv` URLs bind VNDB records to Bangumi
identifiers; titles and names never merge identities. Reopening the same state resumes unresolved graph work and
does not duplicate accepted records or change selection.

Representable family relations, character appearances, qualified voice credits, staff credits, episodes, releases
and producer credits are written through ordinary batch APIs using `cross-media-entities@1` for non-work grains
and the existing Bangumi/VNDB work converters for types 1/2/4 and visual novels. Missing Concept/Scheme bindings,
omitted relation.3/6 and staff.3/6 inventories, unknown live-action platforms and missing target records stay
exact-field gaps or unresolved edges. The focused `specs/cross-media-seed.test.ts` cases use synthetic dump-shaped
input and an importer transport fixture to pin family election, explicit gaps, COPY decoding and idempotent reopen.
`specs/cross-media-seed-api.test.ts` drives the production seed through ordinary batch/read/accept/adopt personas.
Licensed-dump native acceptance remains deferred to integration.

The selection and incident-edge shape comes from `legacy-final:scripts/datasets/bangumi.ts` and
`legacy-final:scripts/datasets/vndb.ts`; COPY text decoding retains the latter's escaping behavior. Format
references read for this implementation are the official Bangumi Archive README and VNDB's grouped-table
contract already used by the existing converter and table reader.

## Provider queue

`GET /v1/review-candidates` has a closed query: required `source` (the native source-name grammar), optional
`context` (Global by default), `status` (`pending` by default or `accepted_unselected`), `limit` (1–100, default 20)
and opaque `cursor`. Its only successful page shape is
`{candidates:[{subject,candidate,adoption}],next,freshness}`. `subject` is the exact native UUID; `candidate` is the
existing subject candidate row, including statement, release, revision, decision/head, selected rank and source;
`adoption` is the existing `{mode,head}` or null. Source retains `source`, `external_id`, `record_revision`,
`digest`, `converter_revision` and `field_group`; references remain native statement references. Freshness is the existing eventual
projection `{consistency:"eventual",target_seconds:10,caught_up}` shape and Session propagation remains native.

`POST /v1/review-candidates:prepare` has the closed body `{source,context?,status?}` and returns
`202 {preparing:true}` with `Retry-After`. It authorizes current `context:accept` on the exact live Context and
atomically records derived preparation work through the kernel operational transaction and shared worker.
Preparation is idempotent and has no public operation identifier or domain receipt. GET never starts work.

An unbuilt or unproved index without useful rows or progress returns the standard retryable 503. Current useful
rows may be returned while bootstrap is incomplete, with `caught_up:false`. A bounded raw discovery step that advances
without a useful page returns only `202 {next}`. A complete empty 200 requires completed source preparation and
current projection coverage. Continuations bind the current viewer, source, Context and status using the native
cursor codec; a continuation conveys no authorization. Neither operation grants Subject visibility or adoption.

The page distinguishes loading, missing preparation, preparing, complete empty, denied, invalid/stale and
unavailable/retry outcomes. Prepare, retry and continuation are explicit interactions, with no empty polling loop.
Authenticated queue data stays in the private session BFF and browser state, outside public SSR/query caches.
Rows use emitted definition labels and native values/evidence, link to the ordinary Subject journey and retain
the selected Context. The existing visible-row toolbar seals at most 20 explicitly checked suggestions; changing
scope clears selection while preserving earlier uncertain attempts. Decisions use existing endpoints, current
heads and original idempotency keys on uncertain retries. Queue refresh and current Subject readings start in
parallel, with individual results retained on refresh failure. Selection requires its independent `context:adopt`
authority and exact slot workflow.

The queue keeps up to five opaque page addresses in the current private visit. Previous, next, retry-current-page
and start-over actions reread native twenty-row pages under the current session; older addresses are explicitly
truncated. Opening an exact candidate review keeps the source, Context, status, page and candidate address in
memory. Returning rereads that page and highlights the candidate only if it is still there. A moved candidate is
reported without cached row data. An expired continuation offers an explicit start-over action. Account changes
retire the visit, and cursors and session material are never placed in the URL or persistent browser storage.

Native exports belong to `semantic/provider-review-queue.ts`; route schemas and action/exposure metadata belong
to `semantic/http/provider-review-queue.ts`. Generated `KernelClient` endpoints are `review-candidates.get` and
`review-candidates.$prepare.post`. Registration alone does not establish running-worker availability.
The module exports `ProviderReviewScope`, `ProviderReviewStatus`, `ProviderReviewCandidate`,
`listProviderReviewQueue`, `prepareProviderReviewQueue`, `stepProviderReviewBootstrap`,
`providerReviewProjection` and `registerProviderReviewWork`; HTTP exports are
`ProviderReviewQuerySchema`, `ProviderReviewPrepareSchema`, `providerReviewSchemas` and `providerReviewQueueRoutes`.

The bounded index stores source/Subject/candidate keys, never statements or permission decisions. Native point
hydration groups Subject homes and releases them before Context, source fences and related homes; final guards
apply current disclosure, identity, lifecycle and account fences. Exact queue associations participate in existing
Semantic minimization and cannot restore an association after its native fence.

Post-integration proof is `bun run --cwd services/kernel check test/semantic/provider-review-queue.test.ts` and
`bun scripts/worker-check.ts --local -- bun test apps/web/tests/provider-review-queue.test.ts`. Native website
acceptance of the served `/imports/review` BFF is `apps/web/tests/native/catalogue-provider-review.host.test.ts`.
Story and visual review remain separate from source/type verification.

Review stories use `Pages/Imports/Review queue`: `pages-imports-review-queue--loaded`, `--preparing`, `--empty`,
`--denied`, `--unavailable`, `--invalid`, `--loading` and `--decision` (each suffix uses the same full prefix).
The loaded story changes the status filter; preparation and unavailable stories exercise explicit continuation
and preparation. Web story review and Root screenshots at phone390/desktop1280 in both themes remain pending.
