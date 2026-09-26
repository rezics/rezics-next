# Verification owner extension

The claim write/read template is `graph.ts` (guarded Jena command and terminal
receipt), `operations.ts` (Account and Access admission, exact reads and
reconciliation), `store.ts` (Content transaction, local receipt and CAS), and
`routes/claims.ts` (typed HTTP surface). Copy the matching admission, receipt,
stale-head and exact-read pattern for another verification operation. Register a
new graph action in `receipt-family.ts` and its exact outbox kind in
`outbox-event.ts`; declare bearer and idempotency headers in the route module.
`correction-delivery.ts` pages immutable correction notices into G-051's Access
notification owner. A lost Access acknowledgement replays by source event and
recipient before the Content cursor advances. Delivery rereads the exact notice
and the recipient's current subscription, exposing only support/dispute fields.
Main composes that owner reader with the regular Content reader by disclosure
basis, so verification corrections reach the production notification dispatcher
without broadening the Content reader's admitted bases.

## Cost contract

- Claim create and source reliability write use one bounded graph command and
  receipt read. Assessment admits at most 32 evidence items, 32 source
  assessments, 40 lineage observations and 128 summary dependencies; over-budget
  lineage abstains, and larger manifests are rejected before activation.
- Evidence and challenge writes are one Content transaction with a bounded
  manifest and local receipt. A summary read checks each of its admitted heads
  and one active generation; it never scans all claims.
- Invalidation fan-out uses the indexed `(kind, reference, target, context)`
  reverse edge and keyset pages of at most 200, with at most 20 pages per call.
  Each page commits its effect ledger, demand and cursor together. Replaying a
  producer identity checks the exact payload; the ledger prevents a target from
  receiving the same invalidation twice even if other events advance its demand.
  The FACT04 integration test checks 205 dependents across bounded pages, resume,
  duplicate identity and one effect per target. Capacity still requires the
  planned load tier.
- Correction delivery pages at most 128 recipients per notice and calls one
  bounded G-051 enqueue per page. The cursor moves after Access commits;
  delivery-time disclosure rejects unsubscribed recipients. The integration
  test checks a lost acknowledgement and one resulting recipient item.

The owner reuses Access admission and grants, graph receipts/outbox/epochs,
Content source observations, and existing publication selection authority.
Quality summaries do not replace an adopted result or protection decision.
