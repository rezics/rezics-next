# Account lifecycle controls

Web review route: `/{locale}/platform/accounts/{accountId}`. The immutable ID selects one target; it supplies no
permission. The page uses the existing signed-in session and shared Origin/CSRF middleware. Requests and SSR are
private, no-store. No bearer, reason or command intent is put in a URL or browser storage. No account scan, handle
lookup, scope change, Auth writer or grant page is added.

The production-configured kernel client reads the exact existing account management endpoint and native
`POST /v1/viewerActions` for that target. Identity and role data never confer permission. Only an exact
`account:suspend` / `account.suspend` or `account:reinstate` / `account.reinstate` advertisement enables confirmation.
The command uses the generated `$suspend.post` or `$reinstate.post` binding, which sends the actual native colon
method, an optional exact reason and the original idempotency header. Native current authorization remains decisive
before receipt replay. Development fixtures never stand in for this capability.

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

## Required Accounts ports

These are requests to the existing native owners, not guessed endpoints or new authority:

- Extend current private account management reading, or publish an explicitly authorized exact-ID private lifecycle
  read, for a governance-authorized target including suspended targets. Return current state, monotonic floor/fence
  observation and native pending effect status. Keep suspension reasons absent. Current
  `GET /v1/accounts/{accountId}/management` only admits active, unfenced self/organization/operator-related targets;
  it returns identity and relationships, not lifecycle state. Its 404 must not be interpreted as suspended or deleted.
- Advertise the existing exact suspension/reinstatement operations through current native viewerActions using their
  actual installed authority source. Current lifecycle route declarations have no resource-type binding, and the
  default viewerActions registry has no readable Global Context entry. Reinstatement authorizes the Global Context;
  do not simulate it with a target role or a guessed Global resource type. Preserve the full actor, scopes, consent,
  delegated principal, assignment/floor, denials and gate formula before receipt access.
- Provide genuine bounded current command/effect readback for the same immutable intent, authorized under current
  authority, so the page can release its new-effect lock only when the original outcome is established. The existing
  command responses allowlist accountId, state, minimumAuthnEpoch and receiptId; they omit effect progress. Neither
  receipt presence, a queued effect nor disappearance from a public read establishes completion.

Until these ports are installed, the real page explicitly shows unavailable private lifecycle state and unavailable
exact actions. The typed real command path is implemented, with no fake fallback. Existing management inventory and
resource grants remain their owners' pages. Illustrative review/recovery stories do not prove native capability.
Native acceptance, stories from recorded outcomes, visual review and operator fanout proof remain later integration
work; this delivery makes no deployment or native completion claim.
