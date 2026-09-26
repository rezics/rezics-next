# Package Main Version install request cost contract

`package.recommendation.set` accepts at most 16 distinct coordinates and stores
one immutable exact revision. Its manifest is bounded by the validated 16-item
input; the command validates one set focus and at most 16 recommendation item
focuses. Current-head selection is one bounded graph query; one admitted write
uses one receipt and one outbox event. Read cost does not grow with unrelated
Works.

Current and exact recommendation reads return at most 16 items. Each read uses
bounded association, revision, position and Main Version existence queries; the
revision and position queries cap rows at 17 to detect overflow. The saved
manifest digest is checked before returning bytes. Missing or corrupt exact
bytes fail closed.

An install request reads one exact recommendation revision and accepts at most
16 coordinates. npm work is bounded by the existing
`npm-registry-range-v1` limits: 64 packuments, 16 MiB per packument, 64 MiB
total packument bytes, 512 nodes, 4,096 edges, 16,384 placement checks,
4,194,304 lookups, 256 artifacts, 32 MiB per artifact, 256 MiB total artifact
bytes and a 60 second resolver deadline. Cargo input is bounded by its profile:
32 index files of at most 64 KiB each, at most 129 selected crates, 32 MiB per
verified archive and 256 MiB total verified archive bytes. Unsupported
ecosystems are refused before a resolver call. A lock is created only after
all requested ecosystems solve and every resolved archive digest is verified.

The integration case checks the 16-item request cap, the exact read cardinality,
provider request counts, receipt-backed edits, lock artifacts and no-lock
refusals. These checks observe application calls and transferred bytes; they do
not claim to bound Jena's internal scan work or PostgreSQL physical work. Those
owners remain unmetered by the current operation-wide complexity harness.
