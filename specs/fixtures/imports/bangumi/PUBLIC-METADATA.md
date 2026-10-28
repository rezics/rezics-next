# Observed public Book metadata tags

[`public-book-meta-tags.json`](public-book-meta-tags.json) is an observed input
projection, separate from the synthetic [`subject.json`](subject.json) fixture.
Inspected on 2026-10-29 (Asia/Shanghai). It is neither an imported/adopted subject
nor evidence that a converter emits metadata-tag proposals.

## Attribution and permitted projection

**BASTARD!! -暗黒の破壊神- — Bangumi contributors**, via
[Bangumi subject 498](https://bgm.tv/subject/498), from the pinned archive below.
The fixture's `sourceURL` is that subject URL; the actual bytes came from the ZIP,
not a live subject response. Public wiki metadata is **CC-BY-SA-3.0** under
[Bangumi's copyright statement](https://bgm.tv/about/copyright) (displayed update
2022-10-04), with the [licence/deed](https://creativecommons.org/licenses/by-sa/3.0/)
and [legal code](https://creativecommons.org/licenses/by-sa/3.0/legalcode).
Redistribute this projection under CC-BY-SA-3.0 with this linked attribution.
Changes: select four fields and format JSON; preserve every selected native value,
including the complete ordered `meta_tags` array. No endorsement is implied.

This metadata permission does not license images, ratings or user writing.
The fixture contains none of those fields, ordinary popularity `tags`, account or
Collection data, infobox prose, summary, counts or rankings. It has no synthesized
revision, date or `coverURL`. The raw row has no native revision field; archive
date, row position and checksums are evidence locators, never native revisions.

## Immutable input and record location

The [source inventory](../../../../packages/definitions/sources/bangumi.yaml)
pins the following official input. The `archive` release tag is mutable; identity
depends on the exact asset name and digest.

| Item                          | Observed identity                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset                         | [dump-2026-10-20.210332Z.zip](https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-20.210332Z.zip)                                        |
| ZIP bytes                     | 447451589                                                                                                                                                      |
| ZIP SHA256                    | `9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93`                                                                                             |
| Release / asset metadata      | [archive](https://github.com/bangumi/Archive/releases/tag/archive) / [asset 660480581](https://api.github.com/repos/bangumi/Archive/releases/assets/660480581) |
| Member                        | `subject.jsonlines` at ZIP root; uncompressed 990267761 bytes, compressed 290684690 bytes, directory CRC32 `0f44b2ba`                                          |
| Record                        | Physical JSON Lines line **457** (one-based), native `id: 498`, `type: 1`                                                                                      |
| Uncompressed byte location    | Zero-based interval `[1116919, 1119528)`, including the terminating LF; 2609 bytes                                                                             |
| Raw line SHA256, including LF | `fb80ae3cb9b5a6713c4d8f105f0fcfa079963391c85f6aa15a00ebe9ddc5331e`                                                                                             |
| Raw line SHA256, excluding LF | `c0058cedb0e51c52022ae6b031fd9814803e9e163d5b0bb73eb08e3bd010db83`                                                                                             |
| Field projection              | Exactly `id`, `type`, `name`, `meta_tags`; JSON object key order is immaterial, array order and members are preserved                                          |

The full array is `日本`, `后宫`, `漫画`, `战斗`, `少年`, `奇幻`, `原创`, `系列`.
The row's manga classification is sufficient for this native type-1 Book input
investigation. It supplies no light-novel assertion.

## Source interpretation and replay

The pinned [Archive README](https://github.com/bangumi/Archive/blob/959474a4fcb833f6dabe8dd2f4fe192f82a71140/README.md)
documents `meta_tags` as public editor-maintained tags, separately from `tags`.
Read-only server reference `1997713eafc51487cbea705b37011442f35539fa` confirms
[string-array field shape](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/openapi/components/subject_v0.yaml),
[native Book type 1](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/internal/model/subject_type.go),
and [archive serialization from `FieldMetaTags`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/cmd/archive/main.go).
The actual pinned row, rather than these producer declarations, establishes the
observed `后宫` member. Source code is AGPL-3.0-only; no code was copied or run.

To replay, first verify the ZIP SHA256 above, then stream only the named member
with a standard ZIP reader. Count physical lines from one, retain line 457 bytes
including LF, check its hash, parse JSON, and select the four named fields.
Do not extract arbitrary archive paths. The [investigation report](../../../../docs/research/imports-audit/bangumi-meta-tags-fixture.md)
includes an offline consistency test for that retained raw row.
