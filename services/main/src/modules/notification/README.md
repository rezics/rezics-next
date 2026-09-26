# Notification owner (Access PostgreSQL)

Template for the PostgreSQL-owned private command/read family with an external
channel adapter. Contract: [notifications](../../../../../docs/contracts/notifications.md);
schema: Access migrations 062–064; cases GOV05–GOV08.

## Shape

| File | Role |
| --- | --- |
| `schema.ts` | Drizzle declarations checked against the migrated DB (`services/main/tests/governance-schema.test.ts`). |
| `store.ts` | `NotificationStore`: producer intake (`enqueue`), recipient commands (preference CAS with receipt, endpoint rotation, stream reset), reads (stream page, hint, delivery), the monotonic watermark and retained erasure reconciliation. |
| `dispatcher.ts` | `NotificationDispatcher`: leases due deliveries (`SKIP LOCKED`), rechecks eligibility and disclosure, calls the `DeliveryProvider` outside transactions, finishes under the lease token, reconciles `uncertain` by stable delivery id, records provider events once, and delegates retained erasure reconciliation to the store. |
| `delivery-worker.ts` | Periodic bounded runner; durable due rows and leases remain the schedule. |
| `http-provider.ts` | Configured REZICS v1 HTTP provider bridge with bounded responses, timeout, stable idempotency key and lookup. |
| `realtime.ts` | One shared Access `LISTEN` connection per Main process; fans out committed stream cursor hints. |
| `subjects.ts` | Owner adapters that render only currently disclosed fields of the pinned subject revision. Main uses the current Access Work-read decision for Content. |
| `../../routes/notifications.ts` | HTTP surface and error mapping; registered by one `.use()` in `app.ts`. |

## Rules the template fixes

- Every transaction takes `access.recovery_fence` first, sets `lock_timeout` 2 s
  and `statement_timeout` 5 s, and maps SQL states through
  `normalizeNotificationError` (23505/40001 → conflict, 23514/23503 → stale).
- A command is idempotent by `(principal, idempotency key)` with a request
  digest; the same key with another body is a conflict, a wrong expected
  revision is stale. Receipts are immutable rows, not a second receipt model.
- The delivery row is the work item; there is no notification outbox. The
  stable delivery id is the provider idempotency key. A thrown provider call is
  `uncertain`, never failure; the next run looks the id up before any resend.
- Terminal states are final in the database trigger; unsubscribe, rotation and
  late callbacks never reopen them. Provider evidence may settle `pending`.
- Items pin an exact subject revision and store no rendered copy; erasure and
  disclosure are decided by the subject owner at delivery time.
- Other recipients' state is indistinguishable from missing (404).
- Content events using the production reader carry
  `content-work-reader-v1:<actingSubject>` as their disclosure basis. Unsupported
  bases fail closed; Main resolves the recipient identity from the active Access
  principal and asks Access for the current Work-read decision before Content
  returns the pinned revision.
- Main starts `NotificationDeliveryWorker` only when the provider URL, provider
  bearer token and callback signing secret are all configured, and only after
  retained Account erasures have replayed. The provider name is `http`.
- The provider bridge posts `notification-provider-send-v1` to
  `<base>/deliveries` with `Idempotency-Key: <deliveryId>`. It accepts only
  `notification-provider-result-v1` (`accepted` with a message id, or an
  explicit `rejected` with a safe code). Lookup uses `GET <base>/deliveries/<id>`
  and `notification-provider-lookup-v1`; 404 means not found. Redirects, 5xx,
  timeouts, malformed responses and oversized bodies stay uncertain. The base
  URL must use HTTPS except for loopback QA adapters.
- Email addresses remain Account-owned. Because this owner has no Account
  verified-address resolver or email endpoint command, the production HTTP
  adapter rejects an email send with no address without contacting the provider.
  The existing push endpoint is the production-configured channel in this slice.
- Realtime is a WebSocket upgrade on `GET /v1/me/notifications/hint`; an ordinary
  GET on that path returns the current cursor snapshot. Enqueue/reset sends a
  minimal `{generation, head}` hint via `pg_notify` inside the Access transaction.
  The shared listener routes the committed hint only to sockets for that recipient.
  Hints are not durable or replayed; after reconnect, compare the hint with the
  saved cursor and fetch every missing row through `readStream`.

## Cost contract

| Operation | Bound |
| --- | --- |
| `enqueue` | O(recipients ≤ 256 × endpoints ≤ 8) rows; one stream row lock per recipient in canonical order. |
| `runOnce(n)` | n ≤ 32 leased rows; ≤ 16 statements per row plus one provider call and at most one lookup. |
| Scheduled delivery tick | At most 32 expired leases recovered plus 32 due rows dispatched; one active tick per Main process. |
| `readStream` | 9 statements; one index range on `(principal_id, stream, generation, sequence)` of ≤ 51 rows, independent of other recipients (EXPLAIN checked at 100/1,000/10,000). |
| `advanceWatermark`, `setPreference`, `readDelivery` | Constant statements on primary/unique keys. |
| Realtime | One listener connection per Main process; O(active sockets for the notified recipient) local sends; ≤256 post-commit hints per event. Provider response bodies are capped at 16 KiB and each HTTP exchange has a 5 s timeout. |
| Production Content disclosure | One Access principal identity lookup, one Access `canReadWork` decision and one exact Content revision read per delivery; the decision is current and recipient-specific. |
| `reconcileRetainedErasures` | Pages of 500 relay intents; each page one bounded update per table; startup fails before the 600-second preparation limit if replay cannot finish. |

## Extending

Copy `store.ts` + `routes/notifications.ts` for another Access-local owner:
keep the transaction helper, the recipient/principal resolution, the receipt
pattern and the error mapping. Copy `dispatcher.ts` + `tests/qa/support/fake-delivery.ts`
for another outbound adapter (lease, recheck, send outside transaction, finish
under lease, lookup before resend). Tests: `tests/qa/integration/notification-delivery.test.ts`
(real Account tokens, cloned owners) and `tests/qa/fault-recovery/notification-erasure.test.ts`
(restored Access backup reconciled from the relay journal).

Main constructs the store after replaying relay-retained Account erasures when
the relay read pool is configured. Account declares `notification:manage`.
The PostgreSQL 18 `NOTIFY` contract publishes only after transaction commit and
may fold identical hints in one transaction, so durable stream reads—not the
socket—own completeness ([PostgreSQL NOTIFY](https://www.postgresql.org/docs/18/sql-notify.html),
reviewed 2026-09-27). The content and listener tests exercise current Access
authorization and real Bun WebSocket connections. Remaining Account-owned work
is a verified-email resolver/endpoint flow and signed unsubscribe links; see the
G-109 handoff proposal.
