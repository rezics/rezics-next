# Ranking generation template

`derived-generation.ts` owns the shared Access lifecycle in migration 110: a
manager-authorized build receipt, a lease epoch that fences old workers, a
checkpoint committed with each derived batch, validation before `ready`, and an
exact-revision active-head CAS. `ranking.ts` adds the admitted rating signal
profile, sparse partition totals and generation-bound delivery. The source of
truth remains the rating observation; the relay envelope is a retained input,
and Access score rows can be rebuilt.

To add another derived family, copy the family-specific parts of
`ranking.ts`, `ranking-schema.ts`, `routes/recommendations.ts` and
`tests/qa/integration/recommendation-generation.test.ts`. Keep the shared
receipt and head in `derived-generation.ts`; add a family row and derived tables
in the reserved Access migrations. The write/read template is
`POST /v1/recommendations/generation-builds` followed by
`GET /v1/recommendations/generations/:generation` and an exact-head activation.
The request pins profile, population, semantic basis and partition count; the
response returns generation, state, checkpoint and replay status.

Cost contract: one build batch reads at most 16 contiguous relay batches, folds
repeated slots and updates one sparse score per touched candidate. A page reads
at most twice its requested candidate count, uses the `(generation_id, score
DESC, candidate)` index, checks each scanned candidate's current visibility,
and returns no count or suppression reason. The integration fixture measures
statement and disclosure-check counts at 10 and 400 candidates.

Each rating receipt resolves its sealed Access admission in one bulk lookup per
batch. The slot row retains the contributor principal; an Account erasure is
checked against that indexed attribution at delivery, and an affected generation
restarts until rebuilt. A rebuild excludes already erased contributors. The
eligible zero-score tail reads current Work heads through `zero-candidates.ts`
under a graph sequence pinned at build registration, ordered by Work IRI. It
shares the same page scan budget and disclosure/erasure checks as positive scores.
The active generation remains required; no active head returns unavailable.

`build-worker.ts` is the production runner: one tick claims or renews one
generation and folds at most 16 relay batches of at most 100 events. Its lease,
checkpoint and score delta commit through `ranking.ts`, so another Main resumes
after an exit. `semantic-basis.ts` resolves a pinned Context revision through
the Context reader and checks the current personal Access or Realm graph
selection at build, activation and delivery. A personal selection revision is
an Access UUID; a Realm selection revision is a graph IRI (Access migration
114). A page adds one indexed Account erasure-journal probe, one bounded
contributor-erasure window probe, one bounded resource-erasure probe and at most
40 Work disclosure probes. The load tier
folds 20,000 observations across 1,000 candidate identifiers with 10,000 on
one target, then checks statement bounds and the score-order index.
