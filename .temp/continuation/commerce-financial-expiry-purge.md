# Commerce financial expiry purge

## Outcome

After confirmed account deletion, the retained financial subset (`commerce.purchase_order` restricted fields)
expires at the fixture-supplied deadline and is physically gone before Access `resolveRetention`. Ordinary order
and entitlement routes stay denied.

## Owner

Commerce owns field minimizers, the payment/tax schedule, and the post-purge `resolveRetention` call. Accounts
supplies only the fixture-only retention inputs (`expiresAt`, required subset) and inspects native rows.

## Contract

[Deletion](../../docs/deletion.md) financial retention; [Commerce erasure participant](../../services/kernel/src/commerce/erasure-participant.md)
(no exceptions until a real schedule; owner calls `resolveRetention` after expiry purge). Frozen
`specs/terminal-erasure-outcomes.test.ts` “retained financial record” case.

## Why this is a continuation

Commerce keeps purchase orders, purges entitlements, and does not acknowledge. There is no production expiry
purge of the restricted order subset. The terminal-erasure driver reads real `commerce.purchase_order` rows and
must not invent an empty inspect result while those rows remain.

## Done when

`setTime(expiresAt)` then `finish()` yields `financial() === []` from native rows, and Access
`resolveRetention({ participant: 'commerce', store })` is called only after that purge commits.
