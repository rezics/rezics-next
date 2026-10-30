# Commerce currency units and creator prices

Access date for every external source below: **2026-10-31**. This is evidence for adoption by the
[Commerce owner](../../services/kernel/src/commerce/README.md), not a currency configuration or runtime contract.
**Fact** identifies primary documentation/source; **Observed** identifies this checkout; **Inference** and
**Recommendation** identify conclusions; **Unknown** identifies an unproved boundary.

Reuse the [payment-evidence report](commerce-payment-evidence-settlement.md#findings-requiring-a-correction-or-explicit-adoption),
especially its price/tax finding, and the [ownership report](commerce-ownership-entitlements-benefits.md#recommended-model-for-adoption):
captured offer terms, payment evidence, benefit permission and creator earnings remain distinct. This report closes
the unit/parser question without reopening their payment, entitlement or commercial-allocation research.

## Answer

**Inference: dividing a raw Stripe amount by `10 ** Intl` currency digits is not valid for every admitted value.**
It works for ordinary USD/EUR, but a formatter's currency metadata cannot establish provider support or units.
The present native boundary admits any lowercase three-letter code, including unsupported currencies. Stripe also
has unit exceptions. Exact integer formatting fixes floating-point loss, but cannot fix a wrong exponent.

**Recommendation:** keep the existing integer fields; attach versioned Stripe unit facts and explicit tax behavior
to new captured terms and money evidence. Start the sale-price mapping with USD/EUR only, and separately enable
only currencies qualified for the deployment's actual mode and settlement setup. Use a strict decimal-text editor,
integer arithmetic and one shared native unit lookup. Retain unknown history as raw evidence with an unknown unit.

## Sources and the current boundary

The reused reference is `/home/edge/projects/rezics/rezics-next/.reference/commerce-integrated-done/stripe-node/`,
commit `3af59f7c86a2350a8ea5298473f258d622bd8651`, tag v23.0.1, [MIT licence](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/LICENSE).
Read only `src/apiVersion.ts`, `src/resources/Checkout/Sessions.ts`, `PaymentIntents.ts`, `BalanceTransactions.ts`
and `LICENSE`; record reuse in the shared `.reference/INDEX.md`. No reference was installed, built or executed.

Official Stripe documentation is publisher-owned documentation, not MIT-licensed by the SDK's licence. The
[ECMA-402 13th edition](https://402.ecma-international.org/13.0/) is the June 2026 published standard; its
[notices](https://402.ecma-international.org/13.0/#sec-copyright-and-software-license) distinguish document permissions
from the BSD software licence. The ISO metadata source is SIX, the ISO 4217 maintenance agency's
[List One XML](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml),
published 2026-09-17. Treat it as publisher data under its terms, not an implementation or provider allowlist.
No source files, full currency table or long passages are proposed for copying.

**Observed:** the relevant current files establish these limits:

| Source                                                                                                                                                                            | Current behavior relevant to this question                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [model.ts](../../services/kernel/src/commerce/model.ts), [routes.ts](../../services/kernel/src/commerce/routes.ts), [commands.ts](../../services/kernel/src/commerce/commands.ts) | Offers/orders capture `currency` and numeric `unitAmountMinor`; creation accepts lowercase three-letter codes and positive safe integers. Repricing accepts positive safe integers. No provider currency/unit allowlist establishes those values' meaning. |
| [stripe.ts](../../services/kernel/src/commerce/stripe.ts)                                                                                                                         | Sends quantity one, inline `price_data.currency` and integer `unit_amount`; omits `tax_behavior`. Selects Managed Payments or automatic tax. Validates provider integers and same-currency fee details before flattening movements.                        |
| [config.ts](../../services/kernel/src/commerce/config.ts)                                                                                                                         | Configures direct-account namespace/mode and Managed Payments selection, but no admitted currency set, settlement-currency proof or unit version.                                                                                                          |
| [price.ts](../../apps/web/src/checkout/price.ts), [orders-page.tsx](../../apps/web/src/checkout/orders-page.tsx)                                                                  | Derive the divisor from `Intl` fractional digits and divide a `number`.                                                                                                                                                                                    |
| [money.ts](../../apps/web/src/checkout/money.ts), [creator-statements-page.tsx](../../apps/web/src/checkout/creator-statements-page.tsx)                                          | Statement formatting already preserves safe integers through BigInt parts. It still chooses the exponent from `Intl.supportedValuesOf`/`NumberFormat`. Keep that precision improvement and ordinary USD/EUR display.                                       |
| [creator-statements.ts](../../apps/web/src/checkout/creator-statements.ts), [schema.sql](../../services/kernel/db/commerce/schema.sql)                                            | Statement amounts are safe-integer API numbers; native columns are `bigint`. `weightedNetMinor` is an integer-text weighted numerator, not directly a currency amount.                                                                                     |

No decimal creator-price parser is present in the inspected price/write path. The parser below is a proposed
boundary for the editor; it does not reinterpret existing API numbers as major units.

**Fact:** the repository pins Stripe 23.0.1 in [package.json](../../services/kernel/package.json).
Its [default API version](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/apiVersion.ts)
is **2026-09-30.endive**; the adapter supplies no version override. The pinned
[inline PriceData](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/Checkout/Sessions.ts#L5437)
defines `unit_amount` as a nonnegative integer in cents/local equivalent. `unit_amount_decimal` instead allows
up to twelve decimal places **of that same provider unit**. It does not mean twelve decimal places of a major
currency, or license fractional yen in this integer-price integration. Keep using `unit_amount`.

## Provider facts, display metadata and eligibility

**Fact:** these charge facts come from Stripe's [amount rules and special cases](https://docs.stripe.com/currencies#minor-units).
Here `e` means major amount = raw integer / `10^e`; `q` is the required charge-input multiple.

| Charge currency/group                                         | `e` | `q` |
| ------------------------------------------------------------- | --: | --: |
| Ordinary documented two-decimal currencies, including USD/EUR |   2 |   1 |
| BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF   |   0 |   1 |
| ISK, UGX                                                      |   2 | 100 |
| HUF, TWD                                                      |   2 |   1 |

HUF/TWD manual payouts require multiples of 100; that restriction does **not** apply to charges. UGX invoice
rounding can create a customer-balance adjustment. These are provider rules, not permission to round creator input.
[Stripe special cases](https://docs.stripe.com/currencies#special-cases)

**Fact:** the published [currency page](https://docs.stripe.com/currencies#presentment-currencies) contains a
country-specific `SupportedPresentmentCurrencies` data object in its HTML. Its `country: "US"` list has 134 entries
and excludes BHD/JOD/KWD/OMR/TND; the AE list includes them. The Markdown rendering omits these generated lists.
**Inference:** global currency recognition and a different country's list cannot qualify US Checkout.

**Fact:** SIX metadata gives BHD/JOD/KWD/OMR/TND three decimal places, MGA two, ISK/UGX zero and HUF/TWD two.
[ISO metadata](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml)
**Inference:** ISK/UGX and MGA demonstrate why ISO display digits are not the Stripe exponent. For example, a
formatter using ISO zero digits would misread raw ISK `500` as 500 instead of 5; one using two MGA digits would
misread raw MGA `500` as 5 instead of 500. The known correct USD/EUR divisor remains 100.

**Recommendation:** reject three-decimal currencies for this direct-US sale slice. Their ISO metadata does not
prove an admitted Stripe charge unit, minimum or multiple. Do not invent a universal exponent-three or
multiple-of-ten rule from another provider, country or Stripe payout product. Broader support requires a separately
adopted product/country/field-specific fact. The facts above do not qualify all other US-listed currencies either.

**Fact:** [ECMA-402 CurrencyDigits](https://402.ecma-international.org/13.0/#sec-currencydigits) supplies formatting
digits, with a fallback of two when information is unavailable. Currency-code well-formedness and
[available canonical currencies](https://402.ecma-international.org/13.0/#sec-availablecanonicalcurrencies) concern
internationalization, not Stripe eligibility. **Inference:** neither successful `NumberFormat` construction nor
membership in `Intl.supportedValuesOf('currency')` is an admissible provider-money validation rule.

**Fact:** [Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) separately
requires Stripe review, a supported business location, direct integration, distribution rights, automated digital
products and eligible product tax codes. US is a supported business location. This establishes no approval for this
account or any particular offer. [Setup](https://docs.stripe.com/payments/managed-payments/set-up) also requires
activation. Ordinary direct payments with `automatic_tax` do not establish Managed Payments qualification.

**Unknown:** actual account approval, eligible product classification, enabled payment methods, settlement accounts,
Dashboard defaults and currency availability for this deployment. No keys, live API calls or account assumptions
were used. Keep these deployment conditions distinct from deterministic unit facts and native validation.

## Integration, presentment and settlement amounts

**Fact:** [Managed Payments](https://docs.stripe.com/payments/managed-payments/how-it-works) enables Adaptive Pricing
by default. The [hosted Checkout reporting guide](https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted#event-destinations-and-reporting)
says Session/PaymentIntent main amounts and currency remain in the **integration currency**. Local customer
payment appears separately in `presentment_details.presentment_amount`/`presentment_currency`. Adaptive Pricing
also requires the inline Price currency to be a settlement currency; ordinary direct presentment support alone
does not prove that requirement is met.

**Observed:** `CheckoutSnapshot.currency` currently says “presentment currency” while the adapter reads
`session.currency`. **Inference:** that label is inaccurate for Adaptive Pricing. Do not rename or reinterpret
stored numbers to repair the label. Preserve field lineage and capture optional presentment details separately.
The pinned [Session source](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/Checkout/Sessions.ts#L1450)
already defines those separate presentment fields.

**Fact:** pinned [BalanceTransaction source](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/BalanceTransactions.ts#L47)
defines signed `amount`, `fee`, `net`, currency and fee-detail currency in cents/local equivalent; `net = amount - fee`.
Its FX example has EUR `1000` on the PaymentIntent but USD `1234` on the balance transaction. The movement's
currency determines its unit. Its `exchange_rate` explains a conversion; it is not a replacement movement amount.

**Recommendation:** record each retrieved balance transaction's original amount/fee/net and unit facts together,
including source ID, provider namespace/mode, field/object origin and API version. Retain existing FX evidence
without recomputing cash. Fee-detail currency must match before combining amounts, as the adapter already checks.
Use the Stripe currency exponent for this balance context, but **do not apply charge minimums, charge multiples or
payout multiples to fees/net**. A sale quantum is a write constraint, not a safe rounding rule for provider evidence.
If exceptional settlement units lack sufficient provenance, retain raw values and mark interpretation unknown.

Statement money is settlement money; captured price is integration money; actual customer payment may be a third
money tuple. Never add these together or convert twice. Missing local-presentment evidence stays absent/unknown,
not a manufactured copy of integration money. None of these tuples alone proves creator payability.

## Limits and tax presentation

**Fact:** [Stripe limits](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts) depend on settlement
currency and payment method: USD/EUR minima are 0.50, JPY 50, HUF 175; FX charges must meet the settlement minimum.
Current card maxima use 12 digits generally, 10 for Cartes Bancaires, 9 for Amex, with tighter regional/network
limits. Non-card maxima use 12/10/9/8 digits for IDR/COP/INR/others, subject to method restrictions.

The pinned [PaymentIntent creation definition](https://github.com/stripe/stripe-node/blob/3af59f7c86a2350a8ea5298473f258d622bd8651/src/resources/PaymentIntents.ts#L3994)
still documents an eight-digit amount maximum and a USD 0.50/equivalent minimum. **Recommendation:** use
`99_999_999` provider units as a conservative application ceiling for new base prices, not a claim that current
Stripe supports no higher amount. Keep tighter applicable provider limits. A price below a known applicable minimum
is rejected; when FX/configuration prevents a deterministic minimum, do not guess an exchange rate or advertise
preflight success. Stripe's final Checkout validation remains necessary. Tax-exclusive base price alone cannot
guarantee that the final taxed payment stays below a provider ceiling; do not truncate tax or silently reduce the
price. Validate observed totals as exact evidence against the actual provider contract, rather than rejecting a
valid paid total solely because tax took it above the application base-price cap.

**Fact:** [Managed Payments tax behavior](https://docs.stripe.com/payments/managed-payments/set-up#optional-configure-the-tax-behavior-of-your-prices)
uses explicit price behavior, otherwise defaults to adding tax, with a configurable default. Ordinary Stripe Tax's
[Automatic setting](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior#tax-behavior) chooses exclusive
for USD/CAD and inclusive for other currencies. It is a tax-behavior setting, distinct from enabling automatic tax.

**Recommendation:** adopt the prior report's explicit **tax-exclusive** captured price for this slice and send
`line_items[0].price_data.tax_behavior = 'exclusive'`. Capture the convention with the offer revision/order and
creation parameters. Label the editor and offer “before tax”; show provider-calculated tax and final total when
available. The current subtotal-plus-tax validation assumes this convention. An inclusive alternative needs explicit
owner adoption and matching reconciliation/display changes; omission is not a stable third convention. Historical
omission does not establish historical exclusivity. This decision supplies no reserve, fee or royalty allocation rule.

## Small native representation and exports to adopt

**Inference — shared pattern:** Stripe's API source binds amounts to particular fields/currencies; its currency and
product documentation supplies operation-specific constraints; ECMA supplies presentation behavior. Together they
support separate unit facts, write admission and locale formatting. None makes a display library, a payout rule or
an ISO entry the authority for all three. The current integer storage and exact statement-parts formatter are
compatible foundations once that missing distinction is recorded.

**Recommendation:** use the current TypeScript/SQL stack and add metadata, rather than a generic money engine:

```ts
type StripeUnit = Readonly<{
  system: 'stripe-api';
  exponent: 0 | 2;
  factsVersion: string;
}>;
type MoneyFact = Readonly<{
  currency: string;
  amountMinor: number;
  unit: StripeUnit | null; // null means unknown, never implicit exponent two
}>;
```

Existing `unitAmountMinor`, tax and movement columns retain their names and numbers. A containing object may share
one unit descriptor across amounts proven to have the same currency/unit. Record a stable immutable facts version,
such as `stripe-money-v1`, whose definition includes source/access date, API baseline and field contexts. Keep the
actual observation API version separately: updating docs does not change an old fact's unit or account approval.

Export one native read-only `stripeMoneyFacts` table, `validateOfferAmount` and serializable unit metadata through
the existing client contract. Web consumes that metadata for `parseCreatorPrice` and `formatMoneyFact`; the server
revalidates every write. A localized string is never the stored amount or a provider parameter.

The exact minimal **sale mapping** is `{ usd: { exponent: 2, chargeMultiple: 1 },
eur: { exponent: 2, chargeMultiple: 1 } }`; there is **no default row**. These are candidate unit facts, not enabled
currencies. Recommend initially enabling USD only, conditional on deployment qualification; enable EUR only with
the required settlement/mode evidence. If the owner retains more currencies, enumerate them from Stripe's relevant
country/product list and adopt their constraints before enabling them. Do not use a generic ISO table.

A separate **read-only evidence lookup** can contain the evidenced charge groups above, plus explicitly listed
ordinary currencies actually needed by retained observations, with field-context provenance. Recognition for display
must never enable offer creation. Versioned additions can teach readers about a unit without reopening old sales.
Unknown currencies or unproven field contexts produce `unit: null`; never infer exponent two from code shape.

At each `number` boundary require a safe integer with absolute value at most **9,007,199,254,740,991**. Prices must
also be positive and within the lower application/provider limits. PostgreSQL signed `bigint` can exceed this API
range: validate before converting to Number. Use BigInt for parsing, sums and intermediate products; reject overflow
instead of rounding, wrapping or saturating. Larger future API amounts require an explicit decimal-integer-string
contract, not a cast. Preserve existing weighted-numerator text; its basis-point divisor is not a currency exponent.

## Exact input and locale display

**Recommendation:** choose a deliberately unambiguous editor grammar: ASCII digits with an optional dot decimal,
no grouping, and an explicit uppercase currency plus “before tax” label. Localize explanatory text and the exact
preview. Input is `type=text` with a decimal keyboard hint, never `valueAsNumber`, `parseFloat` or `Math.round(x*100)`.
This is an input convention, not a claim that every locale uses a dot. State it beside the field.

1. Bound text to 32 characters before parsing. Reject whitespace, signs, exponent notation, symbols, localized
   separators/digits, empty input, leading-zero multi-digit integers, and missing digits around a decimal point.
2. Require `0|[1-9][0-9]*` as the whole part, optionally followed by `.` and one through `e` fractional digits.
   For `e=0`, permit no decimal part. Reject excess precision even if the extra digits are zero.
3. Right-pad the fraction to `e` digits and compute `BigInt(whole) * 10n**BigInt(e) + BigInt(paddedFraction)`;
   absent/zero-length fraction contributes zero. Apply positivity, range, currency admission and applicable limits.
4. Require `raw % chargeMultiple === 0`; reject rather than round. Thus a future admitted ISK/UGX row accepts
   `5`/`5.00` as `500` but rejects `5.01`; HUF/TWD cents remain valid charge precision. A zero-decimal JPY row
   accepts `500` as `500`. These examples do not enable those currencies in the proposed sale mapping.
5. Convert to Number only after all integer bounds pass. Keep the selected currency/unit fixed during editing;
   changing currency requires a new explicit amount, not retaining the old raw integer under another code.

For display, scale using the **recorded provider exponent**, then let `Intl` supply locale digits, grouping, signs
and currency placement. Fix fraction options explicitly. For statements use `e` fraction digits so no evidenced
subunit disappears; even an ISK fee of raw `1` must not be rounded away merely because ISK prices are whole units.
The BigInt quotient/remainder and `formatToParts` pattern already in `money.ts` can do this once its exponent
comes from unit facts. Preserve a negative sign for values between -1 and 0; normalize input negative zero away.

[ECMA-402 formatting](https://402.ecma-international.org/13.0/#sec-intl.numberformat.prototype.formattoparts) supports
parts and exact mathematical input. **Recommendation:** prefer the existing BigInt parts approach; a decimal-string
formatting alternative must preserve exactness through the actual runtime and TypeScript boundary. Never divide
a near-limit Number into a floating-point major amount. For `-1` USD the display must retain `-0.01`, and for
`9_007_199_254_740_991` EUR it must retain all digits of `90_071_992_547_409.91`, with locale punctuation.
The latter is a reader precision case, not an admissible sale price.

Use explicit currency codes in financial views and distinguish “captured price, before tax”, “customer paid” and
“Stripe settlement currency”. For unverified units show, for example, `500 claimed ISK — unit unknown`, or the
existing unavailable label with inspectable raw evidence. Never show a guessed major amount, zero, or a combined
cross-currency total. A recognized formatter currency with unknown provider units is still unknown money.

## Migration boundary, owner decisions and later cases

**Recommendation:** add nullable unit/tax-convention metadata and capture it for newly adopted offer revisions,
orders, provider observations and statement lines. Statements inherit a unit only when every contributing amount
is proven compatible. Group by currency **and unit meaning**; do not merge unknown or incompatible units into a
known total merely because the currency codes match. Existing statement identity/immutability must be respected;
an unknown historical total can remain raw/unavailable rather than being rewritten to fit a new grouping.

Preserve all existing raw numbers, claimed currency, captured revisions and immutable provider movements. Do not
backfill from today's currency table, `Intl`, or the absence of old `tax_behavior`. Where retained provider-field
provenance actually proves units, attach an explicit interpretation/provenance record without replacing the raw
fact. Otherwise leave unit, tax convention and missing presentment unknown. Repricing old offers needs an explicit
adopted money capture before new sale admission; it cannot repair an already captured order. Existing benefit
history does not become a new currency-conversion or entitlement migration.

The Commerce owner must adopt/export precisely:

- The initial enabled integration currencies and separate versioned unit-fact rows, positive-price limits and
  explicit exclusive-tax convention; Web receives that schema and exact parser/display rules.
- Deployment evidence of direct-US/Managed Payments activation, eligible products, enabled methods and settlement
  currencies; these qualify configuration, not historical amounts. Automatic-tax fallback remains a separate mode.
- Native captured unit/version/tax metadata, original Session integration fields, optional local-presentment fields,
  and balance/fee currency-unit provenance; statement projections preserve compatible units and visible unknowns.
- The historical interpretation boundary and immutable facts-version publication. Runtime adoption belongs only in
  the owning Commerce document; this report remains evidence and does not deploy any of these changes.

Three meaningful later cases, after adoption, are:

1. A creator enters USD `12.99`; the API receives `1299`, explicit exclusive tax and captured unit/version. Reject
   `12.999`, grouped/ambiguous input, an unsafe integer and unknown/three-decimal currencies. Repeat the exact
   preview/statement read in English and comma-decimal locales, including a negative cent and the safe-integer edge.
2. With explicit fixture unit rows, JPY/MGA keep whole-unit scale, ISK/UGX `500` means 5 and fractional prices fail,
   while HUF/TWD fractional charges pass. A provider fee not divisible by the charge quantum remains intact.
3. A USD integration price with distinct CAD presentment and a retained settlement movement displays each tuple
   separately. A legacy amount with unknown units stays unknown, and neither it nor another currency is silently
   netted into a known statement total. Tax inclusion omission remains unknown for historical captures.

Limitations: public primary documentation and pinned source only; no account qualification, runtime changes or
checks. Documentation can change independently of the pinned API. Unlisted three-decimal and exceptional settlement
contexts stay closed until supported facts are adopted. No ledger, wallet, FX engine, payout or allocation policy
is introduced.
