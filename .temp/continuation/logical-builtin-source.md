# Headerless logical Collection Source continuation

Goal: commerce. Manager: content.

## Delivered

- `2c61cade2d` keeps logical reads fail-closed when the exact caller Source has no current binding.
- `5fc14b31de` resolves a logical ID to current owner Account/Access, owner-index readiness and state support, or Content's indexed Liked version. It rechecks that evidence on the same captured Source and does not create Collection metadata or a private-working observation from the descriptor.
- `8d1c9357fb` removes the redundant route option. The registered Kernel typecheck passed at this source.
- `docs/library-liked.md` records the decision: binding evidence is separate from Collection metadata and reader authority; absent canonical scope remains unavailable.

## Remaining work

Implement a producer-owned canonical scope and alias-safe prefix source for headerless Everything, state and Liked. The current `canonical-source-store.ts` capture path calls `readNativeCollectionWorkingMetadata`; `nativeSourceCustody.bindOwner` reads `library.collection`; therefore neither can prepare a headerless source. The owner-index functions and `readLikedSubjectPage` provide raw original IDs, but no canonical-ID seek. Sorting or deduplicating one raw window cannot prove canonical order or cross-page uniqueness.

Use the current owner-account binding, owner-index readiness/state support and accepted state pins; use Content's indexed like/love membership and version for Liked. Obtain Semantic's current identity/mapping evidence and preserve original plus terminal disclosure. Carry the actual logical binding and currentness through `prepare`, `prefix`, `containsSubject`, and final revalidation on the exact caller Source. Keep the existing canonical storage/prepared-state machinery; do not add a second renderer or accept descriptor-shaped metadata.

GET must remain read-only: no Collection header, grant, receipt, or domain state; unsupported/unready bindings remain unavailable, distinct from a genuinely empty page. Preserve bounded work accounting and private-working classification.

## Contract and verification

Owner documents: `docs/library-liked.md` (canonical pages and privacy), `docs/dynamic-collections.md`, `docs/collection-source.md`, and `docs/library-owner-queries.md` (Source2a/privacy/identity producer).

After the producer is delivered, run the retained native acceptance argv:

`bun run --cwd services/kernel check test/library/liked-user-cases.test.ts test/library/builtin-pins-user-cases.test.ts test/library/continue-user-cases.test.ts`

Retain assertions for headerless admitted reads, exact Source provenance, current private owner, original and terminal disclosure, canonical membership/prefix, state siblings and holdings, exact accepted pins, and unchanged stored state after GET. These native suites were deferred here; the source typecheck does not establish them.
