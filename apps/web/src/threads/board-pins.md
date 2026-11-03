# Board pins

Decision: The initial board page renders Content's disclosed `pinnedThreads` (at most five, native newest-first
order) above the existing active/hot/new continuation. Ordinary rows keep their supplied order. Identities already
present in that native section are omitted from the continuation on the same page. Web never scans other pages to
discover pins and never sorts downloaded threads into a second feed. Concealed pins are absent from the array and
leave no title, placeholder or count.

Readers see a localized pinned section and a pinned badge on those disclosed rows. Empty continuation keeps the
feed's existing empty and sparse-page meanings and does not claim the board has no pins. Malformed native pin data
is unavailable with an explicit refresh. Preparing, denied and unavailable pin reads do not hide ordinary discussion
rows.

Content owns pin scope, capacity, native ordering, disclosure, moderator authorization and commands. Web displays at
most five native `pinnedThreads` in supplied order; Content remains the cap and currently returns at most three.
Listing responses omit per-row pin actions, so controls appear only from explicit producer actions. Membership,
Realm role names, signed-in state and client-side pin counts do not grant a control. A readable pin can be shown
when management is denied.

The consumer is `BoardPinProducer` in `board-pins/contract.ts`. `readBoard` re-reads the same board-threads GET,
including `pinnedThreads` and ordinary continuation, bound to the current sort and cursor. `change` binds
`boards({ id }).threads({ threadId }).pin` POST `{ pinned }` with the original idempotency key. A missing generated
method stays unavailable; no endpoint or successful native body is invented. Pin/unpin requires confirmation showing
the discussion title. Unknown outcomes retry that same sender, CSRF credential, key and operands. Conflict or
refusal offers an explicit current-state refresh. Viewer, session, target or reading replacement retires local
recovery without claiming to cancel a request already sent. Private pin reads and commands are no-store and stay
outside public metadata.

Slow mode and watch keep their existing owners.
