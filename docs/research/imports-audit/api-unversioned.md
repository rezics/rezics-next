# Unversioned native revision evidence repair

Inspected base: `2748c1c014747e60173fcab7cc4f2cc5e3f46969`.
This report prepares acceptance for the existing policy; it introduces no interface or production behavior.
The focused executable scenario has **not been run**. The file-presence acceptance command does not execute it.

## Defect and expected failure by inspection

`services/kernel/test/imports/api-fixture.ts:145` computes `String(native.lastrevid)` for Wikidata.
An own-property-absent `lastrevid` therefore produces the string `"undefined"`.
`packages/conversion/src/wikidata.ts:144–148` accepts an absent native revision, derives `"unversioned"`,
and requires the supplied envelope revision to match. The fixture consequently rejects valid input with
`ConversionError("Source envelope revision does not match entity", "/lastrevid")`.

In `services/kernel/test/imports/api-unversioned.test.ts`, the exact expected failing operation is
`await d.convert('wikidata', first, converterRevision, context)` in the final context loop, first with
`context === undefined` (bootstrap). It must resolve; instead the current fixture rejects before the following
`expect(raw.record_revision).toBe('unversioned')` can run. The bound iteration uses the subject ID retrieved
from the actual public import, and has the same defect. This is an inspection prediction, not a failed test run.
Public import, reopen and changed-content assertions precede this call so the native path is independently exercised.

## Native call-site map

| Surface                                                                  | Inspected behavior                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/importer/src/dumps.ts:173,218–233`                             | Initializes revision to null; absent Wikidata `lastrevid` stays null. A present revision must be a positive safe integer.                                             |
| `services/kernel/test/imports/api-runtime.ts`, `run()`                   | Reads actual dump bytes with `readDump`, then calls `Importer.runRecords(createSourceRegistration(...), records, ...)`. It does not call fixture `convert()`.         |
| `services/importer/src/importer.ts:916–925`                              | Bootstrap conversion supplies `record.revision ?? 'unversioned'`; stages the returned revision, normalized projection and content digest.                             |
| `services/importer/src/source-registry.ts`, `createSourceRegistration()` | Calls the actual registered source converter; preserves its result and adds importer aliases. No revision invention.                                                  |
| `services/importer/src/importer.ts:169–186`                              | Bound conversion supplies staged `recordRevision` and normalized native record plus actual resolved context; verifies digest and converter revision.                  |
| `packages/conversion/src/wikidata.ts:144–148,335–340,543–552`            | Validates revision equality; hashes normalized content; omits `oldid` when absent; includes digest in bootstrap and proposal keys.                                    |
| `packages/conversion/src/support.ts:193–197,246–260`                     | Canonical normalized content digest and source envelope policy. A null envelope revision becomes `unversioned`; this helper does not make invalid native input valid. |
| `services/kernel/test/imports/api-fixture.ts`, `convert()`               | Calls the same converter with `String(undefined)` rather than the coordinator's `unversioned`. This is the reachable mismatch.                                        |

The fixture is the complete minimal reachable defect found for this surface. A later implementation should change
only its Wikidata revision adaptation, preserving rejection of invalid present revisions. Passing null directly to
the Wikidata converter is insufficient: its current equality check expects the literal `unversioned`.
Do not alter the native reader, converter validation, production coordinator or driver interface.

## Acceptance and decisions

The new scenario uses `openImportApiFixture` and its existing `convert`, `run`, `commands`, `read`, `receipt`,
`effects`, `restart` and `close` ports. It inherits the fixture's real Auth, Access and deployment bootstrap.
There is no SQL permission seed, synthetic successful write or fabricated subject ID. Cleanup is in `finally`;
fixture construction retains its existing partial-failure cleanup.

Synthetic native bytes describe a supported Book Q entity. Every field belongs to its normalized projection,
so `sourceDigest(entity)` is the expected digest, independently compared with conversion and public envelopes.
Changing its English label changes accepted content without adding a native revision. Public proposal IDs,
content, digests and resolved subject ID demonstrate refresh; observed persisted receipts demonstrate real writes.
Reopen followed by identical import must leave all effect counts and public proposals unchanged.
Both bootstrap and bound pure conversions must preserve the unversioned envelope; public citations must contain
the native URL without `oldid`. Explicit revision 101 is a positive control in both phases. Null, zero, negative,
fractional, string, manufactured `undefined` text and unsafe integer revisions are rejection controls.
An explicit JavaScript `undefined` property is not a native JSON value and is not treated as a separate dump case.

The contract authorizes preparation without running the focused remote kernel scenario. The later implementation
must run `bun run --cwd services/kernel check test/imports/api-unversioned.test.ts` once after its final edit,
sequenced with any VNDB statistic fixture writer. No fixture or existing test is edited here.

## Open Library and VNDB

The analogous `String(native.revision)` in fixture conversion has no reachable absent-revision defect for valid
Open Library input. `dumps.ts:192–211` requires five native TSV cells, a positive decimal framing revision,
a positive safe integer payload revision and exact equality. `packages/conversion/src/open-library.ts:167–174`
also requires a positive safe integer and matching envelope; missing or invalid revision is rejected.

The fixture's VNDB grouped `entry_meta.revision` stringification is likewise required.
`services/importer/src/vndb-tables.ts:428` validates revision with `integer(cells.revision, 32767, 1)`;
`metadata()` requires a matching entry and `page()` yields that revision. The grouped runtime branch stringifies
this validated number. `packages/conversion/src/vndb.ts:156–158` independently validates the required native
revision and envelope equality. The generic line reader's bare VN rows are not a valid grouped converter record.
No reachable analogous bug was found by inspection; no optional-revision cases are invented for either source.

## Cost

### Focused record conversion and public import

- Touches: a fixed number of bounded native records, real converter calls, public proposals and exact receipt keys;
  one reopen and identical reimport, then one changed-content refresh.
- Bound: existing per-record converter, public API and journal operations; no new production work or scans.
- Growth check: digest-sensitive assertions establish correctness, not a growth benchmark. Existing cost contracts
  are unchanged; this preparation adds no production algorithm requiring new scale measurements.

## Reading and verification scope

Read the current API driver, fixture, runtime and observer; native dump reader, source registration, importer
bootstrap/bound conversion, VNDB grouped table staging; Wikidata, Open Library and VNDB converter revision paths;
shared digest/envelope helpers; existing API acceptance and Wikidata fixture; importer/conversion READMEs and
repository workflow/Goal definitions. The reference index was read; no external reference implementation was
needed for this repair of an existing policy. Backpressure references concern a different surface.

Only the two declared files are added. There are no files outside the declared paths and no frozen-file changes.

Validation: `test -s services/kernel/test/imports/api-unversioned.test.ts` exited 0 after the final test edit.
`bun scripts/typecheck.ts` exited 0 after correcting a new test's reference-value union narrowing error found
by the first typecheck attempt. No focused kernel scenario, root gate or full kernel check was executed.
