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

A disappearing or concealed thread retires its row actions and moves keyboard focus to an announced regional recovery
target without selecting another discussion. Board, sort, viewer or reading replacement retires the old cohort and
frontier.

Slow mode and watch keep their existing owners. Settings watch and Inbox stay Performance-owned.

Decision: The installed public client supplies Board `pinRevision` and `boards({ id })['pin-advice'].post`; production selected advice sends the admitted generation and exact selected sources through the private no-store server reader.

`BoardPinProducer.inspectSelected` uses that callable after current session preparation and rejects a viewer mismatch
before transport. The bounded input and response validators remain in place. The mounted manager prepares and
displays controls only from its exact selected response, and retains the original command intent through explicit
retry and refresh while source, cohort and browser-session retirement close old controls. The Board page's native
source supplies its observed `pinRevision` on initial and continued pages and rejects changed generations at final
admission. Pin/unpin and generation-change refresh continue through their installed owners.

Decision: Advice uses each displayed available opening post's native `revisionId` as `sourceRevisionId` and the admitted Board page's observed `pinRevision`. Selected advice recognizes the public `session_unavailable` problem code locally and does not import Web's private session module. Abort and visit retirement discard late advice without changing command recovery. Native denial leaves readable discussions intact; a stale generation requires current-state refresh.

Decision: Pin/unpin confirmation is an expandable in-row group tied to its toggle; cancel restores toggle focus, while completion focuses the current status or the Board's announced recovery target.

Decision: Bind pin commands directly to the installed KernelClient callable. A forbidden session request returns
`denied` before transport; only a failure during command transport can be uncertain. The installed client returns
transport failures without an HTTP response; these preserve the original uncertain command for explicit retry.
Confirmation relationships use per-occurrence React IDs so repeated discussions have distinct accessible groups.
The mounted retry and regional focus journey uses installed page, advice and command callables.

### Cost: installed selected pin advice

- **Touches:** one private no-store server read prepares the current session, rejects a viewer mismatch before native
  transport, and makes one generated `pin-advice` request for the displayed selection. A successful command retains its
  existing exact retry and performs one cursor-free Board page refresh before advice runs for the admitted generation.
- **Bound:** at most 25 unique displayed sources per advice request; selected order and each source revision are kept.
  No directory scan, second feed or per-row request is added.
- **Growth check:** `board-pins-advice.test.tsx` verifies the generated callable, request generation and forbidden-session
  boundary; `board-pins-mounted.test.tsx` covers uncertain retry, pin, admitted-generation refresh, renewed advice and
  surviving-control focus. Native physical-growth acceptance remains in Content's existing gate.
