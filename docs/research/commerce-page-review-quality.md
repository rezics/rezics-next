# Commerce page quality: source inventory and outstanding review

Commerce Done-when clauses 1 and 5 and the reviewed-interface Acceptance clause remain **unmeasured**.
This review inventories the retained implementation and identifies the evidence and bounded owner work needed
to assess it. It establishes no rendered-page defect or visual approval: the current launch policy explicitly
defers acceptance, native and browser checks until integration. Full-size screenshots, keyboard/touch measurements,
current native API recordings and assertion exits were not produced. Their absence must remain non-green.

## Revision and authority

Inspected on 2026-11-03. The clean retained source was
`2faf5ef76228791d6d742e045170c31cac3ed87a`; the observed local `dev` ref was
`88a6a9c65a15ad5314f9337a2ddf4362c9df9bed`. These are different revisions. The source comparison below returned
no changed files in its named paths; it does not bind a running Web server, generated artifacts, dependencies,
shared shell or deployed Storybook to either revision. No merge, publication or promotion proof was registered.

Read-only source commands, both exit 0:

```sh
git rev-parse HEAD dev
git diff --name-only 2faf5ef76228791d6d742e045170c31cac3ed87a 88a6a9c65a15ad5314f9337a2ddf4362c9df9bed -- apps/web/src/checkout apps/web/src/stories apps/web/src/routes apps/web/tests services/kernel/src/commerce services/kernel/test/commerce specs/commerce-outcomes.test.ts docs/goals/commerce.md packages/ui/README.md docs/goals/web.md
```

Behavior belongs to [Commerce's owner contract](../../services/kernel/src/commerce/README.md), delivery to
[Commerce's Goal](../goals/commerce.md), shared presentation/review to [Web](../goals/web.md#ownership), and controls
to [UI](../../packages/ui/README.md#form-fields). [Scope](../scope.md) includes offers, checkout, orders and
entitlements; it does not adopt points, a wallet or a payout engine. Research recommendations below are proposals,
not new financial policy. Content retains edition publication and final protected reads; Accounts retains admission.

**Inventory decision:** use actual source exports with shared viewport globals; historical width-suffixed story
names are not substitutes for exports that exist. This decision was sent to the commerce manager through the inbox.

## Owned surfaces and API boundary

Paths in this table are locale-relative browser paths except `/checkout`. Route files are under
`apps/web/src/routes/`; presenters/adapters are under `apps/web/src/checkout/`. These are source bindings, not API
execution evidence. Every row has missing current rendered evidence in both widths/themes and all locales below.

| Surface / route                                                                  | Source and ordinary boundary                                                                                                                                        | Review focus / responsible owner                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject benefit entry, `/subjects/$id` (with its optional slug)                  | `subject-purchase.ts`, `subject-offers.ts`, `subject-offers-region.tsx`; `GET /v1/subjects/:id/offers`, separate private ownership reads                            | Public terms versus private owned state, sparse/preparing discovery, no implied availability. Commerce slot, Web subject composition, Semantic disclosure.                             |
| Offer and accepted terms, `/offers/$id`                                          | `offers/$id.tsx`, `offer-page.tsx`, `benefit-details.tsx`; `GET /v1/offers/:offerId`                                                                                | Fixed edition, licence, quantity one, price/tax/unknown metadata; public delisting concealment, explicit changed-terms consent. Commerce/Web.                                          |
| Checkout start, `POST /checkout`                                                 | `src/server.ts:429`, `start.ts`; current-session `POST /v1/orders` with displayed revision and original intent key                                                  | Double activation, lost response, already-owned and acquisition-pending recovery. Hosted Stripe page is external, not another local page story. Commerce/Web.                          |
| Checkout return, order and receipt, `/orders/$id?checkout=success` or `canceled` | `orders/$id.tsx`, `order-page.tsx`, `order.server.ts`, `order-reconcile.ts`; private order read, current entitlement read and explicit known-order repair           | Redirect never grants, pending/failed/canceled remain distinct, captured terms and actual presentment versus integration charge/tax, honest repair outcomes. Commerce/Web.             |
| Purchase history, `/orders`                                                      | `orders/index.tsx`, `orders-page.tsx`, `orders-current.tsx`; owner-self `GET /v1/orders`                                                                            | Signed continuation, sparse/later empty, independent currencies, no per-row receipt fanout or other-buyer leakage. Commerce/Web.                                                       |
| Owned benefits, `/entitlements`                                                  | `entitlements/index.tsx`, `entitlements-page.tsx`, `entitlements-current.tsx`; owner-self `GET /v1/entitlements`                                                    | Active/revoked/unknown mapping, current viewer, preparing and cursor restart, no public ownership cache. Commerce/Web.                                                                 |
| Owned benefit detail/use entry, `/entitlements/$id`                              | `entitlements/$id.tsx`, `entitlement-page.tsx`, `benefit.ts`; `GET /v1/entitlements/:entitlementId`                                                                 | Captured terms versus current access; only mapped eligible records offer exact `/editions/:id` navigation; refund/dispute/reader unavailability. Commerce/Web.                         |
| Protected use, `/editions/$id`                                                   | `editions/$id.tsx`, Content reader; exact Content edition metadata/revision APIs                                                                                    | Current native authorization and exact purchased revision/hash/body, current ancestry/source loss, retry and image failures. Content; Web shell.                                       |
| Creator offers/availability, `/creator/offers`                                   | `creator/offers/index.tsx`, `creator-offers.ts`, `creator-offers-current.tsx`, `creator-offers-page.tsx`; private `GET /v1/offers`, existing revise/delist commands | Active/delisted history, selling admission, stale drafts/revisions, original uncertain request, no fresh-sale promise from history. Commerce/Web.                                      |
| Creator editor, `/creator/offers/new?editionId=…`                                | `creator/offers/new.tsx`, `creator-offer-editor.tsx`, creator current/address modules; published edition metadata, `GET /v1/commerceMoney`, `POST /v1/offers`       | Choose actual edition, unavailable selling authority/configuration, exact USD/EUR input and before-tax preview, validation and retained intent. Commerce; Content publication handoff. |
| Creator Sales, `/creator/sales`                                                  | `creator/sales/index.tsx`, `creator-sales.ts`, current/address/page modules; private `GET /v1/commerceSales`                                                        | Historical paid purchase differs from refunds, current entitlement, earnings and bank cash; no buyer identity/order access; preparing is not zero sales. Commerce/Web.                 |
| Statements, `/creator/statements`                                                | `creator/statements/index.tsx`, `creator-statements.ts`, list/current/page modules; private payout-statement list                                                   | UTC recording month/currency, signed adjustments, unknown units, no cross-currency total or payable inference. Commerce/Web.                                                           |
| Statement/payment evidence, `/creator/statements/$id`                            | Detail route, `creator-statement-page.tsx`, `creator-statement-address.tsx`, `creator-payment-attestation*`; statement point/line reads and native `markPaid`       | Exact reference, response-confirmed attestation, uncertainty/authority retirement, line and return cursor recovery; reference/time do not prove bank receipt/payability. Commerce/Web. |
| Publication return seams, `/editions` and `/editions/new`                        | Content routes, `content-editions/creator-editions-view.tsx`; creator published editions and publication APIs                                                       | Existing creator-to-offer handoff, missing/unavailable edition, never invent sale authority. Content owns these pages; include them when reviewing the Commerce journey.               |

There is no separate local receipt, payment-evidence or Checkout-return route to mark reviewed: these are order or
statement states. Shared navigation and list/control repairs belong with Web/UI rather than a Commerce replacement.

## Exact story inventory

Each suffix below completes the prefix in its row, for example `pages-commerce-order--reconciliation-retry`.
The filename column is relative to `apps/web/src/stories/`. All exports are source inventory only; no live
`index.json` was consulted and no play function executed. Display names may differ from export-derived IDs.

For **every listed ID**, the review record is: viewport `390` and `1280`; theme `light` and `dark`; locale
`en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr`, `es`; screenshot path **absent**; keyboard and coarse-pointer
states **unmeasured**; exact missed evidence bar **reviewed running page with full-size capture before judgment**.
These common values apply to each suffix, not just the first or happy state. They are not fabricated screenshot paths.

| File                                                     | ID prefix                                               | All exported suffixes                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subject-purchase.stories.tsx`                           | `pages-commerce-subject-purchase--`                     | `signed-out`, `signed-in`, `pending`, `empty`, `preparing`, `partial-preparing`, `denied-signed-in`, `unavailable`, `cursor-error`, `long-title`, `mapped-price-unknown`, `unknown-mapping`, `actual-adapter-unavailable`, `signed-in-long-title`                                                                                                                                                  |
| `offer.stories.tsx`                                      | `pages-commerce-offer--`                                | `signed-in`, `signed-out`, `long-cjk-title`, `delisted`, `kernel-unavailable`, `exposure-open`, `exposure-closed`, `terms-changed`, `terms-changed-mobile`, `mapped-fixed-edition`, `already-owned`, `acquisition-pending`, `already-owned-mobile`, `acquisition-pending-mobile`                                                                                                                   |
| `order.stories.tsx`                                      | `pages-commerce-order--`                                | `paid`, `pending`, `failed`, `failed-after-return`, `canceled`, `active`, `refunded`, `access-unavailable`, `no-entitlement`, `access-refresh`, `recorded-charge`, `long-receipt-narrow`, `unknown-settlement`, `recorded-money-unavailable`, `mapped-current-use`, `reconciliation-queued`, `reconciliation-unavailable`, `reconciliation-denied`, `reconciliation-retry`, `mapped-fixed-edition` |
| `orders.stories.tsx`                                     | `pages-commerce-orders--`                               | `history`, `first-page-empty`, `later-page-empty`, `later-page-empty-with-next`, `long-titles-narrow`, `unknown-settlement-and-money`, `unavailable`, `unknown-viewer`                                                                                                                                                                                                                             |
| `entitlements.stories.tsx`                               | `pages-commerce-entitlements--`                         | `active`, `revoked`, `legacy-unknown-mapping`, `empty`, `another-account-denied`, `unavailable`, `retry`, `preparing`, `stale-cursor`, `long-titles`, `later-page-empty`, `later-page-empty-with-next`, `long-titles-narrow`, `mapped-fixed-edition`                                                                                                                                               |
| `entitlement.stories.tsx`                                | `pages-commerce-entitlement--`                          | `active`, `refunded-with-paid-order`, `another-account-denied`, `legacy-unknown-mapping`, `unavailable`, `preparing`, `retry`, `long-titles`, `mapped-fixed-edition`, `mapped-refunded`, `mapped-disputed`, `reader-unavailable`                                                                                                                                                                   |
| `creator-offers.stories.tsx`                             | `pages-commerce-creator-offers--`                       | `history`, `second-page`, `empty`, `denied`, `unavailable`, `error`, `stale`, `preparing`, `long-title`                                                                                                                                                                                                                                                                                            |
| `creator-offer-editor.stories.tsx`                       | `pages-commerce-creator-offer-editor--`                 | `price-intent`, `actual-route`, `actual-owned-offers`                                                                                                                                                                                                                                                                                                                                              |
| `creator-sales.stories.tsx`                              | `pages-commerce-creator-sales--`                        | `history`, `second-page`, `empty`, `denied`, `unavailable`, `error`, `stale`, `loading`, `preparing`, `incomplete`, `unknown-unit`, `long-title`, `other-creator-same-route`, `other-creator-denied`, `actual-route`                                                                                                                                                                               |
| `creator-statements.stories.tsx`                         | `pages-commerce-creator-statements--`                   | `creator`, `inspect-and-back`, `unknown-historical-money`, `empty`, `denied`, `unavailable`, `error`, `stale`                                                                                                                                                                                                                                                                                      |
| `creator-statement.stories.tsx`                          | `pages-commerce-creator-statement--`                    | `creator`, `negative-adjustment`, `narrow-long-text`, `external-payment`, `unknown-historical-money`, `unknown-historical-money-phone`, `empty`, `denied`, `unavailable`, `error`, `lines-unavailable`, `stale`                                                                                                                                                                                    |
| `content-edition.stories.tsx`                            | `pages-commerce-contenteditionreader--`                 | `published`, `publishedimages`, `missingimage`, `longtext`, `loading`, `unavailable`, `retryrecovers`, `refused`, `withdrawn`, `versionmismatch`                                                                                                                                                                                                                                                   |
| `creator-offer-controls-disclosure.stories.tsx`          | `patterns-commerce-creator-offer-controls-disclosure--` | `normal`, `draft-remains-visible`, `narrow-long-text`, `unavailable-rules`, `unavailable`, `authority-retired`                                                                                                                                                                                                                                                                                     |
| `creator-edition-disclosure.stories.tsx`                 | `patterns-commerce-creator-edition-disclosure--`        | `normal`, `narrow-long-text`, `unavailable`, `choose-edition`, `authority-retired`                                                                                                                                                                                                                                                                                                                 |
| `statement-line-page-recovery.stories.tsx`               | `patterns-statement-line-pages--`                       | `first-empty`, `later-empty`, `later-empty-with-continuation`, `first-empty-with-continuation`, `first-and-next-preserve-address`, `unknown-financial-metadata`, `lines-error`, `preparing`, `narrow-long-text`, `original-line-order-and-multiplicity`, `read-authority-absent`, `read-authority-retired`                                                                                         |
| `patterns/content-edition/content-edition.stories.tsx`   | `patterns-commerce-contenteditionreader--`              | `published`, `publishedimages`, `missingimage`, `longtext`, `loading`, `unavailable`, `retryrecovers`, `refused`, `withdrawn`, `versionmismatch`                                                                                                                                                                                                                                                   |
| `patterns/creator-editions/creator-editions.stories.tsx` | `patterns-content-creatoreditions--`                    | `editions`, `sparse`, `denied`, `unavailable`, `empty`, `loading`, `sign-in`                                                                                                                                                                                                                                                                                                                       |
| `patterns/subject-purchase-slot.stories.tsx`             | `patterns-subjects-purchase-entry-slot--`               | `empty`, `populated`, `private-pending`                                                                                                                                                                                                                                                                                                                                                            |

Older research/owner prose lists `mobile390`, `desktop1280` and `price-intent-390`/`actual-route-1280` variants.
Those exports are absent from the retained files. Use `.storybook/preview.tsx:35` viewport globals `phone390`
(390×844) and `desktop1280` (1280×900) for interactive review. Do not report a nonexistent ID as a failed page.
The screenshot runner instead fixes height at 720; record the actual dimensions rather than labelling that output
390×844 or 1280×900. Existing explicit narrow/mobile exports remain separate states and still need review.

## Story API provenance and existing coverage

The committed `offer*.json` and `order-{paid,pending,failed}.json` recordings under `apps/web/src/kernel/recorded/`
are historical recorder outputs. For example, `order-paid.json` has paid settlement and an entitlement ID, but no
captured `contentEdition`, presentment or recorded-charge fields. It cannot prove today's fixed-edition purchase
or financial display. `apps/web/scripts/record.ts:826` contains their native recorder path with loopback Stripe;
the file's presence does not establish a successful regeneration on the bound revision.

Creator offers, Sales, statements, entitlements and subject-offer examples use the explicitly illustrative modules
`apps/web/src/kernel/fake/{creator-offers,creator-sales,creator-statements,entitlements,subject-offers}.ts`.
Offer/order mapped, recovery and money examples also construct terms or amounts. Content reader pages reuse
pattern fixtures. These are useful rendering inputs, not successful native-sale/use recordings. A route mounted
inside `PageStory` can still receive an illustrative transport response.

The editor's `price-intent` is a `PatternStory` with configured USD/EUR examples, not a successful offer publication.
Its `actual-route` and `actual-owned-offers` mount served routes. `creator-statement--external-payment` checks
an already-recorded reference and explanation (`creator-statement.stories.tsx:145`); it does not exercise the
whole submit/validation/lost-response/conflict sequence. Dedicated form source tests exist, but no distinct page
story exports for those command states were located in this inventory.

Some older prose says generated offers are unavailable. Current `creator-offers.ts:29,44` actually references
`KernelClient['offers']['get']` and calls `client.offers.get`; `subject-offers.ts:53` calls the generated subject
offers binding. Sales uses a narrow typed bridge to `commerceSales.get` (`creator-sales.ts:49–70`). None is grounds
to invent a dependency pass or change generated declarations. Reproduce actual admission/binding failures first.

The following is **declared source coverage**, with zero executed cases in this attempt:

| Existing files (relative to the indicated workspace's `tests/` or `test/commerce/`)                                                                                                                | What they can address after execution; limits                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel `outcomes.test.ts`, `support/outcome-driver.ts`; frozen `specs/commerce-outcomes.test.ts`                                                                                                   | Original buyer/refund/dispute, creator/seller, anonymous, foreign and suspended/account-fence outcomes. The entry imports the frozen suite through `COMMERCE_DRIVER`; preserve its assertions. Not a visual or final protected-read proof.                                                                                               |
| Web `native/native-purchases.host.test.ts`, `native/native-purchases-fixture.ts`                                                                                                                   | Three declared tests: Alice starts Checkout/verified paid return; failed delivery/forged return; buyer history with Bob/anonymous isolation and cursor checks. Browser intercept aborts external Checkout; a loopback signed provider fixture supplies events. No actual processor call is needed. See fixture/placement findings below. |
| Web `checkout.test.ts`, `checkout-pages.test.ts`, `offer-purchase-current-page.test.tsx`, `purchase-return.test.tsx`                                                                               | Checkout submission, page/return recovery and current view. Constructed adapters do not prove the native full journey.                                                                                                                                                                                                                   |
| Web `buyer-receipt.test.ts`, `receipt-checkout-current-session.test.ts`, `receipt-polling-current-order.test.tsx`, `order-reconcile.test.ts`                                                       | Amount meanings, current session/polling/repair; not proof that a paid receipt authorizes Content.                                                                                                                                                                                                                                       |
| Web `subject-offers.test.ts`, `subject-offers-read-admission.test.tsx`, `mapped-entitlement.test.ts`, `entitlements.test.ts`                                                                       | Public offer adapter, admission and exact mapped-reader navigation/refusal; not purchased protected bytes.                                                                                                                                                                                                                               |
| Web `creator-offers.test.ts`, `creator-offer-editor.test.ts`, `creator-offers-refresh-recovery.test.tsx`, `creator-offer-draft-navigation.test.tsx`                                                | Creator reads/writes, currency/validation, revision/draft and uncertain request recovery.                                                                                                                                                                                                                                                |
| Web `creator-sales-native.test.ts`, `creator-sales-current-outcomes.test.ts`, `creator-sales-current-refresh.test.tsx`                                                                             | Native-adapter-shaped transport and current-viewer state. A filename containing “native” alone does not establish a database run.                                                                                                                                                                                                        |
| Web `creator-statements.test.ts`, `creator-statement-current-read.test.ts`, `creator-statement-address.test.tsx`, `creator-statement-line-family.test.tsx`, `creator-payment-attestation.test.tsx` | Cursor/address recovery, line order/multiplicity, exact reference validation, immutable original request, authority retirement and response-confirmed save. No current page capture.                                                                                                                                                     |
| Web `recorded-responses.test.ts`; Kernel `creator-offers.test.ts`, `creator-sales.test.ts`, `payouts.test.ts`, `payout-mark-paid.test.ts`, `order-receipt-financial.test.ts`                       | DTO compatibility and corresponding native producer/accounting evidence; neither replaces current visual review.                                                                                                                                                                                                                         |

Current-viewer/content-item/address tests also exist for orders, entitlements, creator offers, Sales and statements.
They must accompany any later repair of their behavior; this report changes none of those files.

Earlier [design status](design-status-commerce.md) explicitly leaves the ordinary 390/1280 review pending.
Its listed story IDs and old source checks are historical claims, not new images. The
[integrated review](commerce-integrated-done-review.md#what-the-native-evidence-actually-proves) reports an old
23-pass/562-expectation log and a different failed verification revision; neither raw artifact was opened here
because it is in the read-only main checkout outside the permitted reference directories.
[Web's adopted evidence boundary](../goals/web.md#adopted-quality-round-three-requirements) also rejects reuse of
historical captures as current proof. No unknown-revision deployed Storybook was treated as current dev.

## Exact unmeasured clauses and bounded next proposals

These proposals reuse existing owners and do not enqueue briefs or start implementation. Missing measurements
are distinct from assertion failures: there is no current assertion failure, flakiness diagnosis or pre-assertion
service failure from this attempt. The fixture and placement issues below are source findings already present on
the retained base, not failures introduced by this report.

### Buyer journey: missing native composition and page measurements

Exact Done-when clause 1:

> Subject entry, offer, hosted Checkout, private purchase/owned-benefit navigation and final protected use form one
> journey through ordinary APIs, native storage and reviewed pages. The first target is an exact authored native Content edition (`content.edition`, `edition:read`, revision ID and
> SHA256). Real Content sale authority, Accounts opaque benefit facts and final Content reads must be delivered
> before protected-use completion; bounded subject discovery remains a shared delivery.

**Cases/missing instrumentation:** all subject/offer/order/history/entitlement/reader IDs above lack current full-size
captures and per-state keyboard/touch observations. Native fixture setup is also incompatible by source inspection:
`services/kernel/test/commerce/support/outcome-driver.ts:452` supplies a subject-only fresh offer;
`apps/web/tests/native/native-purchases-fixture.ts:127` does likewise. Neither supplies `contentEditionId`.
The current create command calls `captureCurrentContentEdition(input.contentEditionId ?? '', …)`
(`commands.ts:304`), and `benefit.ts:113` rejects an invalid edition locator. These setup paths cannot establish
a successful fresh fixed-edition sale as written. This is an inferred fixture defect, not a measured exit.

There is a separate placement gap: `apps/web/scripts/check.ts:450` discovers only `tests/*.host.test.ts` for the
supported `--host` route, while `native-purchases.host.test.ts` is nested in `tests/native/`. No explicit
`native-purchases` selector was located in the Web script sources. Do not assume `test:host` ran these three cases
or bypass the owning placement by launching Bun directly. Web owns registering this existing test in its supported
runner while preserving Auth/native placement; the original kernel entry remains available independently.

**User outcome / bounded proposal:** reuse Commerce's existing native outcome-fixture repair described in
[the outcome-quality report](commerce-outcomes-quality.md#clause-1-complete-buyer-journey--missing-composition-and-measurement).
Author/publish an actual Content edition through its native fixture, use real sale authority and Accounts admission,
then retain the original provider-fixture and frozen assertions. Add the missing composed paid-to-protected-read
case through current APIs, including refund, same-route foreign buyer, source loss and exact version bytes; use
existing Content fixtures rather than a successful permission stub. Likely paths: Commerce outcome support,
Web native purchase fixture/runner registration, Content fixture support. Commerce leads; Content/Accounts own ports.

Web's bounded follow-up reviews only the listed buyer states after authentic recordings exist: consent/reprice,
double tap/uncertain retry, return/pending/failed, known-order repair, sparse history and exact reader navigation.
Expected user outcome is understandable progress/recovery without a second purchase or a false access promise.
Likely page paths are the buyer presenters/adapters in the route table; shared frame/control changes remain Web/UI.

### Creator financial views: missing current API-to-page and command-state review

Exact Done-when clause 5:

> Creator offer/sales/statement views distinguish historical payment, current entitlement, provider bank payout,
> attributed earnings, reserves/payability and actual external payment attestation. Remaining commercial/shared
> additions require explicit adoption before runtime bodies; accounting unknowns are visible.

Relevant exact owner clause, `services/kernel/src/commerce/README.md:890`:

> Keep these distinct: **provider cash movement**, **historically paid purchase**, **current entitlement**,
> **attributed creator earnings**, **reserves/payability**, **external payment attestation**.

**Missing measurement:** every creator page/pattern ID above lacks a bound screenshot/API recording and actual
keyboard/touch observations. `ExternalPayment` covers saved evidence; dedicated page captures for editing,
first validation rejection, changed-reference resubmission, dispatch pending, uncertain retry, conflict/refresh,
denied/retired authority and confirmed save remain missing. Form tests declare these behaviors but were not run.
No observed layout, copy or disclosure defect is asserted without a capture.

**Bounded proposal / existing owners:** Commerce retains native offers, Sales, statements and `markPaid` evidence;
Web retains the creator list/detail/editor/recovery review. First execute existing producer and form coverage,
then record native responses and capture the current page states. Review historical paid/revoked separately,
negative adjustments and unknown units, long source/payment references, exact-reference command response versus
refreshed statement, and creator/other-creator isolation. Add only missing command-state story inputs if needed.
Likely paths: `creator-offers*`, `creator-offer-editor.tsx`, `creator-sales*`, `creator-statement*`,
`creator-payment-attestation*`, their existing stories/tests and recorder modules. No payout transfer engine,
reserve release policy or richer attestation is adopted. User outcome: creators understand what was sold,
what was attributed, what is unknown and what external reference was actually recorded.

### Reviewed ordinary-API interface: missing captures, input measurements and provenance

Exact Commerce Acceptance clause:

> Connect entry/offer/return/history/owned-benefit/use and creator views to actual APIs, recorded-response stories,
> Web review and screenshots under [verification](../development/verification.md). Native storage, bounded execution,
> reviewed interface and promoted-main evidence remain required. Docs-only adoption is not that test campaign.

Exact UI bar from `packages/ui/README.md`, Form fields:

> Below 768px or with a coarse primary pointer, editable controls and standard action buttons have a minimum 44px
> target. Fine-pointer desktop controls retain their dense sizes.

Exact running-review bar from `docs/development/verification.md:60`:

> Review interfaces in the running product. Compare phone and desktop, both themes, representative content and important
> empty, loading and failure states. Compare shared components across surfaces. Fix the defect class. Automated tests
> support this review; they do not establish visual quality.

**Missing instrumentation:** a width-only image is not a coarse-pointer measurement. The screenshot runner creates
contexts with width/720 height (`apps/web/scripts/screenshots.ts:1081`); review must separately record effective
pointer/hover media, real hit rectangles, keyboard focus and interaction outcomes. No such observation exists here.
No hierarchy, color contrast, overflow, privacy or technical-copy judgment can be derived merely from source classes.

**Bounded proposal:** Web owns one capture/review campaign for the exact inventory, at both widths/themes and the
eight supported locales. English plus Traditional Chinese/Japanese and German are useful first diagnostic views;
they do not waive the remaining locale cells. Use full-page PNGs after story completion/fonts, verify the rendered
locale/theme, inspect each original-size image, and record actual state and pointer mode. Exercise Tab/Shift-Tab,
Enter/Space, Escape/focus return, validation announcement, touch menu/dialog reachability, submit/retry and restart.
Keep the original cursor/request identity when recovery requires it. Test 1280 with coarse pointer as well as
fine pointer; resizing alone must not be called touch coverage.

For each observed gap, record exact ID/route, dimensions, theme, locale, persona, screenshot path, interaction,
missed owner sentence, user-visible outcome and smallest owner repair. Check readable heading/amount/action order,
wrapping CJK/titles/references, real 44px controls, visible focus and contained overlays, independent public/private
data, denied/preparing/error/uncertainty copy, and all six financial meanings. Avoid internal IDs, hash/SQL/transport
or permission machinery as product explanations. A privacy assertion requires API/persona evidence in addition to
pixels. Shared changes stay in Web/UI; local Commerce copy/presenters can be separately briefed after observation.

## Deferred reproduction commands and evidence fields

The commands below are supported source entry points or explicit owner-registration gaps, **not executions**.
Actual exit for every row is **not available**; no run UUID, native log, browser trace or screenshot directory was
created. Original assertions and native fixtures must be retained; no skips, successful dependency substitutes,
generated-binding edits or live processor traffic are authorized by this report.

| Owner action after integration             | Exact command / missing placement                                                                                                                                                                                                 | Evidence to retain                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commerce frozen native outcomes            | `bun run --cwd services/kernel check test/commerce/outcomes.test.ts`                                                                                                                                                              | Candidate/dev SHA, runner placement, actual exit, all original cases/personas, signed loopback requests and native storage results. Preserve remote/compiler database environment.    |
| Commerce creator/receipt producer coverage | `bun run --cwd services/kernel check test/commerce/creator-offers.test.ts test/commerce/creator-sales.test.ts test/commerce/payouts.test.ts test/commerce/payout-mark-paid.test.ts test/commerce/order-receipt-financial.test.ts` | Current creator/other-creator, payment/unknown/adjustment evidence and physical bounds; record setup failures separately from assertions.                                             |
| Web native purchase journey                | Supported existing host entry is `bun run --cwd apps/web test:host`; nested purchase fixture registration is missing as described above                                                                                           | Web must first make the owning runner select the unchanged nested tests. This command alone is not claimed to cover them.                                                             |
| Web response schema compatibility          | `bun apps/web/scripts/focused.ts --private-network -- bun test tests/recorded-responses.test.ts`                                                                                                                                  | Actual exit and response provenance; compatibility is not a new native recording.                                                                                                     |
| Web reference command/recovery             | `bun apps/web/scripts/focused.ts --private-network -- bun test tests/creator-payment-attestation.test.tsx tests/creator-statement-current-read.test.ts tests/creator-statements.test.ts`                                          | Exact sender/key/reference, validation/uncertainty/conflict cases and actual exit; later visual state records remain separate.                                                        |
| Full-size story capture                    | `bun apps/web/scripts/screenshots.ts --story 'pages-commerce-*' --width 390 --width 1280 --theme light --theme dark --out .temp/screenshots/commerce-pages`                                                                       | All eight locales default; actual viewport is width×720. Files use `<id>.<locale>.<theme>.<width>px.png` for multiple widths. Output path must resolve inside the candidate worktree. |
| Companion pattern capture                  | Repeat the same screenshot command with `--story 'patterns-commerce-*'`, then `--story 'patterns-statement-line-pages--*'`, `--story 'patterns-subjects-purchase-entry-slot--*'`, `--story 'patterns-content-creatoreditions--*'` | Same dimensions/themes/locales, original-size inspection and actual exits. Filter to this inventory when unrelated Commerce patterns exist.                                           |
| Interactive local review                   | `bun run --cwd apps/web storybook`                                                                                                                                                                                                | Record local build/source SHA and actual globals, input modes, persona, state, focus/hit measurements and full-size captures before judgment.                                         |

The screenshot runner's existing implementation waits for fonts and captures `fullPage: true`
(`screenshots.ts:906,963`). Its generated test build and output are temporary evidence, not committed source.
Bind a published review through its immutable version URL and `build.json` full SHA
(`apps/web/.storybook/README.md:43`); a deployed site with unknown revision remains insufficient. Shared-dependency
revision differences also matter even when the Commerce files compare equal. Do not register promotion evidence.

## Primary-source findings and recommendation

The reference clone reused, without installation/build/execution, is
`/home/edge/projects/rezics/rezics-next/.reference/storybook-practice/storybook`, commit
`0798ec85fdba7001777219b4f6a8eb8de75f1ee9` (11.0.0-alpha.8), MIT (`LICENSE`). Its reuse is indexed under
`commerce-page-review-quality` in the shared `.reference/INDEX.md`. This matches the repository's pinned
Storybook version, unlike the public site's currently served stable documentation version.

- [Pinned Storybook viewport source documentation](https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/docs/essentials/viewport.mdx), local `docs/essentials/viewport.mdx:7–15,76–85`, separates available viewport options from selected globals. An option existing is not a capture at that size.
- [Pinned StoryRender source](https://github.com/storybookjs/storybook/blob/0798ec85fdba7001777219b4f6a8eb8de75f1ee9/code/core/src/preview-api/modules/preview-web/render/StoryRender.ts), local Git object at that path, lines 215–345, separately awaits loaders, mounts the story and runs play under its own phase. The sparse clone lacks that working file; it was read with `git show HEAD:<path>`. Wait for the completed state rather than treating server/index readiness as page completion.
- [Official Storybook visual-test documentation](https://storybook.js.org/docs/writing-tests/visual-testing) describes comparing story snapshots with an accepted baseline and reviewing changes. A story export or interaction assertion alone supplies no visual verdict. Documentation consulted as primary guidance; no source copied.
- [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) explains the 44×44 CSS-pixel enhanced target criterion and exceptions. This is AAA guidance; UI's adopted phone/coarse-pointer contract is the repository bar, without silently claiming WCAG conformance.
- [W3C focus-visible guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) requires a visible keyboard focus mode; [reflow guidance](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) concerns 320 CSS-pixel equivalent width. A 390px capture alone proves neither keyboard focus nor 320px reflow. W3C documents carry their linked W3C document-use terms; cited and paraphrased, not copied into implementation.

The shared pattern is to hold state, environment and provenance explicit, then inspect the actual rendered result.
For this repository's React/TanStack/Paraglide/Storybook stack, adopt the existing runners and globals, authentic native
fixtures and recorded-response route stories, with per-state visual/input observations. Repair native fixture and
runner selection gaps with their current owners before claiming composed evidence. Preserve unknown financial and
access facts in both recordings and UI. Keep these findings in research until a manager adopts any design change
in its owning document. This documentation-only report changes no workspace code or tests; no workspace typecheck
or focused test is applicable, and broader acceptance remains deferred by the launch policy.
