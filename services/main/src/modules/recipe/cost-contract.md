# Recipe Structure cost contract

Recipe writes use the shared Structure admission and command. Each change accepts
1–16 operations, touches at most those placements and one 32-member order segment,
and reports the shared Structure page and placement costs. The import endpoint
retains the existing source observation and emits bounded insertion batches of
16 operations; source JSON is capped at 65,536 bytes and import output at 128
occurrences. Use the same idempotency key to replay a completed prefix after a
lost response. Concurrent edits can still make a later batch stale, leaving the
earlier batches as a visible partial import for reconciliation.

Exact recipe reads page at most 100 children. Scaling walks active groups and
occurrences through those pages and rejects after 4,096 returned occurrences.
Its response reports pages, immutable-object page reads and visited occurrences
for the one pinned revision; tests assert the returned counts and bound.
Nutrition accepts at most 512 input rows and 64 nutrient values per row; sums
are exact rationals and incompatible units remain separate buckets. All recipe
commands preserve the shared Structure's expected-head CAS, receipt replay and
owner authorization checks.

The recipe operation unit tests cover rational bounds, exact aggregation and
ambiguous-unit lexical retention. The integration test exercises a real Jena
write/read, denied admission, idempotent replay, stale idempotency conflict,
concurrent head conflict, and source-backed import. It does not establish a
physical I/O bound or nutrition-data quality.
