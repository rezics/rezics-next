# Skill dependency lock cost contract

`POST /v1/hub/imports` accepts at most 128 files and 1 MiB of file bytes. The
optional requirements sidecar is at most 64 KiB and declares at most 256
requirements; each target is at most 4 KiB and each native selector at most 1
KiB. Import parsing, exact Content retention and revision-row writes are bounded
by `O(B + F + R)`, with `B <= 1 MiB`, `F <= 128`, and `R <= 256`.

`POST /v1/hub/revisions/{revision}/dependencies` accepts at most 16 resolved
segments. Each segment is read through the selected ecosystem owner and lowered
to one `pkg.lock_segment`; the shared lock owner caps the final artifact list at
256 and writes one `pkg.lock_artifact` per artifact. A Go segment may revalidate
at most 256 retained release captures through its indexed capture owner. Each
Skill revision may declare at most 256 package requirements, each mapped at
most once. Lock creation builds bounded npm edge/instance indexes; Cargo and Go
selector checks inspect at most 256 selected packages per mapped requirement.
It writes one SQL row per segment, artifact, Go capture check and requirement
mapping. Application work is bounded by `O(sum(N) + R*P + S + A + C)`, where
`N` is each selected receipt's bounded inventory (npm: at most 4,096 edges and
512 nodes; Cargo: at most 128 releases; Go: at most 256 captures), `P <= 256`,
`S <= 16`, `A <= 256`, `C <= 16*256` Go capture checks, and `R <= 256`. SQL
calls are bounded by `O(S + A + C + R)`. Request and response bytes are
bounded by the route schema, exact receipt snapshots and shared lock contract.

The Work page read pins the current public publication and eligibility in one
bounded graph query. It checks the exact Content digest and Hub subtype before
returning at most 65,536 bytes of prompt or SKILL.md text. Skill verification
reads at most 128 files and 1 MiB of retained artifact bytes. Version history
uses one graph query for at most 11 publication decisions and one indexed SQL
lookup for dates of at most 10 displayed revisions. Complexity is O(F + B + V),
with F files, B retained bytes and V published versions; Work visibility is
checked before and after the read.

Each ecosystem profile remains the resolver/adapter authority. The Hub operation
does not compare versions or merge package identities across segments. The
revision UUID and requirement mappings are included in the lock's canonical
manifest and idempotency digest. Duplicate caller scopes are rejected before owner reads. The operation performs one exact private
lock replay lookup on a same-key retry; new locks use the shared owner's bounded
resolution reads and one transaction for the lock, segment, requirement and
artifact rows.

`tests/qa/unit/hub-deps.test.ts` checks the 16-segment admission boundary,
duplicate scopes and ecosystem-preserving lowering. The HUB03/PKG18 API tests
check the imported requirement bound, same-ecosystem concrete-artifact proof,
and exact SQL mappings. The shared package-lock API tests own SQL row and
transaction bounds. This check does not establish deployment capacity or bound
the prior ecosystem resolution operation that supplied each receipt.
