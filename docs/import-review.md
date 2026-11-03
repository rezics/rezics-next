# Provider review queue

The authenticated `/imports/review` page prepares and reads provider suggestions in an explicitly selected
Context. This is derived discovery; acceptance and selection remain separate native editorial operations.

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
