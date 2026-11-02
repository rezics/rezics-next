# Resource access recovery

Decision: use the existing account ten-second deadline for each native request, with fifteen-second review,
twenty-five-second lookup/grant and thirty-five-second transfer BFF envelopes; only an explicit retry replays
the original pending command. Each envelope includes the native phases plus five seconds for delivery.

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
