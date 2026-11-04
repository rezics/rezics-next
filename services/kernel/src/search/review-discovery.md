# Public review discovery leaf

Decision: Search copies Content's exact per-review lifecycle version, omits stale indexed reviews until refreshed,
and maps incomplete population cuts to `preparing` while retaining the native full-key continuation.

`createNativeReviewDiscoveryAdapter` builds Content's `createReviewDiscoverySource` and exposes its bounded page,
count, current-summary and registry-reader calls. `createReviewDiscoveryAdapter` accepts that exact Content source
contract (or its factory provider); it does not own a second eligibility or storage path. Without a source, readiness
and operations are `unavailable`. With the installed source, keyset discovery and current public hydration are
available. Count returns Content's public total only when its anonymous eligibility coverage is complete for the
current census generation; otherwise Search preserves Content's `unavailable: true` marker.

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

## Selected mixed Search review context

Decision: Search displays the exact published Content citation with historical question presentation explicitly
unavailable until Content publishes a reusable historical-label contract; today's question label or scale is never a fallback.

The selected mixed page carries `source.openingRevisionId` and Content's opaque lifecycle `sourceVersion`.
After the existing owner hydration and ranking, `prepareSearchReviewContexts` rereads those exact selected
reviews through Content's public producer and native thread disclosure. It uses the current Semantic
`readSubjectSummaryObservation` for native identity, localized label, Type and authorized cover. No public
author-profile projection or feed question-label resolver is used. A withheld target or author withholds citation
presentation; a missing citation remains absent, including when the current vote exists. Available citations retain
exact question ID, units (including zero) and vote revision from the immutable opening revision. No current vote is read.

The final page rechecks Content lifecycle/source identity, opening/place disclosure, citation and Semantic source
observations after asynchronous enrichment. Movement fails the unchanged page with `search_restart_required`;
it never refills rows, reranks, changes the raw frontier or creates another cursor. Concealed context has no sibling
fallback target. Public cards have no private viewer state or commands. Native details and keyboard-operable spoiler
reveal use the existing Content provenance and catalogue cover components. Reader replacement remains owned by
Search's mounted request lifetime; the row issues no requests and keys its reveal state by review/opening/source identity and locale.

### Cost: selected context

For `R <= 100` selected reviews, `S <= R` distinct targets and `A <= R` public author identities, each composition
uses two Content `hydrate` rounds (partition-grouped, at most 100 keys each), two selected `discloseThreads` rounds,
one Semantic summary observation and its final `current` check, and two anonymous Accounts summary batches
bracketing final foreign reads. Attribution movement retires the page together with its citation.
Content hydration retains its exact-anchor probes, dependency/source-version work, native Subject/Board/place/Access
checks and complete census contract. Each native thread disclosure retains its own ancestry and full-body admission
(maximum 2 MiB per document); no history walk, vote read or candidate refill is added. Accounts may read their bounded
avatar and verified-agent summaries; Semantic retains its bounded representative/media/fence work and indexed seeks.
These nested producer reads and raw bodies are charged even when the resulting context is withheld.

Presentation traverses at most 4,096 document nodes at depth 64 per selected opening; an over-budget document
withholds the excerpt. Content's existing excerpt cap remains 160 code points/640 UTF-8 bytes. Target metadata admits
at most 16 Types, 16 cover variants and 16 credit obligations, with explicit field-length bounds before copying or
serializing. Oversized cover metadata withholds only the cover. Serialized context is at most 8 KiB per row and
128 KiB per page; overflow returns explicit unavailable context without an excerpt. Subject labels are at most
1,024 characters and language tags 64. Question/reference history reads are zero while the unavailable historical
presentation seam is installed. These are finite input/work bounds, not measured physical SQL or latency ceilings.
Independent 256/1024/4096 population growth and broader mixed native/browser acceptance remain controller validation.
