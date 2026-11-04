# Identity rating currentness

The vote command resolves a readable target before opening its command transaction, then rechecks that resolved target with one indexed redirect lookup in the voter's transaction. A redirect, non-visible terminal, or pending/unavailable identity home keeps the command attempt retryable and writes neither the vote nor its event.

Visibility repair uses `IdentityRatingParent` as the native Performance boundary. The parent persists the immutable page binding and commit receipt with each effect, verifies the owner incarnation before commit and acknowledgement, and replays those records after an interrupted return. The consumer processes at most 64 work items per page and at most 8 pages per invocation; terminal provenance is reclaimed only after the parent's final-reference check succeeds.

## Retained progress boundary

Decision: native acknowledgement retains the exact page checkpoint; the consumer resumes after an acknowledged nonterminal page and verifies a native tombstone before replaying a reclaimed terminal page.

`IdentityRatingParent` is the minimal native seam on this source. Its concrete native
storage, consumer transaction wrapper and moderation scheduling remain producer work.
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
