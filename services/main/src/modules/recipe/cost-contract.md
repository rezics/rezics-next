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
are exact rationals and incompatible units remain separate buckets. The measure
write rejects more than 64 distinct stored measures (including yield and optional
servings) before admission. It replaces one immutable Structure manifest, reuses
both occurrence trees, reads and writes one manifest page, and writes no
placements. The exact-revision measure read fetches one manifest after a bounded
authorization page. Its response reports the shared page costs; the RECIPE05
test checks those counts, the measure bound, receipt replay, a stale head,
concurrent writers and recovery after a missing manifest. All recipe commands
preserve the shared Structure's expected-head CAS, receipt replay and owner
authorization checks.

Schema.org export reads one pinned revision through Structure pages of at most
100 occurrences, visits at most 4,096 occurrences and rejects a representation
over 1 MiB or section depth over 16. It returns pages, object-page reads and
visited occurrences. The RECIPE03 integration test checks these counters while
comparing retained source bytes, native occurrences and export output.

The Work page read resolves the selected Main Version and Recipe Structure in
bounded graph queries, then pins one revision. It walks at most 4,096 occurrences
in pages of 100, reads at most 64 measures, and rejects a response above 1 MiB.
The optional whole-number servings request is limited to 1–100 and scales the
same pinned occurrence set with exact rational arithmetic. Each ingredient also
gets a kitchen display line (and a metric or US counterpart when the unit
converts) computed in memory from that amount; the display does not add a read.
Its reported cost includes occurrence pages, object-page reads and visited
occurrences. Complexity is O(P + N) for P pages and N visited occurrences; the
read repeats Work visibility checks after hydration.

The recipe operation unit tests cover rational bounds, exact aggregation and
ambiguous-unit lexical retention. The integration test exercises a real Jena
write/read, denied admission, idempotent replay, stale idempotency conflict,
concurrent head conflict, and source-backed import. It does not establish a
physical I/O bound or nutrition-data quality.

Complete retained JSON or JSON-LD Recipe import registers a sealed two-field Source mapping
once per provider and namespace and one immutable conversion per observation.
The conversion inventories at most 128 top-level fields. At most 128 exact text
children can be attached through Source's field-support command, each resolving
one indexed Structure occurrence and one retained JSON pointer of at most eight
segments. Structured values without an exact text match are returned as
`unboundSourceKeys`; they do not acquire inferred support. Each attach uses one
Source transaction and bounded Access/Jena probes. The RECIPE06 integration
test checks the per-attach Fuseki call and byte ceilings, replay, stale authority,
confirmed withdrawal and independent support on the same native occurrence.
Withdrawal leaves the immutable Recipe revision and unrelated supports intact.
