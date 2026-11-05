# Zone History Semantic continuation

Goal: accounts. Manager: accounts.

## Delivered History seam

History registers the five current Zone command receipts (`zone.create`, `zone.configure`, `zone.publish`,
`zone.delete`, `zone.restore`) and five base events (`com.rezics.zone.{created,configured,published,deleted,restored}.v1`).
The events remain nonpersonal with exact `{ id, revision }` payloads. `registerZoneHistoryConsumers` is composed by
`access/shared-history-work.ts`; its callbacks use `observeZoneHistoryConsumerClosure` from `history/receiving.ts`.
That observation binds exact original source transaction/position and event locator, requires complete
`semantic.erasure_delivery` plus no unreleased `semantic.record_purge_hold`, and returns the exact native closure
fields or a pending gap. Existing receiving calls accept the `HistoryReceivingContext` discriminant and carry it
through `readHistoryReceivingReceipt`, `recordHistoryReceivingProof` and `verifyHistoryReceivingReceipt`.
`zones:durable-work/v1` remains uncovered because the base has no delivered Zone durable-work producer.

## Undelivered owner operation

Semantic42 still owns the sole Zone cleanup CAS and its branch lifecycle; the callable that binds its committed
terminal-account barrier and exact captured Zone owner/transaction custody has not landed. Deliver it at the existing
Zones/ Semantic lifecycle seam. It must supply the existing History receiving context with the original home and
epoch, committed account barrier version/time, exact Zone ID/route, captured owner/transaction, resource and lifecycle
revisions, deletion generation, protection revision and bounded durable progress. It must re-read protection and
receiving custody under the owner’s existing locks. A `RecordPurgeAuthority`, a proposed export name, a no-row result,
an empty traversal or delivery/workflow status alone cannot call this branch complete.

The owner must drive actual selected receipt/outbox minimizers after each native consumer and held receiving effect
settles, retain command source custody until real consumer release, and include actual current/former durable-work
producers before closing that family. Then add the complete graph scenarios for held-consumer release, replay, late
registration/effect, failed/archived copies, CAS/protection changes and unrelated surviving resources. Observe source
custody, private disclosure fences, physical copies and durable closure with independent read-only queries; do not
write cleanup SQL or acknowledgement rows in tests.

Landing command for this History seam: `bun run --cwd services/kernel check test/history/zone-consumers.test.ts`.
