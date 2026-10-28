# VNDB statistic public outcome contract

This adds portable acceptance and a typed native binding port only. It does not
implement the binding, alter permissions, or introduce a new import API. The
acceptance command checks that the suite exists; it does not execute its outcomes.
Without `IMPORT_VNDB_STATISTICS_DRIVER`, executing the suite throws
`IMPORT_VNDB_STATISTICS_DRIVER is required: native binding missing`. Missing
binding is an evidence gap, not passing real API proof.

## Authority and decisions

The current importer README, `credentials.ts`, `source-registry.ts`,
`import-client.ts`, kernel rating README, `source-statistics.ts`, its SQL, schemas,
and `http/kernel.ts` registration agree: subject effects use public bulk commands;
the VNDB aggregate uses ordinary public
`PUT /v1/subjects/{id}/source-statistics/vndb`. Its operation identifier is
`rating.source_statistic_put`; its action is `source_statistic:write` on Global
Context. This is the seventh scope in `VNDB_IMPORTER_SCOPES`, with a real resource
grant as well as the OAuth scope. The pinned source date is `2026-10-25`.

The PUT returns the statistic directly, including `source`; the public current
GET returns an array, not an envelope. Strict input uses `sourceRecordId`, `scale`,
`mean`, `count`, `asOf`, `licence`, and `attribution`. Neither Bayesian `c_rating`
nor native votes belong in that write. The mean is `c_average / 100`, count is
`c_votecount`, scale is 1 through 10, licence is `ODbL-1.0`, attribution is `VNDB`.
Zero votes omit a statistic; they do not clear an existing one or create a vote.

The tests use synthetic decompressed ustar bytes with the pinned COPY headers,
two visual novels, and native entry revisions retained. The second zero-vote
record keeps a reduced archive valid for mass-disappearance testing. Updating
the first average keeps its native entry revision unchanged, deliberately proving
digest-based change handling. Native source revision, statistic transaction, and
native vote revision are different concepts: the statistic has a current
`transaction_id`, not a public revision field. Reimport/reopen compares all
observed statistic transactions, receipts and events, while votes remain absent.

Response loss is injected after the real handler commits, then the normal
transport retries. Requests retain exact serialized bytes, bearer and HTTP
idempotency header; receipts retain their native composite identity. Revocation
replays that original captured request and checks a bounded forbidden problem,
no receipt disclosure and no new persistence. Reduced scope uses real Auth
issuance for the same account. Source-stream failure and a valid diminished
archive both preserve the maintained baseline and send no statistic PUT.

## Subsequent native binding

Minimal new declarations are
`services/kernel/test/imports/vndb-statistics-driver.ts` and
`services/kernel/test/imports/vndb-statistics-outcomes.test.ts`, plus shared
`identity-fixture.ts` and `api-runtime.ts` only where composition needs them.
No shared-file hold is needed. Keep the existing six-scope fixtures' assertions
intact: add explicit VNDB configuration or a separate composition rather than
silently widening other sources. The existing identity client registers six
scopes and grants no statistic authority; the API runtime omits the statistic
writer and supplies zero votes. These are the known binding gaps from
[the API audit](api-boundaries.md), not reasons to simulate success.

Actual dependencies to import are `openImportIdentity`, `identitySupport` from
the identity fixture; `createAccountTokenProvider`, `VNDB_IMPORTER_SCOPES` from
importer credentials; `readArchive` from importer archive; `VndbTablesStore` from
importer VNDB tables; `createSourceRegistration` from source registry; `Importer`
from importer; `createImportTransport` from import-client; and `createKernel`
from kernel HTTP. The port imports the existing `ImportSourceStatistic`,
`ImportCredential`, and `ImportIdentity` types. The tests invoke native
`accessCheck`, `withConnection`, and `Access.authenticate` themselves, so a
binding cannot replace permission evidence with a boolean assertion. Use the
existing public lifecycle/Auth/Access setup and command grant/revoke paths;
do not insert grants, bootstrap or content via SQL. Read-only SQL observation
is allowed. Close partial opens and keep all owned temporary state in `.temp/`.

The kernel wrapper should bind the environment variable, execute the portable
suite, assert the actual pass count and absence of skips, and integrate through
the existing affected-test selector. The missing binding is intentional in this
specification task. Wikidata conversion regression is separate and is omitted.

## Cost derivation and remaining probe

`source-statistic-upsert.sql` joins one exact semantic subject anchor by
`(route, subject_id)` and upserts one exact source row by
`(route, subject_id, source)`. Each admitted statistic command writes one current
row, one changed event, and its normal command receipt/write basis. Replaying
the same command uses its receipt rather than another upsert/event. A changed
average uses a new command identity and replaces that one row. Reimport with no
changed record does not admit another statistic command.

Authorization is per command against Global Context, including current grant
validation before receipt replay. Command execution routes to the subject's
partition. Public GET first resolves subject readability and then reads the
source rows under that exact `(route, subject_id)` prefix, ordered by source.
Only VNDB is accepted for writes, so the current supported source disclosure is
bounded. These paths require no cross-partition join or total catalogue scan;
the Global authorization dependency is distinct from joining catalogue data.
Statistics live in `rating.source_statistic`, separate from `rating.vote` and
native population/figure maintenance.

Existing growth evidence read: importer VNDB table/chunk/archive growth tests,
portable `imports-vndb-tables-driver.ts`, and kernel imports API growth
fixture/capture plus the audit's integrated-growth section. These cover staged
indexed pages, source-byte work, SQLite evidence, and shared PostgreSQL nested
capture infrastructure. They do not establish statistic-bearing seven-scope
native API growth: the existing assembly never writes a statistic. A subsequent
binding needs the existing fixed-record/unrelated-population growth probe around
the actual statistic PUT, replay and GET, including nested Access/receipt plans.
The point-row derivation above is inspection, not measured buffers or a new
benchmark result.

Read inventory additionally includes actual identity/API fixtures, drivers,
runtime, observer and capture modules; public bulk response definitions; kernel
problem response construction; source-statistic tests; importer table reader and
its tests; pinned table fixture files and README; VNDB fixture rights README;
and the read-only reference index. No reference implementation was used or
needed for this existing behavior. No product files or frozen tests are changed.
