# Remaining importer measurement ports

Repository evidence at **860ec3c071f213ccd3cd0ad288f7bf0777c20384**, inspected 2026-10-29. All `path:line` references below
refer to that revision, not another worker's pending changes. Primary source is
[rezics-next](https://github.com/rezics/rezics-next/tree/860ec3c071f213ccd3cd0ad288f7bf0777c20384),
licensed [AGPL-3.0-only](https://github.com/rezics/rezics-next/blob/860ec3c071f213ccd3cd0ad288f7bf0777c20384/LICENSE)
(`package.json:4`). This is an internal source inventory: no external research, reference clone, upstream execution,
suite execution or new policy is needed. Findings describe code and assertions, not observed passing native runs.

## Answer and committed prerequisites

The remaining local ports are run-store/run-plans portable evidence, CLI invocation evidence, VNDB table evidence,
and the two asynchronous VNDB chunk/admission aggregators. Their callers still feed SQLite executions/returned rows,
input bytes, chunks or retained bytes into `GrowthSample.cost`. Native growth also disguises requests as rows and
overrides shared PostgreSQL cost with its own PostgreSQL-derived totals. **It does not add SQLite counters to the
PostgreSQL totals at this revision.** Preserve the real native capture while separating these units.

Committed interfaces already available, read as context only:

- `services/importer/tests/support/sqlite-growth.ts:13,177,194,241,346`: synchronous `Sample<T>` contains `value`,
  `counts: {'sqlite statements': number; 'sqlite returned rows': number}`, raw `statements`, and deprecated `cost`.
  Executions include controls; rows are delivered `get/all/values/raw/iterate` results, never visited/index/VM rows.
  `verifyPlans()` at line 365 rejects missing evidence, growing scans, automatic indexes and temporary sorts.
- `services/kernel/test/support/growth-counters.ts:3,23,57,91,102`: existing `CountedValues`, `CountedCheck`,
  `validateCountedRun`, `countedSample`, `countedViolations`; `growth.ts:44,77,409` exports/consumes them alongside real
  PostgreSQL measurements. There is no need for a new shared engine or an assumed future convenience export.
- The committed reconciliation/transport/CPU correction is described in
  [client-counted-costs.md](client-counted-costs.md). Probe/HTTP/reconciliation/CPU, bindings/record-store/record-caps/
  empty-run and probe-self-test/native-key slices are separate owners. Do not reopen their files or infer any further
  delivered export. The remaining direct probe caller `run-store-pages.test.ts` belongs in this inventory too.

Unit-preserving conversion must carry the old tolerance explicitly: `growth-bound.ts:6,124` gives returned-row-like
metrics `{absolute:2, relative:0.1}`, block-like metrics `{absolute:4, relative:0.5}`, and statements `{0,0}`.
For values a,b,c at equal scale ratio r, constant permits `max(b,c)-a <= max(abs,rel*a)`; linear permits
`c-b <= 1.5*r*max(b-a,0)+max(abs,rel*a)`; logarithmic uses factor 2 instead of `1.5*r`.
`growth-counters.ts:119` defaults to **zero** slack, so merely renaming units can strengthen existing assertions.
Retain each inequality below as well as its growth class. Remove unavailable SQLite buffers rather than reporting
`blocks:0`; genuine observed zero executions/requests remain valid. Neither local returned rows nor parser byte
visits establishes database rows examined. Missing observations require a producer, not an invented zero.

## Run-store portable cost and all callers

Producer: [`specs/imports-run-store-driver.ts:164`](https://github.com/rezics/rezics-next/blob/860ec3c071f213ccd3cd0ad288f7bf0777c20384/specs/imports-run-store-driver.ts#L164)
exports `runStoreCost(Evidence,pageCap=100): {rows:number; blocks:0; statements:number}`. It validates evidence and
sums `executions[].rows` and execution count; it captures no PostgreSQL or buffers. `RunStoreDriver.measure` at line
125 returns `{value,evidence}`. Actual forwarding is `services/importer/tests/run-store-driver.ts:89,159`; the
separate run-plans driver forwards at `run-plans-driver.ts:82,156`, returning the same evidence plus
`networkRequests` and `kernelPartitions` (`specs/imports-run-plans-driver.ts:57,64`). Neither driver needs a product
storage rewrite to expose named counts. Preserve raw SQL, binds, per-execution returned rows, database identity,
ANALYZE statements, schema SQL, index metadata, aliases and actual bound EQP.

Every tracked value caller of `runStoreCost` is:

| Caller | Bounds and observations that must survive |
| --- | --- |
| `specs/imports-run-store.test.ts:569,632,675` | Fixed measurements at 561: begin and both seals ≤8 rows/16 executions; classify and ack ≤64/48; pending page ≤8/16; vanished after `Qvanished0`, limit 3, ≤3/16 with exact vanished records 1–3. Finalize cap 8: each call ≤128/256, fewer than scale+20 calls; first page constant, summed rows/executions linear. Supplied staging: visits exactly scale+1, rows ≤16*visits, executions between visits and 32*visits; both linear. |
| `services/importer/tests/run-store-growth.test.ts:85` | Mass-check, classify, pending and ack each ≤64 returned rows/48 executions; constant. One immutable pending envelope survives rejection, reopen and changed-body rejection (109–123); retain exact bytes and keys. |
| `specs/imports-run-plans.test.ts:603` | Shared `measured` at 599 requires zero network requests and empty kernel partitions; rows ≤64*(m+pageCap), executions ≤32*(m+pageCap). Fixed 128-command prepare/ack use m=128, cap=8 (8704/4352); page/finalize use m=0, cap=2 (128/64). All constant. Payload m=1/8/64: prepare executions ≥m; prepare/ack rows and executions linear, page constant. Exact reconstructed public envelopes equal the supplied plan. |

The proof inside `runStoreCost:171–286` is part of the contract, not optional adapter logic: nonempty executions,
nonnegative integer rows, no OFFSET/COUNT; actual ANALYZE per database; raw growing schema/index definitions;
controls have no rows/reads/plan; direct VALUES inserts contain a declared unique key and have no hidden reads;
readable operations require plans and relation occurrences; no growing SCAN/AUTOMATIC/TEMP B-TREE; every alias
needs a declared-index SEARCH with explicit equality/range constraints. A non-point range requires first-column
equality, at least two constrained index columns, SQL LIMIT and returned rows ≤caller pageCap. Preserve this
validator while changing its summary type, rather than replacing it with aggregate counters alone.

Additional direct callers of the probe's deprecated `.cost`:

- `run-store-growth.test.ts:267,274,284`: `measureRunGrowth` calls seven operations at 298–335 (control, stage,
  projection page, vanished page, key, omission, finalize). Rows/executions are constant for point operations and
  **linear** for page operations despite fixed limit 8; preserve the current assertion rather than silently tighten
  it. Block slack alone is overridden to zero at 291; rows use 2/10%, executions zero.
- `run-store-pages.test.ts:32,38–41,50`: one measured callback observes exact active run, three staged keys
  `Q000002`–`Q000004`, and empty acknowledged page; executions >0, returned rows ≥3; both constant with default
  slack. Limit 101 and acknowledged limit 0 reject. No new driver abstraction is required.

Logical axes versus physical seeds:

- Portable run-store `grow` (`specs/imports-run-store.test.ts:539`) uses one accumulating same-source store at
  32/128/512. Each scale adds three complete snapshots of n history keys + one fixed + eight vanished keys;
  prior membership n+9, supplied/survivors n+1. These are records, not n database rows: generations, retained entry
  snapshots, acknowledged/member state and commands are separate relations. Earlier generations remain stored.
  The three seed snapshots alone contribute 3 generations and 3*(n+9) entries per scale; later measured/failed runs
  add more. `Evidence` contains schema and executions, not relation cardinalities: exact total populations of all
  eight tables are not an observed output of this portable port. `persisted()` can expose actual rows outside the
  measurement (`run-store-driver.ts:152`); a cardinality observation is missing if adoption requires those totals.
- Local fixed operations (`run-store-growth.test.ts:63–82`) similarly add three snapshots of n keys per scale plus
  intervening blocked/refresh runs. Run-plans (`specs/imports-run-plans.test.ts:591`) adds three snapshots of n+1
  keys; fixed key has 64 field proposals, the changed private plan has 128 commands. Its independent m axis is
  1/8/64 proposals, not a catalogue scale.
- Direct `seedRunStore` (`run-store-growth.test.ts:152,266`) uses fresh files at logical 1/8/64 with count=500*scale:
  **500/4000/32000 rows in each of eight relations** (sources, generations, entries, members, acknowledged,
  commands, payloads, envelopes), not merely 64 records. One hot source owns all generations; extra sources pad the
  source relation. `run-store-pages.test.ts:9–30` uses fresh databases with n=32/128/512 staged entries and one run,
  without acknowledged population. No inference that every fixed-write axis must become 64/512/4096 is warranted.

Smallest adoption group: `specs/imports-run-store-driver.ts`, both run-store/run-plans portable specs, both forwarding
drivers, `run-store-growth.test.ts`, `run-store-pages.test.ts`; retain run-store and run-plans outcome wrappers
(`run-store-outcomes.test.ts:8`, `run-plans-outcomes.test.ts:6`) as native-store binding entrypoints. The driver type
is also imported by `specs/imports-run-plans-driver.ts:47`, which must agree if the measure interface changes.
The forwarding drivers already provide sufficient raw observations; use the committed shared counted API.
**Frozen-byte reconciliation:** changing either portable spec or its driver contract requires explicit imports
acceptance-owner reconciliation. This report authorizes no frozen-file edit and does not copy the two drivers.

## CLI invocation and streaming evidence

Producer: [`services/importer/tests/cli-driver.ts:33`](https://github.com/rezics/rezics-next/blob/860ec3c071f213ccd3cd0ad288f7bf0777c20384/services/importer/tests/cli-driver.ts#L33)
has private `createSqliteCapture`, whose `finish(): {sql:Execution['sql']; cost:Execution['cost']}` at 139 sums
verified SQL rows/count at 152 and adds `blocks:0`. `createImportCliDriver:205` returns `CliDriver`; `invoke:211,380`
returns `cost: evidence?.cost ?? {rows:0,statements:0,blocks:0}`. `specs/imports-cli-driver.ts:69–81` types
`Execution.cost` as `GrowthSample['cost']`. These are SQLite-only counts, not server authorization or PG cost.

Every tracked cost consumer is `specs/imports-cli.test.ts:211–213,515,523,525–526`: its harness checks SQL length
equals executions and sum of raw rows equals returned rows, with unavailable buffers asserted as zero; fixed
invocations constant, streaming `rows=input.bytes`, `statements=input.records`, both linear. Preserve row slack
2/10% for bytes and SQLite returned rows, zero slack for records/executions. Keep input observations separate from
SQLite work. `cli-outcomes.test.ts:6` dynamically loads this spec with `cli-driver.ts`; `loadCliDriver` at portable
driver line 103 is the only factory loader. Credentials and native Auth suites do not consume `Execution.cost`.

Raw observations: SQL text/binds/per-call rows/EQP; actual captured request byte lengths, authorization and URLs;
CLI observers at `cli-driver.ts:229–267` count boundary bytes/passes, supplied records from real seal counters,
max retained backing and page lengths. Preserve these, including zero-I/O preflight (`imports-cli.test.ts:228`),
not a test-only success sample. A missing capture may honestly mean preflight opened no database; require that
observable no-I/O case rather than using the fallback as proof of a successful SQL path. No SQLite buffer or
visited-row producer exists. This fixture remote is not native Auth/Access/PostgreSQL evidence.

Exact assertions (`imports-cli.test.ts:206–218,409,494–526`): all handles closed; diagnostics ≤4096 UTF-8 bytes,
private markers absent; no COUNT/OFFSET; token reads exactly the selected file, 1–4096 bytes; each request ≤65536
bytes, expected origin and bearer. Fixed successful run has nonempty SQL; no SCAN except CONSTANT ROW, TEMP B-TREE
or AUTOMATIC; SEARCH has declared access prefix; SELECT/WITH/UPDATE/DELETE have nonempty plans. Streaming exits
with mass protection after consuming a disjoint input, bytes exactly encoded input, records=n, passes=1,
peak buffered bytes ≤131072 and max page ≤100. Do not turn its intentional mass-disappearance result into success.

Logical scales 1/8/64 use fresh state paths. Actual seed (`cli-driver.ts:423–464`) adds 4n failed generations with
one staged entry each under `hot-history`, then n unrelated keys, then an unrelated refresh with one survivor and
n−1 vanished keys, through real store operations. Thus failed generations=4/32/256; unrelated membership keys
=1/8/64 (only one remains active after refresh), not 4096 rows on every relation. The measured Wikidata baseline
starts empty; `hot-history` is a different source, not evidence of measured-source history growth.

Smallest group: `services/importer/tests/cli-driver.ts`, `specs/imports-cli-driver.ts`, `specs/imports-cli.test.ts`;
keep wrapper/binding route. Depends on committed probe counts, not pending slices. Portable cost type, generic
harness identities, and streaming sample assertions require **explicit frozen acceptance-owner reconciliation**.
Retain transport/input/SQL as separate named units and all current exact identities.

## VNDB tables, archive, chunks and admission

Producer: [`specs/imports-vndb-tables-driver.ts:153`](https://github.com/rezics/rezics-next/blob/860ec3c071f213ccd3cd0ad288f7bf0777c20384/specs/imports-vndb-tables-driver.ts#L153)
exports `sqliteEvidence()` with attach/start/finish/cancel; finish at 328 returns `{rows,statements}` after raw
bound-EQP validation. It retains calls/parameters internally and counts actual get/all/values/iterator results.
`Cost:72` additionally contains `rowWrites`, `peakBufferedRows`, `crossPartitionStatements`, with **no blocks**.
The mislabeling step is portable spec `sample(scale,cost): GrowthSample` at line 152, called at 570/583: it maps
returned rows/executions to PG names and invents block zero. Its caller must change with the helper/Cost seam.
`loadVndbTablesDriver:127–145` overlays its measured rows/executions on binding cost. All tracked value callers of
this helper are that loader, `vndb-tables.test.ts:53,77`, and `vndb-tables-growth.test.ts:53,238–246`; the latter two
manufacture block zero. No tracked `createVndbTablesDriver` implementation exists at this revision: the portable
loader is a missing-producer seam, not evidence that local tests execute the portable acceptance successfully.
Do not fill its `rowWrites`, buffer or cross-partition fields from guessed zeros or bypass its binding.

| Callsite group | Existing exact bounds, axes and raw material |
| --- | --- |
| `specs/imports-vndb-tables.test.ts:130–154,536–546,557–620` | `validCost` for staged/grouped reads: all values safe integer/nonnegative; executions >0; cross-partition executions=0; buffered rows ≤16*(8+2)=160. Fixed grouped read: executions ≤16, rows between 2+m and 4*(1+m), rowWrites=0. Stage S rows: rowWrites=S, rows/executions ≤8S+16. Enumeration seeds 193 VNs/579 rows; exactly 13 pages, twelve of 16 and one of 1, exact ordered unique keys/cursors, reject limit 17; each page rows ≤4*16*2=128 and buffered rows ≤160. Fixed fixture S=7, staged bytes >0 and ≤8*inputBytes+4096, identical storage at all scales. Fixed-stage/read constant at n=32/128/512, seed requests unrelatedKeys=n and historicalActivity=4n (physical population unavailable without the missing binding). Child m=2/4/8 admitted, 9 rejects; S=m+5 and same byte formula; its separate seed requests 512 keys/2048 historical activity. |
| `services/importer/tests/vndb-tables.test.ts:73,338–375` | Local async measurement returns `{value,cost:{...finish(),blocks:0}}`. Page limit 1 returns v123 with two titles, rows 4–12/executions ≤16; page/inspect constant, stage linear at n=32/128/512. Each scale adds n earlier archives with 2 VNs/7 stored rows each, then hot archive n+1 VNs/3n+4 rows, retained together. Hence before payload cases runs=33/162/675 and rows=324/1608/6732; headers-first input leaves no required spool population. Child count 2/4/8 uses logical scale children²=4/16/64 to satisfy ratio validation: rows linear, executions constant; preserve that actual axis. |
| `vndb-tables-growth.test.ts:238–349` | Async `measureStage` returns `{rows,blocks:0,statements}`; sync projection/validation/cleanup use probe `.cost` at 298/321/347. All rows/executions constant, no extra numeric ceiling currently asserted. Logical 1/8/64 seeds two sources, 250 archives per source per unit: runs=500n (500/4000/32000); rows AND spool=1500n (1500/12000/96000), three rows each per archive. Projection hot run has 17 VNs and returns 16 with next v16; validation 33 VNs; cleanup 65 VNs plus 65 spool rows per each of three tables, erased per run. Staging uses fixed six fixture entries, data before headers. |
| `vndb-chunk-growth.test.ts:44–100,122,163–197` | Private async `stageProbe.measure` sums probe `.cost` rows/executions into `{rows,statements,blocks:0}`, verifies >0 each and EQP evidence count delta equals executions. First axis 32/128/512 accumulates real six-entry same-source ready archives with 7 rows each, plus one measured archive each scale: runs=33/130/515 and stored rows=231/910/3605. SQL constant. Separate 1/8/64 input axis pads VN bytes to 512n: actual iterator visits=admitted bytes=pulled bytes=all six entry lengths; pulls=retention input samples=chunks=n+5; peak input=512, row buffer ≤65536, result 2 records. Input aliases rows=visits, statements=chunks, blocks=admitted bytes, all linear; SQL constant. Keep old **4/50% block slack on admitted bytes**, 2/10% on visits, zero on chunks. |
| `vndb-archive-limits-growth.test.ts:72–122,144–213` | Separate async `stageProbe` returns the same old cost shape; nonempty executions equal evidence length. Every plan row forbids SCAN/TEMP B-TREE/AUTOMATIC and requires indexed source=? AND run_id=?. Fixed rejected/ready SQL both constant; ready memory aliases rows=line capacity, statements=input backing: line exactly 65536, input exactly 128. Explicit rows/executions slack zero; no weakening to shared defaults. Logical 1/8/64 seeds three sources at 128n each: **384/3072/24576 rows in EACH of runs/rows/spool**, plus measured runs. Other-source count explicitly equals 128n at every scale. Ready result 2 records; rejected run has zero stored/spooled rows; failed and ready states survive reopen. |
| `vndb-archive-limits-growth.test.ts:222–276` | Independent entry/byte budgets=8n at 1/8/64; fresh databases. Actual counters: entries=budget+1, bodies=bytes=bodyClosed=budget, outer closed=true, scans=0. Reject before opening excessive body. Old input rows=bytes, statements=entries+bodies (two distinct measured events summed); both linear with zero slack. Old memory rows=peak retained total, statements=0, constant with zero slack; split event names only if retaining the original combined-events bound too. |

All these async wrappers must continue collecting actual synchronous executions across awaits, including failure
cleanup, rollback/release and actual lazy rows. `sqliteEvidence` runs ANALYZE outside capture at every start and
explains each distinct SQL/binding outside measurement (`:276–337`); it rejects COUNT/OFFSET, scan/temp/automatic,
requires declared indexes and constraints, permits empty plans only for controls/exact-PK VALUES inserts. It
currently exposes neither raw calls nor per-execution rows publicly; a richer evidence-return producer would be
needed for public per-execution assertions. Existing sums are enough for honest named aggregate counts.

Preserve adjacent admission/byte witnesses: `vndb-chunk-growth.test.ts:203–230,233–287,294–325` rejects invalid
chunk configuration before pulls; oversized backings for known/header/ignored paths fail before byte visits,
close without resume, erase all failed-run rows/bytes/counts and preserve baseline; eight ignored invalid-UTF8
256-KiB chunks drain without scanning or persistence. `vndb-archive-limits-growth.test.ts:280–375` covers unsafe,
overflow, negative, fractional, infinite declarations; short/lying/mutated bodies and oversized backing: exactly
two entries, 1 or 2 bodies according to whether admission reached that body, no tail, all opened bodies/outer
closed, scans=0, state failed. Invalid options reject before schema creation. `vndb-archive-limits.test.ts:25,41,77,107`
retains default/hard limits, exact-bound admission and no excessive-body pull. No source or timeout changes follow.

Raw TAR archive is already distinct evidence: `specs/imports-archive-driver.ts:39–56` exposes `ReadArchive` and
`observe<T> -> {value,io:IO}`, implemented by `services/importer/tests/archive-driver.ts:150`; portable loader and
`archive-outcomes.test.ts:6` are its callers. It does **not** encode bytes as PG cost. At
`specs/imports-archive.test.ts:443–515`, payload 512*(1/8/64), owned chunks ≤512, bytes exactly archive length,
reads=archiveLength/512, two entries, visits between bytes and 8*bytes, retention between 512 and
1024+maxMetadataBytes; peak difference ≤512 across scales. All six intercepted I/O counts equal zero; before
first body/cancellation ≤1024 bytes pulled, cancellation closes before full archive. Preserve this already honest
port and the loader/native stages; do not recast its observer as a fake database capture.

Smallest groups: (a) `specs/imports-vndb-tables-driver.ts`, `specs/imports-vndb-tables.test.ts`,
`services/importer/tests/vndb-tables.test.ts` and `services/importer/tests/vndb-tables-growth.test.ts`;
(b) `services/importer/tests/vndb-chunk-growth.test.ts`'s wrapper and SQL/input consumers;
(c) `services/importer/tests/vndb-archive-limits-growth.test.ts`'s wrapper and SQL/retention/input consumers.
Depend on committed shared counts/EQP, not a new copied engine. Group (a)'s portable bytes need **explicit imports
acceptance-owner reconciliation**, including the missing binding and the non-SQL fields of Cost. The Entry type
also has tracked consumers `specs/imports-cli-driver.ts:4`, `imports-cli.test.ts:22`, `imports-archive-driver.ts:1`,
`imports-archive.test.ts:6`; leave its source representation unchanged. Groups (b)/(c) need no raw TAR redesign.

## Shared native growth composition and cost aggregation

Producer chain: [`growth-driver.ts:3`](https://github.com/rezics/rezics-next/blob/860ec3c071f213ccd3cd0ad288f7bf0777c20384/services/kernel/test/imports/growth-driver.ts#L3)
returns `openImportGrowthFixture(): Promise<ImportGrowthDriver>` (`growth-fixture.ts:509`). Its measure at 1291
returns `{value,counters:Counters}`; `nativeGrowthCapture:790` preserves `phases.api.postgres` as raw `Capture`,
combines **tagged** SQLite and PG statements, and includes native generic index plans. `api-runtime.ts:772`
`measureGrowth` composes real `measurement.measure` with `growth-sqlite-capture.ts:51` capture. The latter supplies
actual SQL/binds/rowsReturned/optional changes/classification/aliases/EQP and introspected metadata after ANALYZE
(60,250–292), not visited-row estimates. PostgreSQL statements/plans/backends/errors/background remain native.

The only value factory consumer is `specs/imports-growth.test.ts:70`, reached by
`services/kernel/test/imports/growth-outcomes.test.ts:6`. `database()` at spec line 120 produces three cost groups:
SQLite rows=sum rowsReturned and statements=count, fake blocks zero; network rows=requests with statements/blocks
zero; PostgreSQL `costOf(c.postgres)` then **overrides rows with shared rows + sum(rowsAppended), and statements
with PG client calls + raw plan count** (207–222). SQLite is never added to that PG object. `rowsAppended` is itself
derived by summing ModifyTable Actual Rows*Loops (`growth-fixture.ts:378,415–467`), including extra native plans
assigned to the last matching successful SQL; it is not an independent SQLite counter or guaranteed affected-row
producer for every DML. Preserve this existing derived assertion as a separately named native count while keeping
shared PG cost unchanged; do not silently discard it or relabel it as canonical PG rows.

Every value consumer of these groups is the initial reconcile sample (`imports-growth.test.ts:437–442`), second
vanished-page sample (`:478–483`), and growth assertion (`:491–497`); `database` also validates oversize public batch
when it touched SQL (`:531`) and private 300-command plan (`:569`). No additional return-cost callers were found.
The runtime raw Capture is also used independently by API acceptance: `specs/imports-api.test.ts:961–985,1027–1035`
maps SQLite to old cost aliases but feeds **only** `costOf(sample[phase].postgres)` to PG growth. Its reconcile/api/
stop/removal/removalApi groups need the same named SQLite correction if that shared seam is adopted; real
`checkGrowth` at 1039–1046 remains PG evidence. `api-capture.ts:143–178,223–226` keeps raw PG and SQLite separate.
That dependent API group retains integer/nonnegative observations, page records ≤8, partitions ≤8, exact
execution-count and returned-row identities, positive reconcile SQL/rows and positive real API PG rows/blocks/
statements; its five phase groups use constant SQLite rows/executions (2/10% and zero slack), real PG constant
rows/executions and logarithmic blocks. It independently varies catalogue/history/both at 32/128/512.

Exact obligations to retain:

- `imports-growth.test.ts:124–202`: fixture/touched partitions ≤4*items and touched partitions belong to fixture;
  PG SQL list equals raw Capture statements; all explain JSON belongs to raw plans; aligned SQLSTATEs are null
  or five uppercase alphanumerics; failed statements append zero. Planless statements require control/failure.
  Native plans contain Actual Rows and Shared Hit Blocks. Generic index proofs cover every distinct captured or
  nested query text; relations use Index/Index Only/Bitmap Heap/ModifyTable, indexed nodes have nonempty Index Cond.
  Measured sessions stay unpinned. SQLite uses `specs/support/verify-import-api.ts:8`'s actual indexed validator.
- Per-engine execution ceilings are static, unchanged across samples: sum(fixed+perItem*items+perField*M).
  `growth-fixture.ts:470–506` declares SQLite `(1200+80I)+(256+64I+32M)` = **1456+144I+32M**;
  PG **4000+1000I+256M**, charged as client calls+raw plans. Keep these existing coefficients and their method
  derivations, rather than introducing an observed maximum or reducing everything to a growth class.
- `imports-growth.test.ts:210–212`: allocated bytes ≤64*(I*65536+M*1024), peak retained bytes ≤4*(8*65536+M*1024),
  records ≤I for bulk, otherwise ≤8. At 437–497, fixed N/history rows/executions/requests constant, PG blocks
  logarithmic; M payload rows/executions/requests and PG blocks linear. Requests previously used row slack 2/10%.
  Preserve PG-derived combined-row slack 2/10% and combined-execution slack zero separately from shared PG cost.
- I=M for bulk, 8 for vanished page, otherwise 1. Bulk sends exactly M retractions plus M proposals; requests at
  least envelope count. Completed writes=I except unchanged=0; mass-disappearance blocked with 0 writes. Other
  non-vanished cases retain source/key/field SQL witnesses, ≥I client fences and ≥I server fences when changed.
  Vanished pages return exact first/next eight keys, distinct/disjoint, nonempty cursor and source/generation,
  key-range and LIMIT SQL (`:445–488`). `growth-fixture.ts:996` gets visited keys from the actual returned page.
- `:521–569`: reject 101 public commands with no writes and ≤1 request; 300 private commands produce >3 actual
  envelopes. Each body ≤65536 UTF-8 bytes and ≤100 commands, validates, all keys unique, total exact, count
  ≥ceil(commands/100); adjacent batches cannot combine their first next command under both caps.
- Reader/pure conversion stay separate: `readerCost:100` has work/allocated in (0,64*(bytes+fields)], retained
  ≤64*(min(bytes,65536)+fields). Streaming at 373–410: one iterator/pass, exactly S pulls/yields, first yield before
  EOF, ahead ≤8, retained records ≤8 and bytes ≤9*recordLength. Record bytes ≤1024; S=32 except supplied axis
  32/128/512. Framed content exactly 65536 accepted/65537 rejected (`:571–597`). Pure conversion retains untouched
  return equality, byte-identical fixed returns and exact nonincreasing incremental byte slope (`:299–321`), not
  synthetic CPU/heap samples. Pure counters may be absent; no new zero-filled work model is justified.

Raw local units remain available at `growth-fixture.ts:1351–1380`: actual requests plus manual requests, request
body bytes, parser pulled/scanned/copied bytes, page-retention bytes/records. `workUnits` currently sums scanned+
copied bytes **and** SQLite executions + PG calls + raw plan count; it is a mixed work counter, not CPU cycles.
`allocatedBytes` sums pulled+copied bytes, request bytes and page/plan accounting, not measured heap allocation.
Split by those actual ingredients when exposing named counters; retain current composite inequalities as named
derived checks. No current producer measures SQLite examined rows/buffers, machine CPU or general heap bytes.

Physical populations: N/history 32/128/512 and M=1/8/64 are distinct (`imports-growth.test.ts:16–18,225`).
`api-population.ts:45–93,105–189` seeds 2N semantic subjects (hot plus placed routes), 2N SQLite members across
bangumi/seed-other, 2H abandoned generations, and per ordinal one editorial.write_basis for each distinct
placed/hot/account route (≤3H). It appends **32 revisions per ordinal per distinct one of five history routes**:
`32*H*historyRoutes.length`, i.e. 1024/4096/16384 per route before earlier sequences. History route subjects are
separate fixed anchors. Immutable revision sequences accumulate when H falls; revisionOffset preserves prior
history. Native scenario sources can be growth-source or generated sources (`growth-fixture.ts:1237–1242`);
the generic background seed is bangumi/seed-other, so do not claim N hot keys in every generated scenario source.
Bulk setup imports M real records (`:713`); vanished setup imports 96, stages 80 survivors and 16 missing plus a
96-record decoy (`:727`); regular mass baseline has 16 (`:689`). Actual native relation populations include these
setup/warmup writes. Logical 512 alone neither proves nor disproves a ≥4096 physical history population.

Smallest group: portable `specs/imports-growth-driver.ts` + `imports-growth.test.ts` + actual
`services/kernel/test/imports/growth-fixture.ts`; change `growth-sqlite-capture.ts`/`api-runtime.ts` only if an actual
missing producer requires it. Preserve their current raw interfaces otherwise. Type consumers of
`GrowingRelation`/`SqliteStatement` are `specs/imports-api-driver.ts:3`, `specs/support/verify-import-api.ts:5`,
`growth-sqlite-capture.ts:2`, `api-capture.ts:4`, and `api-runtime.ts:47,51,774`; all must remain compatible. Treat
API spec's local sample correction as an explicit dependent acceptance-owner handoff, not an excuse to replace its
native fixture. Portable growth/API driver/spec bytes require **explicit frozen-owner reconciliation**.

## Adoption handoff and limits

The common pattern is genuine raw observations followed by an inaccurate generic summary; the smallest change is
at that summary and every consumer, preserving raw plans, actual dispatch and exact bounds. Adopt groups in
producer/caller order above using the existing counted API; pass old per-unit slack explicitly, since shared
counted defaults differ. Do not edit already assigned slice files or assume their pending work. Filtered lists need
the adopted 64/512/4096 logical rule, while legitimate fixed-write axes may retain their own scales when their
largest actual population is ≥4096. This report records current smaller populations/gaps without changing scales.
No local counted correction establishes server per-batch growth: semantic/growth-sourced-writes owns its separate
native capture/strengthening; an older width-three sample cannot establish 100-command evidence.

Serialized README handoffs only, at this revision's `services/importer/README.md`: CLI row 239; raw chunks 245;
archive staging 246; validation/projection/cleanup 247; run controls/stage/pages/classify/ack rows 249–253. Preserve
their concrete statement/page/byte formulas as well as the test ceilings above:

- Controls ≤3 point statements/rows (activeRun 1 statement/2 rows), stage ≤5 (duplicate 3), plus 2 transaction
  controls; staged/pending/vanished pages 2 statements, acknowledged 1; staged ≤r+2 rows, pending ≤r+1,
  vanished ≤r+3 touches, key ≤5 SELECTs. Classify/prepare ≤14+7q statements, ≤15+7q touches, plus 2 controls;
  q≤100/300, omissions≤3, private plan ≤2 MiB, each envelope ≤100 commands/65536 bytes. Ack ≤1+8r point
  statements/rows plus 2 controls; finalize ≤r+4 statements/2r+3 touches plus 2 controls. These touch ceilings
  must retain their meaning; they are not a measured visited-row counter supplied by the local probe.
- VNDB direct row 2 point statements; spooled row 1 INSERT, one range SELECT per ≤32 rows, 2 insert/counter
  statements and 1 DELETE per row. Validation one SELECT per ≤32 rows plus terminal ranges, 2 per VN/1 per
  child; title LIMIT children+1≤65. Page 2+2r SELECTs, ≤r+1 numeric rows, ≤66r child/metadata rows plus 1 run
  row; cleanup one SELECT per ≤32 rows plus one DELETE per row. Input row ≤65536 bytes, chunks default 256 KiB/
  hard 1 MiB (table configuration ≤256 KiB), spool page 32; entry bytes default 16 GiB/hard 64 GiB, count 512/2048;
  maxRows default 2,000,000/hard 10,000,000, source records 500,000/1,000,000. These limits remain independent.

Row 261's kernel-write/fence
description needs its owner to distinguish counted client sends from real server evidence after adoption; its
obsolete “Kernel call stays within its bound as R grows” title is already identified by the preceding report.
No additional README writer is proposed. Existing raw archive observation and pure/native user-case stages remain
evidence in their own right, rather than local harness results being promoted to native success.

Only this report is changed. Ambiguities resolved: source-only inventory (no external standards survey), raw TAR
port retained, native PG-plus-PG derived metrics preserved separately rather than mistaken for SQLite contamination,
and extra non-growth filenames included through actual helper callers. No claim that all importer costs migrated.
