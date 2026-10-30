# Commerce design status

Desk status of every Commerce-owned **In** system in [scope](../scope.md), with separate purchase and Library owner briefs.
This is evidence and handoff, not another authority. **Designed**, **implemented**, **exposed**, **native-outcome-proven** and **promoted** are separate; implementation/exposure below means source presence.
Native whole-journey proof and promotion are **not established** here. MINIMAL landings/promotion pause do not establish full-row/main completion. Points remain deferred. User-saved dynamic queries are adopted and underway under Library; they are not implicitly deferred by this delivery.

**Primary evidence accessed 2026-10-30.** Documented facts: Stripe's [hosted Checkout lifecycle](https://docs.stripe.com/payments/checkout/how-checkout-works?payment-ui=stripe-hosted)
creates a Session URL and uses a webhook for fulfillment. [Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) requires review, direct sales and distribution rights; it excludes Connect/platform configurations.
Stripe's [Entitlements API guide](https://docs.stripe.com/billing/entitlements?dashboard-or-api=api) assumes subscriptions, Customers and product-feature mapping.
**Inference:** that guide does not establish compatibility with REZICS's local one-time entitlement model.
[Zotero](https://www.zotero.org/support/collections_and_tags) documents overlapping collections, independent tags and automatically updated saved searches.
**Inference:** these support separating facts from views, not REZICS's exact membership/privacy/pin rules. Existing decisions remain local constraints, not vendor evidence.

**Commerce buyer journey.** The [Commerce README](../../services/kernel/src/commerce/README.md) owns purchases;
[Commerce](../goals/commerce.md) owns this journey and [Library](../goals/library.md) retains the personal-space scope.
The adopted [ownership/benefits](commerce-ownership-entitlements-benefits.md) and
[payment evidence/settlement](commerce-payment-evidence-settlement.md) reports remain design evidence.
Known-ID `/offers/$id` now presents the actual sanitized `contentEdition` capture: one fixed version, quantity one,
one-time account binding, native creator identity when its public name is available, and the captured licence.
Its price uses the recorded unit exponent, with explicit before-tax wording only for captured exclusive tax terms;
absent historical money/tax metadata stays unknown. Existing CSRF, observed offer revision and creation-intent retry
remain the sole checkout path; unmapped or malformed terms cannot start a new purchase.

Hosted Checkout returns to private `/orders/$id`; the captured edition terms remain separate from settlement and
the associated current access read. That page links to the exact `/entitlements/$id` record. `/entitlements` keeps
bounded owner-self paging and compact record navigation, with no per-row Content or identity lookups. The detail
uses its immutable sanitized capture and one optional public identity point for that capture's creator. Only an active,
unrevoked mapped record links, through the locale helper, to the existing guarded `/editions/{benefit.resource.id}`.
No subject/offer ID substitutes for the edition, no source thread/post/body enters this presentation, and revision
UUIDs, hashes and publication references remain data rather than buyer-facing prose. Null or absent historical
mapping stays UNKNOWN; revoked/refund/dispute records retain purchase truth without a reader affordance.

Content's [served reader](../../apps/web/src/routes/editions/$id.tsx) and
[native sale binding](../../services/kernel/src/content/edition-sale-native.ts) are integrated source, replacing the
old unavailable-declaration description. Content owns current scopes, opaque buyer facts, ancestry, source/version
checks and final delivery; an active purchase record never promises that the reader will currently open. Native
Commerce/Content sale/use proof, provider eligibility, physical cost/custody, current Web review and promoted-main
proof remain controller/owner work. The order detail wire does not expose captured monetary fields, so this adapter
never reconstructs them from a current offer or adds a history lookup. Reconciliation and money parsing keep their
existing sole writers/renderers. Creator offer/sales/statement completion and commercial adoption retain their owners.

**Next ordinary Web review.** Prior visual acceptance covers only its previously rendered states. Review the exact
new IDs `pages-commerce-offer--mapped-fixed-edition`, `pages-commerce-order--mapped-fixed-edition`,
`pages-commerce-entitlements--mapped-fixed-edition`, `pages-commerce-entitlement--mapped-fixed-edition`,
`pages-commerce-entitlement--mapped-refunded`, `pages-commerce-entitlement--mapped-disputed` and
`pages-commerce-entitlement--reader-unavailable`. Revisit the affected existing
`pages-commerce-entitlement--active`, `pages-commerce-entitlement--refunded-with-paid-order`,
`pages-commerce-entitlement--legacy-unknown-mapping`, `pages-commerce-entitlements--active`,
`pages-commerce-entitlements--revoked` and `pages-commerce-entitlements--legacy-unknown-mapping` states as well,
at 390/1280 and in all eight locales. These are explicitly constructed wire-shaped presentation fixtures, not new
native recordings or delivery evidence. The new interface acceptance source follows the exact mapped edition into
the existing reader adapter, preserves refusal/unavailability and covers unknown/revoked navigation. The local
`bun run --cwd apps/web typecheck` passes on the integrated source (1,025 files). Integration preserves the existing
curated-members preparation guard and the creator-publication translations alongside these benefit translations. The new
`bun test apps/web/tests/mapped-entitlement.test.ts` passes three tests with 198 assertions. Browser, Storybook,
native, remote and integration proof/publication remain pending. No protected-use, privacy, runtime or main approval is claimed.

**Creator offers and exact money.** The [native money policy](../../services/kernel/src/commerce/README.md#native-money-policy-and-captured-prices)
owns closed USD/EUR sale configuration, recorded units and nullable historical tax facts. The served
`/creator/offers/new?editionId=<published edition ID>` consumes Content's actual published metadata through the
existing client and uses the generated `GET /v1/commerceMoney`; the real native owned `GET /v1/offers` remains the
sole listing. Inline repricing/delist use existing BFF/CSRF/idempotency writes and retain the original request on
uncertain retry. A new explicit price captures a revision; unknown old units never prefill a guessed major amount.
Content owns `/editions/new` and the guarded buyer reader. Edition IDs identify a target, never current selling rights.

The editor explains ASCII-dot input, shows a localized currency/before-tax preview and clears the amount when
currency changes. Offer, order-list and statement displays use recorded exponents, BigInt quotient/remainder and
Intl placement/digits; signed cents and safe-integer precision survive without currency summing or UI FX.
Numeric negative zero is normalized to zero; a real negative cent retains its sign in all eight locale cases.
Existing recordings without actual metadata stay unknown. Focused parser/display, write, search and generated-adapter
cases are source, not native proof. Shared localization keys retain the newer base translations; only missing
Commerce keys are added in all eight locales. Native configuration does not establish provider qualification.

Web/Content handoff: actual routes `/creator/offers/new` and `/creator/offers`, publisher next link `editionId`,
and exact 390/1280 stories `pages-commerce-creator-offer-editor--{price-intent,actual-route}-{390,1280}`.
Price stories supply explicit adopted example rules, not native permission or publication. Actual route stories keep
unavailable outcomes when their data source is unavailable. Current visual, native combined-journey and promoted-main
proof remain pending. The positive current mapped-offer fixture now supplies its declared
`{system:'stripe-api',exponent:2,factsVersion:'stripe-money-v1'}` unit, retaining the raw `1299` amount and exact
`$12.99` assertion. Its omitted tax convention remains unknown, preserving the no-before-tax assertion and all
existing mapped/revoked, reader-denial, bounded-read and credential assertions. Historical recordings remain
unchanged. Earlier buyer fixture proof above predates this reconciliation. The creator editor, owned-offer controls
and exact-money presentation are source-complete for this interface slice; local typing of the zero-display
correction is pending. Native combined-journey proof and promoted-main completion remain separate obligations.

**Library / exclusive state.** Sole capability authority: [Library and Collections](../library-and-collections.md), with
[module implementation inventory](../../services/kernel/src/library/README.md); Commerce owns private account-partition facts,
Commerce journey pages with Web shell/patterns/review, Semantic profiles/identity and Accounts Access. [Abstraction research](library-abstraction.md) is delivered,
primary-source-backed but explicitly incomplete for MAL; it supports distinctions, not full runtime acceptance.
Designed subject actions and `/library` call `/v1/libraryEntries`; state set/clear/Undo and owner write sequence exist.
Full fact union, canonical browsing, scoped search and terminal whole-graph/shared-payload cleanup remain incomplete.
**Handoff task:** map subject actions → Everything/Continue across label/session/holding-only presence and state clear/Undo, using the adopted union and identity rules before briefing runtime.

**Curated Collections.** Sole membership authority: [Library and Collections](../library-and-collections.md); presentation/editor
seam: [Collection presentation](../collection-presentation.md); source seam: [Collection source](../collection-source.md).
Delivered abstraction research above and [shelf survey](library-shelves.md) support the broad model, not all editor semantics.
Curator-route headers/ordered duplicate occurrences, Access visibility, `/collections/$id` and `/v1/collections/:collectionId/members`
exist. Designed whole editor includes kind/cover/FULL facts, export and mounting; integrated kind/cover enrichment,
bulk move/remove and common dynamic members are missing. Semantic owns definitions/fact batches, Content image authority,
Web the common editor. **Handoff task:** complete the duplicate-occurrence/note/order journey through selected cross-Collection move, export, mounting and denial, preserving the adopted editor/browse distinction.

**Progress / sessions.** [Library module](../../services/kernel/src/library/README.md) owns algorithms; [profile consumers](../library-profile-consumers.md)
own pin consumption. Delivered [abstraction research](library-abstraction.md) distinguishes rereads and sparse units.
Owner-route sessions/history/units, `/library/progress` and `/v1/progressSessions` implement start/record/complete/abandon;
publication is explicit. Cross-profile/structure-change journey design coverage is incomplete. **Handoff:** how should changed
subject structure preserve sparse completed-unit IDs and reread history without inventing completion or rewriting accepted meaning?

**Copies / holdings.** Same module/profile authorities and delivered abstraction study; private owner-route copies,
`/library/copies` and `/v1/copies` exist, independently of progress/state/payment rights. Profile columns/readers are
partial delivery; the all-kind journey remains incomplete. **Handoff:** which released holding-kind/status transitions and historic-pin display distinguish a digital holding from a consumable purchased benefit?

**Labels.** Sole authority: [independent labels](../library-labels.md); delivered [cap research](library-label-cap-independent-current.md)
and [second investigation](library-label-cap-independent-deep.md) back same-row reservations/restore semantics.
Owner-partition metadata/assignment DAOs exist; Access/CAS/Undo, unprofiled assignment and Everything presence are designed.
Web `/library/labels` [awaits a generated native client](../../apps/web/src/library/labels-read.ts): `/v1/libraryLabels`,
assignment pages/Undo, FULL batch, source cutover and complete purge are not exposed production journeys.
**Handoff task:** map the researched parent-restore/reclaimed-reservation rules onto catalogue → subject tile → Everything → Undo before briefing missing HTTP producers.

**Profiles.** Sole consumer authority: [profile consumers](../library-profile-consumers.md); Semantic owns immutable definitions
registry/compiler/releases, Commerce accepted fact pins, Web labels/choices. Delivered abstraction research motivates generic
configuration; it is not dedicated evidence for every release migration. Columns/native fact adapters and Web profile helpers
exist; complete writer validation, legacy cutover and old-pin rendering across all entry/session/copy pages remain unproven.
**Handoff task:** complete the per-consumer UI/API/storage matrix for the adopted fresh-write and historic-read/clear/Undo rules after profile retirement.

**Built-in dynamic membership (Everything, state, Liked).** Sole authority: [dynamic Collections](../dynamic-collections.md),
with [owner queries](../library-owner-queries.md); delivered [owner-index research](library-owner-index-observation-current.md)
([second investigation](library-owner-index-observation-deep.md)) supersedes older witness plans; [state-set study](library-builtin-set-support-current.md)
is narrower historical evidence. Owner-partition native facts remain truth; one candidate/support directory is derived.
The common members endpoint/page is designed, including private `202` preparation versus genuine empty `200`; current
curated paging cannot deliver it. Common source factories are unavailable; Liked identity/Content reaction versions,
Semantic whole-query disclosure/identity and Library preparation/custody remain pending; Accounts' executor exists, not its complete Library consumer.
**Handoff:** which complete producer coverage makes copy/session-only state siblings and reaction-only Liked ready without false empty results or public leakage?

**Follows / private owner counts — shared Accounts ownership.** Edge authority: [Library module](../../services/kernel/src/library/README.md);
count authority: [private follow counts](../private-follow-counts.md); delivered [simplification research](follow-counts-simplest.md).
Follower-partition edges, implied/explicit precedence, `/library/following` and `/v1/follows` exist. Counts are designed,
not exposed: own outgoing total stays follower-local; canonical pair/support/total resides in the target partition.
Accounts owns management evaluation, account-agent resolution/state and effects admission; Commerce owns projections/maintenance;
Semantic identity/kernel health are prerequisites. Proposed `/v1/followCounts/:targetType/:targetId`, aggregate/readiness, lifecycle and native driver remain pending.
**Handoff:** where should eligible managers see private ready/unready counts with current grants and suspension/erasure updates, without another person's outgoing list or a public total?

**Shared handoff.** Deliver the adopted exact Content-edition producer and pending discovery through existing
Access; do not introduce a second permission engine or label research sketches as delivered signatures. Library
journeys continue under their existing sole behavior authorities and the separate owner brief. These ownership
changes preserve the commerce manager scope and every original native/interface/main obligation.

**Limits and custody.** Read owner deliveries and route/UI seams; the local interface checks above are the only new
verification. No independent native/code audit, runtime or promotion check. Named owners and existing Web producers are handoff responsibilities, not claims of live task registration or delivery proof.
The delivered reports and existing owner sources supply the design evidence; no new audit is introduced.
The linked Stripe fulfillment variant could not be fetched; no fulfillment-detail claim relies on it. REZICS eligibility is unknown.
Read-only references: main `.reference/INDEX.md`; `shelves/bookwyrm/bookwyrm/models/shelf.py`, `LICENSE.md` (Anti-Capitalist Software License 1.4);
`shelves/bangumi-server/openapi/components/user_subject_collection{,_modify_payload}.yaml`, `LICENSE.txt` (AGPL-3.0), at indexed revisions. Shelf/tag evidence only; nothing copied/executed.
