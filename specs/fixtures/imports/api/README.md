# Imports public API outcome specification

These small synthetic catalogue records preserve source dump structure; they are
not live factual assertions about the external IDs. No scenario downloads live
data. Mutations in the suite change source payloads, revisions, record counts or
hostile extensions while retaining the original reader format.

Format and rights references:

- [Bangumi Archive](https://github.com/bangumi/Archive): subject JSON lines use
  exported fields and raw infobox syntax. The fixture infobox explicitly supplies
  an image URL and its rights holder, Example Studio. The launch decision permits
  CC-BY-SA-3.0 summaries; it does not license cover copyright. The suite injects
  hostile posts/comments separately; these are not archive fields to import.
- [VNDB dumps](https://vndb.org/d14) and [data license](https://vndb.org/d17):
  PostgreSQL COPY text uses `vn` and `vn_titles`, literal tabs, `\N` and `\.`.
  This fragment selects factual titles/date data, retaining ODbL and DbCL
  attribution. It contains no descriptions or images with separate content rights.
- [Open Library dumps](https://openlibrary.org/developers/dumps) and
  [catalogue rights](https://openlibrary.org/help/faq/using): five literal tab
  separated columns are type, key, revision, timestamp and complete JSON record.
  These catalogue facts carry CC0; no cover copyright is inferred.
- [Wikidata dumps](https://www.wikidata.org/wiki/Wikidata:Database_download) and
  [data access and CC0](https://www.wikidata.org/wiki/Wikidata:Data_access): one
  entity per line, including `lastrevid` and a referenced external-ID statement.
  The unresolved Open Library ID remains external. This is the entity-lines
  fragment, without a surrounding full-export array/compression container.

The import requirements follow the supplied ADR-0036 import decision, with the
current launch-source/rights requirements and ADR-0029/0030/0031 constraints.
This suite does not migrate the ADR or become a second architecture authority.
Bangumi/VNDB records lacking an intrinsic row revision retain their dump snapshot
revision alongside the record digest. Open Library/Wikidata retain intrinsic
revisions. Changing converter revision runs the actual production converter with
new revision metadata, never a replacement semantic model.

## Driver interface

`IMPORT_API_DRIVER` names an absolute file path or file URL exporting
`createImportApiDriver(options): Promise<ImportApiDriver>` as defined in
[imports-api-driver.ts](../../../imports-api-driver.ts). The loader runs inside
each scenario and every factory instance owns isolated migrated databases and
real Auth tokens. Factory failures clean partial setup; scenario cleanup runs in
`finally`. Importer restart preserves durable state and never resets kernel data.

Reuse production semantic/account fixtures and their authentication setup. The
driver runs the actual importer, dump readers and conversion modules; public bulk
requests traverse actual authenticated HTTP handlers with real Access and rate
limits. The decided semantic endpoint and schema remain semantic's authority.
The test contract prescribes neither an endpoint string nor a proposal wire body.
`RecordView` is read evidence: full actual HTTP responses, extracted actual
statements/references and independently observed stored revisions, never expected
values reconstructed by the adapter. Tests match statements/references inside
the actual bodies as well as proposal IDs in stored revision history.

Controls only pause production boundaries, configure production limits/clock,
drop a committed transport response, or execute real fixture commands. No policy,
fence, receipt or proposal behavior can be implemented by the driver. In
particular, takedown uses the actual target-partition command, and permission
revocation preserves the original Auth token and committed receipt. SQL can
observe storage; it cannot bypass product writes in outcome scenarios.

## Cost

N is accumulated catalogue/importer key cardinality; U x t is accumulated
account/editorial history; M is the bounded fields/proposals in the current
record/batch. S is records physically supplied by a full dump and D is changed,
new or vanished records. Reading S once permits O(input bytes) parsing and
O(S log N) indexed comparisons, not rescanning accumulated N or history.

Pure parsers/converters touch zero database partitions, rows or indexes, have
O(record bytes + M) work, reject oversized records, and retain bounded memory.
The suite configures a 64 KiB record cap, 64-field cap and batch/page cap B=8.
Full dumps never buffer S records or historical state. New/changed comparisons
use indexed (source, record_key) seeks; staging uses indexed
(source, run_id, record_key) pages and maintained source/run counters.

Reconciliation is bounded per step by O(B log N + M). Mass disappearance uses
maintained baseline/seen-survivor counters before publishing any proposal or
successful checkpoint. Vanished enumeration uses bounded indexed keyset pages
for the exact source/generation, with no unbounded anti-join, historical count or
whole-table/partition scan. Public writes occur for D, routing each subject's
command to its authoritative partition. Access, receipt and fence reads are
bounded indexed operations, independent of U x t; fences use point seeks on
(source, external_id, field_group) both on refresh and at server write time.

One deterministic seed method supplies scales 32, 128 and 512 in fresh instances.
N and U x t grow independently around the same one-record change; historical
importer keys include the measured source, and account/editorial history includes
the measured authoritative partition. Setup is outside measurement and may bulk
load only in the performance scenarios. M independently grows through 1, 8 and
32 external-ID fields; 65 must reject. Streaming supplies 32/128/512 records and
checks exact input bytes/record counts, linear instrumented work and fixed memory.
The same mass-stop counter check and permitted one-key removal are also measured
at each N/history scale. An unchanged full dump makes zero public writes, while
authoritative preflight reads remain allowed. Production reader buffering is
bounded by one 64 KiB input chunk plus B actual maximum-size input records, so
buffering the whole largest fixture cannot pass under an unused hard record cap.

The narrow `measure` contract must use the performance Goal's shared harness when
available. Until then it requires executed statements/rows, SQLite FULLSCAN_STEP
and VM_STEP, PostgreSQL actual EXPLAIN rows/buffers, observed index heights and
instrumented byte/token/field visits including revisits. It cannot estimate work
from fixture size or hide operations in adapters. There are no elapsed-time ratios.

For each fixed batch the suite bounds statements by 64+16M, examined rows and
index buffers by 128+32M+16B(index height), and SQLite VM work by
1024+256M+128B(index height). Statements/PostgreSQL result rows remain fixed as
unrelated state grows; only the derived index-height terms can grow. Full scans
and SQLite fullscan steps must be zero. Dependent APIs that cannot meet these
bounds are specification conflicts, not permission to hide costs in a binding.

## Exact scenario names

1. Bangumi dump preserves summary rights and separately credited cover
2. VNDB COPY dump preserves permitted factual rights and source references
3. Open Library five-column TSV imports through public bulk API
4. Wikidata JSON lines retain references without fabricating native external IDs
5. identical dumps after importer restart have zero duplicate effects for every source
6. changed records and converter revisions append proposals while community adoption survives
7. mass disappearance stops before bulk writes or checkpoints and isolates sources
8. exactly twenty percent disappearance proposes source removal without deleting subjects
9. losing all prior records always stops even for a one-record baseline
10. takedown fences survive unchanged refresh payload changes restart and reconversion
11. server fence recheck blocks a takedown arriving after client preflight
12. ordinary actors and revoked bulk replays are denied before receipt disclosure
13. importer obeys actual Retry-After and never acknowledges a rejected batch
14. transport uncertainty retries stable keys after restart without duplicate effects
15. malformed and truncated dumps never publish disappearances or advance snapshots
16. hostile user posts and oversized records never become imported content
17. fixed changes have bounded indexed work as unrelated catalogue and history grow independently
18. full dump reading scales with supplied bytes and keeps fixed page memory
19. pure conversion scales with bounded fields and rejects the hard field cap without database work

## RED evidence and later integration

Run from the repository root:

```sh
bun specs/support/verify-outcome-suite.ts specs/imports-api.test.ts IMPORT_API_DRIVER \
  'IMPORT_API_DRIVER is required: bind the real importer and public API'
```

Observed: verifier exits 0; its Bun child exits 1; all 19 scenarios fail with
exactly `IMPORT_API_DRIVER is required: bind the real importer and public API`;
zero skips/todos/exclusive cases and no import/syntax failures. The verifier
unsets even an inherited binding and checks each literal scenario's JUnit failure.
This proves the executable specification runs RED for the missing binding. It
does not prove product acceptance or any of the production outcomes above.

A later integration binds `IMPORT_API_DRIVER` to the real production implementation
and runs this entire unchanged suite as an actual workspace check/root gate:

```sh
IMPORT_API_DRIVER=/absolute/path/to/production-binding.ts bun test specs/imports-api.test.ts
```
