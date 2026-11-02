# Account lifecycle controls

Web review route: `/{locale}/platform/accounts/{accountId}`. The immutable ID selects one target; it supplies no
permission. The page uses the existing signed-in session and shared Origin/CSRF middleware. Requests and SSR are
private, no-store. No bearer, reason or command intent is put in a URL or browser storage. No account scan, handle
lookup, scope change, Auth writer or grant page is added.

The production-configured generated client calls the real private
`POST /v1/accounts/{accountId}/lifecycleReview` (`account.lifecycle_review`) with an empty body for selection.
Only its exact `account:suspend` / `account.suspend` or `account:reinstate` / `account.reinstate` pair enables
confirmation. The adapter exposes native current state/floor/fence separately from original outcome. Management
and generic viewerActions never authorize lifecycle controls. Healthy authenticated BFF reads retain their existing
null-CSRF support; the native read is a private bearer request. The deliberate write still uses the generated
`$suspend.post` or `$reinstate.post` colon method, exact reason, credential and original idempotency header.

The target and confirmation lead with the current display name and handle, or a localized name-unavailable label.
The exact account ID is selectable in optional account details beside the identity. Review captures a display-only
name/handle snapshot beside the immutable intent; later availability reads cannot relabel that confirmation or
supply authority. Confirmation shows the actual action, exact private reason and sign-in consequences. Technical
help and request details retain protocol, floor/fence, original-key and receipt information without leading the
decision or recovery text. Closing or reloading the page loses its in-memory copy; no persistence is added.

A confirmed immutable intent stays in memory while sending and after response loss. Recovery attempts one current
native read before offering an identical replay, and checks current advertisement again before sending. A receipt
is reported only as recorded; it never proves current state, Auth cleanup or operator fanout completion. New effects
stay locked after recorded or uncertain responses. Native explicit `not_applied` responses are distinguished from
unknown outcomes. The page performs no automatic effect retry or polling loop.

## Native readback and remaining proof limits

Before a deliberate command, the data adapter calls the same private port with the immutable original
`{operationId,key,reason?}` in its body and exact original credential. Native current exact-action authorization
precedes receipt access. An already recorded original is returned without executing another command, even when the
current target state makes that action inapplicable. Otherwise only the exact current applicable advertisement
permits that deliberate request. After the one native command, one bounded readback resolves a lost native response;
there is no effect retry or polling. A received command result remains recorded if the current read fails. Keys and
reasons never appear in URLs, browser persistence, response echoes or logging added by this adapter.

Original status, current snapshot and effect observation are independent. The native reader checks complete original
principal/client/delegation/operand digest and source currentness; an unknown/missing receipt never proves non-application.
Operator reads corroborate actual continuation/page/completion and business receipts. Multi-page or unavailable
operands remain pending/unknown; Auth session cleanup has no installed terminal operand and remains unknown for
suspension. Access session-step authorization is reported separately and never substitutes for Auth completion.
Semantic account-agent synchronization also remains explicitly unknown for both operations. The port supports an
explicit bounded native operator page-key read; the adapter does not traverse it.
The existing page receives native facts and recorded outcomes through its unchanged data consumer. Its captured
identity, consequence/recovery wording, details, immutable intent, synchronous exclusion and conservative new-effect
lock stay intact, including its existing unavailable-state prose. No page, style, story or locale is redesigned.
A later BFF response loss remains uncertain until a supported explicit original replay/read can return a result;
a current selection read alone carries no original key and cannot resolve that result. Refresh loses the in-memory
intent. No automatic retry, custody proof or whole-feature completion is claimed.

The private route's complete call graph, exact primary-key/index bounds, SQL row/byte/statement limits and original
deadline are documented in Access's private lifecycle review section. Checked-in native client declarations include
this real mounted route and its shared projection contract; there is no fixture endpoint or generic public fallback.
The native transport/presentation fixture preserves human identity and exact intent assertions while replacing only
obsolete management/viewerActions expectations. Native acceptance and that fixture remain UNRUN; Web typing is
UNVERIFIED in this delivery.

## Stalled transport recovery

Review, dispatch and readback each allow ten seconds, following Web account management timing; the browser command
allows 35 seconds for these three phases and BFF delivery. Deadlines cover headers and body decoding even when the
transport ignores cancellation, compose caller cancellation, and release timers/listeners on settlement. Route retirement
cancels selection; component retirement cancels its active request without changing another review's operation.
A review timeout uses existing unavailable/retry wording. A possible dispatch or stalled readback stays uncertain with
the exact account, action, key and private reason retained; a received receipt stays recorded, never completed.
Recovery requires an explicit current review and deliberately reuses the original command; native original review
can resolve it before any dispatch. There is no automatic mutation replay or fresh key to escape uncertainty.
The native owner README linked by the assignment is absent on this base; existing generated lifecycle contracts are
consumed unchanged. Sources read: this page group, Web account management's read deadline, the lifecycle route,
generated client entry point and existing lifecycle presentation/transport tests. No reference-project source applies.
