# Public review discovery leaf

Decision: Search copies Content's exact per-review lifecycle version, omits stale indexed reviews until refreshed,
and maps incomplete population cuts to `preparing` while retaining the native full-key continuation.

`createNativeReviewDiscoveryAdapter` builds Content's `createReviewDiscoverySource` and exposes its bounded page,
count, current-summary and registry-reader calls. `createReviewDiscoveryAdapter` accepts that exact Content source
contract (or its factory provider); it does not own a second eligibility or storage path. Without a source, readiness
and operations are `unavailable`. With the installed source, keyset discovery and current public hydration are
available. Exact population cardinality remains unavailable as reported by Content; Search returns the native
`unavailable: true` marker and never manufactures a count.

## Native projection and continuation

The identity is `content:review:<thread UUID>` with the native route derived from that UUID. Each document carries
the exact Content partition position, opening `revisionId` and opaque per-review `sourceVersion` as `version`;
Content's approved 160-code-point excerpt is copied
without widening its cap. The native row's subject, author ID, vote citation and other author-private fields do not
enter Search documents or common summaries.

Content pages accept 1–25 results, examine up to four candidates per requested result, and fetch one lookahead key.
The adapter accepts sparse and empty pages, preserves Content's raw full `(route, thread ID)` continuation, and
validates that it advances past every returned eligible row. Only `next: null` ends a traversal; eligible row count
does not prove exhaustion. Pass the initial page's `position` as the fourth `cut` argument on continuation. Content
retains that cut or reports typed incomplete readiness, which Search maps to `preparing`. Missing cuts and partition
changes require a fresh traversal, so late publication cannot silently fall behind the retained frontier. The cut
does not manufacture an exact population census or retain historical disclosure rights.

Current cards use Content `hydrate` under its anonymous public-read checks and the Search caller's live deadline.
Content omission for a protected, withdrawn or deleted opening stays an omission. A changed opening revision also
withholds the indexed hit. The native `sourceVersion` must also equal the indexed document's `version`. Deletion
followed by restoration changes this binding even if the opening revision is unchanged, so the stale restored hit
stays omitted until refreshed. Unrelated partition writes leave this review's version unchanged and do not delay
its current card. Search never infers lifecycle freshness from a partition position or opening revision alone.

## Cost, bounds and growth

| Operation                      | Static bound                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content page                   | One indexed candidate query with `LIMIT <= 101`; at most 100 candidates hydrated. Each candidate gets one Content thread read and one Semantic subject read, at most 200 owner reads. |
| Count                          | One partition-position read; zero candidate reads. Content's exact count remains unavailable.                                                                                         |
| Search current summaries       | At most 160 documents, grouped by partition and sent in Content batches of 100; at most 320 current owner reads.                                                                      |
| Shared registry current reader | At most 200 identities, sent in batches of 100; at most 400 current owner reads.                                                                                                      |

Growth is bounded by the fixed page, candidate and current-read limits. Page cost does not grow with the population;
continuations advance by the last examined native key. Content owns board, review, opening, subject eligibility and
storage. Its revision, restore, deletion, moderation and publication events remain the incremental refresh inputs.
There is no reply/history walk, second refill loop or private vote read.

The shared registry, closed owner union, common codec, generation projection, default worker and current/query
execution remain with their owners. They consume this leaf only when its typed readiness and native currentness
permit it. The Search owner document for the common format is
[Discovery document format](discovery-document-format.md); universal condition and disclosure authority remains in
[Search conditions](../../../../docs/search-conditions.md#second-scope-producer-boundaries).
