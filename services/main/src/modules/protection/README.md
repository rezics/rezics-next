# Content draft protection template

The first owner binding is `content-draft-protection-v1`: one Content variant's
`draft_head` and optional `protection_head`. Migration 130 serializes every draft
writer, protection change and correction application on the existing variant row.
It appends immutable protection, proposal, decision and application records. The
Content receipt, owner position and outbox are written in the same transaction.
Migration 131 adds a proposal-scoped private-principal comparison key; public
proposal reads omit it. `null` protection means asserted absence for this profile.
Main resolves a lost Content acknowledgement from that operation's receipt and
returns a pending handle if the receipt cannot yet be read. Terminal outcomes
seal the matching Access admission through the owner receipt-family declaration.

`content-store.ts` is the owner write/read template. Copy its operation lock,
recorded-receipt replay, target-row lock, exact basis checks, and single-commit
receipt/outbox pattern for another Content-owned target. Copy `admitted.ts` for
Account/Access admission and distinct actions, then `routes/protection.ts` for
typed transport and current read disclosure. A graph-owned target instead uses
`model/definitions/protection-revision-v1.ts` and the Work title-control command
template; its invariants belong in the profile's SHACL. That graph binding is
not active yet: the native `TitleControlPolicy` permits only unprotected
`work.edit`, `work.title.apply` and `work.title.return` mutations.

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

Protection changes, correction proposals and decisions use the
`editorial-protection-v1` Content outbox recipe. Their events are acknowledged
in order by the Content projection relay and do not create graph outbox events or
new published Content models, so this binding declares no graph event handler or
search projection recipe. The owner's `strongRevokeProtectionScope` and
`strongRevokeProtectionPrincipal` perform
bounded 100-admission reconciliation passes using the Content receipt; unresolved
work stays pending behind the Access fence.
