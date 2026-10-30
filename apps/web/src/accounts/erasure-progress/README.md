# Private erasure progress

`/platform/accounts/$accountId/erasure` selects a known immutable ID, without a directory, public profile lookup
or deletion command. The signed-in session binds each server function to the current viewer. The real transport
uses only configured `KERNEL_ORIGIN`, never the development fake client. Each read is private, no-store and sends
one authenticated `GET /v1/accounts/{accountId}/erasureStatus`, with no body. An explicit reload repeats current
native authorization. Native Access owns exact direct-Global `account:read_erasure`, `gate:account_erasure` and the
full scope/principal/assignment/floor/denial formula. This consumer adds no scope, grant or alternate authority.

The local response contract is closed: `accountId`, `state`, `at`, `completedAt`, `pendingParticipants`,
`retentionOutstanding`, `lateItems`, `effectsFrontier`. Missing fields, private additions, foreign IDs, invalid
states and contradictory completion observations become unavailable. Names are technical participant labels,
bounded to 64 ASCII characters and 64 entries; the body is capped at 16 KiB. No store, reason, locator or native
error payload is rendered. A missing route or missing record supplies no existence or completion proof. The
original barrier and native completion timestamp are preserved, never calculated. A retention-outstanding
observation may carry the actual cleanup completion timestamp while permitted retained material remains.
False flags and an empty pending list never override pending state or prove completion.

The view drops its old observation before every read, on failures and on viewer/session changes. Generation
fencing ignores late responses. It has no background polling, local persistence, mutation or account analytics.
Stories are explicitly illustrative consumer states, not recordings or native participant proof. Native source
installation, original whole erasure closure, external/backup erasure and later Web visual review remain separate.

Source surfaces read: Access README's account deletion policy and internal erasure status; Access's
`erasure.ts` status type and state construction; `docs/deletion.md`; the existing account management, lifecycle
and profile editor BFF/session patterns. No external reference-project source is named for this surface.
