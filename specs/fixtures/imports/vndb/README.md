# VNDB single-record fixtures

These are synthetic, inspectable projections of decoded dump rows, grouped for
one `vn` record. They are not API responses or COPY parser fixtures. Related rows
use the real table and column names; unrelated release columns are omitted.
All text is invented. The extra discussion, review, account and private-list
rows are hostile contamination, not a claim that public dumps contain them all.

Schema and rights were checked against the official
[2026-10-25 dump](https://dl.vndb.org/dump/vndb-db-2026-10-25.tar.zst), specifically
`schema_vndbid.sql` and `README.txt`, and the official
[schema source](https://g.blicky.net/vndb.git/tree/sql/schema.sql).
See also [dump documentation](https://vndb.org/d14) and
[Data License](https://vndb.org/d17#4).

The database license is **ODbL-1.0**; individual database contents use
**ODC Database Contents License 1.0**, identified here as `LicenseRef-DbCL-1.0`
([license](https://opendatacommons.org/licenses/dbcl/1-0/)). This LicenseRef denotes
that exact instrument, not an SPDX-listed license or CC0. Attribution is VNDB.
Descriptions and images have separate source conditions; this fixture supplies
no republication grant. The dump's README still calls the description column
`desc`; its actual schema calls it `description`. Images being downloadable is
not a grant. These tests permit metadata and require omission of prose and covers.
