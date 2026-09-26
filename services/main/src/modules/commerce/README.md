# Commerce, quota and fixed-site owners

Owner schemas: Access-database migrations `090_commerce.sql`, `091_quota.sql` and
`092_fixed_realm_site.sql` (schemas `commerce`, `quota`, `site`), plus Content
migration `060_realm_reply_review.sql`. Column catalogs live in each module's
`schema.ts`; adapters type rows as `OwnerRow<typeof catalog.table>`.
Commerce entitlements are benefit grants, never Access permission grants: no
`access.*` row references them. Consumers read effective benefits through
`resolveBenefits` and recheck `commerce.benefit_epoch`.

## Protected command template (PostgreSQL owner)

`CommerceStore` (`store.ts`) and `routes/commerce.ts` are the template for this
domain's principal-keyed commands. Each command:

1. verifies the Account bearer for its scope in the route, requires a bounded
   `Idempotency-Key` and digests the validated body with `commerceIntentDigest`;
2. opens one transaction with two-second lock and five-second statement limits,
   takes `access.recovery_fence` `FOR SHARE` first (held recovery gives 503);
3. resolves the Account principal, serializes `(principal, key)` with a
   transaction advisory lock and replays the immutable `commerce.receipt`
   result, or conflicts when the key binds another digest or operation;
4. checks authority through Access representation (and a direct grant for
   awards), then expected generations/heads (409 `commerce_stale`);
5. writes the state change, its immutable per-generation event row and the
   receipt together; provider I/O happens only after commit.

Exact retries return the original result with `replayed: true`, even after
later changes; that result does not claim to be current state.

To add an operation, copy one `CommerceStore` method and its route, add its
operation name to the `commerce.receipt` check in a new migration in the
reserved range, and add denial, stale, replay/changed-intent and fence tests
in `tests/qa/integration/subscription-api.test.ts` style. Quota (`quota/store.ts`,
`routes/quota.ts`) follows the same shape but keys replay by the caller-scoped
`(policy, operation, stage)` reservation and worker ACK instead of a receipt row.

## External provider adapter template

`PaymentProvider` is the outbound protocol; `HttpPaymentProvider` binds it with
a per-call deadline. Only the in-stack fake (`tests/qa/support/fake-payment.ts`)
is admitted (`payment_provider.kind = 'fake'`). A settlement is committed
`pending` before the provider call; a failed or lost call moves it to `unknown`,
never to success or failure. Callbacks (`POST /v1/subscriptions/settlements`)
are verified by an HMAC-SHA256 signature over the raw body before anything is
stored, deduplicated by `(provider, eventId)` and applied under the settlement
row lock. `POST /v1/subscriptions/reconciliations` queries the provider outside
the transaction and records `applied`, `no-change` or `still-unknown`. The
fulfillment unique index on `commerce.entitlement_event(settlement_id)` makes
a second fulfillment impossible even for a writer bug.

## Cost contracts

`h` is retained history of the probed table; every probe is primary-key,
unique or selective partial-index lookup with expected `O(log h)` work.
The integration tests count SQL statements per request before and after 2,000
to 3,000 unrelated rows and require equal counts, and check that benefit
resolution uses `entitlement_effective`. Cold-cache I/O, WAL volume and lock
contention under load are not qualified.

| Operation | Bound |
| --- | --- |
| Quote | Fixed probes: fence, principal, key lock and receipt, representation, offering head, price/plan/group, live-subscription check, benefit epoch. Writes one quote and one receipt. |
| Change | Fixed probes as above plus quote, subscription row lock and unresolved-settlement probe. Writes at most one subscription (insert or update), change, settlement, settlement event and receipt; one provider call after commit. Free changes add one fulfillment. |
| Callback | Signature check, fixed callback and settlement probes. Writes one callback row; when applied, one settlement event and update plus one fulfillment (≤2 entitlement rows and events, one subscription update). |
| Reconciliation | Two short transactions and one provider lookup; writes one reconciliation, receipt and at most the callback-sized effect. |
| Gift issue/revoke | Fixed authority probes (representation, direct grant); writes one entitlement row or update, one event, one receipt; the epoch trigger updates one row. |
| Benefits read | At most 65 active grants of one beneficiary, joined to their plan benefits; response bounded by that set. |
| Quota reserve | Fixed probes; opens ≤1 base and ≤16 entitlement ledgers; locks ≤16 ledgers of one beneficiary and policy; writes one reservation and event (the trigger moves one ledger). |
| Quota transition | One reservation row lock and ACK probe; writes one reservation update and event; terminal transitions move one ledger. `expireDue` handles at most 1,000 leases per call with `SKIP LOCKED`. |
| Fixed-site query | One site probe, then the shared public Realm relation (candidate budget `MAX_PHRASE_CANDIDATES`, shared with general corpus hits); filtering is `O(k)` in returned rows. |

The fixed-site query inherits the public Realm relation's candidate budget,
which counts global phrase hits before Realm filtering: a phrase that is common
in general content returns 422 `query_budget_exceeded`, never general rows. A
Realm-scoped text candidate path is needed to lift that limit.
