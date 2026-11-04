# Board pins

Decision: The initial board page renders Content's disclosed `pinnedThreads` (at most five, native newest-first
order) above the existing active/hot/new continuation. Ordinary rows keep their supplied order. The native initial
cohort is the complete bounded section in supplied order, including identities omitted because they are concealed.
Those identities are excluded from ordinary continuation on that page. Later pages return an empty `pinnedThreads`
array and do not imply the board has no pins. Web never scans ordinary pages to rediscover pins, never retains
historical cohorts, and never sorts downloaded threads into a second feed. Concealed pins leave no title, placeholder
or inferred count.

Web consumes the installed generated Board opening method and DTO. Initial and continued reading, including pin
refresh, use that response's disclosed card and context projections; see [Native Board opening receiver](board-opening.md).

Readers see a localized pinned section and a pinned badge on those disclosed rows. Empty continuation keeps the
feed's existing empty and sparse-page meanings. Malformed native pin data is unavailable with an explicit refresh,
distinct from a denied read and from `400 invalid_cursor`. Preparing, denied and unavailable pin reads do not hide
ordinary discussion rows.

Content owns pin scope, capacity (five, newest pin first), native ordering, disclosure, `pin_revision`, moderator
authorization and commands. Web displays at most five native `pinnedThreads` in supplied order. Listing responses
omit per-row pin actions, so controls appear only from explicit producer actions. Membership, Realm role names,
signed-in state and client-side pin counts do not grant a control. A readable pin can be shown when management is
denied.

Effective pin/unpin, including ABA, increments the native pin revision and invalidates the previous cursor. Web
discards that page's continuation authority and offers an explicit restart of this board/sort with no cursor. It
does not silently replay a stale frontier or merge two epochs. An initial page with no cursor re-reads that same
board/sort without a cursor. Expired or foreign cursors use the same restart, not a generic unavailable retry.

The consumer is `BoardPinProducer` in `board-pins/contract.ts`. `readBoard` re-reads the same generated Board opening GET,
including `pinnedThreads` and ordinary continuation, bound to the current sort. After an invalidating command it
omits the obsolete cursor. `change` binds `boards({ id }).threads({ threadId }).pin` POST `{ pinned }` with the
original idempotency key. A missing generated method stays unavailable; no endpoint or successful native body is
invented. Pin/unpin requires confirmation showing the discussion title. Unknown outcomes retry that same sender,
CSRF credential, key and operands. Conflict or refusal offers an explicit current-state refresh before a new intent.
Viewer, session, target or reading replacement retires local recovery without claiming to cancel a request already
sent. Private pin reads and commands are no-store and stay outside public metadata.

A disappearing or concealed thread retires its row actions and returns keyboard focus to a surviving row or the
feed heading. Board, sort, viewer or reading replacement retires the old cohort and frontier.

Slow mode and watch keep their existing owners. Settings watch and Inbox stay Performance-owned.

Decision: The production selected-advice receiver stays unavailable until retained complete-input publication exposes the installed root-derived KernelClient callable; a method-shaped runtime bridge does not establish that client contract.

`BoardPinProducer.inspectSelected` remains unavailable until that callable is published. The bounded input and
response validators remain ready for the existing private no-store native advice route. The mounted manager now
prepares and displays controls only from its exact selected response, and retains the original command intent
through explicit retry and refresh while source, cohort and browser-session retirement close old controls. The Board
page still lacks the observed `pinRevision`, so production selection remains unavailable until the publication
adds it. Tests establish bounded selection, response validation and mounted consumer behavior, not native
management/growth. The publication owner continues the retained lineage through
`416-retained-content-publication.md`; this consumer does not generate or install declarations and makes no
declaration-head claim.

Decision: Advice uses each displayed available opening post's native `revisionId` as `sourceRevisionId`; pin actions stay unavailable until the Board page supplies its observed `pinRevision`.
