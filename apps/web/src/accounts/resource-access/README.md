# Resource access recovery

Decision: use the existing account ten-second deadline for each native request, with fifteen-second review,
twenty-five-second lookup/grant and thirty-five-second transfer BFF envelopes; only an explicit retry replays
the original pending command. Each envelope includes the native phases plus five seconds for delivery.

The mounted route keeps unresolved controllers under its QueryClient, resource and monotonic session revision.
Return reattaches the original IO and reloads current disclosure without sending a command. Route IO captures
the original CSRF header and checks the existing session observer before dispatch; caller replacement hides the
old loader observations and starts a current read. Settled controllers are released. This implements the
[Accounts decision](../../../../../docs/accounts.md#4-clients-consent-requests-and-permission) with the existing
controller, session observer, CSRF check and native replay, without a new transport or persisted command format.

Decision: permission search filters only the current native response, keeps the selected choice visible, and shows
returned nondelegable roles disabled with their returned action expansion.

Decision: retain at most eight admitted predecessor cursors, the current cursor, and one staged target; commit a
window move only after a ready read, and retry the identical staged target after any non-ready result. A fresh visit
starts at First with no predecessors. The coordinates hold at most 10 cursor strings, or 40,960 JavaScript code
units at the native 4,096-unit cursor ceiling. Each explicit Next, Previous, First, page Retry, or current-page
reload performs one bounded native `grants.read` with the existing ten-second native deadline and fifteen-second
review envelope. Only the current admitted twenty-row page and its supplied identities remain in memory; history
never restores old rows or management authority.

The deadline includes headers and body decoding, races transports that ignore cancellation, composes caller
cancellation and releases its timer/listeners. Resource/account/session retirement still invalidates late
continuations. A stalled review becomes unavailable; a potentially dispatched command stays uncertain with
its exact key, resource, recipient, reference interval and payload. A fresh review only changes the current
observations. It never resolves or reauthorizes the pending write. Native receipt headers retain their session
token for the current review even if receipt decoding times out. A confirmed write with unavailable readback
remains confirmed, with no current ownership claim. Last-owner and permission decisions remain native.

Recipient lookup retains each form's draft and existing currentness/outcome rules. Grant review consumes the
native identities already in its DTO and requires no optional Web recipient hydration or additional lookup.
All recovery states reuse the existing unavailable, lookup and exact-operation retry copy in all eight locales.

Sources: this page group's data, recovery, forms and route; Web account management's read deadline and lifecycle
request conventions; the native Realm ownership section of Access's README and the current Accounts decisions.
No external reference source is required for this request-lifetime change.

Decision: current-page admission refresh preserves one in-memory grant or transfer draft for the exact resource,
caller and source grant. Preserve text and selections through loading, preparation and unavailable reads; require
fresh recipient lookup and review after remount. A definitive denial, changed caller/resource, replaced source grant,
confirmed submission or deliberate editor/window replacement retires the draft. Hidden drafts still protect departure.
A pending write is separately retained by the command owner: its inspectable original operands and key sit beside
Retry, and a current read never rewrites them. A successful native grant response must acknowledge the submitted
resource, subject, interval and role/actions; an empty or unrelated 2xx body remains uncertain.

When a supplied identity identifies the resource itself, its recognizable label leads the resource and transfer
review. Exact references remain inspectable without new identity requests. Transfer confirmation includes the acting
account and any delegating principal along with both owners and the source interval.

Decision: an unavailable or denied page recovers through its Retry grant page control; the current-page reload appears
only over a shown page. A restored draft has no verified recipient, so Review refuses with the invalid-form copy until
a fresh lookup succeeds; Review is disabled only while a lookup is in flight.
