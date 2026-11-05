# Complete native reviewed Person composition

Goal: imports
Manager: imports

Owner contracts: services/importer/README.md#reuse-reviewed-person-identity-across-provider-credits,
apps/web/src/features/import-review/README.md#cross-provider-person-comparison and
services/kernel/src/semantic/identity-epoch-contract.md.

The existing seed result now carries personReviewSources (actual admitted source record, converter digest/revision,
original bound native UUID) and personReview (exact selected pair or missing keys, independent citation). The existing
composePersona callback and result/doctor path receive this result without a second wrapper. Current Person reads
remain separate and still withhold dependent credits on missing/conflicting/withdrawn identifiers. The source-handoff
test uses protocol doubles, not a native merge.

The real archives are available read-only under /home/edge/projects/rezics/rezics-datasets/dumps/downloads; both hashes
match the brief. Existing CrossMediaDumpFiles inputs are bangumi/dump-2026-10-20.210332Z and
vndb/vndb-db-2026-11-04 under that same cache. Use scripts/datasets/fetch-dumps.ts and CrossMediaDumpFiles rather than
downloading again. The owner doc records the selected real keys, credited aliases and rows. Actual table digests:

- Bangumi person: c9905a28a65fc787a4376b5ee9f0f77a96b8df25b94759f0e5c4d3d9e8d92b0b
- Bangumi subject-persons: e65213f42f353a1536ff16242ade0de7dabf532738b4b6a3264a7c21b1d8bb05
- VNDB staff: 779527ddb3c8e60e13664be977b68a4cfc2df4c16a3ed344e92f1e1f49f64a0d
- VNDB staff_alias: f48e9d9be6ce4431a55ce5f1e5aadaecff1634a648599f78df75c1b93f8c7f70
- VNDB vn_staff: 69ad79b81df800c1b80639e4dbfd158e74fc94c11508e0212ac3802cd2e86ebc

Remaining implementation:

- Receive the Semantic producer's generated reviewIdentitySource/reviewIdentityExternalId, coherent reviewedIdentity
  and expectedIdentity signatures; this base still has only the additive packages/client seam. Bind generated types
  and errors without an application guard or another DTO family.
- Compose the selected pair through the mounted deliberate reviewer and actual guarded native import transport.
  Record original acknowledged UUIDs, claim transactions, all-kind revisions and string security revisions; no such
  native values were manufactured here. Preserve uncertain command bytes, actor, destination and key.
- Ensure the actual selected family includes the required genuine anime/VN credits, then independently accept/adopt
  and read both current public identifiers/credits. Keep preferred alias28069 and credited alias386 distinct.
- Add services/kernel/test/imports/m1-person-across-media.test.ts against the delivered native guard: exact reopen,
  changed credits, stable bindings/bytes, namesake/Organization/conflicting/withdrawn identifiers, stale review and
  denied current authority. Preserve the frozen suites and mounted credit-return stories.

Verifier retains native/browser, fresh-stack/source-statistics/Bangumi conversion/growth, alias matrix and original
authorization/disclosure acceptance. No native/browser or root acceptance was executed in this implementation part.
