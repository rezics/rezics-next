# Notifications, communication and read state

## Events, inbox and channels

Domain events generate recipient-specific notification intents under current
subscription/preferences and disclosure. An inbox item, email/push delivery and
underlying content are separate identities. Reading a notification does not mark
every source item or conversation message read. Per-device delivery and recipient
read watermarks have independent state.

Private preferences, blocks, muted topics and optional-channel consent remain
Account/private-control data. Security/account recovery messages use a distinct
purpose contract from optional social notifications. A provider aggregate or
source user cannot create a native recipient.

## Delivery protocol

Commit intent with its operation/outbox, then deliver through bounded workers.
Before each delivery, recheck eligibility and render only currently disclosed
fields. Stable delivery IDs and provider idempotency support retries; uncertain
external results require reconciliation. Address/token rotation and unsubscribe
cannot reactivate a cancelled intent. Record terminal disposition and safe diagnostics.

Email has text/HTML, verified sender configuration, suppression and signed
preference controls for optional subscriptions. Push payloads avoid private content
when lock-screen disclosure is not authorized. Webhooks follow installation scope
and signed-envelope contracts. Secret addresses/tokens stay outside public RDF.

## Read and realtime behavior

Read state is idempotent and monotonic within its declared stream/generation,
with explicit resets when allowed. Realtime hints carry sequence/cursor and do not
replace durable retrieval. Reconnect detects gaps and uses bounded reconciliation.
Presence/typing are ephemeral with expiry rather than permanent graph history.

Qualify duplicate events, recipient changes, stale disclosure, lost ACK, invalid
push endpoints, unsubscribe, read races and restore without redelivery surprises.
