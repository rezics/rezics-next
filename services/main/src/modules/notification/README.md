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
| `subjects.ts` | Owner adapters that render only currently disclosed fields of the pinned subject revision. |
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

## Cost contract

| Operation | Bound |
| --- | --- |
| `enqueue` | O(recipients ≤ 256 × endpoints ≤ 8) rows; one stream row lock per recipient in canonical order. |
| `runOnce(n)` | n ≤ 32 leased rows; ≤ 16 statements per row plus one provider call and at most one lookup. |
| `readStream` | 9 statements; one index range on `(principal_id, stream, generation, sequence)` of ≤ 51 rows, independent of other recipients (EXPLAIN checked at 100/1,000/10,000). |
| `advanceWatermark`, `setPreference`, `readDelivery` | Constant statements on primary/unique keys. |
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
External provider configuration, a recipient-specific production subject
reader, email endpoints bound to an Account-verified address, and signed
unsubscribe links remain needed before Main starts the delivery dispatcher.
