# Buyer receipts

## Recorded money presentation

Use the requested locale for formatted amounts, recorded-raw amounts and unknown-unit messages. Preserve localized
word order and the existing supported Intl-locale behavior, including `ar-EG`. Financial evidence remains its exact
signed integer, currency and captured exponent: never infer an exponent from currency, round, guess unknown history,
or change settlement or tax meaning. An unavailable policy preserves the seller's draft; an uncertain edit keeps its
exact intent, key and credential. A deliberate correction requires reviewed current terms.

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

Creator statement and line amounts use the same recorded-money formatter. A missing or unknown unit keeps the signed
minor amount and the unknown-unit message; it is never replaced by a generic unavailable label or a current currency
exponent. HTTP `markPaid` uses the Kernel command clock, matching royalty recording, so an authorized external
reference can close only a prior UTC month.

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
An exposure-cache update restarts at the first page with a fresh read, including when an account changes away and back
before rendering. Public inspection reuses the owned captured-term/reference reader and compares at most two deliberate
operands from one received page. Every replacement clears selection. Page-local Edition/version numbers are reading
labels only, never catalogue names or selection keys.

## VNDB score admission handoff

The [Rating module owner](../services/kernel/src/rating/README.md) owns the current conditional vote writer:
`putVoteOutcome` accepts `input.guard` using its closed `VoteReviewGuard`, with the reviewed native question,
identity and own-vote witness. Stale or unavailable observations and authorization-before-receipt behavior remain
with that native writer; a read witness is not an atomic permission.

Library's VNDB score consumer remains unbound. Its effects stay unavailable until the consumer composes that actual
writer safely with source/review admission and exact retry. A delivered producer is not consumer completion; do not
invent a Library vote writer or import provider aggregates. VNDB score units and explicit clear consent stay private
review choices.

## AniList native score admission

AniList score effects stay unavailable until its consumer safely composes the conditional native vote guard for the
reviewed question revision, counted vote or absence, canonical/counting identity and local correction. Score review
stores owner-selected units and separate effects consent.

## Owned offer terms inspection

The creator’s received offer page supplies read-only inspection, including delisted captures and explicit unknown
historical mapping. Offer ID and observed revision identify the selection; equal titles and shared Editions do not.
Captured revision, declared licence, delivery, acquisition and quantity remain separate from current reader access
and sale eligibility. Revision/hash/reference disclosure performs no content read or independent verification.
Existing public money adapters retain recorded units and before-tax meaning.

After a definitive seller refusal, keep the typed draft and require explicit review of current native
Edition/offer and price facts before a separate correction. Adopt the revision and schema from the same review
response. While a command may have dispatched, retain its amount, currency, Edition, credential and original key;
retry those operands unchanged. Recorded history continues to use its captured units, including signed adjustments
and explicit unknown meaning, without combining incompatible records.
Unavailable current price configuration retains an admitted seller's form and draft; it cannot complete correction
review. Authority withdrawal still retires the private display and command origin.

The offer page keeps its received observation until deliberate review. Inspection never changes a command's original
observation, draft, key or recovery. Selection retires with the current origin or visit; a missing row offers an
explicit restart without scanning pages. Management may inspect its retained row, while public destinations require
an active row on the received page.
