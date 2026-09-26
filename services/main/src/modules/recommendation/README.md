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
