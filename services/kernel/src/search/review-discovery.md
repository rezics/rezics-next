# Public review discovery leaf

Decision: Search composes Content's installed public review source, preserves its unavailable census and full-key
continuation, and returns `preparing` when a still-eligible row has advanced beyond its indexed partition position
without a matching opening revision. This avoids exposing a restored stale row while Content has no per-review
lifecycle version.

`createNativeReviewDiscoveryAdapter` builds Content's `createReviewDiscoverySource` and exposes its bounded page,
count, current-summary and registry-reader calls. `createReviewDiscoveryAdapter` accepts that exact Content source
contract (or its factory provider); it does not own a second eligibility or storage path. Without a source, readiness
and operations are `unavailable`. With the installed source, keyset discovery and current public hydration are
available. Exact population cardinality remains unavailable as reported by Content; Search returns the native
`unavailable: true` marker and never manufactures a count.

## Native projection and continuation

The identity is `content:review:<thread UUID>` with the native route derived from that UUID. Each document carries
the exact Content partition position and opening `revisionId`; Content's approved 160-code-point excerpt is copied
without widening its cap. The native row's subject, author ID, vote citation and other author-private fields do not
enter Search documents or common summaries.

Content pages accept 1–25 results, examine up to four candidates per requested result, and fetch one lookahead key.
The adapter accepts sparse and empty pages, preserves Content's raw full `(route, thread ID)` continuation, and
validates that it advances past every returned eligible row. Only `next: null` ends a traversal; eligible row count
does not prove exhaustion. Each page has its own exact native position. A continuation is not pinned to a fabricated
partition census, so a late publication can appear after the last examined full key with its own later position.

Current cards use Content `hydrate` under its anonymous public-read checks and the Search caller's live deadline.
Content omission for a protected, withdrawn or deleted opening stays an omission. A changed opening revision also
withholds the indexed hit. If the same revision is still eligible at a later partition position, Search returns
`preparing`: Content currently exports no per-review lifecycle version to distinguish an unrelated partition write
from deletion followed by restoration. A freshly indexed document at that exact later position hydrates normally.
This conservative state is retained until Content exports that per-review version; Search does not infer it from
the opening revision or a global position.

## Cost, bounds and growth

| Operation | Static bound |
| --- | --- |
| Content page | One indexed candidate query with `LIMIT <= 101`; at most 100 candidates hydrated. Each candidate gets one Content thread read and one Semantic subject read, at most 200 owner reads. |
| Count | One partition-position read; zero candidate reads. Content's exact count remains unavailable. |
| Search current summaries | At most 160 documents, grouped by partition and sent in Content batches of 100; at most 320 current owner reads. |
| Shared registry current reader | At most 200 identities, sent in batches of 100; at most 400 current owner reads. |

Growth is bounded by the fixed page, candidate and current-read limits. Page cost does not grow with the population;
continuations advance by the last examined native key. Content owns board, review, opening, subject eligibility and
storage. Its revision, restore, deletion, moderation and publication events remain the incremental refresh inputs.
There is no reply/history walk, second refill loop or private vote read.

The shared registry, closed owner union, common codec, generation projection, default worker and current/query
execution remain with their owners. They consume this leaf only when its typed readiness and native currentness
permit it. The Search owner document for the common format is
[Discovery document format](discovery-document-format.md); universal condition and disclosure authority remains in
[Search conditions](../../../../docs/search-conditions.md#second-scope-producer-boundaries).
