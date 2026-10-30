# Commerce design status

2026-10-30. Desk/web status of every Commerce-owned **In** system in [scope](../scope.md), on the current worker base.
This is evidence and handoff, not another authority. **Designed**, **implemented**, **exposed**, **native-outcome-proven** and **promoted** are separate; implementation/exposure below means source presence.
Native whole-journey proof and promotion are **not established** here. MINIMAL landings/promotion pause do not establish full-row/main completion. Points and user-saved dynamic queries remain deferred.

**Primary evidence accessed 2026-10-30.** Documented facts: Stripe's [hosted Checkout lifecycle](https://docs.stripe.com/payments/checkout/how-checkout-works?payment-ui=stripe-hosted)
creates a Session URL and uses a webhook for fulfillment. [Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) requires review, direct sales and distribution rights; it excludes Connect/platform configurations.
Stripe's [Entitlements API guide](https://docs.stripe.com/billing/entitlements?dashboard-or-api=api) assumes subscriptions, Customers and product-feature mapping.
**Inference:** that guide does not establish compatibility with REZICS's local one-time entitlement model.
[Zotero](https://www.zotero.org/support/collections_and_tags) documents overlapping collections, independent tags and automatically updated saved searches.
**Inference:** these support separating facts from views, not REZICS's exact membership/privacy/pin rules. Existing decisions remain local constraints, not vendor evidence.

**Commerce / offers / orders.** Sole financial authority: [Commerce README](../../services/kernel/src/commerce/README.md);
Web owns presentation, Accounts admission, Semantic subject identity. Offers use seller routes; captured orders/settlement/entitlements buyer routes; royalty statements creator routes. Writes stay single-partition.
Research delivered: [integrated review](commerce-integrated-done-review.md) and [refresh recovery](commerce-session-refresh-recovery-current.md)
([second investigation](commerce-session-refresh-recovery-deep.md)) cover narrower evidence/recovery seams, not the whole purchase model.
`docs/research/commerce-ownership-entitlements-benefits.md` and `docs/research/commerce-payment-evidence-settlement.md`
are **pending: absent on this base**. Separation of the mixed [Commerce/Library Goal](../goals/commerce.md) and Commerce contract rewrite remain pending after those two explicitly dispatched reports.
Designed payment evidence is substantial; [actual routes](../../services/kernel/src/commerce/routes.ts) implement known-ID
offer reads/mutations, `POST /v1/orders`, `GET /v1/orders[/:orderId]`, and signed webhook intake.
Web exposes `/offers/$id`, `/orders/$id` and now [buyer history `/orders`](../../apps/web/src/routes/orders/index.tsx)
through the generated client and gated [shell navigation](../../apps/web/src/shell/shell.tsx). Older README claims of absent revise HTTP/history navigation are stale; routes conceal delisted offers and revise intent includes its target.
Owner-reported refresh serialization/growth reds and financial erasure/custody gaps remain; historical review defects are not all current defects.

**Entitlements and actual use.** Same Commerce authority: private `GET /v1/entitlements[/:entitlementId]`, buyer equality,
purchase gates/scopes, settlement grant/revoke rules and terminal-account barrier are designed; records/readers exist.
Whole journey remains incomplete: **subject benefit entry → active offer → Checkout → find owned benefit → use it**.
Subject-to-active-offer discovery, benefit identity/consumer enforcement and an owned-benefit use surface are missing;
history's recorded entitlement ID proves neither active access nor consumption. Purchasing creates no Library holding.
**Handoff:** the two pending research producers must resolve benefit identity/discovery/consumer authorization and supported payment movements, settlement and royalties; orders need the resulting captured-benefit compatibility contract.

**Library / exclusive state.** Sole capability authority: [Library and Collections](../library-and-collections.md), with
[module implementation inventory](../../services/kernel/src/library/README.md); Commerce owns private account-partition facts,
Web pages, Semantic profiles/identity and Accounts Access. [Abstraction research](library-abstraction.md) is delivered,
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

**Recommendations awaiting manager adoption.** Commerce/Web/Semantic/Accounts should select the smallest benefit-consumer
port after the two pending reports; prefer local captured benefit identity/enforcement over adopting Stripe Billing Entitlements
without a subscription/catalogue migration decision. Compatibility impact: new discovery/use contracts, existing order terms retained.
Library/Web should compose the existing Collection journey and keep payment ownership separate. These are recommendations, not adopted API/schema changes; per-system handoffs above need manager dispatch, beyond the two already dispatched reports.

**Limits and custody.** Read owner deliveries and route/UI seams only; no independent native/code audit, tests, typecheck,
generator, runtime or promotion check. Live producer registration is unknown: local manager task state/audit attachment is absent;
named owners are contract owners, not claimed active workers. No research index was present; linked reports were read directly.
The linked Stripe fulfillment variant could not be fetched; no fulfillment-detail claim relies on it. REZICS eligibility is unknown.
Read-only references: main `.reference/INDEX.md`; `shelves/bookwyrm/bookwyrm/models/shelf.py`, `LICENSE.md` (Anti-Capitalist Software License 1.4);
`shelves/bangumi-server/openapi/components/user_subject_collection{,_modify_payload}.yaml`, `LICENSE.txt` (AGPL-3.0), at indexed revisions. Shelf/tag evidence only; nothing copied/executed.
