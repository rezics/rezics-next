# Realm ban management lifetime

`SpacePage` supplies `page.realm.id` to its default `RealmBansPanel`. The Panel still renders the original
`RealmBansControl`; its callbacks call `space-actions`'s `readRealmBans`, `resolveRealmBanTarget` and
`changeRealmBan`. Those original server functions validate inputs and use `loadRealmBans`,
`loadRealmBanTarget` and `writeRealmBan` with the generated native client. No replacement authority or transport
is introduced. Explicit standalone Control fixtures retain their existing props; the optional `lifetime` prop
carries default Panel admission.

The browser Panel requires both `useSession` and its actual QueryClient session cache to describe the same
signed-in account with a nonempty CSRF token. Unknown, preparing, signed-out and missing-token sessions admit
neither private lists nor commands. This is caller admission, never proof of native `realm:ban` permission.
The original CSRF token accompanies the command; a callback cannot borrow a replacement token.

One read-only cache observation per QueryClient records state, subject and CSRF transitions synchronously.
Its monotonically increasing revision records a batched away/back transition even when React renders only the
final tuple. QueryClient replacement is also a source replacement. It fetches no session, roles or other data.

The Control captures the original Realm, readiness, parent lifetime, read/write/resolve functions and initial
read object. Replacing any of them retires the private visit before rendering its successor. Retirement hides
and unmounts the private list, cursor, target, selection, reason, both confirmations, uncertain command and
receipt. Returning an old tuple does not restore them. A replacement ready caller obtains a fresh ordinary
native list. A repeated initial read object cannot seed another visit after replacement or disconnection;
a distinct initial object is an explicitly supplied new read generation for standalone callers.

The Panel and standalone Control also bind the original locale. A locale change fences pending sends
and settlements before rerender; rendering the new locale starts a fresh visit. Management exposure
retains the initial native admission read before entry, so a permitted user can still open the original
management region. Once entered, closing the region retires its private visit; reentry reads afresh.

Decision: retain the initial hidden-region admission read, then retire private ban facts, drafts and late work when an entered management region closes.

Layout cleanup disconnects synchronously and invalidates connection tickets. Strict Mode may reconnect the same
visit, restarting its outstanding read; previously disconnected work remains obsolete. A weak initial-read
retirement marker prevents a genuinely new mount from borrowing a disconnected visit's initial page even
within the synchronous effect-replay window. Default Panel mounts always perform a new native read.

Read generation, target intent and connection ownership guard every queued transport and settlement. Target
edits, selection, reason changes and cancellation invalidate old confirmation intent. Refresh replaces the
read generation and aborts lookup; abort is only an optimization. A single synchronous operation owner spans
final exact identity revalidation and the resulting ban send. Repeated activation cannot slip a second
command between them. Only the owning operation can release busy, and current recoverable failures release
it. A retired success, denial or transport failure cannot update the successor, refresh it or turn an accepted
receipt into an uncertain result.

Only an explicit uncertain retry resends the frozen command's exact Realm, target, action, reason and
idempotency key. It does not perform a speculative new target lookup or invent a new intent. Refresh and other
commands remain excluded until that uncertain result is resolved or its caller retires. A current success
refreshes the list; a recoverable refresh failure preserves its definitive receipt. Native forbidden, closed,
signed-out and role-required responses retain their existing meanings. Sparse empty pages retain `next`;
invalid cursors require explicit first-page Restart. Ban acceptance remains distinct from Accounts' membership
removal completion, and unban does not promise membership restoration or follow changes.

## Departure

Ban controls register with the existing page authoring departure owner; standalone controls use its boundary.
Nonempty target input or reason, an explicit selected account, either reviewed confirmation, and sending or
uncertain commands require the shared Stay/Leave decision. Opening management and inspecting rows are browsing.
Cancelling an unsent confirmation clears only that confirmation; remaining draft fields still protect departure.
Keyboard review keeps its current focus position; Cancel returns focus to the review trigger, and a successful settlement
focuses the existing result boundary only when focus remains on the removed confirmation action.
Stay preserves the exact reviewed identity, reason and confirmation without resolving the handle again or
generating a new key. An uncertain retry retains the original immutable command and excludes refresh.

Confirmed Leave synchronously retires the original visit gate, aborts lookup and invalidates operation, read
and intent continuations before destination reads. Late lookup, write and refresh responses cannot update a
replacement Realm or disclose old private state. Leave does not cancel or roll back a native ban. A definitive
receipt releases command protection immediately, including while list refresh is pending; another nonempty
draft still protects departure. These registrations introduce no native reads, writes or polling.

Decision: whitespace-only target input and reasons count as nonempty drafts until explicitly cleared.

## Current window navigation

Decision: retain eight preceding Realm/visit-bound opaque addresses, commit direction only on native success,
and distinguish current-window Refresh from deliberate first-page Restart through the shared departure owner.

Next pushes only its supplying address after success; Previous rereads the last retained address and pops it
only after success. A failed direction retains its requested cursor and direction for exact Retry. Empty sparse
pages remain continuable. Refresh rereads the active address without pushing; Restart clears preceding addresses
and omits the cursor. Expiration requires Restart. After eight preceding addresses, older addresses are discarded;
reaching that boundary explains first-page recovery. There is one replacing body, never cached page bodies,
forward history, inferred offsets, prefetch, refill, persistence or hidden traversal.

The departure owner's local-leave hook retires drafts and reviews before a page read while preserving this
admitted visit's addresses and independent receipts. Stay preserves the page and reviewed confirmation. Route
Leave still retires the entire visit. Sending/uncertain commands exclude all browse controls. Read generation
retires selected inspection, confirmation and old callbacks even for equal successful replacements. Keyboard
Previous/Next/Refresh/Restart/Retry use the existing read-focus intent; pointer or moved focus never steals focus.
Revocation and source/Realm/session/locale/management retirement clear private navigation with the visit.

## Cost and verification boundary

Work is fixed per lifetime plus O(page size) rendering. The existing native page limit remains 20, target
lookup remains one exact handle read, and a fresh ban uses its existing final exact identity revalidation and
point command. There is no polling, history/directory scan, additional role read, per-row identity read or new
background work.

## Installed current ban review

The installed `KernelClient.realms({ realmId }).bans.get` admits the composed response and original
`selectedAccountId` query through the shared client owner's normal integration. Web derives its response,
query, identities, episode advice and selection types from that installed route. The native owner remains
[Current ban review page](../../../../services/kernel/src/community/README.md#current-ban-review-page) and
[the mounted schemas](../../../../services/kernel/src/community/ban-review-page-schemas.ts).
Web does not import the native schema or modify generated delivery.

The default Panel binds exact inspection to its existing `readRealmBans` server function, original native
HTTP adapter and QueryClient lifetime. An explicit selection reads one Realm/account with the captured list
frontier and limit 20. Retry retains that immutable input; it does not move the visible page, scan/refill the
list or infer exact absence from exhaustion. Native denial, unavailable inspection and admitted operational
absence have distinct explanations. An absent observation is neither a command receipt nor evidence that
Accounts completed membership removal. A missing exact observation stays unavailable.

Every operational row remains visible. Disclosed target/moderator labels and handles use only the native
identity projection. Links admit only its canonical `/@handle` destination. Concealed identities use the
localized Account label and operational key without a link; a null native actor means an erased moderator.
The actual reason/time, jointly disclosed Realm/Space context and episode-bound native unban advice appear
with the row. Advice describes an observation; the original command still reauthorizes, including protected
role refusal. A removal observation cannot establish workflow completion.

Decision: retain four-field standalone observations with safe account-key fallbacks; the default Panel uses installed composition and only its admitted exact selection can establish operational absence.

`RealmBanCurrentControl` keeps its unavailable default for standalone callers without an adapter. Default
Panel inspection binds caller, Realm, exact account and frontier and copies the current episode, including
nested identities/advice, before confirmation. Editing, clearing or explicitly retrying selection retires the
confirmation. Page/source/caller replacement fences queued and late observations. List confirmation also
copies the reviewed episode. Cancel restores focus to the unban trigger. Stay preserves review; Leave retires
it through the existing departure boundary. Inspection does not change a draft, uncertain command or receipt.

The original writer retains immutable uncertain intent and original credentials, excludes duplicate sends,
and reauthorizes every command natively. Explicit new intent creates a new key; uncertain retries preserve
the original key. Successful commands refresh the ordinary list. Native accepted removal remains pending
until Accounts establishes completion, including after unban or reban.

Decision: retain the latest accepted ban and unban command receipts separately within the visit (at most two), replacing only the same action's prior receipt; label earlier receipts as historical without current-state assurances.

Each retained receipt keeps its original immutable command and idempotency key and a copied native result.
Starting another command, an uncertain retry, exact absence or a replacement current episode does not erase
the opposite action's receipt. Revoked admission and visit retirement remove both private receipts. This
bounded display is not native command history or workflow readback.

## Current-ban consumer cost and verification

- Touches: one native composed page per explicit Next/Previous/Refresh/Restart/Retry (including sparse pages), one exact selection per explicit inspection/retry,
  existing handle resolution and final revalidation only for a deliberate ban, and separate original commands.
  Identity/authority arrive from composition, with no per-row network fanout.
- Bound: page20, one exact selected episode, one immutable uncertain command, two accepted receipts, eight
  preceding addresses, one active address and one pending/failed request. Each address pairs the admitted Realm
  and visit with its native opaque cursor (at most 4,096 wire bytes): preceding cursors total at most 32,768
  bytes, active plus pending/failed cursors add at most 8,192; the replacing page retains its existing next
  cursor bound separately. Realm IDs add 36 ASCII bytes per address and visits are scalar references. No
  retained bodies/history, polling, hidden refill or global lookup. Rendering/copying is
  O(page size plus admitted bytes), using the installed response's native bounds.
- Growth check: `tests/realm-bans-window-navigation.test.tsx` advances beyond eight addresses and natively
  revisits the retained prefix with one twenty-row replacing body, exact failure retries and explicit expiration
  recovery. Each activation makes one page request, independent of prior windows; the focus group covers
  committed read handoffs and caller retirement. Native 256/1024/4096 obligations below remain separate.
  `tests/realm-ban-current-installed.test.tsx` exercises 1/10/20 composed rows through the actual
  default Panel/Control, original server validators/handlers, generated native HTTP client and QueryClient.
  It covers identities/destinations, explicit exact retry with the same frontier, unavailable/denied/current/
  absent selection, duplicate exclusion, uncertain unban retry, deliberate reban with a new episode/key,
  independent receipts, pending removal and retirement. Browser/server plumbing and HTTP responses are
  authored fixtures, not native authority or physical growth evidence.

`tests/realm-ban-current-boundary.test.tsx` retains four-field unavailable-fallback and sparse continuation/
replacement coverage. `tests/realm-ban-current-selection.test.tsx` retains the injected observation seam's
unchanged writer/confirmation assertions. `tests/realm-ban-lifetime.test.tsx` retains original admission,
replacement, queued sends, current recovery, bounded20, cursor restart, native denial and immutable retry
assertions. No unchanged writer assertion is removed.

Original frozen acceptance, native preparation/authority/all-pool growth, controller verification and rendered
browser/Storybook integration remain deferred to the controller after integration. Content/Accounts retain
native 256/1024/4096 current-interval/history/identity/authority and registered completion evidence. Consumer
fixtures, installed typing and the older source-only deliveries establish none of those outcomes.

The current-review stories show composed disclosed/concealed identities, erased moderators, exact current/
absent/unavailable/denied states and selected-episode unban confirmation. Their responses are illustrative;
the installed adapter journey and native producer evidence remain separate.
