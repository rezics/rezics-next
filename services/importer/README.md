# Importer

The importer owns source dump ingestion, durable SQLite run and record state, and replayable requests for platform writes through the kernel API.

## Preview a source dump before importing

`rezics-import preview` decodes an actual dump through the registered converters and compares it with a captured
completed baseline. It needs the source kind and dump path; it does not need an account key, credentials, network
access, a writer lease or the configured import state. Help is available without opening a file:

```sh
bun services/importer/src/cli.ts preview --help
bun services/importer/src/cli.ts preview --source wikidata --dump /srv/imports/wikidata.json
bun services/importer/src/cli.ts preview --source wikidata --dump /srv/imports/wikidata.json.gz --compression gzip
bun services/importer/src/cli.ts preview --source wikidata --dump /srv/imports/wikidata.json.zst --compression zstd
bun services/importer/src/cli.ts preview --source vndb --dump /srv/imports/vndb-db.tar.zst --compression zstd
bun services/importer/src/cli.ts preview --source openlibrary --dump-set /srv/imports/open-library/manifest.json --baseline .state/imports.sqlite
```

`--source` is one of the four launch kinds. `--compression none|gzip|zstd` defaults to `none` for exact compatibility;
gzip is admitted only for Open Library and Wikidata streamed dumps; zstd is admitted only for VNDB ustar archives and
Wikidata streamed dumps as one regular local file. A suffix is not a source identity,
revision or licence. `--dump-set` previews one complete Open Library author/work/edition manifest and is
mutually exclusive with `--dump` and `--plan-dir`. `--decode-budget` is a decoded-byte ceiling for one gzip
or zstd dump or one complete dump set (default 256 GiB for the whole set). `--plan-dir` reopens a retained plan
without reopening or decompressing input. `--source-alias` names the configured source identifier used in local
state; the two remain distinct. `--baseline` opens an existing importer state file read-only and copies only that
source's completed generation into a caller-owned temporary store under `os.tmpdir()` (or `--output-dir`). A live
writer does not invent a future baseline. Without `--baseline`, the view is a first-import preview, not proof that
the server has no existing subjects. An unavailable schema is reported precisely. Preview never migrates, takes a
writer lease or modifies import journals.

Pages default to 20 rows and accept at most 100. Use `--page new|changed|unchanged|vanished`, `--limit`, the printed
opaque cursor, `--record` for exact-record drill-down, or `--json` for the version 1 document. Incomplete, truncated
or duplicate input keeps a bounded error identity and withholds a vanished set. Empty input and total disappearance
keep the production stop rule; preview never lowers the threshold. Converter diagnostics appear on the prospective
record view. Media intents are descriptions only. Source statistics stay labelled as source statistics.

`--output-dir` retains the plan for later `--plan-dir` page reads. The directory is created with owner-only access
and is refused when it already contains a database. Plans may be discarded without touching import state.

Decision: preview pages persist only in `--output-dir` or a process-owned temporary directory; `--plan-dir` reopens a
complete plan without re-decoding. The ordinary import invocation is printed with placeholders and is not an
executable interpolation of dump paths.

```sh
bun services/importer/src/cli.ts preview --source wikidata --dump /srv/imports/wikidata.json --baseline .state/imports.sqlite --page changed --record Q1
bun services/importer/src/cli.ts --source wikidata --dump <complete-input-path> --state .state/imports.sqlite --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>
```

## Compare two completed preview plans

`rezics-import compare` reads two completed persistent dump-preview directories and builds a derived before/after
index of exact source-key membership and retained native field/evidence differences. It does not decode dumps, load
historical converters, construct credentials or HTTP clients, write import state, or apply a preview. Help is
available without opening a path:

```sh
bun services/importer/src/cli.ts compare --help
bun services/importer/src/cli.ts compare --left /srv/previews/left --right /srv/previews/right --output-dir /srv/comparisons/refresh
```

Both plans must be complete, share the exact configured source alias and provider kind, and capture the same baseline
generation. Two first-import plans (both without a baseline) may be compared; that view does not establish server
emptiness. Different baseline captures are refused with a bounded mismatch asking for a fresh common capture. Missing
or unavailable metadata is never treated as equality. Different admitted input paths and different converter revisions
may coexist; both are reported and neither is assigned as the cause.

Pages default to 20 rows and accept at most 100. Use `--page only-left|only-right|changed|unchanged|skipped|unavailable`,
`--limit`, the printed opaque cursor, `--record` for exact-record drill-down, or `--json` for the version 1 document.
A record absent from the right dump is an input comparison difference; source withdrawal eligibility remains that
plan's complete acquisition. Title-equal records with changed references or qualifier precision stay changed. A digest
change with equal retained rendered fields is reported as a digest/revision distinction, not complete semantic
equivalence. Unresolved targets stay unresolved on each side. Ordered reference groups are not paired by index when
no stable matching key exists.

`--output-dir` retains the derived comparison for later `--comparison-dir` page reads without reopening the dumps.
Cursors bind to the comparison identity and capture digest. Cancellation or a storage ceiling leaves no completed
marker. The printed ordinary import invocation uses placeholders and the plans' actual source kind/alias.

Decision: comparison reopens retained preview.sqlite files read-only using the delivered preview plan schema; it does
not call DumpPreview.open (a writable reader) or invent a second conversion pipeline. Reopen uses `--comparison-dir`.

```sh
bun services/importer/src/cli.ts compare --left /srv/previews/left --right /srv/previews/right --page changed --record Q1 --json
bun services/importer/src/cli.ts compare --comparison-dir /srv/comparisons/refresh --page only-right
bun services/importer/src/cli.ts --source wikidata --dump <complete-input-path> --state .state/imports.sqlite --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>
```

## Inspect retained source-dump work

`rezics-import inspect` opens an existing importer state file for local read-only inspection. It needs only the state
path and exact configured source identifier; it does not need a dump, account key, credentials, network access or a
writer lease. Its help is available without opening a file:

```sh
bun services/importer/src/cli.ts inspect --help
bun services/importer/src/cli.ts inspect --state .state/imports.sqlite --source wikidata
```

By default, inspection selects the source's active generation, or its completed baseline when no generation is
active. A recognized empty completed source is shown as an empty baseline. Retained generation progress is separate
from the baseline and does not advance it. Stored counters keep their production phase meanings; unavailable legacy
counters are shown as unknown. The displayed status is the stored status, and unrecognized statuses remain
unrecognized.

Pending envelopes and deferred covers are separate live pages. Pages default to 20 entries and accept at most 100;
the next cursor is reusable only with the same source, generation and page kind. Each invocation reads one bounded
page snapshot, so a writer may settle work between page requests. The next page is not a cross-invocation snapshot.
Page rows show classification, stored unresolved counts and bounded field-group/operation summaries. They do not
include request bodies or projections.

```sh
bun services/importer/src/cli.ts inspect --state .state/imports.sqlite --source wikidata --page pending
bun services/importer/src/cli.ts inspect --state .state/imports.sqlite --source wikidata --page covers
bun services/importer/src/cli.ts inspect --state .state/imports.sqlite --source wikidata --record Q42
```

Copy the opaque cursor printed by a page response into the next invocation with that same `--page` value. Use
`--generation <id>` to select another exact retained generation, `--limit 1..100` to set a page size, or `--json` for
the deterministic version 1 document. JSON mode emits one JSON value with `version`, `source`, `sourceState`,
`baseline`, `ownershipRow`, `selection`, `generation`, `record` and `page`; it has no progress chatter. Exact-record
inspection shows retained envelope byte lengths and SHA-256 digests, command identities, unresolved delivery,
settled command outcomes and recorded fence omissions without printing serialized request bodies. A local completion
marker is evidence in this importer journal, not a current selected/public read or proof of publication, adoption,
source rights or cover permission. Other subsystem journals are outside this view.

Decision: inspection accepts an exact configured source ID, defaults to the active generation or completed baseline,
and selects pending-envelope or deferred-cover pages explicitly.

## Compare two retained complete captures

`rezics-import capture-comparison` selects two exact retained complete generation IDs for the same configured source
and pages captured-record differences. It needs the state path, source identifier, `--before` and `--after`; it does
not need a dump, account key, credentials, network access or a writer lease. Generation IDs are exact decimal text
and are never rounded or replaced with the current generation. Help is available without opening a file:

```sh
bun services/importer/src/cli.ts capture-comparison --help
bun services/importer/src/cli.ts capture-comparison --state .state/imports.sqlite --source wikidata --before 1 --after 2 --counts
```

Both captures must be complete history of that exact source. An empty complete capture is a valid input. Staging,
abandoned, noncomplete, missing, partially retired and retired history are distinct unavailable states. API68
retirement metadata is consumed when those columns or statuses are already present; this command does not invent or
migrate that schema. Missing provenance and incomplete supplied-versus-present accounting fail instead of inventing
an empty result.

Comparison uses retained normalized input rows, not public current facts. Present population is `row_json.state =
present`. Vanished journal rows stay in the generation but are excluded from that population; a staged
new/changed/unchanged/vanished classification is import-time evidence and is not this comparison result. Before-only
present records are vanished, after-only present records are new, and common present records are unchanged only when
stored revision, digest and converter revision are all equal. `--before` and `--after` are operator-selected
identities, not a chronological requirement.

Pages default to 20 rows and accept at most 100. Use `--page new|changed|unchanged|vanished`, `--limit`, the printed
opaque cursor, `--record` for two indexed point reads, or `--json` for the version 1 document. Complete category
counts require `--counts` and one explicit streaming merge; a detail page does not recount. A sparse category stops
after a bounded scan window and continues with the cursor even if the page is not full. A page with no matches and
remaining work is not a completed empty comparison. Cursors bind source, both generation IDs, schema and page
parameters, then revalidate header/capture state before the next page. Retirement or incompatible mutation
invalidates the cursor.

One invocation reads one consistent SQLite snapshot and closes. Concurrent source progress cannot retarget the
selected generations inside that invocation. The reader uses the inspect producer's readonly opening, path and
schema guards and never constructs RunStore, RecordBindings or RecordStore. It makes no database create, migration,
lease, checkpoint, cleanup, credential, network, dump or native effect. Bounded projection field detail is shown
only from the immutable stored source-record format; unavailable legacy projection is reported honestly. Native
candidate proposal, acceptance, adoption and current publication stay independent of this local view.

```sh
bun services/importer/src/cli.ts capture-comparison --state .state/imports.sqlite --source wikidata --before 1 --after 2 --page changed --json
bun services/importer/src/cli.ts capture-comparison --state .state/imports.sqlite --source wikidata --before 1 --after 2 --record Q42
bun services/importer/src/cli.ts --source wikidata --dump <complete-input-path> --state .state/imports.sqlite --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>
```

Decision: capture comparison requires exact `--before`/`--after` complete generation IDs for one configured source;
counts are an explicit `--counts` pass; vanished-state journal rows are excluded from each present population.

## Inspect retained record bindings

`rezics-import inspect-bindings` opens the same importer state file for a local read-only visit of one exact
`(source, external_id)` binding. It needs the state path, the exact configured source alias and the exact external
record key. It does not take a writer lease, load credentials, call the network or construct `RecordBindings`.
Help is available without opening a file:

```sh
bun services/importer/src/cli.ts inspect-bindings --help
bun services/importer/src/cli.ts inspect-bindings --state .state/imports.sqlite --source wikidata --record Q42
```

The first document is one consistent SQLite snapshot. It shows retained binding state `pending`, `bound`,
`taken-down` or `absent`, the locally acknowledged subject when a subject is stored, bootstrap / current metadata /
cover pointers, stored candidate capacity as local accounting, and whether each journal family is available, not
retained or unavailable. A missing binding row is distinct from no current `run_sources` row, missing tables,
unsupported columns and unavailable history. Source-level absence is not inferred from a missing binding.

Independent keyset pages default to 20 rows and accept at most 100. Category is `semantic`, `candidates`, `media` or
`metadata`. Cursors bind source, record, category, schema and the exact ordering tuple; key order is lexical, not a
timeline. Candidate pages show currently owned candidates, not every historical accepted candidate. Semantic journals
preserve retired original requests; a local acknowledgement is a receipt, not current acceptance or a public fact.

```sh
bun services/importer/src/cli.ts inspect-bindings --state .state/imports.sqlite --source wikidata --record Q42 --page semantic
bun services/importer/src/cli.ts inspect-bindings --state .state/imports.sqlite --source wikidata --record Q42 --page candidates
bun services/importer/src/cli.ts inspect-bindings --state .state/imports.sqlite --source wikidata --record Q42 --page media
bun services/importer/src/cli.ts inspect-bindings --state .state/imports.sqlite --source wikidata --record Q42 --page metadata --request wikidata:Q42:<original-key>
```

`--json` emits the version 1 document. Human and JSON output keep raw wire bodies out; they show byte length, SHA-256
of the original request body when the body is inside the 65,536-byte budget, original key/signature, acknowledgement
presence and admitted native identifiers. Unknown delivery stays unknown. A reserved media receipt supplies no cover
permission. Metadata acknowledgement is separate from source licence and native current metadata. Taken-down records
an observed native 404; it is not a live visibility check. Oversized or corrupt rows are finite unavailable reasons
and do not stop the page from advancing.

Refresh through a new invocation. A local cursor authorizes no native request. Resume an original uncertain request
with the ordinary authorized import command, which rechecks current registration, credentials, fences and original
immutable bytes/key. Sealed resume remains that command; source-observation CAS remains a separate operation.

Decision: binding inspection is the `inspect-bindings` subcommand; it requires exact `--state`, `--source` and
`--record`, and pages `semantic|candidates|media|metadata` independently of generation/pending-envelope inspection.

## Retire superseded complete generations

`rezics-import retention` is local importer history cleanup for one exact configured source alias. It never contacts
Auth or the API, never mutates native publication, and never erases source records, acknowledgements, bindings,
payloads or the current complete baseline. Help is available without opening a file:

```sh
bun services/importer/src/cli.ts retention --help
bun services/importer/src/cli.ts retention --state .state/imports.sqlite --source wikidata
```

The default command is a read-only generation page (20, at most 100). Each row shows stored terminal status, whether
the generation is the active/recoverable pin or the completed baseline, an eligibility reason, and honest per-table
generation-local counts. Pages follow stored `seq` order with exact generation ID strings. Abandoned, invalid,
staging, ready, finalizing and currently pinned complete generations stay retained. A supposedly complete generation
with pending envelopes, deferred covers or disagreeing stored counts is ineligible and is not repaired into
eligibility.

Build a bounded plan of at most 100 explicitly named IDs. The plan file is created exclusive mode `0600` and records
database identity, source, schema compatibility and the observed baseline, recoverable generation, sequence and
present count. It describes what becomes unavailable and what stays preserved, without emitting records or secret
payloads. A plan token is not a native grant. Apply requires that exact plan identity as `--confirm` and revalidates
the same pins before deleting any page; stale, replaced, tampered or expanded input needs a fresh explicit plan.

```sh
bun services/importer/src/cli.ts retention --state .state/imports.sqlite --source wikidata \
  --generation 1 --output .state/wikidata-retention.json
bun services/importer/src/cli.ts retention --state .state/imports.sqlite \
  --plan .state/wikidata-retention.json --confirm <plan-id> --apply
```

Apply claims the source with ImportSession's PID/birth/capability rules. A live or uninspectable owner is busy.
Selected eligible generations are marked retiring under the same write lock as the plan recheck, then deleted in
bounded keyset pages over `run_entries`, `run_envelopes`, `run_commands`, `run_conversion_diagnostics`,
`run_conversion_diagnostic_records`, `run_aggregate_operations`, leftover `run_staging_checkpoints` and
`run_staging_prefix` rows, and, when present, the VNDB materialization tables keyed by `(source, run_id)`.
Unknown per-run tables are unavailable and are not deleted. Crash restart resumes the
same local plan without restoring removed rows or widening the selected set. A completed plan reports its retired
result without deleting another generation. SQLite may reuse pages; file size need not shrink, and this command never
VACUUMs.

After retirement the generation header remains as a tombstone with status `retired`, distinct from an empty complete
run, corrupt journal or unknown ID. Inspection and diagnostics readers display that status; they do not invent a
second inspector. Ordinary import remains a separate invocation under current credentials. A source-history plan may
recommend `rezics-import backup` without turning snapshot restore into this workflow.

Decision: generation pages use stored `seq` order with exact string IDs; VNDB materialization rows and leftover
staging checkpoint/prefix rows are enumerated for per-run cleanup when those tables exist. Complete generations
normally already dropped staging at seal. An already-aborted apply reports the cancelled apply document and does not
claim a lease.

## Resolve VNDB source-observation conflicts

A newer same-binding VNDB statistic still imports automatically. An equal-date correction, record rebinding or
alias rebinding stops that exact aggregate operation with a durable explanation and leaves the source run
uncommitted. Exit code 6 is this observation-conflict outcome; it is not an authorization failure, invalid dump
or permission to discard unrelated pending work. An older observation date is refused: CAS cannot override date
order, so supply corrected authoritative input.

```sh
bun services/importer/src/cli.ts observations --help
bun services/importer/src/cli.ts observations --state .state/imports.sqlite --source vndb
bun services/importer/src/cli.ts observations --state .state/imports.sqlite --source vndb --operation <64-hex>
bun services/importer/src/cli.ts observations --state .state/imports.sqlite --source vndb --operation <64-hex> \
  --resolve --reviewed-observation <64-hex-head> --api <https-origin> --account-key <path> \
  --account <uuid> --client <client-id> --auth <https-origin>
```

Pages list at most 20 unresolved aggregate operations, keyed by stable operation ids. Detail shows the intended
record, alias, date, count, scale, mean or explicit clear, the readable retained head and the native reason.
A source figure is independent of a REZICS vote. If the live head no longer matches the reviewed digest, inspect
again. Resolution rereads current fences and authority, seals `expectedObservation` onto a successor intent, and
does not rewrite dates or escalate credentials. Uncertain deliveries resume through the ordinary import command
with the original body and key; a timeout is not a definitive conflict. A successful clear retains its native
observation head even when no public figure is visible.

Decision: observation-conflict is RunStatus plus CLI exit 6; same-date dump refreshes wait for explicit
resolution; local digests use kernel `sourceObservation`; generated client fields `expectedObservation` and
`observation` are an additive seam.

Indexed custody lives in `run_aggregate_operations` (primary key `source,run_id,operation_id`;
`run_aggregate_pending` on unresolved statuses; `run_aggregate_record` on `record_key`) and
`run_aggregate_heads` (`source,subject_id,provider`). Each eligible record does one indexed journal
lookup/prepare, one GET of `/v1/subjects/{id}/source-statistics`, three fence checks per
`fences()` pass (facts/summary/cover; two passes once the subject exists), one native PUT or
`:clear` for a newly prepared intent, and after delivery one list GET plus one public figure GET.
Retries and explicit resolutions are extra transitions R. Work is O(N+A+R). A conflict page is
`SELECT ... WHERE status IN ('prepared','uncertain','conflict','refused') AND operation_id>? ORDER BY operation_id LIMIT P`
with P≤20. Unrelated retained history is not scanned per record.

After inspection, return to the existing authorized import command and provide a complete input and the usual
credentials. For the built-in Wikidata source, the invocation shape is:

```sh
bun services/importer/src/cli.ts --source wikidata --dump <complete-input-path> --state .state/imports.sqlite --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>
```

For a configured source alias, keep its original input kind and add
`--source-alias <configured-source-id>`. The existing importer rechecks input integrity, current authority, source
registration, fences and single-owner admission. Inspection never resumes automatically and cannot bypass a writer
or unresolved authority failure.

## Live import progress

Progress is opt-in with `--progress human` or `--progress jsonl`. Both modes use stderr, leaving the existing final
summary on stdout. Human output updates one bounded line on a TTY and writes newline records to a pipe. JSONL writes
one version 1 event per line. Snapshots are coalesced at a fixed 250 ms cadence; phase and terminal changes flush
immediately. A slow sink holds at most one in-flight frame and one current counter snapshot.

Events identify the source kind, invocation UUID, invocation-local sequence and the actual durable importer run ID
when it exists. VNDB also reports its separate table-acquisition run as `sourceRun`. `resumed` marks work recovered
from the same state file; `acknowledgedEffects` counts only successful effects acknowledged during this invocation.
The counters distinguish input bytes, VNDB records materialized, RunStore records staged, acknowledged effects,
record classifications, skipped records, and deferred or rejected media outcomes. A deferred media outcome is not
reported as a total import failure by itself. `sourceComplete` means the input was fully decoded and sealed; it does
not mean the current catalogue was read. `selectedCatalogue` is always `not-read`: local commit does not prove
candidate acceptance, public selection or readback.

Phases are `acquiring`, `materializing`, `staging`, `resuming`, `reconciling`, `deferred-media` and `finalizing`;
terminal phases identify committed, invalid, mass-disappearance, busy, interrupted, denied, failed or
observation-conflict outcomes.
Progress contains no account credentials, request bodies, raw record keys, provider text, URLs or private error
bodies. A broken sink stops this invocation through the existing cancellation path and reports a sanitized output
failure. SIGINT and SIGTERM preserve the durable journal and original pending request. Rerun the ordinary import
command with the same state file and complete source input to recover it; progress does not add an acknowledge,
abandon or force-release operation.

Decision: human and JSONL progress both use stderr so the existing final stdout summary stays compatible.

## Resume a checkpointed local staging capture

Ordinary import still discards an unsealed staging generation and starts again. Large Open Library and Wikidata
files can opt into an explicit staging checkpoint so an interruption before sealing does not repeat conversion of
records that already committed.

```sh
bun services/importer/src/cli.ts --source wikidata --dump /srv/imports/wikidata.json --state .state/imports.sqlite \
  --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin> \
  --checkpoint-staging
bun services/importer/src/cli.ts --source wikidata --dump /srv/imports/wikidata.json --state .state/imports.sqlite \
  --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin> \
  --resume-staging --generation 1
```

`--checkpoint-staging` and `--resume-staging` admit only one uncompressed regular-file Open Library or Wikidata dump.
VNDB archives, gzip, stdin and multi-file manifests are refused; those producers are not guessed from a byte offset.
Before a checkpointed generation starts, the CLI hashes every byte of the opened file. Path, inode, size, mtime and
prefix hashes are not that identity. A failed hash creates no capture and does not contact Auth or the API. Resume
re-hashes the same file, then re-decodes from the first record to verify the committed prefix, and converts only the
remaining records. Changed bytes, a same-size rewrite, a different converter or alias, an old uncheckpointed staging
row, a missing database and live ownership never resume. After a valid seal the checkpoint is deleted so it cannot
compete with sealed recovery. An interruption after sealing uses the ordinary import command with the original
requests; `--resume-staging` does not replace that path.

Decision: checkpointed staging commits each accepted record with its prefix cursor in one SQLite transaction so a
crash keeps either the previous complete checkpoint or the new one. Ordinary acquisition keeps the existing 100-record
staging page.

The [connected design status](../../docs/research/design-status-imports.md) follows the operator from terminal
acquisition, status and recovery through the private SQLite baseline, source ownership and immutable request/ACK
journal. Ordinary account Auth (`POST /signin/key` → `POST /token`) authorizes public tuple/bootstrap and proposal
effects through `POST /v1/subjects:batchWrite`, exact `GET /v1/sourceFences:check`, and media acquisition through
`POST /v1/media:importFromUrl` → `GET /v1/media/{id}:importStatus`. VNDB statistics use the PUT and clear POST below.
[Semantic](../kernel/src/semantic/README.md) owns independent candidate selection through
`POST /v1/subjects/{id}/candidates/{candidate}:accept` and `POST /v1/subjects/{id}:adopt`;
[Content](../kernel/src/content/README.md) owns rights, current fences and final disclosure. Selected results reach
`GET /v1/subjects/{id}`, `POST /v1/pages:read` and `POST /v1/subjects:search`, then the
[Web](../../apps/web/README.md) subject/search journey. These APIs and CLI form the designed journey; browser
candidate-review entry remains Web/Semantic work and is not delivered by Imports. Primary-source rights,
independent selection, current authorization and exact replay remain required. The reviewed SourceRecord binding
below is implemented for the four launch registrations. A general metadata ACK programme, reviewed
vocabulary/measured inputs and broader discovery remain deferred.

## Back up stopped importer state

Keep the same SQLite state after an interrupted or uncertain request. Copying only the main file can miss committed
WAL frames. `rezics-import backup`, `validate-snapshot` and `restore` are local snapshot commands: they route before
credentials and network, and they never construct an Importer just to inspect a file. `inspect`, capture-comparison,
dump previews, live progress and observation CAS keep their existing commands.

```sh
bun services/importer/src/cli.ts backup --state .state/imports.sqlite --output .state/imports.snapshot
bun services/importer/src/cli.ts validate-snapshot --snapshot .state/imports.snapshot
bun services/importer/src/cli.ts restore --snapshot .state/imports.snapshot --state .state/imports-restored.sqlite
```

`--state` for backup must name an existing regular file. `--output` and restore `--state` must name a distinct path
that does not exist. Symlinks, FIFOs, special files, source/destination aliasing and existing output are refused.
Every `import_owners` row is checked with the existing Linux `/proc` process-birth and boot-id identity; a live or
unverifiable owner is busy (exit 5) and is never permission to force a backup or rotate its capability. Older schemas
that cannot establish owner safety are reported as unsupported; RunStore is not opened to migrate them. A suspended
run with no live process remains recoverable, including unresolved durable requests.

The database copy uses SQLite `VACUUM INTO` under a read-only source connection so committed WAL frames are included
without checkpointing the source, concatenating sidecars, or loading rows into an unbounded JavaScript object.
Unknown compatible tables and columns and exact stored payload bytes are preserved. The snapshot is not an
acknowledgement. Destination files are created exclusively at mode `0600` in a new `0700` directory, staged, flushed
and published by renaming the database first and the manifest last. A failure removes only this operation's incomplete
output.

`snapshot.json` records format version 1, SQLite/schema compatibility, SHA-256 and byte length of
`importer-state.sqlite`, creation time, and bounded source/run baseline identities. It does not contain key-file
bytes, tokens, environment variables, provider prose or command payloads. Validation checks the immutable files
against that manifest, `PRAGMA integrity_check`, and the supported importer structure, then returns the bounded
source/run summary. It never repairs, migrates or rewrites a purported snapshot. Restore installs exact snapshot bytes
at a new state path after validation and does not start an import. A restored `import_owners` row is not an authority
grant; ordinary `ImportSession` acquisition still checks live process identity.

Restoring local state cannot undo native writes made after that snapshot, revoke receipts, retract a selected fact or
guarantee that an older source dump is safe. Stop the original importer and use one state lineage. Resume with the
ordinary import command and current credentials; original request keys, current authority, source revision/fence
checks and existing reconciliation remain decisive. There is no force mode, merged restore, selective row restore or
recovery-only request key.

Copying and hashing are O(B+T) time and O(buffer+T) memory for database bytes B and bounded schema/owner metadata T.
Integrity work is SQLite's `PRAGMA integrity_check` over the snapshot's `page_count` pages. Opening a WAL source
read-only may create reader `-wal`/`-shm` sidecars; logical tables and ownership stay unchanged.

Decision: stopped-state snapshots are a new directory containing `importer-state.sqlite` plus `snapshot.json`; Bun has
no backup API, so the consistent copy is SQLite `VACUUM INTO` into an exclusive empty `0600` file so committed WAL
frames are included without checkpointing the source.

## Reviewed provider metadata

The four built-in registrations describe their actual canonical record identity, independently of the configured
source alias: Bangumi subject IDs, VNDB visual-novel IDs, Open Library work/edition keys and Wikidata item IDs.
Names, record links and attribution are application-reviewed descriptors, never dump-supplied licence/name fields.
Bangumi metadata uses CC-BY-SA-3.0; VNDB records identify ODbL-1.0 database terms and separately name DbCL-1.0
permitted metadata contents in attribution; Open Library metadata and Wikidata structured data use CC0-1.0.
These descriptions grant no cover or prose rights. Unknown community registrations have no default descriptor
or writer, and there is no CLI option for unreviewed rights.

Only a completely acquired, validated, mass-loss-checked and sealed generation can send metadata. After actual
tuple binding, the ordinary client calls public `POST /v1/source-records:setMetadata` under current Global
`subject:batch_write` authority, normal rate limits, idempotency and Session handling. Old bound unchanged records
also catch up; an acknowledged identical descriptor skips future writes, including reopen. Metadata failure keeps
the previous source baseline and independent tuple/subject intact. Missing ports, denial, unknown responses and
conflicts never count as completion.

A distinct immutable SQLite metadata request/result journal binds the exact tuple, descriptor and HTTP intent.
Initial fill uses `expected_metadata_revision: null`; a changed descriptor uses only the last actual returned
revision. Pending response-loss intents replay their original bytes/key under current authority before any replacement
descriptor or acquisition. Existing sealed plans, bootstrap envelopes, semantic receipts, source/converter/native
revisions and digests are unchanged. Partial fill preserves native optional leaves; incompatible leaves and stale
CAS remain explicit conflicts.

Metadata costs are separate from semantic/media/statistic envelopes: at most one new point intent per bound
record/descriptor in an ordinary run, or two when replaying a pending descriptor before a replacement. Each intent
uses the existing maximum eight coordinator attempts and at most five HTTP attempts per coordinator attempt;
unchanged acknowledged descriptors send none. The staged descriptor is capped at 8 KiB and native leaf limits
still apply. These bounds do not enlarge old semantic, fence, native-vote or source-statistic ceilings or claim
measured PostgreSQL/local work units.

The Sources consumer now reads the actual returned current `subject.sourceRecords` DTO. Native selected support
and exact fences determine those rows; original per-field references and separate cover/prose credit remain intact.
A metadata row proves neither support for every field nor publication permission. Unknown metadata stays unknown.
The [native outcome](../kernel/test/imports/source-record-metadata.test.ts) uses the existing ordinary API/CLI fixture
to connect catch-up to selected Sources and unchanged reopen while retaining bootstrap/semantic receipt identity.
It is added for integration verification and has not been run in this implementation attempt. Web owns normal
visual review of `pages-subject-sources--selected-facts` and `pages-subject-sources--partial-metadata`.

```sh
bun run --cwd services/kernel check test/imports/source-record-metadata.test.ts
```

Completed results report `new`, `changed`, `unchanged`, `vanished`, and `skipped` separately. An identity-only Bangumi
type 3/6 projection, or an unknown live-action platform, remains a present source member and increments `skipped` once
during acquisition; it creates no subject, proposal, or media effect. Named type 3/6 records convert. The sealed run
stores this bounded count so recovery reports it without reading replacement input. CLI summaries always include
`skipped=N`, including zero.

## Conversion field omissions

Converters already return `{ pointer, code }` diagnostics on `ConvertedRecord`. The importer now retains that sanitized
vector with the exact source, generation, record, digest, converter revision and phase it describes, then offers a
read-only `diagnostics` CLI command. Journal rows are not native publication, request acknowledgement or candidate
selection. API47 keeps generation/pending-envelope/cover inspection; this command owns a separate read model and does
not take a writer lease. Decision: inspect, preview, compare, capture-comparison and diagnostics remain separate CLI
subcommands. API47 keeps single-capture inspection; capture-comparison owns two retained complete generations.

Phases are `staging` for dump conversion and `application` for dependency-driven reconversion. A recognized empty
vector is stored; missing journal rows on a generation are unavailable historical evidence. Resume of the same
digest/revision/converter identity does not duplicate or replace earlier reasons. Invalid converter diagnostic output
fails that record or input; it never becomes a silent empty set. Limits are derived from registered converter field
caps (64), vocabulary gaps (64), the public batch (100), VNDB sentence bytes (4096) and the public envelope (65,536).

```sh
bun services/importer/src/cli.ts diagnostics --source openlibrary --state /path/to/state.sqlite
bun services/importer/src/cli.ts diagnostics --source openlibrary --state /path/to/state.sqlite --record /books/OL900000002M --format json
```

Default generation is the live acquisition or the completed baseline. Pages are diagnostic-bearing records only,
default 20 and at most 100, with source/run-leading keyset order. Repair uses the ordinary import invocation with
placeholders; this command has no accept-all, rewrite-mapping or publish action. The connected native journey is
`services/kernel/test/imports/cli-conversion-diagnostics.test.ts`.

The connected [Bangumi scope-transition journey](../kernel/test/imports/cli-bangumi-scope-transition.test.ts)
uses five metadata-only native envelopes and the ordinary account-key CLI: an existing Book becomes a music
subject, then live action, then returns as a revised Book under the same native key. Complete membership
stays five; only its actually owned candidates are retracted, its communal identity and immutable bootstrap/old
receipts survive, and an independent editor selection remains selected. Returning input produces fresh cited
`bangumi@5` candidates; unchanged reopen writes nothing. This is a separate connected transition from the static
five-record launch checks. Its earlier ignored-type native child is superseded by typed 3/6 conversion.
[Evidence and limits](../../docs/research/imports-audit/cli-bangumi-scope-transition.md) record the raw native
log, actual source/receipt anchors and inspected reference source. This isolated pass does not establish promotion.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-bangumi-scope-transition.test.ts
```

## Command line

Run the importer with a decompressed native dump and an automated account key:

```sh
bun services/importer/src/cli.ts \
  --source wikidata \
  --dump /srv/imports/wikidata.jsonl \
  --state /var/lib/rezics/importer.sqlite \
  --api https://api.rezics.example \
  --account-key /run/secrets/rezics-importer-account.jwk \
  --account 6b147e8d-1762-4717-9a65-aeb435cb843e \
  --client rezics-importer \
  --auth https://auth.rezics.example
```

`--source` accepts `bangumi`, `vndb`, `openlibrary`, or `wikidata`. `--dump -` reads standard input for plain input only. `--compression none|gzip|zstd` defaults to `none`; gzip is admitted only for Open Library and Wikidata streamed dumps, zstd only for VNDB ustar archives and Wikidata streamed dumps, and neither is inferred from a filename suffix. zstd requires one descriptor-owned regular local file, not stdin, URLs, archive extraction or an external command string. `--zstd-executable` selects an absolute trusted zstd binary; otherwise the importer uses `/usr/bin/zstd` or `zstd` on PATH. Missing or incompatible zstd (needs `-d`, `-c`, `-M#` and `--no-pass-through`) fails before credentials, state or native work. `--decode-budget` is a positive decoded-byte ceiling for gzip, zstd or one complete dump set (shipped default 256 GiB for the whole capture). `--source-alias` selects a configured source identifier, and `--disappearance-threshold` accepts a number from 0 through 1. `--api` and `--auth` must be HTTPS origins with no path, query, fragment, or credentials. `--account-key` names the private JWK, `--account` is its account UUID, and `--client` is the registered first-party client ID. The CLI has no switch for weakening the origin rules. `--help` prints usage without reading the key, opening SQLite, or contacting Auth or the API. VNDB archives and Bangumi input reject gzip before credentials or state are opened. Bangumi and Open Library reject zstd at the same point.

### Open Library dump set

Open Library publishes author, work and edition dumps as separate files. `--dump-set` names one local JSON
manifest that lists those files as one complete capture for the configured source alias. It is mutually
exclusive with `--dump` and is accepted only for `--source openlibrary`. Version 1 remains family/path only
and means uncompressed members. Version 2 requires explicit per-member `compression: "none"|"gzip"` and is
the supported mixed-input format; unknown fields stay refused. `--compression` stays a single `--dump`
option. `--decode-budget` on a dump set is the whole-set decoded-byte ceiling (default 256 GiB), including
plain members, and is never multiplied by member count. The set is the entire alias generation, not a patch,
append, native-profile choice or disappearance override. Preview the same manifest with
`rezics-import preview --source openlibrary --dump-set` before ordinary import.

```json
{
  "version": 1,
  "source": "openlibrary",
  "members": [
    { "family": "author", "path": "ol_dump_authors.txt" },
    { "family": "work", "path": "ol_dump_works.txt" },
    { "family": "edition", "path": "ol_dump_editions.txt" }
  ]
}
```

```sh
bun services/importer/src/cli.ts --source openlibrary --dump-set /srv/imports/open-library/manifest.json \
  --state /var/lib/rezics/importer.sqlite --api https://api.rezics.example \
  --account-key /run/secrets/rezics-importer-account.jwk --account 6b147e8d-1762-4717-9a65-aeb435cb843e \
  --client rezics-importer --auth https://auth.rezics.example
```

The manifest may list at most 64 members and is at most 64 KiB. Paths are at most 4096 bytes. Relative
member paths resolve from the manifest directory. All three families must appear; an explicitly empty
member file is an empty family under the ordinary complete-input and disappearance rules. A member's
declared family must match decoded TSV framing. Author members are admitted for completeness and skipped
as catalogue records, matching the work/edition converter. Duplicate keys, family mismatch, missing
members, malformed late input and cancellation invalidate the whole capture. One generation, one seal
and one coordinator run cover every member. A local SHA-256 of consumed member bytes and per-member
lengths is a capture digest, not a source revision or licence.

```json
{
  "version": 2,
  "source": "openlibrary",
  "members": [
    { "family": "author", "path": "ol_dump_authors.txt.gz", "compression": "gzip" },
    { "family": "work", "path": "ol_dump_works.txt", "compression": "none" },
    { "family": "edition", "path": "ol_dump_editions.txt.gz", "compression": "gzip" }
  ]
}
```

Decision: dump-set admission keeps version-1 family/path manifests as uncompressed complete sets and
adds version 2 with explicit per-member none/gzip. Authors remain non-catalogue framing members.
`--decode-budget` on `--dump-set` is the aggregate decoded-byte ceiling. `--compression` remains
single-stream and is rejected with `--dump-set`. `--checkpoint-staging` and `--resume-staging` also
refuse `--dump-set`; a complete dump set remains ordinary acquisition. Preview and import share one
acquisition iterator; a completed preview plan reopens without member files.

Ordinary rerun of the same `--dump-set` command first resolves prior sealed work under existing
ready/finalizing recovery. Changing or deleting the manifest does not rewrite unknown native bodies.
Keep the same state path and current credentials. Explicit no-input resume remains the sealed dump-free
resume command.

Wikidata input accepts the decompressed native mixed Item/Property JSON dump directly, with one entity per
line inside its JSON array; existing item-only JSONL input also works. No item extraction or caller-side filter
is needed. The [official JSON dump guidance](<https://www.wikidata.org/w/index.php?title=Wikidata:Database_download&oldid=2479770906#JSON_dumps_(recommended)>)
documents this mixed format (verified 2026-10-30).

The reader admits `type: 'item'` with canonical `Q[1-9][0-9]*` identity and recognizes `type: 'property'` only
with canonical `P[1-9][0-9]*` identity. Either kind's `lastrevid`, when present, must be a positive safe integer.
Properties pass the same bounded JSON, byte and array-framing validation, then are excluded before conversion
and source staging. They create no subjects, commands, schema definitions, source membership or `sourceRecords`
metadata and do not increment `skipped`. Unknown types, mismatched identities and malformed native revisions
invalidate the entire acquisition before effects or baseline replacement. Lexemes, EntitySchemas and user/talk
content remain unsupported. Properties do not count toward item survival: a replacement containing only
Properties still triggers the existing mass-disappearance guard when prior items all vanish.

Yielded Wikidata items use the registered `wikidata-5` converter, the shipped catalogue vocabulary and the reviewed
[conversion-local dish/food bindings](../../packages/conversion/README.md#source-mappings-and-limits). The public
pure converter remains item-only. Supported
names, dates, URLs and unresolved author statements retain their source references, supported qualifiers and
ranks through editor acceptance/adoption and public reads. A refresh creates new cited proposals under the
same returned subject identity; it preserves independent Context selections. Exact quantities with unsupported,
unresolved or narrowed qualifiers are withheld as whole measurements, including after durable staging.
The source registry reads the converter's exported `converter_revision`; changed
records follow the ordinary revision-change path, with mass-disappearance protection
unchanged. Dishes bootstrap as Recipe, food and food ingredients as Food, with CC0
labels/descriptions and cited P186 material relations after binding. Dish takes
precedence over food; other mapped-type conflicts are refused. Instruction text and
P18/Commons images are excluded and create no assets.
Unknown-language text and unknown-licensed prose/images confer no import authority. Keep the same state path
for unchanged refresh and interrupted work: reopen checks current tuple fences before delivering pending facts.
The [connected native journey](../kernel/test/imports/wikidata-rich-cli.test.ts) and its
[evidence notes](../../docs/research/imports-audit/wikidata-rich-cli.md) cover this operator flow.

The account key must be a regular private-JWK file readable only by its owner (for example, mode `0600` or `0400`); symlinks, non-files, and group- or world-accessible files are refused before network access. Dump paths must also open as regular files. Both file opens use nonblocking acquisition followed by descriptor-based regular-file checks, so FIFO paths are rejected without waiting for a writer, reading content, opening SQLite, or contacting Auth or the API; key opens retain symlink protection and the existing mode and 16 KiB limits. The focused [FIFO subprocess cases](tests/cli-special-files.test.ts) exercise the actual CLI with no writer for dump and key paths, checking exit 2, closed handles and no state or network effects. Their child deadline is a liveness guard, not a performance claim; admitted regular-file byte bounds and the existing native CLI receipts remain separate evidence. The importer keeps the bearer only in memory, renews it 60 seconds before expiry, and renews and replays once after an API 401. Bangumi, Open Library, and Wikidata request six registered scopes. VNDB requests those six plus `source_statistic:write` and `subject:read` for its aggregate rating and observation head. The account needs the fixed Global Context grants `subject:create`, `subject:batch_write`, `source_fence:read`, and `media:import_from_url`; a VNDB account also needs `source_statistic:write` and `subject:read`. Platform staff put the importer actor on the `service` tier once through `setRateTier`, before the first large import. The VNDB token must carry `subject:create`, `subject:batch_write`, `source_statistic:write`, `subject:read`, `statement:propose`, `source_fence:read`, `media:import_from_url`, and `media:read_reservation`; other sources omit `source_statistic:write`. VNDB `subject:read` is required to GET the current observation head. `statement:propose` comes from the standing grant every active account has, and `media:read_reservation` lets the importer read the status of media it imported. Provision the account, client, key, grants, and tier outside the CLI.

Official Open Library and Wikidata gzip dumps are admitted with `--compression gzip` on the original regular file. The importer streams owned compressed windows through member-framed `createInflateRaw` (RFC 1952 header/trailer, CRC/ISIZE) into the existing dump decoder. Decision: concatenated members, including an empty last member, are one complete input; this runtime's `createGunzip` concatenates members but reports trailing garbage as the same incorrect-header error as a non-gzip first byte and drops a decoded prefix when a complete member shares one write with trailing bytes. Non-gzip bytes after a member trailer fail the capture. Gzip header mtime, extra fields, filename and compression level never enter record identity. A decoded early record followed by a bad trailer still invalidates the capture. The decoded-byte budget is a zip-bomb ceiling (default 256 GiB, one transform-window overshoot counted), not permission to relax record or journal caps. Compressed and decoded byte counts are reported separately through `--progress` when present.

Official VNDB `tar.zst` archives and Wikidata zstd dumps are admitted with `--compression zstd` on the original regular file. Install a trusted zstd 1.5.x (this environment has `/usr/bin/zstd` v1.5.7) that exposes `-d`, `-c`, `-M#` and `--no-pass-through`. The importer selects that executable once through `--zstd-executable` or the documented lookup (`/usr/bin/zstd`, then `zstd` on PATH), then spawns it as a direct child with those fixed arguments and pumps descriptor-owned chunks to its stdin. Manifests and source bytes cannot supply the executable path or arguments. Decision: concatenated zstd frames, including an empty last frame, and skippable frames are one complete input, matching the installed tool; raw passthrough and non-zstd trailing bytes fail. Decoder memory is `-M128MB` (128 MiB window; `--long=27` dumps are admitted, larger windows fail). Capture, preview-plan completion and publication wait for input-pump EOF, parser completion and child exit 0 together. An early decoded prefix with a later corrupt, truncated, checksum-failing or nonzero-exit frame invalidates the unsealed capture and leaves the last completed baseline and immutable requests unchanged. Compression metadata is not a record revision or licence. Resume native application through the ordinary sealed command (API62); do not decompress a replacement file as authority to reseal it.

```sh
bun services/importer/src/cli.ts --source wikidata --dump /srv/imports/wikidata.json.gz --compression gzip --state /var/lib/rezics/importer.sqlite --api https://api.rezics.example --account-key /run/secrets/rezics-importer-account.jwk --account 6b147e8d-1762-4717-9a65-aeb435cb843e --client rezics-importer --auth https://auth.rezics.example
bun services/importer/src/cli.ts --source wikidata --dump /srv/imports/wikidata.json.zst --compression zstd --state /var/lib/rezics/importer.sqlite --api https://api.rezics.example --account-key /run/secrets/rezics-importer-account.jwk --account 6b147e8d-1762-4717-9a65-aeb435cb843e --client rezics-importer --auth https://auth.rezics.example
bun services/importer/src/cli.ts --source vndb --dump /srv/imports/vndb-db.tar.zst --compression zstd --state /var/lib/rezics/importer.sqlite --api https://api.rezics.example --account-key /run/secrets/rezics-importer-account.jwk --account 6b147e8d-1762-4717-9a65-aeb435cb843e --client rezics-importer --auth https://auth.rezics.example
```

VNDB table paths are validated by the importer; do not extract an untrusted archive to the filesystem. Use fixed operator-controlled paths and literal command arguments, without shell interpolation. Bangumi, Open Library, and Wikidata input is their native framed text format. Native record revisions are retained when present; unversioned records remain unversioned.

For the pinned VNDB dump, `c_average` and `c_votecount` replace the VNDB source statistic on each visual novel through `PUT /v1/subjects/{subjectId}/source-statistics/vndb`. The mean is `c_average / 100` on a 1 to 10 scale, as of the dump date, under ODbL-1.0 with attribution `VNDB`. A statistic-only refresh can retain the same native entry revision and every semantic candidate. The completed input snapshot advances only after the required statistic write is acknowledged and bounded reconciliation retains every proposal; a failed or uncertain write leaves the prior completed baseline intact. The Bayesian `c_rating` is omitted, and no source statistic creates native votes. Bangumi's `score`, `score_details` and `rank` remain omitted because its licence covers entry information and not ratings.

Before publishing a source statistic, the importer checks its already obtained current facts omission for the
exact configured source and external ID, including previously bound VNDB records. A facts fence suppresses that
statistic write; metadata still completes through ordinary omission/reconciliation without acknowledging a
statistic effect. Cover and summary groups remain independent. Every refresh reads current fences before the
unchanged shortcut, and prepared bulk dispatch retains its late fence check. This is a client publication guard:
the exact clear operation and final disclosure remain owned by Content. Positive publication stays suppressed;
exact zero-vote removal may still run behind the facts fence.
The frozen [caller test](tests/source-statistic-fence.test.ts) binds first, then fences changed and unchanged
refreshes through the production importer and source registration with a fake external transport.
[Source-statistic tests](tests/source-statistics.test.ts) retain public-route, acknowledgement and retry coverage.

Explicit sanitized VNDB `c_votecount: 0` with its admitted paired `c_average` produces an exact removal
intent, including `0/null` and `0/0`. The ordinary seven-scope CLI calls the installed
`rating.source_statistic_clear` operation, `POST /v1/subjects/{id}/source-statistics/vndb:clear`,
with strict `{sourceRecordId, count: 0, asOf}` and expects 204 with ordinary session continuity.
Default `vndb` calls omit `sourceAlias` and retain their existing bytes. A configured VNDB feed alias sends its
exact registration alias on both positive PUT and clear POST, while provider `vndb` and native record `v123`
remain unchanged. Facts/claim/read-fence identity follows that alias. The single subject/provider score slot
is unchanged: removal matches its current subject/provider/record/alias association; absent or mismatched
bindings leave another association intact. Canonical `vndb` fencing does not govern a custom alias.
Clear uses the existing bounded write coordinator, keyed POST retry budget and run-derived identity;
reopening a sealed run reuses the original bytes/key before reading replacement source records. The native archive admission gate still validates a supplied
archive first; it cannot replace the sealed projection or its clear command. An uncertain or denied clear
preserves the previous complete baseline.
Both missing fields mean UNKNOWN and send no statistic request; a partial pair remains invalid. A positive
count with unavailable mean also sends no statistic request. No mean, vote, mapping or revision is invented.
For the same native/converter revision, the statistic-refresh completion proof requires an existing
acknowledged VNDB record and exhaustive retention of every semantic candidate/proposal, including when the
source-specific statistic omission requires no request. It advances only the input projection, without a
fabricated receipt or changes to old semantic requests/receipts. Beyond the reviewed binding above, general metadata acknowledgement remains deferred.

The supplemental [alias journey](../kernel/test/imports/vndb-statistic-alias.test.ts) reuses the same fixture
for ordinary alias PUT/clear, exact facts fencing and stale-association preservation.
The frozen [zero-refresh journey](../kernel/test/imports/vndb-zero-refresh.test.ts) now has an adjacent genuine
native CLI fixture. It uses pinned headers/COPY archive input, real account-key credential effects, public
clear/read/receipt/event observation, same-state response-loss recovery and current grant denial. UNKNOWN
is explicitly a registered-source/coordinator branch in the same imports world, since the pinned archive
cannot omit those columns. The existing native figure fixture supplies a separate real vote/worker control.
The caller also preserves an independent imported tuple/subject, semantic candidate IDs and full old receipts.
This implementation has no native execution receipt yet: native acceptance is reserved for integration by
the current verification instruction. Local verification commands/results and tested revision are recorded
in the capability manifest; they do not claim native acceptance or promotion.

The native archive binding and real account-key CLI caller are exercised by
`services/kernel/test/imports/vndb-statistics-outcomes.test.ts` and `vndb-cli-native.test.ts`.
They use synthetic COPY rows with the pinned headers, retain the native revision and statistic fields,
and observe public responses and exact native receipt/event anchors. The binding keeps its importer SQLite
file across close/reopen in the same native server and Auth world. Its reported source baseline uses
RunStore's maintained complete-generation pointer and present count; it is distinct from an entry revision
and from a statistic transaction. See the [verification record](../../docs/research/imports-audit/vndb-statistics-native-verification.md)
for check results and limits. Native acceptance `3641609f-917a-40df-b98e-c5f3603a4311`
passed the unchanged six cases (91 assertions), the CLI caller (249 assertions) and its wrapper;
local focused regressions and the importer compiler also passed. The native CLI observed two
statistic receipts/events, ten unchanged bulk receipts and zero native votes through refresh/retry/revocation.
This six-case binding is separate from the fourteen-case table/growth port.

Keep the same SQLite state path when resuming. Prepared writes and receipts are durable, and a retry reuses their original command keys and request bodies. Do not replace or clear the state file after an interrupted or uncertain request. Exit codes are 0 for committed/help, 2 for invalid input, 3 for mass disappearance, 4 for authorization denial, 5 for a busy source, and 130 for interruption; other unresolved import failures exit 1. Diagnostics contain only bounded maintained counters. Operator interruption aborts this invocation’s actual account-key Auth requests and body reads as well as API work. CLI cleanup ends its credential-provider lifetime; cancellation prevents a successor token exchange or later bearer publication without cancelling other invocations. Aborted, oversized or failed Auth body consumption cancels the owned reader without waiting for an untrusted cancellation hook; the existing 120-second request deadline and 1 MiB response ceiling still apply.

To rotate an operator key while a run is pending, provision and approve the new key for the same account and
client before retiring the old key through Auth's credential-effect lifecycle. Replace the private JWK at the
existing owner-only key-file path, then invoke the same command with the same SQLite state. Each CLI invocation
loads its account key afresh; a live invocation retains the key it already imported. Keep the ordinary six scopes
(plus the existing VNDB statistic scope only for VNDB). Grant restoration and key retirement are separate operations:
current grants govern receipt replay, and retiring a key prevents new sign-ins with that key without claiming
revocation of already-issued bearer tokens.

The frozen [native key-rotation journey](../kernel/test/imports/cli-key-rotation.test.ts) connects the ordinary CLI
to native Auth, Access, public commands and the registered media worker. It loses a real committed response,
denies exact original-bearer replay after ordinary grant revocation, retires the old key, and resumes the durable
run with its original bytes and command keys. The [evidence record](../../docs/research/imports-audit/cli-key-rotation.md)
describes its observations and limits. The local credential test supplies only the file/crypto preflight.

A complete source reduction exceeding the default 20% disappearance threshold exits 3 before public effects and
retains the last completed baseline. After reviewing the supplied input, invoke the same CLI with the same state
and input and an explicit existing `--disappearance-threshold` value (for example, `0.5` admits losing two of five
records). The stopped acquisition is terminal, so the next invocation acquires and validates the supplied input
again; it does not resume an unapproved removal plan. Losing every prior record still stops at threshold `1`.
Malformed framing, truncated JSON and input-read failure exit 2 before effects, regardless of threshold. A clean
EOF on valid JSONL cannot detect upstream omission of complete records; the disappearance guard still applies.

Stopped diagnostics report reconciliation outcomes, all zero when sealing stopped before classification. They
do not estimate new/changed/unchanged/vanished counts by scanning the baseline. RunStore separately maintains
prior, supplied and surviving-member counts for seal admission. An admitted three-of-five unchanged successor
reports `unchanged=3 vanished=2`, and reopening that input reports `unchanged=3 vanished=0`. Source removal
retracts only the missing records' owned candidates. Native subject identities, other Contexts' selections,
independent facts and immutable bootstrap requests/receipts survive. Receipt replay uses current authorization;
a revoked grant denies even an original bearer carrying a previously successful request.

The [native CLI journey](../kernel/test/imports/disappearance-cli-native.test.ts) exercises this connected flow
with five synthetic Bangumi metadata records, an approved account key, real Auth/Access and public editor
acceptance/adoption. It observes exact durable baseline anchors, native removal proposals, original receipt bodies,
authorized byte-identical replay and revoked-grant denial. It covers one controlled source reduction, with no
external assets, provider matrix or new throughput claim.

The [bounded reappearance journey](../kernel/test/imports/cli-source-reappearance.test.ts) binds the ordinary
account-key CLI to the native application for all four launch sources in one Auth/Access/worker world. Each feed
has five synthetic metadata records: removing one reaches the default 20% boundary, and returning its changed
title must reuse the original exact tuple claim and bootstrap receipt while appending proposals with the changed
revision/digest. A second removal followed by a public facts fence must suppress both the next return and old
receipt/candidate disclosure. Independent editor selections and every other source's claims and receipts survive;
unchanged reopen sends no public writes. VNDB uses a tar archive of native COPY tables, not scalar JSON.
Run `bun run --cwd services/kernel check test/imports/cli-source-reappearance.test.ts` through the managed worker
check. The selected native case passed at `669e18e5bff87837e8368e7c0ea9f562cb2f3188` with 3,443 assertions;
[evidence and limits](../../docs/research/imports-audit/cli-source-reappearance.md) record its managed log,
source/converter revisions and receipt anchors. Local protocol proof and broader imports promotion remain
separate. This adds no sourceRecords migration, asset, summary, discovery or new PostgreSQL growth claim.

The remaining launch operators share the [reviewed native reduction journey](../kernel/test/imports/cli-reviewed-source-reduction.test.ts):
five synthetic VNDB ustar/COPY records, Open Library five-column TSV works and Wikidata JSONL books coexist
in one native application/Auth world and one state file. Each operator supplies three unchanged records,
sees the default guard stop, explicitly reviews the same input with `--disappearance-threshold 0.5`, and
reopens without writes. Only the two missing records' retrieved owned candidate IDs are retracted through
ordinary batch commands. Public candidate/retraction reads, independent accepted/adopted facts, communal
subjects, exact bootstrap journals and receipt point reads establish preservation. Loss of all three remaining
records still stops at threshold `1`. The exact original successful retraction request is denied after native
Global bulk-grant revocation, including when replayed with its original bearer. Only that ordinary grant is
restored between source legs. VNDB uses the existing statistic foundation and seventh scope; the other
operators retain six scopes. Acquisition reaches EOF and seals before any request, and each CLI invocation
closes its handles. See the [evidence and limits](../../docs/research/imports-audit/cli-reviewed-source-reduction.md).

A completely consumed VNDB archive containing the six valid headers/table members with no data rows reaches
the same total-loss guard when that source has a completed nonempty baseline. Header validation remains with
the native table reader; fresh empty catalogues and malformed archives remain refused before effects.

Limits follow the exports in `src/dumps-bytes.ts`, `src/vndb-tables.ts`, `src/import-fetch.ts`, and `src/import-client.ts`: dump chunks default to 256 KiB (1 MiB maximum), records default to 256 KiB (1 MiB maximum), VNDB archives default to 16 GiB and 512 entries (64 GiB and 2,048 entries maximum), and VNDB source pages contain at most 16 records. HTTP request bodies are capped at 2 MiB, public batch bodies at 64 KiB, responses at 1 MiB, and scheduled HTTP retry waits at 30 seconds per attempt and 60 seconds total with a 120-second request deadline. Each HTTP transport invocation defaults to three counted attempts and permits at most five, plus its existing one-time 401 renewal. Alongside ordinary GET/HEAD and eligible POST retries, the exact `/v1/subjects/{UUID}/source-statistics/vndb` PUT retries only with a valid quoted structured-field `Idempotency-Key`. Other PUT routes and missing or malformed keys remain ineligible. Retried requests preserve their original bytes, headers and bearer except for the existing explicit 401 renewal rule; all attempt, wait, body and deadline ceilings remain unchanged. Cover resolution handles at most 64 assets per record, with one POST and one status GET per invocation and no inline polling wait.

Record write width starts at `recordConcurrency` (default 16). After a final transport `429` or a `503` problem with `retryable: true`, an admitted continuation halves the width, rounding down to at least one. The failed write goes to the front of the queue with the same envelope and command keys; its record resumes at that write, preserving completed planning, bootstrap and cover resolution. Nothing new starts while active records meet or exceed the width. Each successful write adds one slot up to the configured concurrency. A write started alone at width one that still overloads fails as before; older requests from a wider cohort can requeue while it drains. Other failures retain their existing behaviour. Width persists across pages and phases within a run and resets for the next run.

Admission and retry accounting are separate controls. Each invocation of the coordinator's Write callback is one logical write with at most **eight transport invocations**, including the initial call. Eight is a local platform policy, not a standard's retry count: it permits more than the six width reductions from maximum K=64 while bounding a failing write independently of successful neighbors. Success, width recovery and requeue never refill this allowance. Exhaustion retains durable unresolved work, leaves the record unacknowledged and produces the existing `bulk-failed` outcome. An isolated width-one overload can stop sooner. A later explicit durable resume gets a new allowance; this is no lifetime cap across operator reruns.

For eligible 429 and retryable 503 responses, integer-seconds and HTTP-date Retry-After hints follow [RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3). The bounded adapter carries a sanitized not-before time, its original invocation deadline and any retry-refusal reason through ImportTransportError. A queued continuation waits until that time using the injected clock/sleep and cannot reopen a refused wait or deadline budget. A hint that cannot fit the 30-second per-wait, 60-second total scheduled wait or original invocation deadline stops the write without truncation or an early new invocation. Missing/malformed hints retain fallback behavior; other status classifications are unchanged.

This adopts the [bulk backpressure research](../../docs/research/importer-bulk-backpressure.md): prospective concurrency admission from [Netflix's limiter](https://github.com/Netflix/concurrency-limits/blob/78a74b9878d38c4c048b0304ce12a162ab7b7222/concurrency-limits-core/src/main/java/com/netflix/concurrency/limits/limiter/SimpleLimiter.java), finite per-invocation accounting from [Smithy's retry strategy](https://github.com/smithy-lang/smithy-typescript/blob/cb3a25c37bc9455ccb116fe722c544adac981690/packages/core/src/submodules/retry/util-retry/StandardRetryStrategy.ts), and retained serialized work from the [Elastic bulk helper](https://github.com/elastic/elasticsearch-js/blob/acf9711ba7f55064ac70dbe1439b931501ccc7d2/src/helpers.ts#L581). No reference implementation is copied. Per-HTTP attempt/wait/deadline caps remain distinct from the eight-call logical-write allowance. With transport maxAttempts A, physical sends per logical write are at most 8*(A+1), including 401 renewal. Unlimited whole inputs and operator reruns have no aggregate bound; arbitrary injected transports/providers that never settle have no overall wall-clock bound.

`tests/write-width.test.ts` verifies this behaviour in `contention answered with retryable 503 narrows the write width and every record lands once`, `a single writer that still gets retryable 503 fails the run as before`, and `width grows back to the configured concurrency after successful writes`.

The ordinary account-key caller is connected to native Auth, Access, the public write-rate limiter and the
registered media worker in
[`cli-native-backpressure.test.ts`](../kernel/test/imports/cli-native-backpressure.test.ts).
Seventeen supplied synthetic Bangumi records cross multiple public envelopes. One invocation recovers from real
429 responses; competing authorized receipt replays then keep one refreshed record refused while independent
records succeed. Exhaustion retains the completed source baseline and exact pending envelopes. After actual
admission recovery, a fresh same-state CLI drains those envelopes with their original keys, preserving bootstrap
and media evidence, original native receipts and an independent editor's accepted selection.

`runImportCli` accepts optional `stdin`, `fetch`, `signal`, `clock`, `observer` and `createImporter` boundaries.
The clock supplies both transport and coordinator retry timing. A construction observer can wrap transport
calls and return the real `createImporter(options)`; it must retain the options object, since the CLI attaches
its session-backed media resolver after construction. This boundary adds no command-line configuration or
alternative writer. The [verification note](../../docs/research/imports-audit/cli-native-backpressure.md) describes
the captured evidence and its limits; local protocol tests alone do not establish this native journey.

## Explicit local batch of independent source imports

Catalogue operators can preview and deliberately run a bounded local JSON manifest of independent launch-source
jobs instead of assembling separate invocations. This is a product command, not a Goal-controller scheduler.

```sh
bun services/importer/src/cli.ts batch --manifest /srv/imports/launch.json --json
bun services/importer/src/cli.ts batch --manifest /srv/imports/launch.json --run \
  --api https://api.rezics.example --account-key /run/secrets/rezics-importer-account.jwk \
  --account 6b147e8d-1762-4717-9a65-aeb435cb843e --client rezics-importer --auth https://auth.rezics.example \
  --progress jsonl --json
```

The manifest is version `1`, at most 16 jobs and 64 KiB. Each job names one of `bangumi`, `vndb`, `openlibrary` or
`wikidata`, an exact configured `--source-alias` when used, a local complete dump path and an existing ordinary
state path. Relative paths resolve against the manifest directory under the existing regular-file, no-follow
descriptor policy. Credentials, API origins and account keys stay on the invocation; they are never embedded in
the manifest or report. Default invocation parses, validates and displays ordered aliases and input modes. It does
not acquire credentials, open state for mutation, decode dumps or send network requests. `--run` is the only
execution switch; there is no hidden approval loop or cached plan token.

Successful preflight is local shape and path validation. It does not prove dump integrity, current authority or
that every job will succeed. Preflight refuses unknown fields, stdin, URLs, environment interpolation, include
files, globs, duplicate configured sources, and two path spellings of the same state file for one source. Shared
SQLite is allowed only for distinct aliases under existing ownership rules. Jobs are not merged because names
resemble each other. Decision: Open Library dump-set manifests remain one job's complete `--dump` input; batch
jobs cannot declare `dumpSet` because the ordinary single-source CLI has not delivered that flag.

`--run` revalidates every ordinary input at each job, then calls the exported single-source CLI serially in
manifest order. At most one importer, input and state owner is active. Handles close before the next job.
Progress keeps the existing stderr protocol with a bounded job index/name context; underlying source/run IDs and
invocation identity stay intact. JSON output lists at most 16 summaries, the actual stopping job and explicit
not-started jobs. Human output keeps a concise final result on stdout. Native errors are never rewritten as
success. Single-source stdout contracts are unchanged.

Any non-success, cancellation, uncertain delivery, disappearance, incompatible input or observation-conflict
exit 6 stops before the next job. Completed jobs stay completed. Later jobs are not started, not labelled failed
and not rolled back. SIGINT or SIGTERM before a job begins starts no new coordinator. There is no
continue-on-error, hidden retry, force disappearance, automatic CAS resolution or parallel worker. A dump replacement or a different state inode between local preview and execution is refused rather
than followed. Ordinary writes by an earlier job into a shared SQLite file are not a replacement.

Rerunning the manifest uses ordinary per-source journals only. The report cannot resume a request, skip a job
from an old summary or mint new keys for unresolved work. A stopped or uncertain job prints the established
ordinary importer command, and observation conflicts also point at `rezics-import observations`, without
executing either automatically.

```json
{
  "version": 1,
  "jobs": [
    { "source": "bangumi", "dump": "bangumi.jsonl", "state": "importer.sqlite" },
    {
      "source": "openlibrary",
      "sourceAlias": "catalogue-ol",
      "dump": "works.tsv",
      "state": "importer.sqlite",
      "compression": "none"
    }
  ]
}
```

## Known own references

Imports owns the default handoff of successful local claims to conversion, including ordinary
[`createSourceRegistration`](src/source-registry.ts), [`Importer`](src/importer.ts) and
[CLI](src/cli.ts) construction without an injected identifier provider. A later Open Library
edition must receive the real work subject ID already learned from successful public
create-or-resolve for the exact same configured source alias and native work key. The
completed response and its durable own binding are identity evidence. Never allocate or
guess a UUID, infer across aliases, look up a source label, or search global claims.
The configured alias is authoritative even when it differs from the native registration's
alias; an identical native key under another alias supplies no evidence.

This is bounded own-claim resolution within the current session's durable bindings. The
existing [`resolvedReferences` context](../../packages/conversion/README.md#package-api)
passes actual native-key bindings to the pure converter. Conversion remains caller-resolution
capable; this default producer obligation belongs to the importer and requires no conversion
API change. The ordinary default path point-reads up to the converter's 64 supplied author/work
keys through `RecordBindings.claim`. An explicitly injected identifier provider retains its
existing interface and output and takes precedence over this local handoff. No new author source
adapter or global resolver is implied.
An unknown author retains its native external identifier and citation, using `somevalue`
only where the adopted property permits it, including the Open Library author relation.

An acknowledged edition whose bounded work dependency becomes known must be reconsidered
when the unchanged source input is reimported. Learning may refresh it in that complete dump
or on the next identical import; by the latter, its relation must use the actual work ID. A
bounded signature of exact own-reference outcomes is committed with the resolved run entry,
so a later unchanged pass revisits only when one of those outcomes changes. The lookup is
linear in at most 64 supplied relation keys and uses indexed exact-key point reads; it does not
enumerate stored history. One signature row is retained per acknowledged Open Library record.
Equality of the source row alone cannot justify skipping that dependency check. The resolved
semantic body produces a distinct proposal command key and candidate while native revision,
data-only source digest and converter revision remain intact. Immutable bootstrap command
bytes, their key and receipt never change. Recovery replays previously prepared requests
exactly; changed dependency planning must not rewrite uncertain or acknowledged envelopes.

Old unresolved candidates and their revisions/history remain readable. Source reconciliation
may retract its own candidate through the ordinary API but must not commandeer another
Context's adoption. The community's prior selection remains until its editor independently
accepts and adopts the resolved candidate. Once actual resolution is unchanged, further
identical runs create neither duplicates nor replay conflicts. Cached IDs and receipts are
not permission grants: native target admission and disclosure still check current
authorization, including on replay and after grant revocation.

The ordinary default `Importer` now supplies this handoff without an injected identifier
provider. It point-reads the configured alias and native relation keys through
[`RecordBindings.claim`](src/record-bindings.ts). The existing
`run_reference_signatures(source,record_key)` table stores one bounded signature per
acknowledged record; an unchanged record is replanned only when the exact own-reference
outcomes change. Prepared bootstrap bytes, keys and receipts remain immutable across reopen.
During a dependency refresh, proposals whose producing converter revision and complete semantic statement
are unchanged are retained, while changed relation bodies are proposed with new keys. This avoids duplicate
candidate effects for unrelated fields such as an unchanged unknown author.

A trusted converter revision change reconciles every unfenced field even when its semantic values match.
The bounded current owned-candidate comparison reads the producing revision from each immutable saved proposal;
an old revision cannot supply provenance for the new converter. A transition from the acknowledged converter
also refreshes candidates from an earlier matching revision left behind a fence; only already acknowledged
proposals from the current run can be retained during that transition. Ordinary retractions and fresh proposals use
stable run-specific operation keys while preserving the source digest, native revision, bound subject and prior
request/receipt bytes. Exact source/record/field fences are checked before the unchanged shortcut and again at
dispatch. Same-run recovery can retain candidates already acknowledged from the current converter. VNDB's
statistic-only completion still requires a successful statistic write and exhaustive semantic retention; it
cannot stand in for new-converter proposals. See the [focused verification record](../../docs/research/imports-audit/revision-fence-refresh.md).

### Refresh source-only provenance

A changed admitted source field requires fresh cited proposals even when its catalogue values remain equal.
For example, changing only an unversioned Bangumi Book's native date changes the source digest, while the
unchanged `bangumi@3` converter still emits only its name and external identifier. The importer retracts its
old owned candidates and publishes those equal facts with the actual new digest, using the same native subject
and claim. It preserves bootstrap bytes, old requests/receipts and independently selected editor candidates.
It does not infer `schema:datePublished`. Current facts fences suppress publication; unchanged successors send
no public writes. Keep the same state path for recovery and immutable-plan replay.

Semantic retention requires matching source digests as well as converter revision, subject, group and complete
statement. A candidate acknowledged by the current immutable run remains eligible during recovery. The explicit
confirmed VNDB statistic-only exception still requires exhaustive semantic retention and its acknowledged
statistic effect; it does not become a generic source-metadata acknowledgement.

The frozen [local caller](tests/source-only-provenance-refresh.test.ts), focused
[partial-receipt/reopen caller](tests/source-provenance-recovery.test.ts), and
[native ordinary CLI journey](../kernel/test/imports/source-only-provenance-refresh.test.ts) bind this outcome.
The single managed native acceptance passed with exit status 0 at
`d1f050321ebc4f50af830ac4ef5cf14041d85303`; the frozen caller proves changed source provenance,
immutable native anchors, independent selection, unchanged no writes and current facts fencing.
[Evidence and limits](../../docs/research/imports-audit/source-only-provenance-refresh.md) record the supplied
receipt and the three unchanged importer safety-test compiler diagnostics. This scoped pass adds no growth,
main integration or promotion claim.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/source-only-provenance-refresh.test.ts
```

### Reconcile a new converter revision with current fences

- Touches: the bounded current owned candidates and their immutable proposal source fields, exact run/member/acknowledgement keys and ordinary public bulk commands.
- Bound: at most 300 current candidates per record, 100 commands and 65,536 bytes per envelope; existing O((1+q) log R) writes and O(q) retained data at the existing q caps. The revision comparison adds no SQL, history scan, source pass or privilege; existing proposal matching work is unchanged.
- Growth check: existing local/canonical PostgreSQL/derived units and bounds remain unchanged. Focused refresh acceptance proves proposal provenance and fences, not new growth measurements; native growth remains with the shared producer's full acceptance.

The frozen [native cases](../kernel/test/imports/known-reference-refresh.test.ts) cover the
default handoff and unchanged dependency refresh. Original implementation locator:
`0b648d744b3ed6f34bf435866606c102d1b0707d`. The installed combined observation correction
preserves proposal property objects and requires the native read datatype only on native
responses; a busy partition relay consumes one of the same 16 calls and is never readiness.
Its installed SHA-256 is
`f46b81a106c65ed6a37732845c89c94c239affa69105ba47d67fc2d94584dc89`, matching the approved raw
file, canonical worker bytes and read-only frozen registry. The latest authorized amendment
factors the existing property conditional into a local binding before the same generic matcher;
the compared objects and business assertions are unchanged. The preceding root typecheck failed
with frozen-helper TS2353 before native execution. Current-tree root typecheck passed all 13 workspaces on
`39e12edb2885ffd974fa849f9de53b0fa3d21ab1` (check `95993fff-f007-4bce-830a-78972966d876`).
Focused native acceptance then passed on `2f7e1cc68802bb34d6906dfb0dbb1000669002fa`
(check `1e7682fe-3eb8-4f38-93d9-a9207c83bab2`): 2 cases, 135 assertions. Both known-claim and
late-learning flows reached real target-addressed candidate acceptance/adoption and stable replay.
Late learning preserved old unresolved history and independent community adoption; revoked-grant
replay returned 403.
The unknown author retained its external identifier and exact native read datatype. This proves
the two bounded default Open Library flows, with no new full-imports or growth claim.
All three adjacent recovery files passed (11 cases, 158 assertions), with the extra recovery file
run separately after a filename correction. The local reopen regression passed (2 cases,
16 assertions); runtime, storage and local regression bytes remain unchanged, so those qualified
results are reused.
See the [verification report](../../docs/research/imports-audit/own-reference-refresh-verification.md)
for revisions, receipts, reached transitions and evidence limits.

### Own-reference refresh cost

- Touches: read at most 64 author/work relation keys from the bounded Open Library projection, with one indexed `RecordBindings.claim` point read per supplied key; compare and persist one signature for the record. A changed signature runs ordinary bounded candidate reconciliation. Existing journals and receipts are read only by their exact owner/key.
- Bound: O(M + F log B) per supplied record for M projection bytes, F ≤ 64 native relation keys and B stored binding rows, plus existing bounded planning and writes. Reconciliation additionally compares at most C × Q full statements, C ≤ 300 current owned candidates and Q ≤ 100 Open Library proposals, each under the existing bounded statement/envelope bytes. This adds local comparison work, not a history scan or server query. Durable dependency metadata is O(1) per record; source record admission retains its existing byte and field caps. No claim/history enumeration or source-wide dependency sweep is used.
- Growth check: `services/importer/tests/own-reference-refresh.test.ts` previously passed exact-alias point reads and the default reopen/late-learning/stable-replay path (2 cases, 16 assertions). Native evidence and its limits are recorded in the verification report. No new native growth measurement or PostgreSQL count is claimed.

The exact native command is:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/known-reference-refresh.test.ts
```

### Independent named feeds

The [Open Library edition and cover CLI journey](../kernel/test/imports/openlibrary-cli-edition-media.test.ts)
connects a five-column work/edition TSV to account-key Auth, the real coordinator, ordinary
editor selection and public reads. The same edition bytes initially retain unresolved
author/work citations, then resolve only the exact work claim learned within their configured
source. Separate source cover IDs reach registered media jobs with independent unknown-rights
credits; `-1` never becomes a media request. A cover tuple fence survives close/reopen without
changing native entry identity/revision or immutable bootstrap/media requests. Unknown-licensed
prose never becomes a proposal or public summary. See the
[evidence record](../../docs/research/imports-audit/openlibrary-cli-edition-media.md)
for fixture framing, observation boundaries and verification limits.

Two configured aliases for Open Library share a provider and its bibliographic CC0-1.0
permission, but share no native claims, dependency evidence, request journals, baseline or
run ownership. Alias spelling supplies neither licensing evidence nor another provider.
An edition under `books-b` remains unresolved when only `books-a` knows its work key;
after B learns its own actual work claim, an unchanged import can propose the resolved
relation without rewriting the bootstrap bytes, key or receipt. Existing unresolved
history and independent editor selections remain intact.

Disappearance has no normalized source projection. It bypasses own-reference resolution
and reconciles only the vanished record's exact-source candidates. Refresh and tuple-fence
checks still use the selected alias. A live `ImportSession` ownership handle makes another
CLI invocation for that alias busy before source acquisition or public writes, while a
different alias can proceed in the same SQLite file. Releasing the handle permits normal
reopen with the original identities; ownership and timeout rules are unchanged.

[`named-feed-cli-native.test.ts`](../kernel/test/imports/named-feed-cli-native.test.ts)
exercises this connected journey through the production CLI, staged/approved/applied account
key, native Auth/Access/kernel and worker. Its two controlled native TSV feeds share one
tmpfs SQLite file. It records exact serialized requests, actual claims and receipts, baseline
fingerprints/counts and public responses using the original CLI bearer. Editor selection
and governance fences use public commands. The adjacent own-reference regression covers
disappearance without a source projection. These cases add no source-record catch-up,
provenance backfill, global resolution or PostgreSQL growth claim.

Cost: inspect supplied feed bytes, exact alias/native-key journal rows and at most the
existing 64 own-reference keys, plus existing bounded public writes and tuple-fence reads.
Current alias point/keyset reads and source ownership retain their existing caps; no
other-source, catalogue or history enumeration is added.

### Changed-dependency cost obligation

For one supplied record, let F be its admitted native reference-key count, bounded by the
supplied record-byte and field caps, B the stored binding rows, and M its bounded source
and semantic-body bytes. Examine only those F keys with exact `(configured source alias,
native key)` local point reads and bounded per-record dependency metadata. Required work
is O(M + F log B) for resolution comparison, plus bounded changed-command planning and the
existing journal/write costs; retained dependency state is O(F) per record. Unchanged input
still incurs this bounded comparison before skipping effects. Whole-dump work follows the
finite supplied records; learning a claim must not trigger binding, history or catalogue
enumeration or an unbounded replay sweep. This derives a required bound, not measured
implementation evidence or a mandated dependency storage/API. Existing injected-provider
call bounds below remain unchanged.

## Deletion

The [common deletion policy](../../docs/deletion.md) governs lifecycle; the
[first public scope](../../docs/scope.md) limits imports to Bangumi, VNDB,
Open Library and Wikidata, with no recipe-site source or user posts. Imports
owns pure conversion, an ordinary authenticated API client and private,
operator-managed SQLite coordination state. Authoritative contributions and
subjects belong to [Semantic](../kernel/src/semantic/README.md), media to
[Content](../kernel/src/content/README.md), and account lifecycle to
[Access](../kernel/src/access/README.md#account-deletion-policy).

Those owners are responsible for enforcing platform soft deletion, record-owner
restore within 30 days, separate bounded purge, account erasure, early-purge
permission, takedown and legal holds through their public APIs under the common
policy. Imported proposals and media remain under those owners. The importer
does not soft-delete, restore or purge authoritative user-owned records, expose
parallel lifecycle routes, or use privileged SQL into those modules.

Accounts owns one terminal workflow and a fixed, versioned participant list.
The kernel's `imports` work effect consumes
`com.rezics.access.account-tombstoned.v1`, then records an immutable `none`
acknowledgement through Access. `none` is truthful for the reviewed importer
storage because no importer-owned persisted payload is owned by a platform
account. This is server-side work in the kernel; the importer CLI remains an
API-only client with no PostgreSQL dependency, privileged write, deletion hook
or access to operator SQLite/key files. Dispatch by itself is not completion.
The common [deletion policy](../../docs/deletion.md) and
[Access coordinator](../kernel/src/access/README.md#account-deletion-policy)
remain authoritative for lifecycle and acknowledgement semantics.

The retention inventory is exact: accepted source projections and source
record state are keyed by source and external key; run state, generations,
candidate/media identifiers, immutable request and acknowledgement bytes,
receipts, counters, and same-source process ownership are importer-owned
SQLite coordination state. None has an account owner or account locator.
Credentials and bearer tokens are memory-only; operator key/configuration
files and source inputs are external to application storage. Author, editor,
uploader, delegate, operator and acting-human attribution, shared receipts,
outbox, media, search and catalogue copies belong to their respective owners,
not this importer inventory. No importer copy of account-owned payload was
found, so there is no purge job or personal-data retention interval here.
This `none` result does not attest cleanup by those other participants.

Any future importer field or store containing personal or private account
data must first gain a native indexed account ownership relation or an exact
locator recorded atomically with its producer. Its retention and bounded
minimizer must be documented before release; do not infer ownership from a
source name, scan JSON/name text, or add a central ownership graph. A new
personal-library import is outside the current storage and public scope until
that producer and locator exist.

In [`importer.ts`](src/importer.ts), source disappearance and replacement reconcile
provenance by publicly bulk-retracting the actual returned source candidate IDs.
This does not delete a communal subject, another contributor's adoption or media
bytes. [`record-bindings.ts`](src/record-bindings.ts) removes an acknowledged
retracted candidate's local binding pointer and retains its journal receipt;
that cleanup is not content purge. The `present`/`vanished` checkpoints and
generations in [`run-store.ts`](src/run-store.ts) and
[`record-store.ts`](src/record-store.ts) describe source state, not user-facing
soft deletion or restoration.

Refresh must respect server deletion, authorization and disclosure checks.
Planning checks `(source, external_id, field_group)` takedown fences before even
the unchanged-record shortcut, and dispatch checks them again. Never clear
those fences or terminal source claims to recreate withheld material.

The public import transport and standalone media resolver admit open fence evidence only with
`fenced: false` and `securityRevision: null`. Closed evidence requires `fenced: true` and a nonempty
string proof; standalone ports preserve opaque proofs without imposing a numeric revision grammar.
Malformed or contradictory evidence throws before media journal preparation, POST or status calls,
including for an already bound exact owner. The frozen [fence evidence cases](tests/media-fence-evidence.test.ts)
exercise the actual public transport and SQLite-bound resolver. These checks add no read pass or retained state;
existing media resolution growth evidence and native receipts and limits remain unchanged.

The `run_reference_signatures` table holds only exact source/key dependency outcome signatures.
It is coordination metadata for every role, has no role-specific product surface, and contains
no account, bearer or owner data. It follows the same restart and retention restrictions below.

Operational source/key/revision/digest/converter-revision rows, sanitized source
projections, generation pages, returned IDs, exact prepared request bytes and
replay receipts support restart safety. They have no product browse, count,
search or sitemap surface. Bearers stay in memory; the automated account key
file is externally provisioned, not an account-content database. This state is
not a workaround for retaining deleted private account content. Current code
has no timed coordination-state purge job or retention interval; do not clear
state while effects remain unresolved. Operators may deliberately retire
explicitly selected superseded complete generation captures through
`rezics-import retention`; that path does not erase acknowledgements, payloads,
bindings or native published state. Authoritative lifecycle work and its
bounds belong to the linked owners; conversion itself has no purge work.

## Cost

### Compare two retained complete captures

- Touches: the two selected complete captures with N and M retained input rows, source/generation header point reads, and at most p≤100 displayed details plus bounded scan windows. Other sources and old generations are unrelated.
- Bound: complete `--counts` is one indexed merge of O(N+M) row visits plus index seek cost, O(p+w) working memory for fixed scan window w=256, and no retained global key set. A detail page performs at most w scanned present-merge steps with a continuation even if fewer than p matches; total full traversal remains O(N+M) without recounting. Exact-record detail uses two primary-key seeks and bounded stored projection decode.
- Growth check: production compare/count/page/exact-record paths on 32/128/512 captured rows, equal ratio 4, including mostly-unchanged sparse changes, vanished/reappeared records, converter-only changes, and independently growing unrelated history. Count visited rows, decoded projection bytes, comparison calls, retained buffers and SQLite read queries. Counts and paged union agree; page/cancellation bounds hold.

### Explicit source statistic removal

- Touches: the existing bounded source projection/own binding and one public exact-subject/source/record clear command per changed zero intent; no extra global lookup.
- Bound: at most one native clear effect per source record/run under existing logical-write/transport budgets. UNKNOWN sends zero statistic requests; source rows/candidates remain indexed and bounded. Physical retries remain visible in native HTTP captures, separately from positive PUTs and votes.
- Growth check: existing importer counted/store/transport bounds remain unchanged. Content owns native exact-key clear/read/fence growth. The connected native journey observes effect/receipt/recovery; it adds no synthetic PostgreSQL growth series and has not been run in this attempt.

### Source-only provenance refresh

- Touches: the already bounded current record's <=300 owned candidates/proposals and existing exact source/subject/fence/journal reads; no new lookup authority.
- Bound: changed-record delta times q indexed journal/proposal work; current-run replay and unchanged input preserve existing caps/zero duplicate effects. Confirmed statistic-only effect retains its accepted bound.
- Growth check: existing reconciliation/counting and native sourced-write growth keep their units and literal bounds; the native caller proves actual changed-provenance/public outcome, not a new PostgreSQL growth series.

### Fenced statistic refresh

- Touches: the already obtained bounded facts-omission result for the exact tuple; the existing positive-statistic HTTP effect only when unfenced.
- Bound: one in-memory omission lookup within at most three groups, no additional SQL or fence request, and zero statistic HTTP writes for the fenced tuple.
- Growth check: the production importer/registration caller test above proves suppression; existing source-statistic native/cost suites retain their independent scope. This guard adds no native growth measurement.

### Operate a permitted scalar source feed

- Touches: supplied native bytes, exact current-run tuple/journal and existing ordinary Auth/public commands.
- Bound: existing source byte/field/page and command budgets; input consumed once after the actual acquisition rules. No catalogue/history scan or predicted native effects. The caller captures exact consumed bytes, actual seal accounting and independent committed rows/receipts under the existing fixture bounds.
- Growth check: reuse the existing importer/native capture bounds and units. The new three-provider caller acceptance proves connected behaviour and retains raw observations; it claims no new growth measurement.

### Complete the rejected-cover operator journey

- Touches: supplied bounded source bytes, exact owner/run/record and native receipt/subject/candidate keys, ordinary Auth/public requests and captured response bodies.
- Bound: existing input/page/projection/public envelope and retry bounds, O(input bytes+(S+D)(1+q)logR) with bounded q. No catalogue/history scan or invented PostgreSQL units.
- Growth check: existing local counted ceilings and canonical/derived native suites remain unchanged. This connected outcome adds no growth series or replacement counters.

### Native mixed Wikidata acquisition

- Touches: each existing bounded JSON line plus type, identity and optional native revision validation; only admitted Q items stage indexed source rows and public effects.
- Bound: O(input bytes) scan with unchanged record/chunk retention caps, no per-property retained set or durable rows, and unchanged item reconciliation bounds.
- Growth check: `tests/wikidata-mixed-dump.test.ts` exercises the production coordinator with mixed input, unchanged and changed refresh, property-only mass-stop and invalid acquisition. Its real durable in-memory stores and typed external API fake prove local coordination, not real server authorization, PostgreSQL work or promotion. Existing reader growth/retention cases remain the measured cost evidence; the connected native item/public bulk journeys above supply separate API evidence.

### Local zstd admission

- Touches: compressed bytes C, decoded bytes B, one direct zstd child with a 128 MiB `-M128MB` window, bounded stdin/stdout/stderr pipes, existing parser record bound R and source staging/application work N.
- Bound: streaming work O(C+B); parent retained memory O(inputWindow+outputWindow+stderrBudget+R) with pipe windows ≤256 KiB and stderr 8 KiB; child decoder memory is the configured 128 MiB plus observed fixed overhead. Decode budget default 256 GiB with at most one window overshoot. Termination uses a 2s SIGTERM grace then SIGKILL and an actual reap. No second decompression pass, full decoded spool or extra engine scan.
- Growth check: `tests/zstd-input.test.ts` and `tests/cli-zstd.test.ts` run the installed zstd tool plus production intake/parsers for identity, late failure, cancellation and handle closure. Native import comparison remains the deferred controller suite. Decision: executable lookup is `--zstd-executable` (absolute), else `/usr/bin/zstd`, else `zstd` on PATH.

### Interrupted source acquisition cleanup

- Touches: the existing input iterator boundary, exact source lease and owned SQLite/file handles.
- Bound: one cleanup request per unfinished source iterator, with one abort listener per pending input/cleanup operation. After cancellation, no further input reads or acquisition HTTP/public writes; source-controlled cleanup promises are observed for rejection without waiting for settlement. Owned descriptor reads and already-dispatched import writes still settle before their handles close. Valid input has no lifetime timer cap.
- Growth check: `tests/cli-upstream-cancellation.test.ts` uses an actual CLI child with a nonsettling source return; `tests/cli-upstream-cleanup.test.ts` covers queued generator return, late rejection, prior-baseline preservation and same-process reacquisition. Existing `tests/concurrent-cli-owners.test.ts` and `tests/cli-file-admission.test.ts` retain ownership and descriptor-admission coverage. These are stack-free acquisition checks, with no native Auth/public success, PostgreSQL budget or wall-time performance claim.

### Review and resume a bounded partial source reduction

- Touches: the supplied current run, maintained seal counters, exact missing-record pages and their existing native removal commands and receipts.
- Bound: existing current-run/source-key page seeks, at most 100 records per page and 300 current owned candidates per record, with the existing envelope and retry budgets. No global catalogue or receipt-history scan, new approval state or retry allowance is introduced.
- Growth check: existing run-store and importer reconciliation growth cases retain their mass-loss and removal capture bounds. The native CLI journey above proves connected safety and recovery; it does not measure physical work at additional scales.

### Adaptive writes

- Touches: one width counter and prospective admission check per success; constant-time halving and insertion of the existing failed-write continuation. Existing wider cohorts drain without cancellation; no database reads or storage are added.
- Bound: active plus paused records stay at most K (`recordConcurrency`, default 16, maximum 64), with queued continuations admitted before fresh records. Width-one failure is an early stop, while the independent logical-write allowance bounds partial overload even as successes restore width.
- Growth check: `tests/write-width.test.ts`, `contention answered with retryable 503 narrows the write width and every record lands once`, `a single writer that still gets retryable 503 fails the run as before`, and `width grows back to the configured concurrency after successful writes` cover retained effects, live records, virtual waits and recovery.

### Logical write retry admission

- Touches: one in-memory attempt counter and existing bounded continuation per active/paused logical write, plus constant sanitized retry timing/refusal metadata. No new database tables, history reads, source scans or API effects beyond exact envelope replay.
- Bound: <=K live records and queue entries with constant metadata each; <=8 transport invocations per logical write independently of input N or history. Each invocation retains its attempts/wait/deadline caps; its final hint is charged against that invocation's remaining wait/deadline allowance before a continuation may send. Physical sends <=8*(A+1). Explicit resume starts a later run allowance.
- Growth check: `tests/logical-write-budget.test.ts`, `unrelated successes cannot refill a failing logical write budget` compares 16/64/256 successful neighbors, counts 401 renewal sends, preserves exact command identity and observes no duplicate effect; `prior completed effects and exact envelope identities survive retry exhaustion` checks durable resume. `tests/retry-after-layering.test.ts`, `retry-after survives the final transport response without an early coordinator send` and `oversized retry-after leaves durable unresolved work without retrying early` cover both overload statuses, seconds/date and cap refusal; `deferred cover polling cannot reopen a terminal retry refusal` covers the media pass. The full importer check preserves `importer-reconciliation-growth` at history scales 32/128/512 and `import-fetch-growth` at M=1/8/64; probe-count/cost assertions are unchanged.

### Imports erasure disposition

- Touches: importer SQLite state is keyed by source, external record, run or process ownership, with no platform account ownership relation. Candidate/media IDs, source projections, command bytes and receipts support source reconciliation. Operator-managed key files and in-memory bearers do not make those records account-owned payload; author, editor, uploader, delegate, operator and acting-human evidence in shared stores belongs to those stores' participants. See the [current inventory and delivery limits](../../docs/research/imports-audit/erasure-participant.md).
- Bound: the required `none` disposition validates the native tombstone and makes one indexed coordinator point acknowledgement for `imports` within the 11-participant version-1 set, without reading or mutating importer SQLite. This storage rationale does not establish delivery. A future importer-owned personal field requires its producer to supply an indexed ownership relation or exact locator and bounded minimizer before `none` can remain valid; no JSON/name scan supplies that relation.
- Growth check: `../kernel/test/access/growth-erasure-coordinator.test.ts`, `erasure acknowledgement (first) stays constant as accounts and completed erasures grow at three scales`, owns the coordinator bound. No new importer benchmark or zero-work measurement is implied. Native registration, delivery and replay require the participant acceptance; their reached evidence is recorded in the audit.

### Measurement units and evidence

Composed growth setup appends immutable PostgreSQL revisions to the actual selected subjects after native baseline binding; a smaller history target starts a new appended range without rewriting earlier revisions. Same-source SQLite run history and same-route unrelated subjects remain separate growth populations.

The [remaining measurement inventory](https://github.com/rezics/rezics-next/blob/472aa311ffe270eca9f01f7d7bf633281c76f14d/docs/research/imports-audit/remaining-cost-unit-ports.md)
and [VNDB binding inventory](https://github.com/rezics/rezics-next/blob/14659f678751fc153ab67752628b9d9efc32c15d/docs/research/imports-audit/vndb-tables-binding-seams.md)
are dated source evidence, not passing executions or authority to amend frozen acceptance.
Current table grouping still retains `id`, `olang`, `c_votecount` and `c_average`.
The fourteen-case portable table binding remains absent: it needs acceptance-owner reconciliation of the stale
whole-object statistic oracles, a production committed acquisition/baseline association, row-lifetime observation
and closed execution-boundary evidence. Table `ready` is not a committed baseline; adapter Maps, guessed IDs,
row-write formulas and zero-filled observations cannot supply these producers. Deliver the missing production
producers with their caller in one implementation. The separate six-case native statistics binding must retain
actual source-statistic API effects; neither local table success nor pure conversion proves those effects.

- Touches: count SQLite executions (including controls) and returned rows, input bytes/chunks, requests and retained bytes under those names. Keep raw SQL, bindings, bound EQP, schema/index evidence, validators and combined-events assertions. Returned rows do not measure examined rows; unavailable SQLite buffers cannot be reported as `blocks: 0`. Preserve canonical native PostgreSQL capture unchanged, with PG-derived appended rows and calls-plus-plans as separate named checks, never SQLite totals. Counted client sends in `tests/importer-growth.test.ts` are distinct from real server capture in `../kernel/test/semantic/growth-sourced-writes.test.ts`; width-only observations and a shorter series do not prove full batch growth. Record actual physical populations separately from logical scales and independent payload axes.
- Bound: retain every exact statement/page/byte formula in the Cost table below. In particular, run classify/prepare uses <=14+7q statements and <=15+7q touches plus two controls; acknowledgement <=1+8r point statements/rows plus two controls; finalize <=r+4 statements/2r+3 touches plus two controls. VNDB pages use 2+2r SELECTs, <=r+1 numeric rows and <=66r child/metadata rows plus one run row; internal ranges hold <=32 rows and public pages <=16. These touch bounds do not become measured examined-row counters. Native SQLite execution ceiling remains 1456+144I+32M and PG calls-plus-plans 4000+1000I+256M; allocated/retained byte ceilings remain 64*(I*65536+M*1024) and 4*(8*65536+M*1024). Source policies and all independent admission/byte limits remain unchanged.
- Growth check: when porting old checks, explicitly carry row-like slack {absolute:2, relative:0.1}, byte/block-like slack {absolute:4, relative:0.5} and execution slack {absolute:0, relative:0}; counted defaults are zero. Preserve stricter explicit-zero checks and exact ceilings. For equally spaced ratio r and samples a,b,c, slack=max(absolute,relative*a); constant permits max(b,c)-a<=slack, linear permits c-b<=1.5*r*max(b-a,0)+slack, and logarithmic uses factor 2 instead of 1.5*r. Local helpers and artifacts establish neither native/API/growth acceptance nor physical zero I/O.

### Credentials

- Touches: one key file read at start; per renewal, one `POST /signin/key` and one `/token`.
- Bound: at most ceil(T / 240 s) renewals over a run of duration T, plus one per 401. Nothing per record.
- Growth check: `../../specs/imports-cli-credentials.test.ts`, test `a long import renews before expiry within the sign-in bound and every batch write succeeds`, on a virtual clock across three token lifetimes, counting sign-ins.

### Import run

- Touches: per record, the same requests as today, plus one batch for a cover whose media was pending. Per run, one pending-cover pass.
- Bound: run time about ceil(N / K) x the record's request path x request latency, plus the media tail capped by `mediaDeadlineMs`. In-flight records at most K. Live state O(K) plus one page of 100 staged rows, independent of N and of history.
- Growth check: `../../specs/imports-pipeline.test.ts`, test `virtual throughput at sixty four two hundred fifty six and one thousand twenty four keeps bounded live state`, at N = 64, 256 and 1024 on a virtual clock.

### Import run (processor)

- Touches: per record, its conversion, its journal rows and its request bodies, each once. Every SQL text is prepared once per connection, the cover intent, batch and result bodies are validated once however many modules they cross (a small memory of accepted bodies, bounded in entries and bytes), a record's journals are written in one commit and its receipts in one commit, and a page of staged records shares one commit. Per record: at most five converter calls, 165 statements and 3 commits; no statement is prepared per call.
- Bound: processor time per record constant in the dump size and in history; the only per-run work is schema, ownership and the first preparation of each statement.
- Growth check: `tests/record-cpu-growth.test.ts` at 256, 1024 and 4096 records through the pipeline driver with zero latency, counting converter calls, statements prepared and executed, and commits instead of wall time.

### Retain conversion diagnostics

- Touches: one current staged record and at most D admitted diagnostic entries/bytes; existing source/generation keys and writer transaction. Application reconversion writes the same generation row identity for phase `application`.
- Bound: O(D) extra validation and writes per converted record, bounded by derived per-record entry/byte ceilings (228 entries, 65,536 vector bytes); O(N*D) across N records with page-bounded memory. No reads of unrelated historical generations or PostgreSQL work added by local retention.
- Growth check: `tests/conversion-diagnostics-growth.test.ts` at 32, 128 and 512 diagnostic-bearing records and separately 32, 128 and 512 unrelated history, counted local SQLite executions/returned rows plus raw EQP SEARCH evidence. The repository counted-scale helper requires equal ratios of at least four, so 32/64/128 cannot be admitted.

### Retire superseded complete generations

- Touches: indexed generation metadata, selected generation-local rows D, a bounded plan of at most 100 IDs and page size p≤100, current baseline/source-owner point reads. Shared acknowledgements, bindings and payloads are not enumerated or rewritten.
- Bound: index seeks O(log H+p) per generation/table page, total O(D log H) pessimistically for row deletion with bounded transactions and memory O(p+100). Eligibility and count queries use source/run indexed prefixes; count cost is proportional to the explicitly examined capture. No whole-database scan, whole-key retention set, repeated OFFSET, shared payload anti-join or VACUUM. Schema migration (`run_retention_work`, `run_generation_seq`) is separate from steady-state deletion.
- Growth check: `tests/retention-growth.test.ts` at 32/128/512 selected-capture rows, equal ratio four, with unrelated source and historical rows also growing. Counts actual visited statements and returned rows through shared SQLite instrumentation. Baseline/ack/binding/payload snapshots remain byte-identical.

### Review diagnostic pages and exact record

- Touches: source/generation point reads, indexed diagnostic-bearing record page P≤100 and at most D bounded diagnostics per returned record.
- Bound: O(log(H+N)+P*D) local work and O(P*D) bounded output/memory; exact record O(log(H+N)+D). No N/H aggregate scan, JSON payload reads of projections or schema writes on read.
- Growth check: `tests/diagnostics-cli-growth.test.ts` at 32, 128 and 512 current diagnostic-bearing records and independently growing unrelated history, fixed page 20, first/next/end pages and exact-record lookup with production SQL instrumentation and EQP. The series uses ratio four because the counted helper rejects 32/64/128.

### Skipped input accounting

- Touches: one in-memory scalar increment for each ignored conversion during the existing acquisition; successful seal writes that scalar to the exact run-generation row. Resume makes one exact `(source,id)` metadata read before finalization, including when acknowledgements are already durable. Existing databases add the column with default zero, preserving prepared work and receipts.
- Bound: O(1) retained state and one indexed point write/read per run; no source-wide count, history enumeration, ignored-key set, or second acquisition pass. Invalid or duplicate acquisition cannot publish a successful partial count. The scalar is a nonnegative safe integer.
- Growth check: `tests/bangumi-scope.test.ts`, `mixed complete dump counts both exclusions on initial, unchanged and changed runs without false disappearance`, both durable-resume scenarios, and the directly executed CLI scenario assert exact accounting and no skipped-record effects at real SQLite state boundaries.

### Operation bounds

These bounds follow `src/` and `../../packages/conversion/src/`: R is stored records (including retained run history), B is binding/journal rows, M is one record/request/response's bytes, r is one page/batch's records, and k is rows changed; H is records already seen in a dump, C is a supplied chunk's backing bytes, S is supplied table/snapshot rows, D is disappearances, and q is commands for one record.
An indexed point operation examines at most one matching row plus O(log R) or O(log B) B-tree navigation; a keyset range examines its bounded results plus that navigation, without OFFSET, history enumeration, or COUNT scans.
Below, PK means the declared primary-key index, SELECT/INSERT/UPDATE/DELETE counts exclude connection-time schema/PRAGMA work, and each transaction adds BEGIN IMMEDIATE plus COMMIT (or ROLLBACK on failure); methods make zero kernel calls unless explicitly described.
Run/record pages cap r at 100, VNDB pages at 16, internal VNDB ranges at 32, and command/result batches at 100; public run projections/envelopes and binding snapshots cap M at 65,536 bytes; `readDump`/`runDump` source records default to 256 KiB with a hard 1 MiB maximum, while source-record staging separately budgets serialized normalized records at 1 MiB plus a fixed wrapper; private record plans cap M at 2 MiB and q at 300 (classification alone caps q at 100); record metadata has fixed field byte limits of 64/512/256/64/128 for source/key/revision/digest/converter revision.
Growth checks below cite exact existing titles only for the exercised paths; outcome checks cover limits and failure handling rather than every growth path.

| Operation                                                                           | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Growth check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry and bounded input (`cli.ts`)                                              | Parses bounded argv and validates the exact origins before I/O; reads and imports one owner-only account key, opens one file or stdin with no-follow descriptor custody, owns bounded chunks, optionally gunzips Open Library/Wikidata dumps or decompresses VNDB/Wikidata zstd dumps through one owned child, and carries Open Library's native TSV date into record metadata. The `diagnostics` subcommand delegates before credentials or network construction. gzip is rejected for VNDB/Bangumi before credentials or state. zstd is rejected for Bangumi and Open Library at the same point; dump-set members stay none/gzip. | O(A + K) preflight with A ≤16 KiB and key K ≤16 KiB. One input read, O(C+B) gzip/zstd+decoder work; owned compressed and decoded windows ≤256 KiB from backings ≤1 MiB, plus one Open Library line ≤256 KiB+1. No whole-file materialization or source-key set; diagnostics ≤4 KiB. Credential network bounds are stated above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `services/importer/tests/cli-outcomes.test.ts`: real source pipeline outcomes. `specs/imports-cli.test.ts`: actual SQLite work stays fixed and streaming input grows linearly across three scales. `tests/diagnostics-cli.test.ts`: diagnostics routing, help and handle closure. `tests/compressed-dump.test.ts` and `tests/compressed-dump-cli.test.ts`: gzip admission, integrity and equivalent decoded identity.                                                                                                                                                                                                                                                                                                      |
| Streaming gzip dump transform (`compressed-dump.ts`)                                | Sits below the common owned byte reader. Member-framed `createInflateRaw` validates CRC/ISIZE/EOF; concatenated members including an empty last member are one complete input; trailing non-gzip bytes fail. Never falls back to raw text. Reports compressed and decoded bytes separately.                                                                                                                                                                                                                                                                                                                                         | O(C+B) work; retained windows O(Wc+Wd) with Wc,Wd ≤256 KiB plus zlib's configured high-water mark; decoded budget default 256 GiB with at most one window overshoot. Memory independent of whole-file size. Codec buffering is the configured production high-water mark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/compressed-dump-growth.test.ts`: production raw and gzip paths at 32/128/512 records, ratio four, highly compressible input and a slow consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Streaming zstd dump transform (`zstd-input.ts`)                                     | Sits below the same owned byte reader. Spawns one trusted zstd child (`-d -c -M128MB --no-pass-through -`) and pumps descriptor-owned compressed windows to stdin. Concatenated frames, empty last frame and skippable frames are one complete input; raw passthrough and trailing non-zstd bytes fail. Capture waits for pump EOF, parser completion and child exit 0. An early parser stop still drains decoded stdout and joins the child. Reports compressed and decoded bytes separately.                                                                                                                                      | O(C+B) work; parent windows O(Wc+Wd) with Wc,Wd ≤256 KiB plus 8 KiB stderr; child window 128 MiB plus fixed overhead; decoded budget default 256 GiB with at most one window overshoot. One child per invocation. Termination grace 2s then SIGKILL and reap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/zstd-input.test.ts`: identity versus plain Wikidata, concat/skippable/empty frames, late trailing/truncated/checksum/window failure, decode budget, missing/incompatible executable, hang SIGKILL, stderr flood and replaced file. `tests/cli-zstd.test.ts`: admission, offline preview and plan-dir reopen.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Retain conversion diagnostics (`run-store.ts`, `importer.ts`)                       | Validates the converter diagnostic array without accessors; INSERT the exact generation/record/phase identity; INSERT diagnostic-bearing review keys; UPDATE stored generation counts. Resume of the same digest/revision/converter identity is a PK seek with no second write.                                                                                                                                                                                                                                                                                                                                                     | Generation/entry/diagnostic PK exact seeks; ≤4 statements/point rows per record plus 2 transaction controls when folded into the staging commit; O(D + log R) extra work, D ≤228 and vector ≤65,536 bytes; no unrelated-generation reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/conversion-diagnostics-growth.test.ts`: `staging diagnostic retention stays indexed as diagnostic-bearing records and unrelated history grow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Review diagnostic pages and exact record (`diagnostics-cli.ts`)                     | Opens an existing regular file read-only with `O_NOFOLLOW`; source/generation point lookup; indexed diagnostic-bearing keyset page; exact record PK prefix. Releases handles before rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1 source + 1 generation point read, then 1 keyset SELECT of P+1 review keys and P diagnostic PK prefix reads; O(log(H+N)+P*D) local work, P≤100, output/memory O(P*D). No OFFSET, schema writes, lease, or projection JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/diagnostics-cli-growth.test.ts`: `diagnostic pages and exact lookup stay indexed as current omissions and unrelated history grow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Binding inspection overview, page and exact request (`binding-inspection-store.ts`) | Opens an existing regular file with the shared read-only path guard; exact `binding_records` point read; optional current metadata/cover pointers and per-record group capacity; one selected journal family keyset page or one exact original-request PK. Releases handles before rendering. No `RecordBindings` constructor, WAL pragmas, lease or native call.                                                                                                                                                                                                                                                                   | Point reads O(log B); keyset page 1 SELECT of P+1 owner-prefixed rows, P≤100; body length is measured in SQL before load/hash; projection O(P·M) for M≤65,536. Memory O(P+M). No OFFSET, all-history COUNT, payload-history join or per-row table scan. Native writer paths unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/binding-inspection-growth.test.ts`: production CLI/reader at 32/128/512 retained request rows, ratio four, plus independently growing unrelated sources, records and generations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dump lines and parsing (`dumps.ts`, `dumps-bytes.ts`)                               | Reads decompressed bytes; decodes/parses one line and yields duplicates unchanged to durable RunStore staging; no SQL/writes/API or retained native-key set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | O(M) scanning, amortized copying and parsing per record line; O(C + L) live input, line buffers, decoded scratch and COPY framing metadata, independent of H. L is caller `maxRecordBytes` + 1, + 2 for Wikidata, or max(cap + 1, 65,536) for VNDB outside COPY; accepted records remain at most cap. Chunk backing is checked before scanning/copying/yielding: default 256 KiB, maximum 1 MiB, including tiny views of larger buffers. Unterminated tails reject after L + 1 examined bytes; no next chunk is pulled before yielding. Record caps default to 256 KiB and cannot exceed 1 MiB, independently of chunk backing and normalized projection budgets; total scanning is linear in supplied bytes and skipped lines have no count cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/dumps-growth.test.ts`: `streaming parser growth follows supplied bytes with bounded per-record read-ahead`; `oversized unterminated tails abort with the same byte bound at every scale`; `one fixed admitted backing is charged in full and only the first record is visited before yield`. `tests/reader-bounds-outcomes.test.ts`: `all bounded reader outcomes pass with production parser`. Duplicate uniqueness is measured by the run-staging growth check below. `tests/record-caps-growth.test.ts`: `one-record acquisition has linear actual parser work outside database measures`; `record boundaries retain native framing overhead, UTF-8 accounting and upstream cleanup`.                            |
| Bangumi pure conversion (`../../packages/conversion/src/bangumi.ts`)                | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Normalized source ≤64 KiB, ≤64 ordinary tags and ≤64 public metadata tags, ≤6 commands and one cover intent; summary Text snapshot ≤32 KiB, infobox ≤64 KiB characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `../../packages/conversion/tests/bangumi-growth.test.ts`: `fixed source conversion intercepts I/O at every unrelated population scale`. `../../packages/conversion/tests/logical-growth.test.ts`: `Bangumi: actual unrelated conversions leave anchor return bytes identical`; `Bangumi: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                               |
| VNDB pure conversion (`../../packages/conversion/src/vndb.ts`)                      | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Normalized grouped record ≤64 KiB, ≤64 titles, ≤32 links, strings ≤4096 bytes and ≤98 commands; no assets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `../../packages/conversion/tests/vndb-growth.test.ts`: `fixed conversion performs zero SQL network or file I/O across unrelated populations`. `../../packages/conversion/tests/logical-growth.test.ts`: `VNDB: actual unrelated conversions leave anchor return bytes identical`; `VNDB: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                               |
| Open Library pure conversion (`../../packages/conversion/src/open-library.ts`)      | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Converter normalized record ≤2 MiB, prose ≤1 MiB, field arrays ≤64, combined author/work relations ≤64 and proposals ≤100; importer admission/staging independently enforce the smaller record/projection caps above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `../../packages/conversion/tests/open-library-growth.test.ts`: `fixed conversion touches zero SQL and network across unrelated catalogue and history growth`. `../../packages/conversion/tests/logical-growth.test.ts`: `Open Library: actual unrelated conversions leave anchor return bytes identical`; `Open Library: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                               |
| Wikidata pure conversion (`../../packages/conversion/src/wikidata.ts`)              | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Native supported record ≤128 KiB, ≤64 statements and terms, ≤15 references and ≤16 snaks per bounded collection, ≤100 commands; no assets or instrumentation metrics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `../../packages/conversion/tests/wikidata-growth.test.ts`: `fixed conversion return is byte-identical after unrelated actual conversions`. `../../packages/conversion/tests/logical-growth.test.ts`: `Wikidata: actual unrelated conversions leave anchor return bytes identical`; `Wikidata: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                          |
| VNDB raw entry chunks (`vndb-tables.ts`)                                            | Admits full backing before scanning supported rows or discarding user/unknown entries; only supported entries allocate the 64 KiB row buffer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shared chunk validator defaults to 256 KiB with a hard 1 MiB ceiling; the table loader further restricts configuration to ≤256 KiB. O(C + M) live input/row scratch (plus bounded spool pages above), with C bounded before retention/copy even for empty views; supported scanning is O(record bytes), ignored bodies count bytes without decoding. Total work is linear in admitted input, within archive admission limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/vndb-chunk-growth.test.ts`: `raw six-entry staging SQL stays constant across accumulated native keys and source history`; `native input visits grow linearly over 1/8/64 owned chunks with bounded admitted backing`; `late oversized known/header/ignored backings fail before byte access and erase staged rows`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| VNDB archive streaming and staging (`vndb-tables.ts`)                               | `begin`: INSERT run; `inspect`: SELECT run, both PK(source,run_id). Stage: keyed state UPDATE, stream six supported paths, INSERT spool before header or INSERT row + UPDATE run counters after header; drain spool via PK(source,run_id,table_name,sequence) and DELETE each consumed row; finish with keyed ready UPDATE (failure: failed UPDATE + cleanup).                                                                                                                                                                                                                                                                      | O(M) bytes scanned/decoded per supported row, raw row M ≤ 65,536 and serialized payload O(M); one fixed row buffer plus ≤32 spooled rows/decoded scratch and C backing bytes, O(C + 32M) live storage, no next chunk prefetch. Every entry is admitted before its body: total decompressed entry bytes default to 16 GiB (hard 64 GiB), entry count to 512 (hard 2048), including unknown entries and directories. Safe-integer declared sizes reserve aggregate bytes; actual bytes must match and reject over-declaration before scanning. Ignored entries are drained without decoding/row buffering. Full chunk backing is checked before retention or byte access on every raw entry, with no prefetch; `readArchive` additionally bounds tar framing and yields owned payload copies ≤512 bytes. Supported input rows capped by maxRows (default 2,000,000, maximum 10,000,000), VN records by maxSourceRecords (500,000/1,000,000). Direct row: 2 point statements; spooled row: 1 INSERT, then 1 range SELECT per ≤32 rows, 2 insert/counter statements + 1 DELETE per row. Rows touched O(k), cost O(k log R + supplied bytes); no prior-run scan.                                                                                                                                                                                                                       | `tests/vndb-tables-growth.test.ts`: `VNDB staging stays within its bound as R grows`. `tests/vndb-archive-limits-growth.test.ts`: `fixed admission rejection and ready staging keep exact-run SQL and live buffers constant over history`; `entry and byte populations stop exactly before the excessive body with linear admitted input`; `unsafe declarations, lying bodies and oversized backing close raw input without scanning or draining`.                                                                                                                                                                                                                                                                         |
| VNDB validation, projection page and cleanup                                        | Validation walks each table's PK(source,run_id,table_name,id,child) keyset; each VN seeks titles + metadata, each child seeks its VN. Page: inspect, numeric `vndb_table_ids` range, then metadata/title PK seeks per VN. Cleanup: row/spool PK prefix range SELECT and exact DELETE per row.                                                                                                                                                                                                                                                                                                                                       | Validation: 1 SELECT per ≤32 rows (plus terminal ranges), 2 SELECTs per VN or 1 per child; O(S log R + SM), not history. Title seek LIMIT children+1 ≤65 detects overflow; children ≤64; metadata 1 row. Page: 2+2r SELECTs, ≤r+1 numeric rows plus ≤66r child/metadata rows and 1 run row, O(r log R + 64rM) bytes/work. Cleanup: 1 SELECT per ≤32 rows plus 1 DELETE per row, O(k log R + kM), ending each table with a short/empty page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/vndb-tables-growth.test.ts`: `VNDB projection stays within its bound as R grows`; `VNDB validation stays within its bound as R grows`; `VNDB cleanup stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Fetch one request (`import-fetch.ts`)                                               | Reads/copies request once without teeing its stream; checks retry identity, gets one token, sends exact buffered bytes; cancels retried response bodies, buffers the final response before returning; no SQLite.                                                                                                                                                                                                                                                                                                                                                                                                                    | O(M) amortized CPU/owned buffered bytes and O(aM) transmitted bytes; a defaults to 3, maximum 5 (unsafe writes 1), with ≤a−1 waits. Lower-only request/response caps default to 2 MiB/1 MiB; final response chunks also reject backing >1 MiB before copying. Each full producer backing buffer must be ≤2 MiB before retention or copy, including empty/tiny views and direct ArrayBuffer/view bodies; accepted chunks are copied and released, so live memory is O(M + C) with C ≤2 MiB, independent of chunk history. Known excessive request length rejects before pulling; overflow cancels without another pull. GET/HEAD and keyed POST retry transport/429/5xx; batch POST requires nonempty distinct command keys. Fallback min(1,000×2^(attempt−1),30,000) ms; waits cap at 30s each/60s total and the whole invocation at 120s, all lower-only. An advertised wait beyond budget returns the bounded response without shortening the wait; unrepresentable delays do likewise. Deadline/caller abort interrupts body reads, token, upstream, cancellation and sleep.                                                                                                                                                                                                                                                                                                   | `tests/import-fetch-growth.test.ts`: `real adapter sends two attempts and linear supplied bytes at M = 1, 8, 64`; `body cap counts UTF-8 bytes and stops streaming before reading the remainder`; `repeated 429 is capped, cancels only retried bodies, and returns the actual final response`; `HTTP-date Retry-After uses the injected clock and never shortens advertised waits`. `tests/http-bounds-outcomes.test.ts`: `all bounded HTTP outcomes pass with production fetch`. `tests/request-backing-growth.test.ts`: `fixed visible bytes survive 1/8/64 chunks and five exact adapter attempts at both entrypoints`; `oversized backing stops at the first offending pull, including empty views and later chunks`. |
| Run start, capability, seal and checkpoint controls                                 | `begin`: SELECT source, UPSERT source lease/sequence, INSERT generation; busy: SELECT only. `activeRun`: source/generation join; `source`: SELECT source. `reopen`: SELECT generation + UPDATE lease. `abandon`: SELECT generation + UPDATE generation/source on release. `seal`: SELECT generation + UPDATE ready counters or two release UPDATEs; stored supplied/survivor/prior counters avoid aggregate scans.                                                                                                                                                                                                                  | PK source, PK(source,id) generation throughout; ≤3 statements/point rows per control operation (activeRun 1 statement/2 point rows), constant bytes, O(log R), k ≤2; every transaction adds 2 controls. The durable per-source run lease and atomic SQLite updates intentionally coordinate workers sharing one state file and its single writer; ImportSession guards live same-source coordinators before capability rotation. Separate imports scale through separate state files or independent sources; importer writes use the API, so platform bounds do not depend on this deployment boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures seal. `tests/run-store-growth.test.ts`: `Run control stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Run stage one record                                                                | SELECT generation; INSERT OR IGNORE entry; SELECT member; optional survivor UPDATE member; UPDATE generation counters. Duplicate branch instead UPDATEs invalid flag. Stores bounded projection/row JSON and seen-generation marker. The entry PK(source,run_id,record_key) detects duplicate native keys; the invalid flag commits before throwing.                                                                                                                                                                                                                                                                                | Generation/entry/member PK exact seeks; ≤5 statements/point rows (duplicate 3) per record, +2 transaction controls per commit (the coordinator stages up to 100 records per commit; a record failing in the middle keeps the records before it and its invalid mark); k ≤3, O(log R + M) accepted bytes/work, O(M) live serialized state independent of H, no retained source-key array; H unique records occupy O(HM) durable staging bytes already included in R. Descriptor validation enumerates caller object own keys before rejection, so hostile object width is not bounded by the accepted JSON cap. Source-record mode serializes normalizedRecord with a separate hard 1 MiB budget, then adds the fixed sourceKind wrapper; public projection mode remains 64 KiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/run-store-growth.test.ts`: `Run staging stays within its bound as R grows`. `tests/record-caps-growth.test.ts`: `larger sanitized record stage and exact key/page reads stay indexed as unrelated state grows`; `hard projection cap counts serialized record bytes independently of its fixed wrapper`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Run pages and stored projection/observation                                         | `pageStaged`: source/generation capability join + entry range; `pageAcknowledged`: acknowledged range; `pagePending`: generation SELECT + `run_envelope_pending(source,run_id,pending,record_key,envelope_index)` range. `pageVanished`: generation no-op capability UPDATE + `run_missing(source,active,seen,record_key)` composite range with generation and cursor-member PK subqueries. `key`: source, optional baseline entry, acknowledgement, optional generation and staged entry SELECTs; returns persisted row/projection JSON and omissions, without parsing a private command plan.                                     | Staged/pending/vanished: 2 statements, acknowledged: 1; staged ≤r+2 rows, pending ≤r+1, vanished ≤r+3 point/range touches including capability write. Entry/acknowledgement PK and envelope index keysets avoid scans; vanished skips survivors/inactive history through index predicates. `key` ≤5 point SELECTs. O(log R + rM) page work/bytes; key O(log R + M). Projection is persisted JSON, not a platform-wide read; no write except vanished capability check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures pending. `tests/run-store-growth.test.ts`: `Run projection page stays within its bound as R grows`; `Run vanished page stays within its bound as R grows`; `Run key observation stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Run classify, prepare and omission checks                                           | SELECT generation/entry; missing entry: SELECT member, INSERT entry, re-SELECT entry. First classification: SELECT acknowledgement, baseline-entry seek with source-pointer subquery; per command SELECT payload, optional INSERT payload, INSERT command; INSERT each split envelope; UPDATE entry/generation. Omissions: UPDATE entry, SELECT each saved command, optional UPDATE command/envelope, UPDATE remaining. Resolution when eligible: UPDATE entry, UPSERT acknowledgement, UPDATE generation.                                                                                                                          | All PK seeks: entry(source,run_id,key), acknowledgement/member(source,key), payload(source,command_key), command(source,run_id,command_key), source/generation as above. ≤14+7q statements, ≤15+7q point-row touches (baseline subquery adds one), +2 controls; O((1+q) log R + M) bytes/work, q ≤100 for classify or ≤300 for prepare, omissions ≤3, saved keys ≤300; private plans ≤2 MiB split into at most q envelopes, each ≤100 commands/65,536 bytes; replay avoids history scans and rejects changed bytes for a reused key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures one-command classification. `tests/run-store-growth.test.ts`: `Run omission check stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Run acknowledgement and finalize checkpoint                                         | Ack: SELECT generation, per result SELECT command; successful unfinished results UPDATE command/envelope, group by record for UPDATE remaining RETURNING and optional SELECT entry, optional three-statement resolution above. Finalize: SELECT generation, entry PK keyset page, UPSERT member per entry, then UPDATE generation cursor or UPDATE source pointer/count + generation complete.                                                                                                                                                                                                                                      | Ack ≤1+8r point statements/rows +2 controls; O(r log R + rM) work, response envelope ≤65,536 bytes. Finalize ≤r+4 statements, ≤2r+3 row touches, +2 controls; O(r log R + rM), durable cursor, no COUNT. Across pages finalization writes all S+D entries, including unchanged records: O((S+D) log R); each call remains independent of total history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures acknowledgement. `tests/run-store-growth.test.ts`: `Run finalize stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Record get, count, page and upsert (`record-store.ts`)                              | Get SELECT record; count SELECT stored count; page SELECT keyset range. Put: SELECT previous state, UPSERT record, optional UPSERT/increment or UPDATE/decrement count.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Record PK(source,record_key), counts PK(source); get/count 1 statement/≤1 row, page 1/≤r rows; put 2–3 point statements/rows +2 controls, k ≤2. Metadata bytes constant, page O(r) bytes; O(log R + r) reads, O(log R) put, no count scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/sqlite-growth.test.ts`: `actual record store uses indexed keys at three analyzed scales` measures get/count/page. `tests/record-store-growth.test.ts`: `Record upsert stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Binding lookup, candidate page and media projection (`record-bindings.ts`)          | `claim`: SELECT owner; `journal`/`mediaPending`: SELECT owner/key journal; `candidates`: SELECT current owner/group candidate keyset; `mediaIds`: SELECT binding then current cover-key media row. No retired-history enumeration.                                                                                                                                                                                                                                                                                                                                                                                                  | PKs: records(source,external_id); journal/media(source,external_id,key); candidates(source,external_id,field_group,candidate). 1 statement/point row per lookup; page 1 statement/≤r rows; projection ≤2 statements/point rows. O(log B + rM) page bytes/work, projection O(log B + M); r ≤100/group, reserved/current capacity ≤100/group and ≤300/record, M ≤65,536 per snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/bindings-growth.test.ts`: `Binding lookup stays within its bound as B grows`; `Binding candidate page stays within its bound as B grows`; `Media projection stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Binding prepare, acknowledge and taken-down write                                   | Prepare SELECTs binding/journal; create INSERTs binding; propose SELECTs group count, optionally INSERTs group, UPDATEs group/record counts; retract SELECTs candidate; finally INSERT journal. Ack SELECTs binding/journal; create UPDATEs binding; propose SELECTs/INSERTs candidate; retract SELECTs/DELETEs candidate and UPDATEs group/record counts; finally UPDATE acknowledgement. TakenDown: SELECT/UPDATE binding.                                                                                                                                                                                                        | Owner-prefixed PKs above plus groups(source,external_id,field_group), every statement exact keyed. Prepare create/propose/retract ≤4/7/4 statements, ack ≤4/5/7 (replay 2), takenDown 2; same upper bound on point rows, +2 transaction controls each. O(log B + M), constant k ≤4; one command per prepared envelope; no lookup of all journals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/bindings-growth.test.ts`: `Binding write stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Media prepare, accept and observe                                                   | Prepare SELECT binding/media, INSERT media, UPDATE cover_key (replay only two reads). Accept/observe SELECT binding/media then UPDATE receipt/status; accept replay or terminal rejected replay skips UPDATE.                                                                                                                                                                                                                                                                                                                                                                                                                       | Same owner/media PKs: prepare ≤4 point statements/rows, accept/observe ≤3, +2 controls; O(log B + M), constant k ≤2, snapshot M ≤65,536; no SQL polling loop, projection follows current cover_key, not all historical jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/bindings-growth.test.ts`: `Media write stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Media resolution (`media-resolver.ts`)                                              | Snapshots/validates all supplied assets before effects; SELECTs claim and one cover fence, then sequentially seeks exact media journals, prepares/replays POST bytes and persists receipts/statuses via bindings; returns available URL-to-ID mappings and per-asset outcomes.                                                                                                                                                                                                                                                                                                                                                      | At most 64 distinct assets, each snapshot ≤65,536 bytes, depth ≤32 and ≤65,536 nodes; O(64M) retained input/results, O(64 log B + 64M log M) local work including canonical snapshot key sorting, independent of history. One fence plus ≤1 POST and ≤1 status GET per asset: ≤129 logical calls, one in flight and no inline polling waits. HTTP retries/deadlines apply only when the injected port uses the bounded adapter; arbitrary port latency and repeated resolve invocations have no aggregate deadline. Terminal saved statuses avoid polling; accepted receipts avoid POST replay; no source-baseline write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/media-resolver-outcomes.test.ts`: `all durable cover outcomes pass with production resolver`. A resolver growth check across retained media history is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Checkpointed staging resume (`staging-checkpoint.ts`, `run-store.ts`)               | Opt-in SHA-256 of complete local bytes, then one INSERT prefix row and checkpoint UPDATE per accepted record in the staging transaction; resume PK-seeks ordinal then record key. Seal deletes the checkpoint so it is not an application cursor.                                                                                                                                                                                                                                                                                                                                                                                   | Acquire O(B) hash plus ordinary O(B+N log M) decode/stage. Resume O(B) hash plus O(B) redecode, K PK seeks, convert/insert only N-K. Live memory O(max frame); no O(K) key set. Unrelated sources do not add prefix work. Native transport starts only after seal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Coordinator acquisition and reconciliation (`importer.ts`)                          | Acquires source ownership, converts/stages the source once to EOF before effects, seals, keyset-pages staged/vanished/pending work, plans current owned candidates, dispatches saved envelopes and finalizes durable pages.                                                                                                                                                                                                                                                                                                                                                                                                         | Acquisition is O(supplied bytes + S log R), with O(M) per-record conversion and separate normalized staging budget; reconciliation/finalization visit S+D records, O((S+D)((1+q) log R + (1+q) log B + M)) including bounded command work. Pages retain O(rM), r ≤100, current candidates ≤300/record; no accumulated source-key set or catalogue/history enumeration. Result arrays default empty with streaming sinks; opt-in key collection caps at 10,000 total. Resume drains durable pending work before newer input; replay preserves stored command bytes and source revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`; `source acquisition is explicitly linear and reaches EOF once before any effect`. `tests/import-session.test.ts`: `uncertain run replays original source and command bodies before changed input is consumed`.                                                                                                                                                                                                                                                                                                                                                  |
| Session ownership and recovery (`import-session.ts`)                                | Same connection supplies RunStore and RecordBindings; acquire SELECTs/upserts import_owners by source in an immediate transaction, checks Linux PID/boot/birth identity, then permits durable capability rotation; release verifies capability and deletes the exact owner.                                                                                                                                                                                                                                                                                                                                                         | PK(source) exact seeks: acquire ≤2 statements plus 2 transaction controls, busy ≤1 plus controls; reopen checks owner then reads active run and rotates its lease, ≤4 statements plus 2 controls; release 2 statements. O(log R) database work with constant identity bytes and no history scan; O(number of held sources) local ownership/close work. Live same-source owners exclude another connection; dead process recovery needs no timeout, while independent sources proceed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`. `tests/import-session.test.ts`: `same-file live owners exclude another connection while independent sources proceed`; `guard release permits capability rotation and fences old RunStore handles`; `dead process owner recovers immediately with birth identity and no lease timeout`.                                                                                                                                                                                                                                                                          |
| Kernel writes and fence reads per record/batch                                      | `Importer` checks three exact tuple fences per planning/dispatch phase, prepares bindings and immutable RunStore envelopes before writes, then validates and persists receipts. Bootstrap sends one create; dispatch sends one saved envelope with fenced groups removed. No accumulated kernel subject/candidate enumeration; default Open Library references use exact local binding point reads.                                                                                                                                                                                                                                 | One batch call per envelope e, e ≤ q ≤300 per prepared record, each ≤100 commands/65,536 bytes; optional bootstrap adds one call. A planning pass reads ≤6 fences (unchanged: 3), dispatch adds 3 per envelope, so ≤7+4q logical calls for planning plus one dispatch pass. Default Open Library planning adds at most 64 indexed local claim reads for supplied relation keys; this also applies to unchanged records before the dependency signature comparison. Coordinator writes multiply each logical call by ≤8 bounded transport invocations, each with ≤A+1 physical sends (A ≤5, including one-time 401 renewal), and O(M) per-send bytes under the adapter caps above. Resume can dispatch pending work before planning and again afterwards; repeated run invocations have no lifetime retry cap. Current owned candidate reads hold ≤300 candidates, ≤100/group, using bounded local keysets; pages hold O(rM), per-record work O((1+q) log R + (1+q) log B + M + 64 log C), where C is indexed local claim count. One compact dependency signature row is retained per acknowledged Open Library record. The coordinator reuses journal bytes/keys, hashes planned identities into source-prefixed keys, and does not batch across records. Arbitrary injected media/identifier providers have no enforced call bound; kernel internal cost is outside these files. | `tests/import-fetch-growth.test.ts`: `network uncertainty preserves exact bytes, URL, method and caller headers`; `only POST with a valid caller Idempotency-Key retries arbitrary writes`. `tests/importer-growth.test.ts`: `client transport sends each supplied bounded batch once as input grows`. `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`; `source acquisition is explicitly linear and reaches EOF once before any effect`.                                                                                                                                                                        |
| Operation                                                                           | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Growth check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------      | -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                     | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI entry and bounded input (`cli.ts`)                                              | Parses bounded argv and validates the exact origins before I/O; reads and imports one owner-only account key, opens one file or stdin with no-follow descriptor custody, owns bounded chunks, optionally gunzips Open Library/Wikidata dumps, and carries Open Library's native TSV date into record metadata. The `diagnostics` subcommand delegates before credentials or network construction. gzip is rejected for VNDB/Bangumi before credentials or state.                                                                                                                                                                    | O(A + K) preflight with A ≤16 KiB and key K ≤16 KiB. One input read, O(C+B) gzip+decoder work; owned compressed and decoded windows ≤256 KiB from backings ≤1 MiB, plus one Open Library line ≤256 KiB+1. No whole-file materialization or source-key set; diagnostics ≤4 KiB. Credential network bounds are stated above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `services/importer/tests/cli-outcomes.test.ts`: real source pipeline outcomes. `specs/imports-cli.test.ts`: actual SQLite work stays fixed and streaming input grows linearly across three scales. `tests/diagnostics-cli.test.ts`: diagnostics routing, help and handle closure. `tests/compressed-dump.test.ts` and `tests/compressed-dump-cli.test.ts`: gzip admission, integrity and equivalent decoded identity.                                                                                                                                                                                                                                                                                                      |
| Streaming gzip dump transform (`compressed-dump.ts`)                                | Sits below the common owned byte reader. Member-framed `createInflateRaw` validates CRC/ISIZE/EOF; concatenated members including an empty last member are one complete input; trailing non-gzip bytes fail. Never falls back to raw text. Reports compressed and decoded bytes separately.                                                                                                                                                                                                                                                                                                                                         | O(C+B) work; retained windows O(Wc+Wd) with Wc,Wd ≤256 KiB plus zlib's configured high-water mark; decoded budget default 256 GiB with at most one window overshoot. Memory independent of whole-file size. Codec buffering is the configured production high-water mark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/compressed-dump-growth.test.ts`: production raw and gzip paths at 32/128/512 records, ratio four, highly compressible input and a slow consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Retain conversion diagnostics (`run-store.ts`, `importer.ts`)                       | Validates the converter diagnostic array without accessors; INSERT the exact generation/record/phase identity; INSERT diagnostic-bearing review keys; UPDATE stored generation counts. Resume of the same digest/revision/converter identity is a PK seek with no second write.                                                                                                                                                                                                                                                                                                                                                     | Generation/entry/diagnostic PK exact seeks; ≤4 statements/point rows per record plus 2 transaction controls when folded into the staging commit; O(D + log R) extra work, D ≤228 and vector ≤65,536 bytes; no unrelated-generation reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/conversion-diagnostics-growth.test.ts`: `staging diagnostic retention stays indexed as diagnostic-bearing records and unrelated history grow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Retire superseded complete generations (`retention.ts`, `retention-cli.ts`)         | Read-only list/plan of one source's generations; apply deletes generation-local rows for at most 100 explicitly named complete non-baseline IDs. Point-reads current baseline, recoverable pin, sequence, present_count and owner; keyset DELETE pages over entries/envelopes/commands/diagnostics/aggregates/leftover staging checkpoint-prefix/VNDB run tables. Shared acknowledgements, bindings and payloads are unread.                                                                                                                                                                                                        | Indexed source/run prefixes; O(log H+p) per page, p≤100, selected ≤100, memory O(p+100). COUNT/EXISTS cost is the examined capture. Crash cursor persists with each bounded page. No OFFSET, payload anti-join, VACUUM or whole-history scan. Schema discovery (`run_retention_work`, `run_generation_seq`) is separate from steady-state deletion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/retention-growth.test.ts`: `retention plan, apply and restart stay indexed as selected-capture rows and unrelated history grow` at 32/128/512.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Review diagnostic pages and exact record (`diagnostics-cli.ts`)                     | Opens an existing regular file read-only with `O_NOFOLLOW`; source/generation point lookup; indexed diagnostic-bearing keyset page; exact record PK prefix. Releases handles before rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                      | 1 source + 1 generation point read, then 1 keyset SELECT of P+1 review keys and P diagnostic PK prefix reads; O(log(H+N)+P*D) local work, P≤100, output/memory O(P*D). No OFFSET, schema writes, lease, or projection JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/diagnostics-cli-growth.test.ts`: `diagnostic pages and exact lookup stay indexed as current omissions and unrelated history grow`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Dump lines and parsing (`dumps.ts`, `dumps-bytes.ts`)                               | Reads decompressed bytes; decodes/parses one line and yields duplicates unchanged to durable RunStore staging; no SQL/writes/API or retained native-key set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | O(M) scanning, amortized copying and parsing per record line; O(C + L) live input, line buffers, decoded scratch and COPY framing metadata, independent of H. L is caller `maxRecordBytes` + 1, + 2 for Wikidata, or max(cap + 1, 65,536) for VNDB outside COPY; accepted records remain at most cap. Chunk backing is checked before scanning/copying/yielding: default 256 KiB, maximum 1 MiB, including tiny views of larger buffers. Unterminated tails reject after L + 1 examined bytes; no next chunk is pulled before yielding. Record caps default to 256 KiB and cannot exceed 1 MiB, independently of chunk backing and normalized projection budgets; total scanning is linear in supplied bytes and skipped lines have no count cap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/dumps-growth.test.ts`: `streaming parser growth follows supplied bytes with bounded per-record read-ahead`; `oversized unterminated tails abort with the same byte bound at every scale`; `one fixed admitted backing is charged in full and only the first record is visited before yield`. `tests/reader-bounds-outcomes.test.ts`: `all bounded reader outcomes pass with production parser`. Duplicate uniqueness is measured by the run-staging growth check below. `tests/record-caps-growth.test.ts`: `one-record acquisition has linear actual parser work outside database measures`; `record boundaries retain native framing overhead, UTF-8 accounting and upstream cleanup`.                            |
| Bangumi pure conversion (`../../packages/conversion/src/bangumi.ts`)                | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Normalized source ≤64 KiB, ≤64 ordinary tags and ≤64 public metadata tags, ≤6 commands and one cover intent; summary Text snapshot ≤32 KiB, infobox ≤64 KiB characters.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `../../packages/conversion/tests/bangumi-growth.test.ts`: `fixed source conversion intercepts I/O at every unrelated population scale`. `../../packages/conversion/tests/logical-growth.test.ts`: `Bangumi: actual unrelated conversions leave anchor return bytes identical`; `Bangumi: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                               |
| VNDB pure conversion (`../../packages/conversion/src/vndb.ts`)                      | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Normalized grouped record ≤64 KiB, ≤64 titles, ≤32 links, strings ≤4096 bytes and ≤98 commands; no assets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `../../packages/conversion/tests/vndb-growth.test.ts`: `fixed conversion performs zero SQL network or file I/O across unrelated populations`. `../../packages/conversion/tests/logical-growth.test.ts`: `VNDB: actual unrelated conversions leave anchor return bytes identical`; `VNDB: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                               |
| Open Library pure conversion (`../../packages/conversion/src/open-library.ts`)      | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Converter normalized record ≤2 MiB, prose ≤1 MiB, field arrays ≤64, combined author/work relations ≤64 and proposals ≤100; importer admission/staging independently enforce the smaller record/projection caps above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `../../packages/conversion/tests/open-library-growth.test.ts`: `fixed conversion touches zero SQL and network across unrelated catalogue and history growth`. `../../packages/conversion/tests/logical-growth.test.ts`: `Open Library: actual unrelated conversions leave anchor return bytes identical`; `Open Library: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                               |
| Wikidata pure conversion (`../../packages/conversion/src/wikidata.ts`)              | Reads supported native fields, normalizes source data, hashes the digest and returns proposals/metadata; zero SQL, network or persistent catalogue state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | O(M) work and logical retained return bytes per record, independent of unrelated catalogue/history size. Native supported record ≤128 KiB, ≤64 statements and terms, ≤15 references and ≤16 snaks per bounded collection, ≤100 commands; no assets or instrumentation metrics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `../../packages/conversion/tests/wikidata-growth.test.ts`: `fixed conversion return is byte-identical after unrelated actual conversions`. `../../packages/conversion/tests/logical-growth.test.ts`: `Wikidata: actual unrelated conversions leave anchor return bytes identical`; `Wikidata: whole-return logical bytes have at most linear incremental slopes`.                                                                                                                                                                                                                                                                                                                                                          |
| VNDB raw entry chunks (`vndb-tables.ts`)                                            | Admits full backing before scanning supported rows or discarding user/unknown entries; only supported entries allocate the 64 KiB row buffer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shared chunk validator defaults to 256 KiB with a hard 1 MiB ceiling; the table loader further restricts configuration to ≤256 KiB. O(C + M) live input/row scratch (plus bounded spool pages above), with C bounded before retention/copy even for empty views; supported scanning is O(record bytes), ignored bodies count bytes without decoding. Total work is linear in admitted input, within archive admission limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tests/vndb-chunk-growth.test.ts`: `raw six-entry staging SQL stays constant across accumulated native keys and source history`; `native input visits grow linearly over 1/8/64 owned chunks with bounded admitted backing`; `late oversized known/header/ignored backings fail before byte access and erase staged rows`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| VNDB archive streaming and staging (`vndb-tables.ts`)                               | `begin`: INSERT run; `inspect`: SELECT run, both PK(source,run_id). Stage: keyed state UPDATE, stream six supported paths, INSERT spool before header or INSERT row + UPDATE run counters after header; drain spool via PK(source,run_id,table_name,sequence) and DELETE each consumed row; finish with keyed ready UPDATE (failure: failed UPDATE + cleanup).                                                                                                                                                                                                                                                                      | O(M) bytes scanned/decoded per supported row, raw row M ≤ 65,536 and serialized payload O(M); one fixed row buffer plus ≤32 spooled rows/decoded scratch and C backing bytes, O(C + 32M) live storage, no next chunk prefetch. Every entry is admitted before its body: total decompressed entry bytes default to 16 GiB (hard 64 GiB), entry count to 512 (hard 2048), including unknown entries and directories. Safe-integer declared sizes reserve aggregate bytes; actual bytes must match and reject over-declaration before scanning. Ignored entries are drained without decoding/row buffering. Full chunk backing is checked before retention or byte access on every raw entry, with no prefetch; `readArchive` additionally bounds tar framing and yields owned payload copies ≤512 bytes. Supported input rows capped by maxRows (default 2,000,000, maximum 10,000,000), VN records by maxSourceRecords (500,000/1,000,000). Direct row: 2 point statements; spooled row: 1 INSERT, then 1 range SELECT per ≤32 rows, 2 insert/counter statements + 1 DELETE per row. Rows touched O(k), cost O(k log R + supplied bytes); no prior-run scan.                                                                                                                                                                                                                       | `tests/vndb-tables-growth.test.ts`: `VNDB staging stays within its bound as R grows`. `tests/vndb-archive-limits-growth.test.ts`: `fixed admission rejection and ready staging keep exact-run SQL and live buffers constant over history`; `entry and byte populations stop exactly before the excessive body with linear admitted input`; `unsafe declarations, lying bodies and oversized backing close raw input without scanning or draining`.                                                                                                                                                                                                                                                                         |
| VNDB validation, projection page and cleanup                                        | Validation walks each table's PK(source,run_id,table_name,id,child) keyset; each VN seeks titles + metadata, each child seeks its VN. Page: inspect, numeric `vndb_table_ids` range, then metadata/title PK seeks per VN. Cleanup: row/spool PK prefix range SELECT and exact DELETE per row.                                                                                                                                                                                                                                                                                                                                       | Validation: 1 SELECT per ≤32 rows (plus terminal ranges), 2 SELECTs per VN or 1 per child; O(S log R + SM), not history. Title seek LIMIT children+1 ≤65 detects overflow; children ≤64; metadata 1 row. Page: 2+2r SELECTs, ≤r+1 numeric rows plus ≤66r child/metadata rows and 1 run row, O(r log R + 64rM) bytes/work. Cleanup: 1 SELECT per ≤32 rows plus 1 DELETE per row, O(k log R + kM), ending each table with a short/empty page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/vndb-tables-growth.test.ts`: `VNDB projection stays within its bound as R grows`; `VNDB validation stays within its bound as R grows`; `VNDB cleanup stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Fetch one request (`import-fetch.ts`)                                               | Reads/copies request once without teeing its stream; checks retry identity, gets one token, sends exact buffered bytes; cancels retried response bodies, buffers the final response before returning; no SQLite.                                                                                                                                                                                                                                                                                                                                                                                                                    | O(M) amortized CPU/owned buffered bytes and O(aM) transmitted bytes; a defaults to 3, maximum 5 (unsafe writes 1), with ≤a−1 waits. Lower-only request/response caps default to 2 MiB/1 MiB; final response chunks also reject backing >1 MiB before copying. Each full producer backing buffer must be ≤2 MiB before retention or copy, including empty/tiny views and direct ArrayBuffer/view bodies; accepted chunks are copied and released, so live memory is O(M + C) with C ≤2 MiB, independent of chunk history. Known excessive request length rejects before pulling; overflow cancels without another pull. GET/HEAD and keyed POST retry transport/429/5xx; batch POST requires nonempty distinct command keys. Fallback min(1,000×2^(attempt−1),30,000) ms; waits cap at 30s each/60s total and the whole invocation at 120s, all lower-only. An advertised wait beyond budget returns the bounded response without shortening the wait; unrepresentable delays do likewise. Deadline/caller abort interrupts body reads, token, upstream, cancellation and sleep.                                                                                                                                                                                                                                                                                                   | `tests/import-fetch-growth.test.ts`: `real adapter sends two attempts and linear supplied bytes at M = 1, 8, 64`; `body cap counts UTF-8 bytes and stops streaming before reading the remainder`; `repeated 429 is capped, cancels only retried bodies, and returns the actual final response`; `HTTP-date Retry-After uses the injected clock and never shortens advertised waits`. `tests/http-bounds-outcomes.test.ts`: `all bounded HTTP outcomes pass with production fetch`. `tests/request-backing-growth.test.ts`: `fixed visible bytes survive 1/8/64 chunks and five exact adapter attempts at both entrypoints`; `oversized backing stops at the first offending pull, including empty views and later chunks`. |
| Run start, capability, seal and checkpoint controls                                 | `begin`: SELECT source, UPSERT source lease/sequence, INSERT generation; busy: SELECT only. `activeRun`: source/generation join; `source`: SELECT source. `reopen`: SELECT generation + UPDATE lease. `abandon`: SELECT generation + UPDATE generation/source on release. `seal`: SELECT generation + UPDATE ready counters or two release UPDATEs; stored supplied/survivor/prior counters avoid aggregate scans.                                                                                                                                                                                                                  | PK source, PK(source,id) generation throughout; ≤3 statements/point rows per control operation (activeRun 1 statement/2 point rows), constant bytes, O(log R), k ≤2; every transaction adds 2 controls. The durable per-source run lease and atomic SQLite updates intentionally coordinate workers sharing one state file and its single writer; ImportSession guards live same-source coordinators before capability rotation. Separate imports scale through separate state files or independent sources; importer writes use the API, so platform bounds do not depend on this deployment boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures seal. `tests/run-store-growth.test.ts`: `Run control stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Run stage one record                                                                | SELECT generation; INSERT OR IGNORE entry; SELECT member; optional survivor UPDATE member; UPDATE generation counters. Duplicate branch instead UPDATEs invalid flag. Stores bounded projection/row JSON and seen-generation marker. The entry PK(source,run_id,record_key) detects duplicate native keys; the invalid flag commits before throwing.                                                                                                                                                                                                                                                                                | Generation/entry/member PK exact seeks; ≤5 statements/point rows (duplicate 3) per record, +2 transaction controls per commit (the coordinator stages up to 100 records per commit; a record failing in the middle keeps the records before it and its invalid mark); k ≤3, O(log R + M) accepted bytes/work, O(M) live serialized state independent of H, no retained source-key array; H unique records occupy O(HM) durable staging bytes already included in R. Descriptor validation enumerates caller object own keys before rejection, so hostile object width is not bounded by the accepted JSON cap. Source-record mode serializes normalizedRecord with a separate hard 1 MiB budget, then adds the fixed sourceKind wrapper; public projection mode remains 64 KiB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/run-store-growth.test.ts`: `Run staging stays within its bound as R grows`. `tests/record-caps-growth.test.ts`: `larger sanitized record stage and exact key/page reads stay indexed as unrelated state grows`; `hard projection cap counts serialized record bytes independently of its fixed wrapper`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Run pages and stored projection/observation                                         | `pageStaged`: source/generation capability join + entry range; `pageAcknowledged`: acknowledged range; `pagePending`: generation SELECT + `run_envelope_pending(source,run_id,pending,record_key,envelope_index)` range. `pageVanished`: generation no-op capability UPDATE + `run_missing(source,active,seen,record_key)` composite range with generation and cursor-member PK subqueries. `key`: source, optional baseline entry, acknowledgement, optional generation and staged entry SELECTs; returns persisted row/projection JSON and omissions, without parsing a private command plan.                                     | Staged/pending/vanished: 2 statements, acknowledged: 1; staged ≤r+2 rows, pending ≤r+1, vanished ≤r+3 point/range touches including capability write. Entry/acknowledgement PK and envelope index keysets avoid scans; vanished skips survivors/inactive history through index predicates. `key` ≤5 point SELECTs. O(log R + rM) page work/bytes; key O(log R + M). Projection is persisted JSON, not a platform-wide read; no write except vanished capability check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures pending. `tests/run-store-growth.test.ts`: `Run projection page stays within its bound as R grows`; `Run vanished page stays within its bound as R grows`; `Run key observation stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Run classify, prepare and omission checks                                           | SELECT generation/entry; missing entry: SELECT member, INSERT entry, re-SELECT entry. First classification: SELECT acknowledgement, baseline-entry seek with source-pointer subquery; per command SELECT payload, optional INSERT payload, INSERT command; INSERT each split envelope; UPDATE entry/generation. Omissions: UPDATE entry, SELECT each saved command, optional UPDATE command/envelope, UPDATE remaining. Resolution when eligible: UPDATE entry, UPSERT acknowledgement, UPDATE generation.                                                                                                                          | All PK seeks: entry(source,run_id,key), acknowledgement/member(source,key), payload(source,command_key), command(source,run_id,command_key), source/generation as above. ≤14+7q statements, ≤15+7q point-row touches (baseline subquery adds one), +2 controls; O((1+q) log R + M) bytes/work, q ≤100 for classify or ≤300 for prepare, omissions ≤3, saved keys ≤300; private plans ≤2 MiB split into at most q envelopes, each ≤100 commands/65,536 bytes; replay avoids history scans and rejects changed bytes for a reused key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures one-command classification. `tests/run-store-growth.test.ts`: `Run omission check stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Run acknowledgement and finalize checkpoint                                         | Ack: SELECT generation, per result SELECT command; successful unfinished results UPDATE command/envelope, group by record for UPDATE remaining RETURNING and optional SELECT entry, optional three-statement resolution above. Finalize: SELECT generation, entry PK keyset page, UPSERT member per entry, then UPDATE generation cursor or UPDATE source pointer/count + generation complete.                                                                                                                                                                                                                                      | Ack ≤1+8r point statements/rows +2 controls; O(r log R + rM) work, response envelope ≤65,536 bytes. Finalize ≤r+4 statements, ≤2r+3 row touches, +2 controls; O(r log R + rM), durable cursor, no COUNT. Across pages finalization writes all S+D entries, including unchanged records: O((S+D) log R); each call remains independent of total history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `tests/run-store-growth.test.ts`: `fixed run-state operations stay indexed at three scales` measures acknowledgement. `tests/run-store-growth.test.ts`: `Run finalize stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Record get, count, page and upsert (`record-store.ts`)                              | Get SELECT record; count SELECT stored count; page SELECT keyset range. Put: SELECT previous state, UPSERT record, optional UPSERT/increment or UPDATE/decrement count.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Record PK(source,record_key), counts PK(source); get/count 1 statement/≤1 row, page 1/≤r rows; put 2–3 point statements/rows +2 controls, k ≤2. Metadata bytes constant, page O(r) bytes; O(log R + r) reads, O(log R) put, no count scan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/sqlite-growth.test.ts`: `actual record store uses indexed keys at three analyzed scales` measures get/count/page. `tests/record-store-growth.test.ts`: `Record upsert stays within its bound as R grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Binding lookup, candidate page and media projection (`record-bindings.ts`)          | `claim`: SELECT owner; `journal`/`mediaPending`: SELECT owner/key journal; `candidates`: SELECT current owner/group candidate keyset; `mediaIds`: SELECT binding then current cover-key media row. No retired-history enumeration.                                                                                                                                                                                                                                                                                                                                                                                                  | PKs: records(source,external_id); journal/media(source,external_id,key); candidates(source,external_id,field_group,candidate). 1 statement/point row per lookup; page 1 statement/≤r rows; projection ≤2 statements/point rows. O(log B + rM) page bytes/work, projection O(log B + M); r ≤100/group, reserved/current capacity ≤100/group and ≤300/record, M ≤65,536 per snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/bindings-growth.test.ts`: `Binding lookup stays within its bound as B grows`; `Binding candidate page stays within its bound as B grows`; `Media projection stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Binding prepare, acknowledge and taken-down write                                   | Prepare SELECTs binding/journal; create INSERTs binding; propose SELECTs group count, optionally INSERTs group, UPDATEs group/record counts; retract SELECTs candidate; finally INSERT journal. Ack SELECTs binding/journal; create UPDATEs binding; propose SELECTs/INSERTs candidate; retract SELECTs/DELETEs candidate and UPDATEs group/record counts; finally UPDATE acknowledgement. TakenDown: SELECT/UPDATE binding.                                                                                                                                                                                                        | Owner-prefixed PKs above plus groups(source,external_id,field_group), every statement exact keyed. Prepare create/propose/retract ≤4/7/4 statements, ack ≤4/5/7 (replay 2), takenDown 2; same upper bound on point rows, +2 transaction controls each. O(log B + M), constant k ≤4; one command per prepared envelope; no lookup of all journals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/bindings-growth.test.ts`: `Binding write stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Media prepare, accept and observe                                                   | Prepare SELECT binding/media, INSERT media, UPDATE cover_key (replay only two reads). Accept/observe SELECT binding/media then UPDATE receipt/status; accept replay or terminal rejected replay skips UPDATE.                                                                                                                                                                                                                                                                                                                                                                                                                       | Same owner/media PKs: prepare ≤4 point statements/rows, accept/observe ≤3, +2 controls; O(log B + M), constant k ≤2, snapshot M ≤65,536; no SQL polling loop, projection follows current cover_key, not all historical jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/bindings-growth.test.ts`: `Media write stays within its bound as B grows`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Media resolution (`media-resolver.ts`)                                              | Snapshots/validates all supplied assets before effects; SELECTs claim and one cover fence, then sequentially seeks exact media journals, prepares/replays POST bytes and persists receipts/statuses via bindings; returns available URL-to-ID mappings and per-asset outcomes.                                                                                                                                                                                                                                                                                                                                                      | At most 64 distinct assets, each snapshot ≤65,536 bytes, depth ≤32 and ≤65,536 nodes; O(64M) retained input/results, O(64 log B + 64M log M) local work including canonical snapshot key sorting, independent of history. One fence plus ≤1 POST and ≤1 status GET per asset: ≤129 logical calls, one in flight and no inline polling waits. HTTP retries/deadlines apply only when the injected port uses the bounded adapter; arbitrary port latency and repeated resolve invocations have no aggregate deadline. Terminal saved statuses avoid polling; accepted receipts avoid POST replay; no source-baseline write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/media-resolver-outcomes.test.ts`: `all durable cover outcomes pass with production resolver`. A resolver growth check across retained media history is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Checkpointed staging resume (`staging-checkpoint.ts`, `run-store.ts`)               | Opt-in SHA-256 of complete local bytes, then one INSERT prefix row and checkpoint UPDATE per accepted record in the staging transaction; resume PK-seeks ordinal then record key. Seal deletes the checkpoint so it is not an application cursor.                                                                                                                                                                                                                                                                                                                                                                                   | Acquire O(B) hash plus ordinary O(B+N log M) decode/stage. Resume O(B) hash plus O(B) redecode, K PK seeks, convert/insert only N-K. Live memory O(max frame); no O(K) key set. Unrelated sources do not add prefix work. Native transport starts only after seal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Coordinator acquisition and reconciliation (`importer.ts`)                          | Acquires source ownership, converts/stages the source once to EOF before effects, seals, keyset-pages staged/vanished/pending work, plans current owned candidates, dispatches saved envelopes and finalizes durable pages.                                                                                                                                                                                                                                                                                                                                                                                                         | Acquisition is O(supplied bytes + S log R), with O(M) per-record conversion and separate normalized staging budget; reconciliation/finalization visit S+D records, O((S+D)((1+q) log R + (1+q) log B + M)) including bounded command work. Pages retain O(rM), r ≤100, current candidates ≤300/record; no accumulated source-key set or catalogue/history enumeration. Result arrays default empty with streaming sinks; opt-in key collection caps at 10,000 total. Resume drains durable pending work before newer input; replay preserves stored command bytes and source revision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`; `source acquisition is explicitly linear and reaches EOF once before any effect`. `tests/import-session.test.ts`: `uncertain run replays original source and command bodies before changed input is consumed`.                                                                                                                                                                                                                                                                                                                                                  |
| Session ownership and recovery (`import-session.ts`)                                | Same connection supplies RunStore and RecordBindings; acquire SELECTs/upserts import_owners by source in an immediate transaction, checks Linux PID/boot/birth identity, then permits durable capability rotation; release verifies capability and deletes the exact owner.                                                                                                                                                                                                                                                                                                                                                         | PK(source) exact seeks: acquire ≤2 statements plus 2 transaction controls, busy ≤1 plus controls; reopen checks owner then reads active run and rotates its lease, ≤4 statements plus 2 controls; release 2 statements. O(log R) database work with constant identity bytes and no history scan; O(number of held sources) local ownership/close work. Live same-source owners exclude another connection; dead process recovery needs no timeout, while independent sources proceed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`. `tests/import-session.test.ts`: `same-file live owners exclude another connection while independent sources proceed`; `guard release permits capability rotation and fences old RunStore handles`; `dead process owner recovers immediately with birth identity and no lease timeout`.                                                                                                                                                                                                                                                                          |
| Kernel writes and fence reads per record/batch                                      | `Importer` checks three exact tuple fences per planning/dispatch phase, prepares bindings and immutable RunStore envelopes before writes, then validates and persists receipts. Bootstrap sends one create; dispatch sends one saved envelope with fenced groups removed. No accumulated kernel subject/candidate enumeration; default Open Library references use exact local binding point reads.                                                                                                                                                                                                                                 | One batch call per envelope e, e ≤ q ≤300 per prepared record, each ≤100 commands/65,536 bytes; optional bootstrap adds one call. A planning pass reads ≤6 fences (unchanged: 3), dispatch adds 3 per envelope, so ≤7+4q logical calls for planning plus one dispatch pass. Default Open Library planning adds at most 64 indexed local claim reads for supplied relation keys; this also applies to unchanged records before the dependency signature comparison. Coordinator writes multiply each logical call by ≤8 bounded transport invocations, each with ≤A+1 physical sends (A ≤5, including one-time 401 renewal), and O(M) per-send bytes under the adapter caps above. Resume can dispatch pending work before planning and again afterwards; repeated run invocations have no lifetime retry cap. Current owned candidate reads hold ≤300 candidates, ≤100/group, using bounded local keysets; pages hold O(rM), per-record work O((1+q) log R + (1+q) log B + M + 64 log C), where C is indexed local claim count. One compact dependency signature row is retained per acknowledged Open Library record. The coordinator reuses journal bytes/keys, hashes planned identities into source-prefixed keys, and does not batch across records. Arbitrary injected media/identifier providers have no enforced call bound; kernel internal cost is outside these files. | `tests/import-fetch-growth.test.ts`: `network uncertainty preserves exact bytes, URL, method and caller headers`; `only POST with a valid caller Idempotency-Key retries arbitrary writes`. `tests/importer-growth.test.ts`: `client transport sends each supplied bounded batch once as input grows`. `tests/importer-reconciliation-growth.test.ts`: `actual coordinator fixed work searches same-source keys/history at three scales; command work is linear`; `source acquisition is explicitly linear and reaches EOF once before any effect`.                                                                                                                                                                        |

When deferred cover recovery finds a currently bound candidate whose exact command key belongs to the run's immutable cover proposal, it retains that acknowledged candidate and omits both its retraction and proposal replay. Older candidates remain eligible for replacement; their retractions must still receive successful receipts, unless the cover group has a valid fence omission. This uses the existing bounded per-record candidate pages and adds no journal or database query.

Bound: Run-store and resolver descriptor validation examines O(K) own keys supplied by the caller, the changes side of the O(changes × log stored N) criterion; this work is independent of stored R/B/H and catalogue/history. Direct in-process callers pay for the objects their code builds, so validation does not reject an arbitrarily wide host object in constant time or cap its pre-validation allocation. External source records are guarded at 1 MiB (256 KiB default), parsed API responses at 1 MiB, and public envelopes and binding snapshots at 65,536 bytes. Private record plans remain capped at 2 MiB and are not public envelopes.
The concrete media resolver bounds calls and scheduled waits per invocation, while injected coordinator providers and repeated run invocations have no lifetime API-call bound.

## Native scalar-feed operator evidence

`services/kernel/test/imports/provider-cli-native.test.ts` calls actual `runImportCli` with an account key provisioned
through native Auth stage/approve/apply, native Access/public grants, the existing kernel runtime and its real worker.
The three independently named cases are:

- `Bangumi account-key CLI imports refreshes reopens and safely stops the native scalar feed`
- `Open Library account-key CLI imports refreshes reopens and safely stops the native scalar feed`
- `Wikidata account-key CLI imports refreshes reopens and safely stops the synthetic native scalar feed`

They pin `bangumi@3` (unversioned) and `open-library@3` (edition revision 11 → 12). Wikidata uses the actual
exported converter revision, currently `wikidata-4`, with synthetic Q571 revision 24681012 → 24681013.
Bangumi retains types 1/2/4 and complete skipped membership for 3/6. Open Library
uses five-column TSV, an independent work and the pinned edition with unresolved native author/work keys. Each
case checks actual tuple claims, retrieved cited candidates, immutable bootstrap bytes/keys/receipts, unchanged
new invocations, a supported-value refresh, independent community adoption and preservation of the last completed
baseline with zero public writes after malformed/truncated input and mass disappearance. Owned key/state files
are mode 0600 on tmpfs; each CLI invocation and all fixture resources are closed.

Run the native acceptance through the worker check queue; landing owns regression and root checks:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/provider-cli-native.test.ts
```

The source cases were frozen at `637f28a6d1`. On the original base with `wikidata-3`, at tested revision
`02fa3231fc`, the native command passed all
three cases with 3,392 assertions (check `db222e74-09b0-47e4-83f6-025e202ba014`), and root typecheck passed
(check `15bbed60-7e96-4489-9965-ba862c069b0c`). Captured first-input bytes were 1,263 / 762 / 3,105 for
Bangumi / Open Library / Wikidata, with 3 / 2 / 2 subjects and 17 / 22 / 21 immutable importer receipts after
refresh. Each source's malformed, truncated and mass-disappearance inputs produced zero public writes and
preserved its completed baseline. Exact consumed-byte and seal counters are emitted in the native check log.

The current producer dependency `17183ec750d8f577bd7e86c570b9638c34b986da` ships `wikidata-4`. The caller
imports its actual `converter_revision` instead of asserting the historical `wikidata-3`; source `lastrevid`,
fixture bytes and business assertions are unchanged. At tested revision `eceb114710`, current-producer native
acceptance passed all three cases with 3,392 assertions (check `3d253830-6c17-40fd-9f11-25934deb5667`).
The log records actual `wikidata-4` proposals, unchanged first-input bytes and receipt counts above, and zero
public writes for all nine unsafe-input stops. The original receipt remains evidence only for its original base.

Local reconciliation preflight passed formatting, direct conversion/importer package compilers, caller TypeScript
parsing and production module/registration resolution to `wikidata-4`. The direct kernel compiler requires a
native database for Reylo SQL analysis (`No database URL` locally); the passing native check supplied that
prerequisite and wrote 683 analyses. No root or sibling regression check was repeated for this reconciliation.

Caller corrections retain exact values and public contracts: the edition type expectation changed from
`schema:BookEdition` to the existing native observation `bf:Instance`; native URL/sameAs property expectations
changed from command-input `{ id }` to public `SnakSchema`'s `{ id, data_type: 'url' }`. Candidate selection uses
strict structural equality instead of JSON member order. Safe acquisition stops require zero Auth requests,
matching lazy token renewal on the first public request. Converter observations use exact repository paths.
The feed fixtures omit cover acquisition, retaining separate
Bangumi CC-BY-SA summary rights and the omission of unknown-licensed Open Library prose. This proves the scalar
operator entrypoint only; it does not add general SourceRecord metadata, words, form/classification, VNDB archive
or statistics, or the deferred cross-surface discovery matrix.

The separate [Bangumi summary and cover CLI caller](../kernel/test/imports/bangumi-cli-media-fixture.ts)
connects the account-key entrypoint to the real media reservation/status API, registered jobs, editor selection,
refreshed pixels and exact cover tuple takedown. Its [verification notes](../../docs/research/imports-audit/bangumi-cli-media.md)
record the frozen original-byte assertion conflict and distinguish privately retained originals from reencoded
public variants. A native pass is not claimed for that assertion.

## Exact CLI acknowledgement interruption

The [native account-key journey](../kernel/test/imports/cli-ack-recovery.test.ts) runs Bangumi and Open Library in
one ordinary Auth/Access/public API world. It captures a committed bulk response and its native receipts, aborts
before local acknowledgement, closes the CLI and reopens the same private SQLite/key paths. The new invocation
drains the sealed generation with its original bytes and keys before a later invocation admits the supplied
successor input. An independent community selection, immutable bootstrap/proposal/media journals and original
native media objects survive. Revoking the Global grant denies replay with the exact old bearer without revealing
stored success. See the [evidence and limits](../../docs/research/imports-audit/cli-ack-recovery.md).

Run this focused native outcome through the managed check queue:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-ack-recovery.test.ts
```

This connected outcome adds no PG growth series; missing growth evidence is recorded as missing. Existing
source, journal, media and transport limits and counted growth evidence retain their original scope.

## Native file acquisition admission

The [file journey](../kernel/test/imports/cli-file-admission.test.ts) runs ordinary
`--dump <path>` acquisition for all four sources through real account-key Auth,
Access and public writes, including the registered media worker. Each source
completes an import, rejects malformed replacements without Auth/public effects
or changes to the completed baseline and immutable receipts, then accepts a valid
successor on the same SQLite state. VNDB reads ustar through `readArchive` rather
than injected entries. Invalid archive staging exits 2, matching scalar input
admission; interruption still exits 130. Files and SQLite close on either path.
The [evidence notes](../../docs/research/imports-audit/cli-file-admission.md) describe
captured anchors and limits. This caller adds no growth measurement or input cap.

## Rejected cover and valid successor through the CLI

Keep the same source and SQLite state after a corrupt cover is rejected. Metadata import can complete while
the rejected cover remains explicitly terminal in the media journal and native status. The importer supplies
no converter media mapping for that object and publishes no cover attachment. Reopening the same input does
not submit another media job or fetch that URL again, even if the provider has replaced its bytes. A changed
source cover URL creates a distinct request and media object; only actual availability permits a cover proposal.
An editor still accepts and selects that proposal through the ordinary API. Cover credit remains
`LicenseRef-unknown`, independently of the provider's metadata rights.

The [frozen native outcome](../kernel/test/imports/cli-rejected-cover-recovery.test.ts) now has a connected
account-key caller for two independent records, Bangumi JSONL and an Open Library edition TSV, in one native
Auth/Access/worker world. It observes corrupt-image rejection, same-state reopen, a genuinely changed source,
private original equality, encoded AVIF/WebP variants, public selected media and download decisions, immutable
old journals/receipts, and an independent contributor's adopted title. Managed acceptance passed at
`94e003a486ee861a4d5a71083cda671f786bb7b9`: one native case, two provider children, six successful CLI
invocations and 820 assertions. See the [evidence record and limits](../../docs/research/imports-audit/cli-rejected-cover-recovery.md)
for the raw log, actual source/converter/bundle revisions and receipt anchors. This is scoped native evidence;
integration, promotion and the broader consumer matrix remain open.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-rejected-cover-recovery.test.ts
```

## Concurrent ordinary CLI operators

Use the same `--state` path for independent configured `--source-alias` feeds. A live CLI owns its exact alias
while acquiring input, including while stdin waits before EOF. Another CLI for that alias exits 5 before Auth
or public writes; a different alias can seal and publish in the same SQLite file. Cancel the owner through
SIGINT and reopen with the same state and complete source input. Source claims, own-reference resolution,
receipts and tuple fences remain confined to their configured alias even when native provider keys coincide.

The frozen [concurrent native journey](../kernel/test/imports/concurrent-cli-owners.test.ts) binds actual concurrent
`runImportCli` calls to one native Auth/Access/application/worker world. Its [evidence description](../../docs/research/imports-audit/concurrent-cli-owners.md)
covers held acquisition, same-alias refusal, independent publication, cancellation/reopening, immutable prior
identities/receipts, and exact-tuple fence visibility. The importer-local companion proves only pre-effect
ownership and cleanup. Native execution and growth evidence are separate; this caller introduces no growth series.

During incomplete acquisition, interruption requests upstream iterator cleanup once and releases the actual
source guard even if that cleanup never settles or is queued behind a stalled read. Late read/cleanup rejection
is observed. The CLI reports exit 130 after closing its owned handles, so a same-state rerun can acquire the
source normally. Incomplete input cannot seal a successful or empty dump, advance the prior completed baseline,
or start Auth/public effects. Ordinary EOF and parser-error cleanup retain their existing behavior; cancellation
can interrupt a pending source cleanup. Owned file reads and already-dispatched writes settle before SQLite
and descriptor closure. This boundary does not detach ingestion or change post-dispatch authorization cleanup.
The frozen [CLI child](tests/cli-upstream-cancellation.test.ts) proves the nonsettling-return acquisition case;
its timeout only bounds a failing test, and establishes no performance or native-stack claim.

## VNDB durable table materialization

`VndbMaterialization` is the CLI's production facade for validated VNDB table
entries and ustar archives. It stages the complete generation before ordinary
`Importer.runRecords` publication, enumerating at most 16 grouped records per
page. `baseline(key)` reads the completed RunStore row and its durable acquisition
link; it does not maintain a second record baseline. Failed acquisition cannot
resume publication or replace that baseline. Unchanged publication retains the
original acquisition, while interrupted sealed work resumes with its own original
acquisition even if a subsequent invocation supplies a different archive.

The staged `vn.alias` field is newline-separated text and survives COPY
materialization into the pure converter. Nonempty lines become undetermined
alternate names; alias changes and removals participate in the ordinary
importer's source digest, candidate reconciliation and durable replay. The
converter caps a record at 64 alias lines and 162 commands; the importer sends
those commands in its existing 100-command batches.

The native materialization acceptance binds all fourteen portable table outcomes
and the account-key CLI publication/reopen/late-invalid journey. Its local SQLite
row, byte, execution and EQP evidence does not add canonical server growth claims.
See [the materialization evidence](../../docs/research/imports-audit/vndb-materialization-native.md).

## VNDB and Wikidata sealed CLI recovery

The [connected operator journey](../kernel/test/imports/cli-sealed-source-resume.test.ts) captures a committed
response lost before local ACK, closes all CLI handles and reopens the same private state/key paths. VNDB
validates every supplied archive before recovery: malformed replacement input rejects with status 2 and no Auth
or public effects; valid replacement input permits the original sealed generation to drain with its original
acquisition and native revisions. Wikidata drains sealed work without reading replacement stdin; the same
malformed stream is admitted and rejected only on the next fresh invocation. A later valid invocation publishes
the successor for each source, preserving subject identity, original receipts and independent Context selection.
VNDB retains its seventh statistic scope and exact statistic receipt identity.

The managed native acceptance passed at `fc2509fd177143bafb3a4f598bb0db43c55337a8`: one frozen test, two source
children and 1,686 assertions. The [receipt and limits](../../docs/research/imports-audit/cli-sealed-source-resume.md)
record exact log, source revision/digest and original receipt anchors; promotion remains separate. Source bytes are the pinned
VNDB COPY/header files in real ustar and Wikidata `Q571` in streamed JSON-array framing. This connected outcome
adds no growth series and does not close general source metadata or discovery work.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-sealed-source-resume.test.ts
```

## Mid-run bulk authority loss

The ordinary CLI retains its completed baseline and original sealed generation when native bulk authority is
revoked between writes. It exits 4 after authorization denial and closes its handles. Restore the existing grant
and reopen the same state to drain pending prepared bytes and keys; a distinct supplied successor is acquired on
the following invocation. Earlier authorized transactions remain committed. Receipt replay checks current Access
before revealing stored success, including replay with the original bearer.

The frozen [native journey](../kernel/test/imports/cli-midrun-authority-resume.test.ts) binds seventeen changed
Bangumi records after a metadata-only baseline, real account-key Auth, native Access/public writes, the media worker
and an independent community selection. It schedules actual outgoing requests before forwarding to Access and
retains exact native denial bodies. See [scenario, evidence and limits](../../docs/research/imports-audit/cli-midrun-authority-resume.md).
The corrected managed native run passed one test and 4,330 assertions at
`72f22215978b429a77e33a34e0dd7e75d909d787`, with no TypeScript diagnostics. The evidence notes retain its raw
receipt and the earlier fixture typing correction. This proves the connected journey; main promotion and native
growth evidence remain separate.

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/cli-midrun-authority-resume.test.ts
```

This connected outcome reuses existing input, envelope and retry bounds and adds no growth series. Original native
receipts, bootstrap/proposal/media journals and acquired objects remain independently observed recovery anchors.

## Explicit reviewed vocabulary and Bangumi lookup

`seedReviewedCatalogue({path, port, seeds?, signal?})` in
[`reviewed-catalogue.ts`](src/reviewed-catalogue.ts) is the one trusted operator
producer. Its finite authored input is the four records in Definitions'
`reviewed-vocabulary.json`: source scheme, canonical media-genre scheme,
canonical Q690342 Concept, and source-scoped public `后宫` Concept. Scheme self
records use the empty literal member; the canonical member is the exact reviewed
QID. These authored keys identify seed owners, never provider records or derived
UUIDs. Native create-or-resolve receipts supply every subject/candidate ID.

Run deliberately with an already authorized ordinary operator account:

```sh
bun services/importer/src/reviewed-catalogue-cli.ts \
  --state .temp/reviewed.sqlite --api https://api.example.org \
  --auth https://auth.example.org --account-key .temp/operator.jwk \
  --account <account-uuid> --client <registered-client-id>
```

The account needs genuine current Global trusted batch, create/propose and
editorial acceptance/adoption authority and matching OAuth scopes. The tool
grants nothing. Ordinary imports never invoke it. Use the same state file for
subsequent ordinary Bangumi imports; the platform seed namespace stays separate
from provider namespaces. No SourceRegistration option or parallel registry exists.

Before effects, the entire exact inventory passes descriptor-safe preflight and
the existing RunStore acquisition/seal policy. The unchanged RecordBindings
journal retains original native claim/proposal bytes and ACKs. Every owner's
real Source metadata CAS ACK precedes its bootstrap, including response-loss
recovery. The sealed inventory deterministically reproduces the same metadata
bytes/key before a claim exists; after binding, the existing metadata journal
retains the genuine receipt. Changed sealed input or unrelated editorial heads
are refused. Acceptance and adoption use freshly read native heads and genuine
returned receipts, with current authority required on replay.

Seed alias is exactly `rezics_reviewed_vocabulary`. External IDs are `v1:` plus
unpadded base64url UTF-8 canonical JSON of `[schemeURI, exactLiteral]`, without
normalization or identity hashing. The raw ConversionContext key remains UTF-8
JSON, not base64url. Both actual external ID and complete public command key are
checked before effects. The pinned member produces 82 ASCII external-ID bytes
and a 174-byte complete key with the existing 64-hex command suffix; oversize
identities are rejected, never shortened. Existing provider aliases/QID keys stay
unchanged. Reviewed licence metadata covers only its explicitly attributed
projection; authored scheme metadata deliberately has no inferred licence.

`createReviewedCatalogueLookup(bindings, port)` implements the existing
`ImportIdentifierLookup`; the ordinary Bangumi CLI installs it by default. It
reads four current original subjects, their fact fences and six bounded native
candidate slots (limit 100 each), checks scheme membership, exact external
identity, distinct canonical correspondence, accepted selected unretracted
provenance and current disclosed graph. Redirects, hidden/retracted/unselected
subjects or candidates, foreign repair, Access refusal, missing seeds and
unavailable native reads produce no mapping. A local journal ID is only a read
anchor. Retained Context adoption alone is insufficient after retraction.

Lookup makes four fence reads, four subject reads and six candidate-list reads
for the fixed reviewed inventory; no label search, population scan or extra
source probe occurs. Pure conversion bounds are twelve projected fields,
64 public metadata tags of 200 characters, six commands and the existing 64 KiB
projection guard. The native producer/consumer cases and geometric 64/512/4096
lookup case are authored in Kernel's existing native fixture. Native outcomes
remain integration proof; this source delivery permits local typing only.

## Registered source vocabulary mapping

Bangumi and VNDB registrations append bounded proposals from the shared pure
vocabulary mappers when a trusted conversion caller provides normalized graph
rows and released bindings in `ConversionContext.sourceVocabulary`. The graph
owner supplies row traversal and resolved identities; the importer registration
does not search for endpoints, create subjects or resolve labels. Mapping output
uses the existing source alias, revision, digest, licence attribution and
ordinary batch-write path. Mapping-specific command-key revisions prevent a
sealed command from being replayed with changed statement bytes.

Exact unresolved values and descriptor admission failures are returned both as
`sourceVocabularyGaps` and structured conversion diagnostics, including provider,
source path, code or endpoint, required profile and property where applicable.
VNDB release supersession remains a release-to-release `wdt:P155` gap while the
released VNDB Release profile lacks that property. TBA and absent release dates
remain distinct outcomes; date precision is never guessed. These proposals do
not contain VNDB votes, personal lists or score-derived facts.
