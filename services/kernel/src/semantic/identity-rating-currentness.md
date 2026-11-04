# Identity rating currentness

The vote command resolves a readable target before opening its command transaction, then rechecks that resolved target with one indexed redirect lookup in the voter's transaction. A redirect, non-visible terminal, or pending/unavailable identity home keeps the command attempt retryable and writes neither the vote nor its event.

Visibility repair uses `IdentityRatingParent` as the native Performance boundary. The parent persists the immutable page binding and commit receipt with each effect, verifies the owner incarnation before commit and acknowledgement, and replays those records after an interrupted return. The consumer processes at most 64 work items per page and at most 8 pages per invocation; terminal provenance is reclaimed only after the parent's final-reference check succeeds.

## Retained progress boundary

Decision: native acknowledgement retains the exact page checkpoint; the consumer resumes after an acknowledged nonterminal page and verifies a native tombstone before replaying a reclaimed terminal page.

`IdentityRatingParent` is the minimal native seam on this source. The journal below
supplies retained-page storage; producer inventory storage, the consumer transaction
wrapper and moderation scheduling remain producer work.
The consumer does not create another rating or erasure writer. Existing parents without
checkpoint support keep their receipt-based behavior; durable continuations require all
three native methods described below and `native` metadata on their selected pages.

The selected page's `native` identity names the retained frontier, phase and revision.
All three enter the selected-page digest together with the scope, owner incarnation,
epoch, cursors and work items. Scheduler ordinals are never substituted for them.
`readRepairCheckpoint` reads the checkpoint committed with native acknowledgement.
It takes precedence over a caller's older saved reply. A nonterminal checkpoint means
the next selection must start at its exact `next` cursor; an unchanged selection stays
pending before another commit. Each invocation still advances at most eight pages.

A reclamation checkpoint reselects the exact retained terminal page, verifies its
committed receipt and acknowledges idempotently before attempting another cleanup step.
`selectPage` with a replay binding must resolve that retained page, even if the live
frontier advanced. An unrelated selection, changed native phase/revision, changed scope,
or different receipt position cannot satisfy a replay.

`reclaimFinalProvenance` may return `continuing` after one bounded removal page.
The caller retains the reclamation checkpoint and schedules the next invocation.
`still-referenced` preserves existing completion semantics: this obligation is finished,
and another real reference retains the payload. The native owner must wake cleanup when
that last reference disappears. Every native cleanup stage must be idempotent.

After the last reference permits payload removal, the native owner retains a compact
tombstone binding the scope, frontier, phase, revision, selected-page digest, owner
incarnation and committed receipt. `verifyReclaimedCheckpoint` checks that evidence
through native full keys, including current ownership; caller JSON grants no authority.
The consumer checks this proof before reselecting payload, including when a cleanup
reply was lost before a `complete` checkpoint reached the caller. A missing verifier
cannot certify terminal replay. Owner ABA leaves replay pending. Compact replay does
not require retained vote payload. This is domain replay evidence, not a funding ticket.

## Consumer structural bounds

Every textual selection operand is at most 256 UTF-8 bytes; the visibility has three
fixed values. A page has at most 64 unique work-item IDs, each with three textual
operands and one safe integer or null. The selection has at most twelve other textual
operands (scope, page identity, two cursors and native identity). JSON escaping expands
each input byte by at most six; numeric values need at most seventeen bytes. Thus an
encoding candidate is below `204 * 256 * 6 + 64 * 17 + 2,048 = 316,480` bytes.
The accepted complete encoding is capped at 65,536 bytes before hashing. Oversized,
duplicate, malformed and nonadvancing pages perform no native commit. Scope and page
identity are frozen before crossing asynchronous boundaries. Receipt identity is frozen
before native verification and acknowledgement. Checkpoints carry fixed identity and
receipt fields, never work-item payload or arbitrary extra properties.

One page calls selection, receipt read, optional commit, verification and acknowledgement
at most once each: five native calls, including conflict, empty and lost-reply recovery
paths. A repair invocation adds one checkpoint read, at most one compact replay check
and at most one reclamation step. Its ceiling is `8 * 5 + 1 + 1 + 1 = 43` native calls;
compact terminal replay takes at most two. Failures terminate the invocation; no local
retry loop repeats IO. Pending paths are prefixes of these finite paths. These are
consumer bounds; they do not claim the absent producer's SQL/index/trigger bounds.
The concrete producer must compose its documented per-call bounds with these finite
multiplicities. No quote, prepaid balance or runtime dispatch allowance is required.

## Native retained-page journal

Decision: preserve the retained consumer API and implement its native replay storage as
an additive transaction-local journal; connect the absent producer through
`IdentityRatingJournalProducer`, without importing its incompatible replacement consumer.

`identity-rating-journal.ts` supplies durable selected pages, receipts, acknowledgement
checkpoints and compact terminal replay evidence. It requires a live native command.
The producer's existing wrapper admits and locks once, then passes the whole normalized
selection to its read-only `assertHeldAdmission` in that same transaction. Its sole
`applySelectedPage` writer is called only when no native receipt exists. Persisted
ownership uses `core.partition.node` and its monotonic `epoch`; selected owner fields
must match them. The root never updates its owner incarnation and cannot revive after
reclamation. Moving away and back therefore cannot authorize terminal replay.

Acknowledgement and the producer's frontier advancement belong in the same transaction.
The journal retains the actual native frontier, phase, revision and selected-page digest,
never a scheduler ordinal. Its checkpoint wins over lost caller replies. Exact selection
uses the full scope digest and page digest and compares the entire scope and binding.
An acknowledged old page cannot rewind progress. A unique partial index admits at most
one unacknowledged selection per scope. Native empty pages follow the ordinary effect
and receipt path; producer failures roll back the page and never certify an empty result.

Journal reclamation is only the final retained-copy stage. The producer must first
finish its provenance, event, obligation and receipt inventories and prove removal of
the final real reference under its held reference fence in the same transaction.
`reclaimIdentityRatingJournalPages` keeps the terminal selection through every bounded
deletion page. The final deletion and compact tombstone commit atomically, so loss of
that reply is recoverable without reading deleted payload. The journal does not claim
that its page count is the producer's reference inventory. Accounts' combined erasure
and historical redirect flattening remain separate outcomes.

### Static journal bounds

There are two tables, each with a full-key primary index. Page insertion also maintains
one partial unique index on the scope for unacknowledged pages; its foreign key probes
one journal root. There are no triggers or cascades. Scope keys are fixed SHA-256 text,
with full JSON comparison after lookup. A selection uses the consumer's 65,536-byte
array encoding limit. Its stored object representation adds at most 64 sets of fixed
field names plus fixed page names (less than 8,192 bytes); 131,072 bytes allows SQL
JSONB whitespace and encoding. Root scope, binding, receipt and checkpoint encodings
have enforced 4,096/16,384/8,192/32,768-byte ceilings respectively. They contain only
the adapter's bounded fields. Whole rows and constant-width indexes are finite.

Commit uses at most five journal statements: one owner lock, root insert, root lock,
receipt seek and page insert. Producer application is an independently composed
cost. Including conflict, uniqueness and foreign-key probes, the journal examines
at most eight rows, writes at most two rows and inserts at most three index
entries. Receipt conflict/replay is its four-statement prefix and never repeats
producer application. Acknowledgement uses at most five
statements, examines at most five rows and updates two rows; it removes at most one
partial-index entry. Checkpoint read and terminal verification use two statements
and at most two rows. Exact page replay uses three statements and at most three rows.

Cleanup uses at most six journal statements: owner/root locks, an indexed ordered
65-row seek excluding at most one terminal row, deletion of at most 64 selected keys,
one terminal-key deletion and one root update. It examines at most 134 rows,
deletes at most 65 page rows, updates one root and removes at most 130 index entries.
It returns `continuing` after the first 64 when more remain. Reclaimed replay uses the
two-lock prefix. Final-reference verification is an additional producer cost on each
nonterminal cleanup invocation. Failures terminate without a local retry loop.
For the consumer's 43-call ceiling a conservative journal allowance is
`43 * 6 = 258` statements and `43 * 134 = 5,762` examined rows, plus the separately
derived producer selection, effect, admission and reference-verification bounds.
No runtime quote, funding ticket, balance or dispatch allowance is accepted.

Native producer caller installation, all other cleanup inventories and their composed
SQL/index bounds remain required before native end-to-end acceptance. This journal
does not activate an alternative vote writer or change moderation authorization.
