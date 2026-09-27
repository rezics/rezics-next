# Native creation and reading

Creators can draft, publish and read source-free Works through the same Work,
Contribution and Main Version identities used for source adoption. A Post may be
a standalone utterance or occur more than once in a composition without copying
its body. Image-only and poll-only publications need no fabricated text document.
The [BOOK cases](../../scripts/qa/cases/book-and-creation.ts) and
[publication owner](../../services/main/src/modules/content-publication/) carry
the implemented command and exact-history behavior.

Unsaved local edits, shared editing state and published history are different.
Future collaborative editing needs an explicit session or qualified merge
protocol that preserves block identity, validates the resulting document and
keeps both inputs on conflict. [Client synchronization](client-synchronization.md)
owns offline command replay; presence alone promises no conflict-free merge.

Reading progress belongs to stable occurrences. Exact comments and citations
must retain revision and selector. Reuse in another Realm requires its own
acceptance and does not transfer contributor control. Large exports need
cancellable jobs, repeated disclosure checks and an explicit account of missing
coverage or losses.

[Post media](media.md#post-attachments-and-preview-selection) retains the pending
cover, banner and preview design. Its visual interaction belongs with the
frontend implementation and stories.
