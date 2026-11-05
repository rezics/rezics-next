# VNDB empty Latin-cell evidence

Inspected 2026-10-29 against repository revision `fb7ffaca82ead9baaa84e18992aae8644aa9ae78`.
The pinned dump's schema permits SQL NULL, an actual zero-length string and whitespace text in
`vn_titles.latin`. Its producer preserves their distinction. The complete pinned title table contains
**34,600 NULLs and 43,433 nonempty strings; no empty or whitespace-only Latin strings**.
Thus the reader/converter disagreement is established, but failure on an observed pinned record is not.
An upstream semantic equivalence between empty/whitespace strings and missing Romanization remains unknown.

## Primary evidence and provenance

The [inventory, line 1](../../../packages/definitions/sources/vndb.yaml) and
[table contract, line 10](../../../specs/imports-vndb-tables-driver.ts) pin the official
[2026-10-25 archive](https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst).
Existing source-inventory artifacts were reused read-only: `.temp/vndb-db-2026-10-25.tar.zst`,
`.temp/schema_vndbid.sql` and `.temp/vndb-README.txt`; the earlier source-fixture evidence supplies
`.temp/vndb-source/schema.sql` and `.temp/vndb-source/dbdump.pl`. Exact recorded artifact paths were
read; no other checkout was changed. There is no VNDB clone in the inspected shared `.reference/INDEX.md`.
No clone, reference-index edit, upstream installation, build or execution was needed.

The archive is 191,512,964 bytes, SHA-256
`674166bcbcc5db842b8bba979c3a540dff60c62efb63c0f09f9966200a44e979`.
Its members were independently streamed without extracting archive paths. README and schema hashes match
the existing pins. Only selected schema, README, timestamp and public title members were read as evidence;
no account, list, vote or user-post member was collected.

| Artifact               |   Bytes | SHA-256                                                            |
| ---------------------- | ------: | ------------------------------------------------------------------ |
| `README.txt`           |    2047 | `49dc1574d7a656fa43fe0809f1981e09c401a0fa0c3c365d9fc0509c3c71e454` |
| `schema_vndbid.sql`    |   10473 | `d608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758` |
| `TIMESTAMP`            |      23 | `2f3cda9758dbb5922a546b5fa16c77354fc10523d2425defd16b79b90f7a777c` |
| `db/vn_titles.header`  |      29 | `28f787cc2c19c65c80abcafc289b26f26b1ea59b71ddcbac8bcfabc30534c269` |
| `db/vn_titles`         | 4698631 | `9689d860e10ad08a5eda3a84dda7496edf94e450a86353cf49597c7ad2684fcc` |
| Saved `sql/schema.sql` |   66538 | `00c110018ded73f4a6acb31ebc2b4725a9599f67b583bf29f94abf88ae85ba76` |
| Saved `util/dbdump.pl` |   22158 | `7849210e7df27c12ba93bb98b9440cca3b28f2f0dfe6142bdfde54075d2d5608` |

`TIMESTAMP` is `2026-10-25 08:00:23+00`, not an entry revision. The saved producer matches the
contract's existing content hash. Its original URL is
[util/dbdump.pl](https://g.blicky.net/vndb.git/plain/util/dbdump.pl); the saved schema came from
[sql/schema.sql](https://g.blicky.net/vndb.git/plain/sql/schema.sql).
These URLs are mutable: their content hashes identify the inspected evidence, and their Git commit IDs
and exact deployment relationship to the dump are **unknown**. A search-index commit is not substituted
as a verified producer revision. Direct live retrieval was unavailable; cached primary bytes suffice here.

README lines 30–53 license the database under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
and individual contents under [DbCL 1.0](https://opendatacommons.org/licenses/dbcl/1-0/), attribution VNDB.
The title observations below concern that permitted metadata, not separately licensed descriptions/images.
VNDB source code is AGPL-3.0-only according to its official
[README](https://g.blicky.net/vndb.git/tree/README.md?id=fc3325b9442008babe7c5e6e657492f0d08dcf72).
No upstream implementation is copied into REZICS.

## What the field means, and what the pin actually contains

Dump `schema_vndbid.sql:464–471` declares `title text NOT NULL`, nullable `latin text`, and the
composite primary key `(id, lang)`. There is no default, nonempty, trimming or whitespace CHECK there.
Saved native `sql/schema.sql:1653–1660` has the same column declarations and no such table constraint.
This establishes representability under those declarations, not every production editor's validation rules.
In particular, NOT NULL alone does not make an empty primary title meaningful.

Producer `util/dbdump.pl:151` filters title rows only by visible parent VN. `export_table:191–234`
selects public columns directly, with special transformations for user IDs and timestamps, neither of which
applies to `latin`. It sends the query through PostgreSQL COPY TO STDOUT and writes the returned text;
there is no Latin-specific trimming, NULLIF, fallback to `title`, or filtering of blank Latin cells.
`export_schema:238–253` strips CHECK/CONSTRAINT/DEFAULT suffixes when generating the public schema,
so absence of checks in the exported schema alone would not establish production validity.

The [PostgreSQL 17 COPY specification](https://www.postgresql.org/docs/17/sql-copy.html#SQL-COPY-PARAMETERS)
defines the defaults used here: text format, tab separator and `\N` for NULL. Therefore:

| Raw final COPY cell                | Decoded value                   | Declaration allows it |    Pinned observations | Established interpretation                                     |
| ---------------------------------- | ------------------------------- | --------------------- | ---------------------: | -------------------------------------------------------------- |
| `\N`                               | SQL NULL / `null`               | Yes                   |                  34600 | Absent optional Romanization                                   |
| Zero bytes before LF               | `''`                            | Yes                   |                      0 | Present zero-length text; no documented distinct semantic role |
| Spaces, or escaped whitespace only | Nonempty whitespace string      | Yes                   |                      0 | Text, not SQL NULL; no established absence convention          |
| Nonblank text                      | String                          | Yes                   |                  43433 | Supplied Romanization                                          |
| `\\N`                              | Literal backslash followed by N | Yes                   | Not separately counted | Text, not a NULL marker                                        |

The official [API field documentation at an immutable revision](https://g.blicky.net/vndb.git/tree/api-kana.md?id=b1ef613e7d98f1fe44237c77f0ad8e63d5863263)
describes `titles.title` as original-script text and `titles.latin` as its nullable romanized version.
This corroborates optionality, not a dump-normalization rule; it assigns no special meaning to empty or
whitespace-only strings. No editor-validation guarantee is inferred from that API description.

Observation method: split all 78,033 LF-terminated COPY rows into exactly five tab-separated cells,
recognize the raw NULL marker before decoding backslash/control/octal/hex escapes, decode UTF-8, then
count null, exact empty, whitespace-only and other strings. Python Unicode `isspace()` classified whitespace;
no non-null value had leading/trailing whitespace under `strip()` either. This is a complete observation of
this member, not a claim about later dumps or every Unicode definition of blankness.
The header is exactly `id\tlang\tofficial\ttitle\tlatin\n` (escape notation).

Two actual records locate the positive evidence; raw-line hashes include LF:

- Line 1, bytes `[0,28)`: `v1`, `en`, true, `Let's Meow Meow!`, NULL;
  SHA-256 `6f2c3b98c5699e6e1319184e344af040c1340de966eeecea348cfdeeeccffa08`.
- Line 2, bytes `[28,86)`: `v1`, `ja`, true, `みんなでニャンニャン`, `Minna de Nyan Nyan`;
  SHA-256 `6f50dc37d1fedb09c60b325f28a3164dd30a9eb2477b74f3060643a528acab4d`.

## Actual composition boundary

The [reader, line 121](../../../services/importer/src/vndb-tables.ts) distinguishes raw `\N` from zero bytes,
and `columns:159` retains the trailing cell. `insert:416–422` requires a nonempty primary title but
stores Latin strings/null unchanged. `page:496–517` returns the stored child rows and numeric metadata revision.
[CLI framing, line 705](../../../services/importer/src/cli.ts) stringifies that revision; the
[coordinator, line 932](../../../services/importer/src/importer.ts) passes the real payload through registration
to `convertVndb`. No intervening normalization repairs an empty Latin cell.

Deterministic minimal sketch, **synthetic, not an observed empty record**: retain the real fixture's three
headers and just its `v124` VN/entry_meta rows. Use the normal title header and the following sole title row,
where the displayed escapes denote bytes:

```text
v124\tja\tt\t港\t\n
```

After `begin`/`stage`, call `page('vndb', run, {after: null, limit: 1})`. Its record has `title: '港'`,
`latin: ''`. Pass `{external_id: row.key, record_revision: String(row.revision), record: row.record}`
to the actual `convertVndb`. By inspection, `project:175` calls `titleText('')`; `text:60–69` throws
`ConversionError` at `/vn_titles/0/latin` before a digest or any proposals are returned.
Changing only that final cell to raw `\N` yields null and bypasses the Latin title validator.
Whitespace-only Latin passes the reader but fails `titleText:71–75`; it is not silently trimmed.

The existing [reader test, line 280](../../../services/importer/tests/vndb-tables.test.ts) stages empty Latin
on `v124` but inspects only `v123`. The frozen
[portable COPY scenario, line 241](../../../specs/imports-vndb-tables.test.ts) does inspect the empty `v124`
cell, but never calls its `converted` assertion helper for that row. Its
[driver interface, line 87](../../../specs/imports-vndb-tables-driver.ts) nevertheless includes real converter
output in every page record: a binding that eagerly converts every row would encounter this rejection.
The helper's expectation at line 116 includes a candidate for every non-null Latin value; it is not
existing acceptance for semantically omitting `''`. No native binding is present in this checkout.
Do not fill that gap by fabricating output or suppressing conversion in the adapter. Existing
[language assertions, line 34](../../../packages/conversion/tests/vndb-language.test.ts) concern nonempty Latin.
These are coverage/binding limits, not fresh acceptance results. No product suite was executed here.

## Recommendation for owner adoption

Imports owns this seam. Recommend explicitly accepting **exactly zero-length optional Latin text** in
the converter's source projection while emitting no Romanized name/label/alias for it. This is a proposed
REZICS handling of a schema-permitted value, not a claim that VNDB defines `''` as SQL NULL or that the
pinned dump needs this repair. Preserve the primary title and its existing language unchanged.
Keep whitespace-only strings rejected under the current meaningful-title rule: this evidence gives no
reason to trim them into valid absence. Missing/wrong-type fields and invalid primary titles stay errors.

The smallest future correction is an optional-field validation case and a Latin-candidate emission guard,
plus an explicit converter input-contract sentence in its owning README and a converter revision change.
Do not weaken shared `titleText`, rewrite the parser's value, alter definitions/language assertions, or
change the existing decoding fixture to pass conversion. Add independent composition acceptance rather
than reuse or edit the frozen helper's non-null candidate expectation:

1. Observed null and nonempty cases retain the primary title; a nonempty Latin value retains existing
   canonical language behavior. Bootstrap and resolved phases must validate real returned commands.
2. The exact-empty sketch reaches the real converter through `page`, succeeds in both phases, retains
   `latin: ''` in accepted source data and emits the primary name, with no empty or invented Romanized
   candidate, label or alias. Clearly identify this as schema-edge acceptance, not observed dump replay.
3. Null and exact-empty records may have equal semantic name output but must have different digests.
   Repeat conversion and target rebinding preserve each data digest. Nonempty Latin changes affect it.
4. Whitespace-only Latin, missing/wrong-type Latin and empty/blank/null primary titles still reject;
   do not make invalid title data valid to satisfy a lexical COPY fixture.

The [digest contract, line 67](../../../packages/conversion/README.md) hashes the sanitized accepted source
projection, not original COPY bytes. [Conversion, line 225](../../../packages/conversion/src/vndb.ts) hashes
that projection before generating candidates. Preserve `''` versus null there; omit only its semantic
candidate. Equivalent COPY escape spellings need not have different product digests. The archive/member/
line hashes above separately preserve raw evidence identity. Neither digest is a fabricated entry revision.

This report adopts no product change. Only this report is delivered; no outside-path files, frozen tests,
definitions, mappings or READMEs are edited. Offline work was linear in finite archive/member bytes;
observation retained the 4.7 MB title member and its split rows, decoding one row at a time. Memory was
O(member bytes), with no catalogue operation or production cost claim. Delivery acceptance is
`bun scripts/worker-check.ts -- test -s docs/research/imports-audit/vndb-empty-latin.md`;
no root typecheck, kernel, check-host or product gate is part of this investigation.
