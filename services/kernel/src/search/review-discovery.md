# Public review discovery adapter

Decision: reviews use the Content thread ID with the `review` discriminator and a native `(route, thread ID)` keyset; Search reports unavailable or preparing until Content supplies complete revisioned coverage and current disclosure.

`review-discovery.ts` defines the narrow Search leaf seam for Content. The retained source does not yet export a complete review population reader, so the adapter has no default producer and returns `unavailable`. A registered producer may report `preparing` until its full eligible population and current summaries are covered. Search never infers readiness from a sitemap, subject-thread listing, board sample or fixture.

## Producer contract

The Content producer owns the eligibility decision and the native source position. `count(partition)` pins an exact eligible population count and position. `page(partition, after, limit, atPosition)` reads that population at the pinned position in `(route, thread ID)` order. Pages contain at most 100 records; the adapter checks every key, route, partition, revision and continuation before returning any document or frontier. The caller passes the number already consumed so a short page, premature end, extra row or missing continuation cannot certify exhaustion. A page must stay at the census position.

Each record carries the thread UUID, native route, monotonic source version, opening revision ID, Content canonical destination, opening title and opening text. Text is bounded to the native 2 MiB opening body. `owner: content`, `kind: review` and the thread UUID form the identity. Board, place, target, opening publication, thread state and their disclosure checks remain Content responsibilities; Search does not derive them from separate lists. The projection has no current author-vote field. Immutable public vote citations are outside this adapter.

`read(partition, ids, atLeast)` returns one current observation per requested ID from a position at least as new as the indexed documents. `eligible` includes the current projection; `withdrawn`, `deleted` and `concealed` carry only identity and source version. A stale eligible document is withheld when its version or opening revision no longer matches. Withdrawal and deletion therefore reduce visibility during indexing lag; restoration is visible only after the newer eligible revision is indexed and passes current hydration.

`summaries(ids, context)` is a separate current Content read under the Search reader context. It may omit IDs the reader cannot currently see. Returned summaries must match the source version, opening revision, destination and opening text; malformed, foreign or duplicate rows reject the whole batch. The adapter returns only the canonical destination and disclosed opening title/text. Private current author votes never enter the document or summary.

## Bounds and readiness

Population and current-owner reads are partitioned and bounded to 100 IDs per source call. Search requests at most 100 rows per population page and 160 documents per current hydration operation. Page positions, per-thread source versions and opening revision IDs remain native values; no timestamp substitutes for them. Incomplete coverage is `preparing`; an absent or unavailable producer is `unavailable`; only a complete producer may return `ready`.

This leaf exports normalized documents and current summaries for the shared mixed pipeline. The shared registry, common document validator, generation projection and mixed currentness path have a separate owner; their call-site integration is tracked separately. Universal kind, ordering and disclosure authority remains in [Search conditions](../../../../docs/search-conditions.md#second-scope-producer-boundaries).
