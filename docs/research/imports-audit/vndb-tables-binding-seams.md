# VNDB table binding: production seams and remaining contract gaps

Repository inspection at `ba527538407241a3b896a5221503ab40b098d273`, 2026-10-29. This is read-only source research;
assertions below describe existing code and tests, not newly observed passing executions. Primary implementation
source is [REZICS at that revision](https://github.com/rezics/rezics-next/tree/ba527538407241a3b896a5221503ab40b098d273),
licensed AGPL-3.0-only (`package.json:4`, [LICENSE](../../../LICENSE)). Local citations give file and line numbers
at that revision. No external source was downloaded, cloned, installed or executed, and no reference clone changed.

## Finding

An honest implementation of the complete fourteen-case portable binding is **not currently available by wiring
existing exports alone**. Raw staging, validated grouping, durable table reopening and pure conversion are real.
There are three distinct remaining dependencies: reconcile the frozen projection oracle with adopted statistics;
provide an owned local materialization-baseline producer; and provide missing observations, especially live row
buffer occupancy and execution-boundary zero evidence. An adapter must not implement these as simulated state.

No `createVndbTablesDriver` implementation exists in the inspected tree. Its only call is
[`specs/imports-vndb-tables-driver.ts:132`](../../../specs/imports-vndb-tables-driver.ts); the other references are
the interface comment and missing-driver verifiers. Local table tests instantiate `VndbTablesStore` directly and
do not execute all portable outcomes. `specs/support/verify-import-vndb-tables.ts:5` and
`verify-import-vndb-projection.ts:5` exercise missing-driver evidence, not successful ingestion bindings.

## Exact source, projection and converter identity

The pinned source is [the official VNDB dump dated 2026-10-25](https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst).
Existing primary-source provenance is retained in `specs/imports-vndb-tables-driver.ts:10–18` and
[`packages/definitions/sources/vndb.yaml:1`](../../../packages/definitions/sources/vndb.yaml): README SHA-256
`49dc1574d7a656fa43fe0809f1981e09c401a0fa0c3c365d9fc0509c3c71e454`, schema SHA-256
`d608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758`, generator SHA-256
`7849210e7df27c12ba93bb98b9440cca3b28f2f0dfe6142bdfde54075d2d5608`.
The cited [official generator](https://g.blicky.net/vndb.git/tree/util/dbdump.pl) exports `entry_meta.itemid` as `id`.
These are reused repository provenance, not a fresh upstream verification. Database permission is
[ODbL-1.0](http://opendatacommons.org/licenses/odbl/1.0/), permitted contents permission is
[DbCL-1.0](http://opendatacommons.org/licenses/dbcl/1.0/), attribution VNDB; this grants no blanket creative-content
republication. No upstream implementation code is proposed for copying.

The six synthetic files under [`specs/fixtures/imports/vndb-tables/db/`](../../../specs/fixtures/imports/vndb-tables/db/)
contain tab-separated headers and COPY TO STDOUT rows, not executable SQL or pregrouped JSON:

| Table        | Raw columns and pinned values                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vn`         | `id,image,c_image,olang,c_votecount,c_rating,c_average,c_length,c_lengthnum,length,devstatus,alias,description`. `v123`: `cv123,cv123,en,2,700,700,\N,0,2,0,Harbor Sentinel,UNLICENSED_DESCRIPTION_SENTINEL`; `v124`: `\N,\N,ja,0,\N,\N,\N,0,0,0,Minato,UNLICENSED_DESCRIPTION_SENTINEL`. |
| `vn_titles`  | `id,lang,official,title,latin`. `v123/en/t/Sentinel Harbor/\N`; `v123/de/t/Harbor German Edition/\N`; `v124/ja/t/港の物語/Minato no Monogatari`.                                                                                                                                          |
| `entry_meta` | `id,created,lastmod,revision,num_edits,num_users`. `v123/2020-01-01/2026-10-24/7/6/3`; `v124/2021-02-03/2026-10-25/19/18/4`.                                                                                                                                                              |

Actual producer [`services/importer/src/vndb-tables.ts:399–441`](../../../services/importer/src/vndb-tables.ts)
validates all known VN columns, stores `{id,olang,c_votecount,c_average}`, and discards description, image, alias,
Bayesian rating and length fields. Titles preserve native strings/null and decode the official boolean. Metadata
preserves dates/counters and numeric revision. `page:496–515` reconstructs exactly these stored payloads.

Actual converter exports are `convertVndb`, `converter_revision = 'vndb@7'`, `VndbConversion`, `VndbOptions` and
`vndbLimits` in [`packages/conversion/src/vndb.ts:13,32,241`](../../../packages/conversion/src/vndb.ts).
`project:148–237` retains both statistics together, native ID/revision/optional lastmod, titles and optional links;
missing auxiliary link arrays become empty. It hashes this sanitized data at line 250, not COPY bytes, target ID,
or converter revision. Native revisions remain numeric in grouped `entry_meta`, string in the source envelope.

The existing actual converter binding is [`packages/conversion/tests/vndb-driver.ts:11–39`](../../../packages/conversion/tests/vndb-driver.ts).
`bindVndbDriver()` forwards the same record object to `convertVndb` with only `{external_id,record_revision,record}`
framing, passes context unchanged, exposes real output paths and uses `checkBatchWrite`. Reuse it by reference;
do not duplicate conversion, filter proposals or supply a table-page subject. Unresolved output is one create with
type/labels/optional aliases/descriptions and source metadata, no statements/citations (`vndb.ts:337–372`).

## Frozen oracle reconciliation required before implementation

The adopted statistic path is authoritative in [`services/importer/README.md:39`](../../../services/importer/README.md),
`packages/definitions/sources/vndb.yaml:2601–2609`, and
[`services/kernel/src/rating/README.md:167–175`](../../../services/kernel/src/rating/README.md).
The definition's `status: omitted` means omitted from catalogue facts/native votes; its explicit reason retains
`c_votecount` and `c_average` for the licensed source statistic. It does not authorize dropping them from input.

`createSourceRegistration('vndb')` uses the actual converter and exported revision
([`source-registry.ts:44–54,81–107,111–134`](../../../services/importer/src/source-registry.ts)). Its additional
`sourceStatistic` requires count >0 and non-null average >=100, mean `average/100`, scale 1–10, pinned dump date,
ODbL licence and VNDB attribution. Thus this fixture produces count 2/mean 7 for `v123`, no statistic for `v124`.
`Importer` invokes `ImportTransport.writeSourceStatistic` at `importer.ts:590–608`; production transport dispatches
ordinary `PUT /v1/subjects/{id}/source-statistics/vndb` at `import-client.ts:289–323`. This is separate from native
votes and pure converter proposals. `credentials.ts:19` declares the additional scope. The provenance and public
contract are also recorded in [vndb-statistics-contract.md](vndb-statistics-contract.md). The local
`tests/source-statistics.test.ts:45–159` uses stub replies and is not native public API proof.

The conflict is concrete: frozen `GroupedRecord.vn` at `specs/imports-vndb-tables-driver.ts:68` and prose at
lines 20–24 omit the statistics; **two whole-object `toEqual` oracles** in
[`specs/imports-vndb-tables.test.ts:70,187`](../../../specs/imports-vndb-tables.test.ts) reject their presence.
The first local native table expectation explicitly requires `{id:'v123',olang:'en',c_votecount:2,c_average:700}`
(`services/importer/tests/vndb-tables.test.ts:126–144`). Extra properties satisfy structural TypeScript assignment
but fail these runtime equalities. Stripping them changes the accepted source digest and disables the statistic.

Smallest proposed acceptance-owner reconciliation, **not amended here**:

1. Extend the frozen grouped VN shape to required `c_votecount:number` and `c_average:number|null`; update the
   adjacent retention sentence to name both adopted fields. Leave `Cost`, `Entry` and loader/helper ABI intact.
2. Change the helper's whole-VN expectation from only `{id:row.key,olang:anyString}` to the full four-field
   expectation: for the pinned `v123`, count 2/average 700; for pinned `v124`, count 0/average null, retaining
   its ID/language checks. Every current caller of `converted` uses those fixture identities. Do not use a
   permissive partial-object match that hides unexpected retained fields.
3. Change the explicit first-row oracle from `{id:'v123',olang:'en'}` to
   `{id:'v123',olang:'en',c_votecount:2,c_average:700}`; add the symmetric exact `v124/ja/0/null` assertion.
   Preserve all discarded-content, real-converter equality, revision/digest and validation assertions.

Optional Latin policy is already adopted in [`packages/conversion/README.md:181–213`](../../../packages/conversion/README.md),
implemented by `vndb.ts:196,292–295` at `vndb@7`: preserve exact `''`, omit its Romanized candidate, distinguish
its digest from null; reject whitespace-only/missing/wrong-type Latin and invalid primary titles. The portable
COPY case at lines 241–269 requires a stored empty cell and does not call `converted` on that row. It can eagerly
convert with the current converter. Its helper at line 116 still constructs a candidate for every non-null Latin
value; if the owner extends helper coverage to this row, change that condition to non-null **and nonempty** and
assert omission explicitly. Do not normalize `''` to null or resurrect an empty alias in the binding. The older
[empty-Latin investigation](vndb-empty-latin.md) describes a historical rejection, superseded by the owner README.

## Every port operation and observation

The complete port is `specs/imports-vndb-tables-driver.ts:60–125`. In the tables below, **implemented** means an
actual production export; **composable** means mechanical delegation/observation without rewriting behavior;
**missing** means the required producer or contract bridge is absent. Private structural types in
`vndb-tables.ts:11–45` are not named exports: derive them through `Parameters`/`ReturnType`, preserving the ABI.

| Port method                                | Actual exported seam and status                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `converter`                                | **Composable:** actual `bindVndbDriver():VndbDriver` above; source function/revision are production exports. Pure binding contract is `specs/imports-vndb-driver.ts:1–38,50–70`; framing only.                                                                                                                                                                 |
| `begin()`                                  | **Implemented/composable:** `VndbTablesStore.begin(source,runId):void`, `vndb-tables.ts:225`; chooses isolated acquisition identity, inserts real `(source,run_id)`. Adapter may generate the run string, never model its state.                                                                                                                               |
| `stage(run,entries)`                       | **Implemented/composable:** `stage(source,runId,AsyncIterable<ArchiveEntry>):Promise<void>`, line 243. Forward original entry objects/streams, no manual COPY parser, stream replay, archive extraction or acquisition codec.                                                                                                                                  |
| `page(run,after,limit)`                    | **Composable:** `page(source,runId,{after,limit})`, line 496, returns key/numeric revision/grouped record/cursor, no `output` (local test line 145 explicitly checks absence). Add output by calling the existing converter binding on each actual returned record without context. Projection-oracle reconciliation remains prerequisite.                     |
| `commit(run)`                              | **Missing for this local materialization:** no table-store commit or validated-snapshot promotion. Coordinator `Importer.runRecords` exists, but has different effects and run identity; see composition below.                                                                                                                                                |
| `baseline(key)`                            | **Missing acquisition-baseline producer:** no table-store key digest/converter-revision/committed pointer. Existing `RunStore.source/key` exposes catalogue-run baselines, not a persisted acquisition-to-run association.                                                                                                                                     |
| `inspect(run)`                             | **Partly implemented:** `inspect(source,runId):Run`, line 232, returns state/sourceRecords/stagedRows/stagedBytes only. Other requested fields require actual observers below.                                                                                                                                                                                 |
| `retainedMarkers(markers)`                 | **Composable read-only test observation:** caller owns real DB; enumerate current logical SQLite rows, encode strings/BLOBs, and inspect any actual durable spools/logs outside measurement. Local precedent `vndb-tables.test.ts:263–272`. Search actual BLOB bytes too, not JSON numeric-array spelling. No deleted-page-remnant or imagined logfile search. |
| `measure(operation)`                       | **Partly composable:** attach factory argument to every actual handle before constructing stores; await whole operation. Loader lines 133–143 overlays actual SQLite rows/statements. Non-SQL evidence gaps remain below.                                                                                                                                      |
| `seed({unrelatedKeys,historicalActivity})` | **Partly composable, complete binding missing:** real `begin/stage` can seed earlier same-source acquisitions in the same handle/tables; real coordinator/public API can populate catalogue/activity. No single exported seeder satisfies this port's combined neighbourhood. Existing generic API population is not a VNDB same-partition witness.            |
| `reopen()`                                 | **Composable for tables:** caller closes real file-backed DB, opens the same path, attaches evidence before statements, reconstructs stores. Local `vndb-tables.test.ts:50–86,150` demonstrates this. `ImportSession.reopen` is lease rotation, not handle reopen. Full baseline survives only when its missing producer is implemented.                       |
| `close()`                                  | **Composable:** close owned handles and remove only isolated fixture directory under worktree `.temp/`; caller owns `VndbTablesStore`'s DB. If using `Importer`, await `Importer.close():Promise<void>` (`importer.ts:163`), which closes `ImportSession` and RunStore.                                                                                        |

| Required observation                             | Actual evidence and exact limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/sourceRecords/stagedRows/stagedBytes`     | **Implemented** by table `inspect`. Bytes are maintained UTF-8 JSON payload length (`insert:433–441`), not SQLite file/WAL size or total physical storage. Failure zeros counters before keyed cleanup (`stage:333–341`).                                                                                                                                                                                                                                                                                                                             |
| `retainedTables`                                 | **Composable** from distinct actual `table_name` values in current logical materialized rows/spool, outside measurement, not a constant allowlist or SQLite schema table names. The fixture expects `entry_meta,vn,vn_titles`; failed rows/spools must really be absent.                                                                                                                                                                                                                                                                              |
| `proposalEmissions`                              | No table counter. **Composable observation** by wrapping actual converter calls and enumerating actual returned proposals through `locate`, attributing calls to the current run. Count commands, not calls or predicted titles; observe before EOF too. `ImporterOptions.onConversionOutput` (`importer.ts:76`) fires in planning after seal (line 1019), not every initial conversion at line 938, so is insufficient alone.                                                                                                                        |
| `publishedProposals`                             | No table producer. Observe actual `ImportTransport.batchWrite` requests/results (`import-contract.ts:21`), if connected; a converter output is not publication. Local-only execution must establish an observed closed publication boundary; initializing a counter to zero is insufficient evidence.                                                                                                                                                                                                                                                 |
| `externalRequests`                               | No table producer. Real transport is injectable (`ImporterOptions.transport`, `import-client.ts`); record actual fetch dispatches in any connected composition, including nested/retry requests. Local staging/page has no network call in its source path, but a binding must observe/enforce that boundary for the whole operation, rather than infer an empty array from lack of instrumentation.                                                                                                                                                  |
| `executedDumpStatements`                         | **Composable with strict real-SQL wrapping:** stage allowlists entry paths, ignored SQL bodies never reach a decoder (`stage:274–285`, `readEntry:351–366`); actual SQL is fixed importer code. Observe every real exec/run/prepared execution and binds on actual handles and fail closed on unclassified SQL. With this observed execution inventory, zero archive-derived statements is meaningful; no archive SQL parser or second SQLite instance.                                                                                               |
| `rows/statements`                                | **Implemented aggregate observer:** `sqliteEvidence.attach/start/finish/cancel`, driver lines 153–344. Counts actual returned `get/all/values/iterate` rows, execution calls including controls, nested work and bound EQP internally. `finish()` publicly returns only `{rows,statements}`; it does **not** export raw calls, individual row counts or changes.                                                                                                                                                                                      |
| `rowWrites`                                      | No table aggregate export. **Composable strict wrapper** can accumulate real statement `run().changes` for materialized-row/spool mutations, excluding run counters, while delegating unchanged to the already observed handle. Header-first measured stages insert exactly S materialized rows; page makes zero mutation calls. Do not derive writes from `stagedRows` or count counter updates as data writes. Reverse-order spool insertion/deletion is real additional work, not a physical-write zero.                                           |
| `peakBufferedRows`                               | **Missing producer.** Real `all()` result lengths expose delivered batches, not simultaneous lifetime across validation, spooling, nested title/metadata calls, parent arrays and grouped outputs. `DumpRetention` observes byte capacities, not parsed row lifetimes. Max one result length, page length, formula from limits, and zero are all insufficient. An owned row retain/release observation at actual allocation/lifetime sites is needed.                                                                                                 |
| `crossPartitionStatements`                       | **Missing table-port producer.** Observe actual executor calls, including nested ones, when connected. Existing `createApiCapture` (`services/kernel/test/imports/api-capture.ts:28,105,394`) captures native executions/plans and partition witnesses; partition cardinality is not a count of cross-partition statements. Pure local stage/page have no kernel dependency, but absence of PostgreSQL configuration alone is not an observed zero. Require a closed execution boundary or real native executor observer before returning this field. |
| baseline `run/revision/digest/converterRevision` | Revision is native `entry_meta.revision`; digest/revision export come from real converter. Persistence of all four with an acquisition-run commit pointer is **missing**. `RecordStore.RecordRow` lacks run; `RunStore` has a different generation identity. Neither an adapter Map nor latest-ready-run inference can fill this gap.                                                                                                                                                                                                                 |
| seeded neighbourhood                             | **Missing complete evidence:** seed real earlier VNDB rows in this same SQLite file/source, and real catalogue keys/activity in the same relevant partition. Retain physical cardinalities outside measurement. Never move background data to a second DB/source or use generic Bangumi placement as VNDB proof.                                                                                                                                                                                                                                      |

`services/importer/tests/support/sqlite-growth.ts:5–18,63,181–197,347–391` already exports
`SqliteEvidence` (SQL, parameters, rows, kind, plan, optional changes) and `createSqliteProbe`; its measurements
are synchronous. The private async wrappers in chunk/admission tests correctly delegate each synchronous native
execution across awaits. These are real available observers, not an excuse to attach substitute storage. A narrow
same-handle wrapper can supply mutation counts; no existing observer supplies the missing row-lifetime metric.
Its event retention is capped at 4096 events and 1 MiB. Bound any supplementary event retention, reset by
measurement, restore wrappers, avoid double wrapping cached
statements, and fail on unsupported methods rather than silently omit them. Aggregate zero observations must be
backed by intercepted execution boundaries, not default-valued fields. No richer shared observer API is assumed.

## Actual coordinator composition and why it is not a local commit

Production composition is explicit in [`services/importer/src/cli.ts:676–739`](../../../services/importer/src/cli.ts):
construct `VndbTablesStore(importer.session.store.database)`; `begin` an acquisition UUID; `stage` raw entries to
completion; keyset-page groups; yield `SourceRecord {source:'vndb',key,revision:String(row.revision),payload:row.record}`;
then `Importer.runRecords(createSourceRegistration('vndb'),records,options)`. `readDump` (`dumps.ts:72,142–190`)
is the separate SQL-COPY framed flat-VN reader, not a replacement for this native table/header grouping path.
TAR/zstd acquisition remains upstream of this port; `archive.ts` must not be copied into another adapter.

`Importer.runRecords` (`importer.ts:151,879–969`) acquires `ImportSession` ownership, uses `RunStore.begin`,
converts all supplied records, stages sanitized `SourceProjection`, then seals before planning/publication.
It invokes ordinary batch/fence/statistic APIs and uses `RecordBindings` for actual returned identities/candidates.
`RecordBindings.acknowledge` (`record-bindings.ts:334–399`) requires actual success replies; `claim:404` contains
no baseline metadata. No invented SubjectID, receipt, direct product SQL or second source registration belongs here.

`RunStore<SourceProjection>` (`run-store.ts:16–23,289,421`) owns numeric generation/lease identity, immutable staged
records and completion. `finalize:1175–1224` requires classified/resolved work and switches the source pointer only
after bounded finalization. `source:1227` returns generation/count; `key:1233` returns actual baseline `RecordRow`.
These exports compose a **catalogue** baseline after real API reconciliation. The CLI never persists a link from
its acquisition UUID to that generation, and `ImportRunResult` (`importer.ts:51`) does not return a run handle.

`RecordStore.get/put/page` (`record-store.ts:5–12,181–253`) stores individual acknowledged rows, with no run field,
complete-source validation or atomic whole-source promotion. It is not a ready-made table snapshot commit.
`ImportSession` (`import-session.ts:35–48,82–85,105–110`) constructs source-record RunStore and bindings on the same
handle; its `reopen` rotates an active lease, not a materialization baseline. Calling `RunStore.classify` with empty
commands and `acknowledgeNoEffects` to force completion would invent a converter-ignored/no-owned-candidates
disposition (`run-store.ts:669–700`); VNDB bootstrap actually emits a create, so that shortcut is invalid.

Recommendation: treat portable table `commit/baseline` as a **local durable validated-materialization snapshot**,
used for comparison at the pure conversion boundary, never a catalogue authority or proof of publication. There
is no separate existing local operation that meets it. Imports must own its minimal production producer and
durable acquisition association before dispatching a mechanical adapter; do not name imaginary existing methods.
If catalogue completion is required instead, explicitly adopt coordinator/API acceptance and its identities and
permissions in the owner contract first; that is a different boundary and must reuse the actual composition above.
In either boundary, EOF plus all required-table validation precedes conversion/publication, and invalid input
cannot switch the previous baseline. Table `ready` alone is not a committed comparison baseline.

## All fourteen frozen case names

Names and lines are from the full [`specs/imports-vndb-tables.test.ts`](../../../specs/imports-vndb-tables.test.ts).
Every case needs the actual binding; local lookalikes do not close its missing producer/oracle dependencies.

| Line | Exact test name                                                                                                  | Critical binding dependency                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 170  | the actual VNDB table-file format is grouped into complete source records before conversion                      | Exact retained projection, real converter, zero effects before page.        |
| 217  | tables and headers may arrive in any order and reopen reads durable grouped rows                                 | Real spool/reopen, commit and baseline tuple.                               |
| 241  | COPY escapes nulls booleans numeric cells and split UTF8 decode before conversion                                | Unmodified native decoder, including exact empty Latin.                     |
| 273  | changed raw title and entry revision reach the real converter and committed digest                               | Actual source digest and durable promotion.                                 |
| 294  | normalization ignores unsupported public descriptions and images while titles and revisions affect conversion    | Actual producer allowlist, raw retained-marker observation.                 |
| 336  | all required tables validate before the first proposal and a failed source cannot replace the baseline           | Await late duplicate, refuse early page/commit, preserve committed pointer. |
| 379  | duplicate table column and primary keys abort rather than overwrite or disappear                                 | Native uniqueness and failed-run cleanup, baseline unchanged.               |
| 394  | missing required tables headers titles metadata and mismatched ids abort without API fallback                    | Native completeness/parent checks and observed no network.                  |
| 423  | malformed COPY cells headers truncation and invalid UTF8 abort atomically                                        | Actual validation/failure state, observed no conversion/publication.        |
| 465  | unsafe archive paths links and normalized aliases abort before any publication                                   | Forward raw entries, actual path/link checks, no adapter sanitization.      |
| 480  | unrelated user post review list tables and shipped SQL are never staged decoded or executed                      | Inspect actual retained rows/spools and SQL/request boundaries.             |
| 520  | keyset enumeration enforces the fixed page cap and emits each VN exactly once                                    | Actual cursor/page cap, measured returned rows and live rows.               |
| 557  | one grouped record uses indexed seeks and constant returned rows and statements at 32 128 and 512 unrelated keys | Same-partition seed, SQL/EQP, writes/buffers and storage bounds.            |
| 594  | supported child cardinality grows only with supplied rows through the hard cap and rejects above it              | Real children 2/4/8/9, exact staging writes, commit/rejection.              |

## Growth, EQP and resource assertions that must survive

Read alongside the historical [remaining measurement-port inventory](https://github.com/rezics/rezics-next/blob/5c47a835ca/docs/research/imports-audit/remaining-cost-unit-ports.md).
That inventory's VNDB sections are evidence about units and callers, not a delivered table driver. Current
unit-only migration is separate: do not alter `Cost`, `Entry`, `GroupedRecord`, loader or helper ABI in that work.

| Source/callsite                                          | Exact existing bounds and populations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Portable `validCost/bounded/boundedStage`, lines 130–150 | Safe nonnegative integer fields, statements >0, cross-partition statements 0, peak rows <=16*(8+2)=160. Page statements <=16, returned rows >=2+m and <=4*(1+m), writes 0. Stage writes S, returned rows/statements <=8S+16.                                                                                                                                                                                                                                                                                                                        |
| Portable enumeration, lines 520–551                      | 193 VNs, 579 materialized rows; reject limit 17. Exactly 13 pages (12*16+1), ordered unique supplied IDs and exact cursors; each page returned rows <=128 and peak rows <=160.                                                                                                                                                                                                                                                                                                                                                                      |
| Portable fixed and child probes, lines 557–620           | Unrelated keys 32/128/512, history 4n; fixed seven-row stage and one grouped page constant rows/statements. Staged bytes >0 and <=8*inputBytes+4096, rows/bytes identical at all scales. Child m=2/4/8 admitted, 9 rejects; S=m+5, same byte bound, separate 512/2048 seed. Physical populations unknown until an actual seeder exists.                                                                                                                                                                                                             |
| Local `vndb-tables.test.ts:338–394`                      | Page v123/two titles: returned rows 4–12 and statements <=16. Page/inspect constant; supplied stage linear at 32/128/512. Adds n prior two-VN/seven-row archives per scale plus hot n+1-VN/3n+4-row archive: cumulative runs 33/162/675, materialized rows 324/1608/6732. Children 2/4/8 use logical children-squared scales 4/16/64, rows linear/statements constant.                                                                                                                                                                              |
| Local `vndb-tables-growth.test.ts:13–15,80–154,257–349`  | Logical 1/8/64; 250 archives/source/unit in two sources: runs 500n (500/4000/32000), rows and spool each 1500n (1500/12000/96000), plus hot data. Fixed reverse-order stage, projection, validation, cleanup all constant SQL rows/executions, no additional numeric ceiling. Hot projection 17 VNs returns 16/next v16; validation 33; cleanup 65 VNs and 65 spool rows per table.                                                                                                                                                                 |
| Local `vndb-chunk-growth.test.ts:44–200`                 | Async real-execution probe: positive returned rows/statements, EQP event delta equals executions. Same-source real archives at 32/128/512 give cumulative runs 33/130/515 and rows 231/910/3605; fixed stage SQL constant. Input 1/8/64 pads VN to 512n bytes: visits=admitted=pulled bytes=sum six members, pulls=retention input samples=chunks=n+5, peak input=512, line <=65536, two outputs. Input work linear, SQL constant.                                                                                                                  |
| Local `vndb-archive-limits-growth.test.ts:72–276`        | Async probe verifies all event plans indexed by source/run; no SCAN/TEMP B-TREE/AUTOMATIC. Logical 1/8/64 seeds three sources at 128n: each relation runs/rows/spool has 384/3072/24576 background rows. Rejected/ready SQL constant with zero row/execution slack; ready line exactly 65536/input 128; failed rows/spool empty, states survive reopen. Independent budgets=8n: entries=budget+1, bodies=bytes=closed bodies=budget, outer closed, scans 0; reject before excessive body; linear input and constant retained bytes with zero slack. |

`sqliteEvidence` explains distinct actual SQL/bindings after capture and ANALYZEs before it. It forbids
OFFSET/history COUNT, scans except constant rows, automatic indexes and temporary sorts; SEARCH must use a
declared index or integer primary key with equality/range constraints; empty plans only for controls or direct
VALUES inserts carrying full primary keys (`driver:276–337`). Do not replace this with SQL spelling assertions.
Current `createSqliteProbe` additionally exposes raw evidence; it does not measure examined rows or SQLite buffers.

Portable/local `GrowthSample` wrappers currently map returned rows/executions to generic names and insert
`blocks:0`; that means unavailable counters, not zero I/O. Preserve row slack 2/10% and execution slack zero
(`services/kernel/test/support/growth-bound.ts:6–9,120–130`). Chunk input's admitted-byte alias uses block slack 4/50%; admission explicitly
uses zero row/execution slack. Preserve each numeric inequality while a separate owner corrects units; do not
strengthen, weaken or silently remove them while creating a binding.
For each equally spaced ratio triple `(a,b,c)` and ratio `r`, constant means `max(b,c)-a <= slack`;
linear means `c-b <= 1.5*r*max(b-a,0)+slack`, with `slack=max(absolute,relative*a)`.
The helper admits three to five samples, equal ratios >=4, and largest logical scale <=4096; physical seeded
populations can be larger. No timing threshold substitutes for these assertions.

Actual operation ceilings (`vndb-tables.ts:72–73,194–198,295–325,445–542`): direct row two point statements;
spooled row one INSERT, range read per <=32 rows, two insert/counter statements and exact DELETE. Validation
keysets supplied rows in batches 32, two seeks/VN and one/child; titles limit children+1 <=65. Page has 2+2r
SELECTs, <=r+1 numeric parent rows, <=66r child/metadata rows plus one run row. Cleanup is batch-32 reads and
exact deletes. Native row cap 65536 bytes; child default/hard 64 (portable config 8), page hard 16; maxRows
2,000,000/10,000,000, source records 500,000/1,000,000. Table chunk configuration only lowers shared 256-KiB
default, even though shared dump chunk hard limit is 1 MiB. Archive defaults/hard bounds are 16/64 GiB and 512/2048
entries, counted before body access even for ignored/empty members. Byte accounting is separate from row counts.

All adjacent local table tests were read: `vndb-tables.test.ts`, `vndb-tables-growth.test.ts`,
`vndb-chunk-bounds.test.ts`, `vndb-chunk-growth.test.ts`, `vndb-archive-limits.test.ts` and
`vndb-archive-limits-growth.test.ts`. Retain their admission controls: exact limits succeed; oversized backing for
known/header/ignored members fails before byte iteration, closes without resume and removes failed rows; invalid
options reject before schema/pulls; eight ignored 256-KiB invalid-UTF8 chunks drain without scanning/persistence.
Unsafe/overflow/negative/fractional/infinite declarations, short/lying/mutated bodies and oversized backing
close all opened iterators, do not pull tails and leave durable failed state. These are source-code assertions,
not proof that the complete portable suite, public API, growth or erasure acceptance passed in this investigation.

## Later implementation group and dependency order

1. Imports acceptance owner reconciles only the frozen statistics projection and documents the local snapshot
   meaning in `services/importer/README.md`; source-statistic policy/definitions stay as adopted. Relevant frozen
   paths are `specs/imports-vndb-tables-driver.ts` and `specs/imports-vndb-tables.test.ts`; no worker may amend them
   on the authority of this report. Preserve all fourteen outcomes and keep the independent converter port intact.
2. Imports supplies the missing production baseline/acquisition persistence and live-row observation in the
   existing owner `services/importer/src/vndb-tables.ts`, with focused producer tests. This is true code work,
   not glue promised to exist later. Exact exports must be adopted before the binding assignment. Execution-boundary
   observers also need concrete wiring before non-SQL zero fields can be claimed. Existing coordinator stores do
   not eliminate these dependencies; avoid changes to RunStore/RecordStore/Bindings/ImportSession for a fake bridge.
3. New mechanical binding path: `services/importer/tests/vndb-tables-driver.ts`, exporting
   `createVndbTablesDriver(limits,attachSqlite)`. Actual dependencies: `bun:sqlite.Database`, `VndbTablesStore`,
   the adopted missing producer, `bindVndbDriver` from `packages/conversion/tests/vndb-driver.ts`, and genuine
   same-handle evidence/retention observers. Raw entry forwarding and converter object identity remain intact.
   Seed earlier same-source acquisitions through real table operations; seed catalogue/history through ordinary
   APIs if needed, with actual partition evidence. `createApiPopulation` (`kernel/test/imports/api-population.ts:11`)
   uses Bangumi hot placement and direct performance SQL; it is not a drop-in permitted seeder for this binding.
4. New wrapper path: `services/importer/tests/vndb-tables-outcomes.test.ts`. It must run the full portable suite
   with `IMPORT_VNDB_TABLES_DRIVER` pointing to that real factory and require exactly **14 pass, 0 fail, no skip,
   no todo**, with nonzero exit/output forwarded on failure. Existing wrapper pattern is
   `services/importer/tests/pipeline-outcomes.test.ts:5–25`; neither missing-driver verifier is suitable acceptance.
   Future scoped command: `bun scripts/worker-check.ts -- bun test services/importer/tests/vndb-tables-outcomes.test.ts`.
   Root typechecking remains separate; no whole importer/kernel suite follows merely to obtain a success summary.
5. Evidence path is this report, `docs/research/imports-audit/vndb-tables-binding-seams.md`. Unit-count migration,
   native six-case statistics binding and seven-scope/statistic-PUT fixture integration are separate dependencies
   with their own acceptance; do not duplicate them or claim table binding proves their outcomes.

The shared pattern in the inspected producers is exact-key durable storage, bounded supplied-input traversal,
mechanical framing and actual side-effect acknowledgements. Follow that pattern at each missing seam. This report
adopts no new source policy and changes only its declared path; it creates no driver, wrapper, missing-driver test,
fixture, oracle, dependency or product edit. Its artifact acceptance is file existence/nonemptiness only; it cannot
claim native/public API/statistics/discovery/growth/erasure acceptance or Goal completion on main.
