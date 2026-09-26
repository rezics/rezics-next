# Content draft protection template

The first owner binding is `content-draft-protection-v1`: one Content variant's
`draft_head` and optional `protection_head`. Migration 130 serializes every draft
writer, protection change and correction application on the existing variant row.
It appends immutable protection, proposal, decision and application records. The
Content receipt, owner position and outbox are written in the same transaction.
Migration 131 adds a proposal-scoped private-principal comparison key; public
proposal reads omit it. `null` protection means asserted absence for this profile.

`content-store.ts` is the owner write/read template. Copy its operation lock,
recorded-receipt replay, target-row lock, exact basis checks, and single-commit
receipt/outbox pattern for another Content-owned target. Copy `admitted.ts` for
Account/Access admission and distinct actions, then `routes/protection.ts` for
typed transport and current read disclosure. A graph-owned target instead uses
`model/definitions/protection-revision-v1.ts` and the Work title-control command
template; its invariants belong in the profile's SHACL.

## Cost contract

One mutation touches one variant, one receipt and one outbox event. It reads at
most one prior proposal, one candidate and one decision by key, plus at most 32
exact evidence references and a candidate of at most 1 MiB. The owner command
does not scan unrelated variants or proposals. `editorialStates` admits at most
50 targets through variant primary-key lookups. Correction history reads at most
51 rows from `(variant_id, created_at DESC, id DESC)` to return 50 and a cursor.
The cursor is bound to its target; over-limit requests and malformed continuations
are rejected. The focused store tests exercise 50/51 pagination and bounded
target reads; integration tests exercise Account/Access admission and HTTP replay.

The generic Access admission registry and strong-revocation dispatcher do not yet
recognize these three receipt families. Until they record terminal Content proofs
and seal them on revocation, these routes must remain unwired in production.
