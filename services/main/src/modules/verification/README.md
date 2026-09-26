# Verification owner extension

The claim write/read template is `graph.ts` (guarded Jena command and terminal
receipt), `operations.ts` (Account and Access admission, exact reads and
reconciliation), `store.ts` (Content transaction, local receipt and CAS), and
`routes/claims.ts` (typed HTTP surface). Copy the matching admission, receipt,
stale-head and exact-read pattern for another verification operation. Register a
new graph action in `receipt-family.ts` and its exact outbox kind in
`outbox-event.ts`; declare bearer and idempotency headers in the route module.

## Cost contract

- Claim create and source reliability write use one bounded graph command and
  receipt read. Assessment admits at most 32 evidence items, 32 source
  assessments, 40 lineage observations and 80 summary dependencies; over-budget
  lineage abstains, and larger manifests are rejected before activation.
- Evidence and challenge writes are one Content transaction with a bounded
  manifest and local receipt. A summary read checks each of its admitted heads
  and one active generation; it never scans all claims.
- Invalidation fan-out uses the indexed `(kind, reference, target, context)`
  reverse edge and keyset pages of at most 200. Each page commits its demand and
  cursor together. The schema test checks the index plan; the claim API test
  checks analysis work and paged invalidation. Capacity still requires the
  planned load tier.

The owner reuses Access admission and grants, graph receipts/outbox/epochs,
Content source observations, and existing publication selection authority.
Quality summaries do not replace an adopted result or protection decision.
