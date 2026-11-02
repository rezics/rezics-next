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
invalid cursors offer explicit first-page refresh. Ban acceptance remains distinct from Accounts' membership
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

## Cost and verification boundary

Work is fixed per lifetime plus O(page size) rendering. The existing native page limit remains 20, target
lookup remains one exact handle read, and a fresh ban uses its existing final exact identity revalidation and
point command. There is no polling, history/directory scan, additional role read, per-row identity read or new
background work.

`tests/realm-ban-lifetime.test.tsx` authors the actual default Panel/Control/session-cache composition with the
original server handlers and generated native HTTP client. Deferred native responses and an independently
deferred original server-function response cover replacement, queued sends, current recovery, bounded20,
sparse cursor restart, native denials, exact uncertain retry and duplicate exclusion. The acceptance is
**UNRUN** in this implementation placement. Existing acceptance/native/bound/growth/browser/Storybook/root
and stack verification are also deferred to integration; Web workspace typing is the permitted local check.
Typing cannot establish those outcomes or whole-feature completion.

Existing affected stories remain unchanged:

- `pages-community-realm-bans--management-journey`
- `patterns-community-realm-bans--current`, `--ban-and-unban`, `--removal-pending`, `--unban-confirmation`,
  `--next-page`, `--empty`, `--loading`, `--unavailable`, `--forbidden`, `--closed`, `--invalid-cursor`,
  `--role-removal-required`, `--revoked`, `--ambiguous-retry`, `--saving`
