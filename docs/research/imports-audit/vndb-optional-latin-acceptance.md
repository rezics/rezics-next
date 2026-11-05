# VNDB optional Romanization acceptance

This freezes a required future repair at the native COPY reader/converter/public bulk seam.
It does not adopt an owning README change or claim the repair is implemented. Imports has decided to
accept exactly zero-length optional `vn_titles.latin`, retain `''` in the sanitized source projection,
and emit no Romanized semantic name, label or alias for it. NULL remains NULL. Whitespace-only Latin,
missing/wrong-type Latin and meaningless primary titles remain errors. Shared `titleText` stays strict.
The owning README adoption is sequenced separately before implementation.

## Evidence and fixture identity

The full completed investigation was read at
`/home/edge/projects/rezics/worktrees/6ef6a875-1c52-41cd-a7c8-8ac0afd18225/docs/research/imports-audit/vndb-empty-latin.md`.
Its pinned official 2026-10-25 dump has 78,033 title rows: 34,600 NULL and 43,433 nonempty Latin
values, **zero actual empty or whitespace-only Latin cells**. This suite's empty cell is controlled
schema-edge input, not an observed native empty record or an upstream equivalence to SQL NULL.
No external research or new upstream retrieval was needed.

The source-specific fixture reads all three headers and unchanged `v124` VN/entry_meta rows from
`specs/fixtures/imports/vndb-tables/db/`. Revision is native numeric `19`, framed as string `'19'`,
never a timestamp. The existing fixture is synthetic COPY data with real columns. Its normal primary
is `港の物語`, nonempty Romanization `Minato no Monogatari`. NULL, exact-empty and whitespace controls
change only the final title cell. The empty title row is exactly
`v124\tja\tt\t港の物語\t\n` in escape notation: zero bytes after the final TAB before LF.

A separate positive case retains observed title/Latin cells from pinned `vn_titles` lines 1–2:
`Let's Meow Meow!` / NULL and `みんなでニャンニャン` / `Minna de Nyan Nyan`.
Their original source ID is `v1`; this controlled composition explicitly transplants only their parent
ID to `v124` to reuse the bounded fixture VN/entry_meta shell. It does not claim an observed `v124` row.
The original raw rows including LF have SHA-256
`6f2c3b98c5699e6e1319184e344af040c1340de966eeecea348cfdeeeccffa08` and
`6f50dc37d1fedb09c60b325f28a3164dd30a9eb2477b74f3060643a528acab4d`.
Attribution is VNDB; database ODbL-1.0, individual contents `LicenseRef-DbCL-1.0` (DbCL 1.0).
No user rows, images, descriptions or statistics are imported by these cases. The reader discards
unused description/image fields in the unchanged VN shell; its zero vote count creates no statistic.

## Frozen native cases

`services/kernel/test/imports/vndb-optional-latin.test.ts` contains six independent named cases:

1. `observed NULL and nonempty title cells retain VNDB attribution and canonical Romanization`
2. `NULL and nonempty Latin preserve native primary names, citations and canonical language`
3. `exact-empty final COPY cell imports only the primary title and replay/reopen has no duplicate effects`
4. `same-key NULL to exact-empty changes data digest while retaining subject and immutable bootstrap receipt bytes`
5. `whitespace Latin rejects before row effects and missing/type/primary errors retain exact converter paths`
6. `COPY acquisition rejects incomplete tables without promoting the prior sealed baseline`

The fixture uses actual `VndbTablesStore.begin/stage/page`, real registration and converter, native
`api-runtime` and `api-observer`, ordinary Auth-issued credentials/Access and public bulk HTTP. No
portable COPY helper, frozen suite, product definition, mapping or README is changed. Subject IDs
originate in actual completed create-or-resolve responses; subsequent binding reads retain that ID.
The observer uses public disclosure plus read-only native effect/receipt observation. SQLite files
are isolated under the system tmpdir; TMPDIR is not redirected. No expected output is seeded.

Bootstrap and resolved conversion use that returned ID, preserve exact accepted NULL/empty data,
check data-only digest equality across phases and converter-revision rebinding, and require different
digests for NULL versus empty at the same key/native revision. The registered normalized alias is
checked against the actual projection. Nonempty language remains `ja-Latn`. Primary-only cases assert
exact name counts, bootstrap labels/aliases and absence of blank disclosed labels/aliases. Citations
retain `https://vndb.org/v124.19`. Saved native bootstrap journal bytes/acknowledgement and original
public receipts remain immutable through refresh; replay/reopen adds no effects or receipts.

Whitespace is staged without trimming and rejected before public batch writes, preserving the prior
baseline/effects. Nine invalid payload variants cover spaces/control whitespace, missing Latin,
number/boolean/object Latin and empty/blank/NULL primary titles in both conversion phases, at
`/vn_titles/0/latin` or `/vn_titles/0/title`. Nonrepresentable COPY types are introduced only by mutating
an actual staged payload, never by inventing parser coercion. Incomplete acquisition remains rejected;
page admission before staging is also checked. No helper count or timing claims PostgreSQL cost.

## Verification record

The base inspected is `496f04de1f4998d5163bd46d239425f4351a1c9e`; converter revision is `vndb@5`,
registration alias `vndb` (both inspected from production exports). Product implementation remains
unchanged. Exact command results and the first reached failure are recorded below after execution.
Artifact acceptance (`test -s` on this report) proves specification delivery only; it is not product
acceptance. No whole-kernel or root product gate is requested.

Read sources: the complete investigation above; conversion README and `src/vndb.ts`/`support.ts` contract;
importer README, source registration, coordinator and `vndb-tables.ts`; imports Goal, architecture,
scope and development workflow; native API runtime/observer/fixture and public import driver; frozen
VNDB table driver and existing reader/language tests; all six COPY fixture files. These supply the
bounded surface; no reference project is named for implementation by this contract.

Decisions: observed v1 title cells use an explicitly controlled v124 parent transplant; the extra positive
fixture-shell case remains distinct from observed-source evidence. Revision-rebinding uses a trusted
converter option solely as a digest control, not a custom release or native record revision. Acquisition
coverage removes a required header and leaves all authority/effect operations on the actual APIs.
No files outside the three declared paths are changed.

Fixture byte identity (UTF-8, including LF): VN header 110 bytes; title header 29; metadata header 48;
unchanged v124 VN row 70; unchanged metadata row 35. The sole primary-title rows are NULL 26 bytes,
exact-empty 24, nonempty 44, spaces-only 27. Thus the six-member empty fixture is 316 bytes and the
NULL control is 318 bytes. The exact-empty row SHA-256 is
`d689b97580efb6fdd41131446b474272a3f8eef04ea23560d02effd040c8c090`;
NULL control is `b0fcd7e148b35f82c727ea73f289add5cd44ff0fef47168926b72e12b1004f46`.
These raw-byte evidence hashes are distinct from the product sanitized-data digest.

Root typecheck: `bun scripts/worker-check.ts -- bun run typecheck` passed (exit 0), log
`.temp/goal/checks/worker-check-2026-10-28T19-19-38.944Z-c4a05c3f.log`.
An earlier native invocation stopped at three TypeScript errors before executing cases; an overlapping
initial root typecheck also identified the runtime fixture's literal `batchRecords: 8` contract.
These acceptance-authoring defects were corrected (value-union narrowing, omitted optional context,
and the existing runtime's required batch size). They are not product or environment failures.
Initial logs are `.temp/goal/checks/worker-check-2026-10-28T19-14-40.946Z-2f607190.log` and
`.temp/goal/checks/worker-check-2026-10-28T19-15-29.999Z-d6123c2c.log`.

The intermediate native run reached all six cases: four passed, two failed exactly at empty acceptance,
log `.temp/goal/checks/worker-check-2026-10-28T19-17-17.114Z-b9b4468c.log`. The final invocation below
covers the corrected fixture batch size and response-derived ID in the strict error case. Checks waited
for shared slots; no queued check was interrupted or treated as stuck.

Final focused command:
`bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/vndb-optional-latin.test.ts`
exited 1 with **4 pass, 2 fail, all 6 cases executed**. Final log:
`.temp/goal/checks/worker-check-2026-10-28T19-25-33.755Z-fd5c588b.log`.
Cases 1, 2, 5 and 6 above genuinely passed. The first reached failure is case 3 at
`completed`: expected `"complete"`, received `"invalid-input"` after staging exact-empty Latin through
real public import acquisition. Case 4 independently reaches the actual converter and throws
`ConversionError: Invalid or oversized dump text`, pointer **`/vn_titles/0/latin`**, at
`packages/conversion/src/vndb.ts:175` via `titleText`, before digest/output generation.
This is the intended red on unchanged `vndb@5`, not a blocker to specification delivery.

Nonexecution is limited to assertions downstream of those two failures: successful empty import,
empty replay/reopen, empty sanitized digest comparison and refresh/old-receipt replay are frozen but
not yet proven. NULL bootstrap creation/receipt observation and NULL conversion phases run before
case 4's rejection. No empty digest or successful empty receipt is fabricated.

Environment: all six cases reached native execution; no environmental failure blocked acceptance.
The check host emitted a nonfatal missing-Git-metadata timing warning and a pg concurrent-query
deprecation warning. Neither is treated as a product pass, blocker or database cost proof. No native
suite was rerun to obtain a success summary, and no whole-kernel gate was run.

Delivery acceptance command is
`bun scripts/worker-check.ts -- test -s docs/research/imports-audit/vndb-optional-latin-acceptance.md`.
It checks only that this specification artifact exists and is nonempty.
