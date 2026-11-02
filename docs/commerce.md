# Buyer receipts

The ordinary own-order detail consumes `GET /v1/orders/{orderId}` through the generated client and the default
Order page BFF. Its accepted price is the order's captured `currency`, `unitAmountMinor`, `moneyUnit`,
`taxBehavior` and `taxCode`, never the offer's current terms. The recorded unit price is labelled separately from
the recorded paid total. Exclusive tax is named only when that mode was captured. The order placement date is
not presented as a settlement date.
Missing currency has its own unavailable label in every supported locale; it is not described as a missing amount.

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
An authoritative failed payment retains its explanation and return-to-offer link after a success return URL.
The known benefit's primary reader link requires an active, associated current native entitlement, unrevoked state
and matching captured terms. The Content reader reauthorizes the viewer and source when opened. Status polling
updates only settlement and marks access for refresh; it cannot authorize a reader link.

The five current-access examples use the existing `PatternStory` provider harness. The recorded-charge page example
uses `PageStory` and the ordinary loader with explicitly constructed financial inputs; those amounts do not amend
the older native recordings or establish native financial evidence. Named terminal stories retain their states.
The single focused `apps/web/tests/buyer-receipt.test.ts` exercises the actual generated client, default BFF and
renderer using bounded HTTP inputs, including repricing isolation and failed/canceled versus paid/revoked messaging.
Native persistence, provider, browser, visual and original acceptance execution remain integration obligations.

## Private creator accounting delivery

`GET /v1/commerceSales` retains the exact own-account `commerce_sale:list` consent/action, selling gate,
`{sales,next,projectionState}` DTO and native signed keyset. Captured title, terms, nullable money unit and historical
settlement are accounting facts; buyer identity, Library/use data, current entitlement, cash/payability and net-refund
finality are absent. Current Access authorization is checked before and after the private native read; no browser
selector, privilege, grant or evaluator is added.

The [Commerce owner contract](../services/kernel/src/commerce/README.md#private-creator-sales-accounting) now uses
actual committed order effects, a fresh exact buyer-home source and the separate native live-copy hold/gate body.
Default worker composition performs the positive creator-home write and recovers its exact immutable result before
consuming source-role holds. Unknown historic coverage stays `preparing`, even on an empty page.
Historical source work and receipt roles are covered through independent bounded native frontiers before Accounts
can seal a home; original event-proof gaps remain pending. Financial source,
statement adjustments, unchosen economics and shared History custody remain separate. This implementation does not
establish native, privacy, physical, whole-journey or main acceptance.
Internal checkout updates use their genuine buyer-owned native commit receipt when actor write-basis attribution
is intentionally absent. Current native order/revision-event proof remains mandatory; receipt ownership creates
neither a worker principal nor financial truth from its response.

## Subject purchase entry

A healthy signed-in session reads the embedded Subject offer directory without a CSRF token; commands retain their
separate mutation credential and explicit terms acceptance. Anonymous visitors use public discovery. Each page,
retry and restart performs one bounded directory read, preserving native offer order and exact target identities.
Missing or denied read authority remains distinct from an empty directory; there is no anonymous fallback or
per-offer entitlement read. Session, Subject, locale and viewer-exposure changes retire previous rows and late replies.
Decision: a viewer-exposure cache update restarts discovery at the first page with a fresh read, including when an
account changes away and back before rendering.
