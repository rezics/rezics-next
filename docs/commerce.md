# Buyer receipts

The ordinary own-order detail consumes `GET /v1/orders/{orderId}` through the generated client and the default
Order page BFF. Its accepted price is the order's captured `currency`, `unitAmountMinor`, `moneyUnit`,
`taxBehavior` and `taxCode`, never the offer's current terms. The recorded unit price is labelled separately from
the recorded paid total. Exclusive tax is named only when that mode was captured. The order placement date is
not presented as a settlement date.

`recordedCharge` is nullable. A historically paid order exposes the retained Checkout integration observation's
actual `amount_total` and optional tax, with its own recorded currency and unit. This is the integration currency
total, not a derived local presentment or balance transaction amount. The Session, order, currency and captured
subtotal must match; a known captured tax must agree. Missing observations, unknown units and inconsistent evidence
leave the charged total unavailable. The price plus tax is never substituted for a provider total. Null tax stays
unavailable; recorded zero tax is displayed as zero. Amount display uses the existing exact recorded-exponent money
formatter, including zero-decimal units, without deriving an exponent from the currency.

The read preserves buyer equality, scope and concealment. It uses the existing order point read with one scalar
probe of the same buyer-home Session/context in `money_observation_object`, ordered by its existing index with
`LIMIT 1`. It neither traverses observations nor changes the number of SQL statements or HTTP reads. Internal
command reads omit that probe. Current entitlement, subject, optional public creator and viewer-action reads retain
their existing bounds. Rendering never calls Stripe or reads a current offer. Storage and payment semantics remain
owned by the [native Commerce contract](../services/kernel/src/commerce/README.md#historical-payment-and-current-entitlement).

Payment and current access have separate labels. Failed, canceled and unresolved orders never render a purchased
benefit's confirmation. Paid orders retain their receipt after revocation, and an incidental cancel return cannot
override native paid settlement. Unavailable access, no entitlement and access requiring refresh remain distinct.
The known benefit's primary reader link requires an active, associated current native entitlement, unrevoked state
and matching captured terms. The Content reader reauthorizes the viewer and source when opened. Status polling
updates only settlement and marks access for refresh; it cannot authorize a reader link.

The five current-access examples use the existing `PatternStory` provider harness. The recorded-charge page example
uses `PageStory` and the ordinary loader with explicitly constructed financial inputs; those amounts do not amend
the older native recordings or establish native financial evidence. Named terminal stories retain their states.
The single focused `apps/web/tests/buyer-receipt.test.ts` exercises the actual generated client, default BFF and
renderer using bounded HTTP inputs, including repricing isolation and failed/canceled versus paid/revoked messaging.
Native persistence, provider, browser, visual and original acceptance execution remain integration obligations.
