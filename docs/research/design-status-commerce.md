# Commerce design status

Desk status of every Commerce-owned **In** system in [scope](../scope.md), with separate purchase and Library owner briefs.
This is evidence and handoff, not another authority. **Designed**, **implemented**, **exposed**, **native-outcome-proven** and **promoted** are separate; implementation/exposure below means source presence.
Native whole-journey proof and promotion are **not established** here. MINIMAL landings/promotion pause do not establish full-row/main completion. Points and user-saved dynamic queries remain deferred.

**Primary evidence accessed 2026-10-30.** Documented facts: Stripe's [hosted Checkout lifecycle](https://docs.stripe.com/payments/checkout/how-checkout-works?payment-ui=stripe-hosted)
creates a Session URL and uses a webhook for fulfillment. [Managed Payments eligibility](https://docs.stripe.com/payments/managed-payments/eligibility) requires review, direct sales and distribution rights; it excludes Connect/platform configurations.
Stripe's [Entitlements API guide](https://docs.stripe.com/billing/entitlements?dashboard-or-api=api) assumes subscriptions, Customers and product-feature mapping.
**Inference:** that guide does not establish compatibility with REZICS's local one-time entitlement model.
[Zotero](https://www.zotero.org/support/collections_and_tags) documents overlapping collections, independent tags and automatically updated saved searches.
**Inference:** these support separating facts from views, not REZICS's exact membership/privacy/pin rules. Existing decisions remain local constraints, not vendor evidence.

**Commerce / offers / orders.** Sole purchase authority: [Commerce README](../../services/kernel/src/commerce/README.md);
[Commerce Goal](../goals/commerce.md) owns purchase completion, and [Library Goal](../goals/library.md) separately
retains personal-space completion under the same commerce manager, all original tasks and native/main requirements.
Both [ownership/benefits](commerce-ownership-entitlements-benefits.md) and
[payment evidence/settlement](commerce-payment-evidence-settlement.md) reports are delivered and adopted through
that owner contract; [future modules](../commerce-modules.md) remains the sole future financial map.
Commerce owns API/storage/journey pages. Web owns shell/navigation, shared patterns and visual review; existing Web
checkout/history and Library interface producers remain handoffs, not duplicate rewrites. Offers use creator homes;
orders/evidence/entitlements buyer homes; statements creator homes. Writes remain single-partition.
Existing [routes](../../services/kernel/src/commerce/routes.ts) provide known-ID offer reads/create/revise/delist,
order creation/read/history and entitlement read/list. Web supplies `/offers/$id`, `/orders/$id`,
[history `/orders`](../../apps/web/src/routes/orders/index.tsx) and shell navigation. Old claims of absent revise HTTP,
delisted concealment or history navigation are superseded by source presence, not a new acceptance result.
The four payment-fix directions are creation uncertainty, complete evidence, immutable movement economics and
bounded signature/secret inputs; this document does not certify their owner delivery or native/main proof.
Financial erasure/custody and actual native/DBOS growth gaps remain open.

**Entitlements and actual use.** The owner contract adopts one-time account-bound acquisition of one immutable
fixed-version benefit/quantity one, separate from subject/payment/Library/future item identities. Historic subject-only
orders retain UNKNOWN benefit mapping until explicit authorized mapping. Partial-refund compatibility and terminal
no-restoration remain. The exact first target is adopted: native authored `content.edition`, `edition:read`, fixed revision ID/SHA256.
Commerce has bounded immutable capture storage, HTTP DTOs and native entitlement data reads. It now imports the
canonical Accounts benefit type and exact authenticated/mechanical Content sale entrypoints. Released per-attempt
preparation preserves normal parent authorization and receipt ordering; physical Checkout has a one-use in-memory
lifetime fence. Verified exact bindings permit paid grant/restore independently of financial truth and revocation.
Content's entrypoints in this base are agreed unavailable declarations, pending its real native original-publisher
and current-consent verifier. The bounded sequential reads do not establish a cross-home simultaneous snapshot;
Content still rechecks current authority before final bytes. Fresh sale stays closed while that runtime is absent.
The delivered sole offer-consent writer supplies observed expectedOfferRevision and its digest; the composed
fresh body preserves its revision conflict check after authorized exact receipt replay. The native Commerce
buyer-fact reader is composed with Accounts Access independently of Content sale reads. Content final
source/ancestry reads, subject discovery, owned navigation, native sale/use proof, reviewed UI and promoted-main
journey remain pending.
Tax/unit, reserves/carry/payability, richer external attestation and authenticated recovery require the explicit
owner/Root commercial/shared adoption recorded in the purchase contract before runtime bodies.

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

**Limits and custody.** Read owner deliveries and route/UI seams only; no independent native/code audit, tests, typecheck,
generator, runtime or promotion check. Named owners and existing Web producers are handoff responsibilities, not claims of live task registration or delivery proof.
The delivered reports and existing owner sources supply the design evidence; no new audit is introduced.
The linked Stripe fulfillment variant could not be fetched; no fulfillment-detail claim relies on it. REZICS eligibility is unknown.
Read-only references: main `.reference/INDEX.md`; `shelves/bookwyrm/bookwyrm/models/shelf.py`, `LICENSE.md` (Anti-Capitalist Software License 1.4);
`shelves/bangumi-server/openapi/components/user_subject_collection{,_modify_payload}.yaml`, `LICENSE.txt` (AGPL-3.0), at indexed revisions. Shelf/tag evidence only; nothing copied/executed.
