# @rezics/definitions

The immutable definition catalogue release format stored by the kernel. This package
exports the release types, the JSON Schema 2020-12 document at
`@rezics/definitions/schema/release.json`, and pure validation and digest functions.

Use `validateRelease(input)` before storing a release. An empty array means valid;
otherwise violations carry RFC 6901 pointers and `invalid`, `unsafe_pattern`, or
`limit` codes. Results are sorted, deduplicated by pointer, and capped at 64.
Validation checks references, CURIE expansion, sorted unique lists, datatype-specific
members, fixed value schemas, and regular-expression safety. Pattern checks use
recheck's in-process synchronous entry point, with a three-second timeout per distinct
pattern; inconclusive results fail validation.

Releases allow at most 256 types, 1,024 properties, 64 properties per type, and 1 MiB
of canonical UTF-8 JSON. Collection and size limits precede schema and pattern checks.
Inputs are parsed JSON, without cycles. Validation does not mutate them.

`valueSchema(datatype, options)` builds the fixed Wikibase value-content schema.
`releaseDigest(release)` returns `sha256:` followed by the SHA-256 digest of its
RFC 8785 canonical JSON. Validate first: the digest function does not validate.
Catalogue generation and bundled definitions are separate concerns.

Run `bun run --cwd packages/definitions check` from the repository root.
