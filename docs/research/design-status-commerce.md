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
Subject pages now receive Commerce's exact public/private region exports through the shared `AppShell` seam.
The closed subject-offer BFF consumes the selected cursor/default-10/max-20 page contract and keeps current native
denial, preparing, unavailable and successful sparse pages distinct. `nativeSubjectOffersApi` now binds the delivered
generated `KernelClient.subjects({id}).offers.get` caller through the existing locale/session-aware BFF. Its page,
query and options types derive from that caller. The development transport remains an explicit 503 example because
no actual current native page is recorded; it is not evidence of a missing producer.
Constructed presentation examples never supply runtime discovery or ownership facts. Public reads start only after
hydration/session preparation, bind query keys to the actor/session, cancel old reads and use private no-store.
Current offer-review credentials and named denials are preserved as well; no anonymous retry substitutes for refusal.
One explicit next-page action reads one page. There are no automatic mutations, polling or per-card lookups.
The shared private region links to existing own `/entitlements` records without an owned/absent claim; this base
declares no bounded owned-benefit batch. The existing review/Checkout/record/reader journey keeps its sole authorities.

Web handoff modules are `checkout/subject-purchase.ts` (`subjectPurchaseRegions`, `SubjectOffersRegion`,
`SubjectOwnedBenefitsRegion`) and `checkout/subject-offers-region.tsx` (`SubjectOffersView`). The source adapter in
`checkout/subject-offers.ts` exports `createNativeSubjectOffersApi`, `nativeSubjectOffersApi`, `SubjectOffersPage`,
`SubjectOffer`, `SubjectOffersQuery` and `NativeSubjectOffersOptions`; the latter four derive from the delivered
generated directory caller. The decoder preserves the native captured original target after identity merges;
directory membership and Realm/current disclosure remain native decisions, with no invented Realm selector.

The existing story prefix is `pages-commerce-subject-purchase--`, with exact suffixes `signed-out`, `signed-in`,
`pending`, `empty`, `preparing`, `partial-preparing`, `denied-signed-in`, `unavailable`, `cursor-error`, `long-title`,
`mapped-price-unknown`, `unknown-mapping`, `actual-adapter-unavailable` and `signed-in-long-title`. Reproduce the real
adapter's explicit negative transport at `/?path=/story/pages-commerce-subject-purchase--actual-adapter-unavailable`;
the story prepares the existing Storybook session and receives 503 from `kernel.local`. The other public wire
examples remain illustrative. All eight locales use current shared rows and the signed-in mount seam. The ordinary
Web phone390/desktop1280 light/dark review remains pending; no new capture replaces the frozen evidence.

The existing `apps/web/tests/subject-purchase.test.ts` remains unchanged. The new focused
`apps/web/tests/subject-offers.test.ts` covers the delivered generated request, exact headers/options, one explicit
cursor read, sparse/preparing positives, named refusals, genuine failure, session-token continuity, strict capture
decoding and unknown historic terms. Local `bun run --cwd apps/web typecheck` passes with no type errors in 1,396
files. `bun test apps/web/tests/subject-offers.test.ts` passes five tests with 68 assertions; these constructed
transport cases establish adapter behavior only. No native, database, browser, capture, host or remote check ran.
Native producer binding is present in source. Whole-journey, privacy/protected-use, visual and promoted-main proof
remain pending; source typing does not establish those outcomes.

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

**Offer acquisition recovery.** The existing `/checkout` BFF now decodes native `409 benefit_already_owned` and
`409 acquisition_pending` Problems with `effect_status: not_applied`, using the existing Valibot decoder and native
UUID shape. It forwards only recognized Problem members and validated record IDs from its current-session
`POST /v1/orders` response. The Offer page explains the two outcomes separately and links through the current
locale helper to the existing entitlement (preferred for already-owned) or order. An already-owned response with
only an order ID opens that order; missing/malformed IDs and unknown conflicts retain unavailable/retry behavior.
It never follows a supplied href, infers ownership from Library, replaces displayed terms with an old order, creates
a second checkout intent or grants reader access. The existing order and entitlement pages remain their own
authorized reads. Price conflict still requires explicit reload/review; timeout retries retain the original snapshot,
key and observed revision. Concurrent clicks share one in-flight request; resolved recovery cannot resubmit.

The shared decoder/request helper is in `apps/web/src/checkout/offer-recovery.ts`; the live BFF is
`apps/web/src/checkout/start.ts` (the alternative handler/route paths in the assignment do not exist).
The current base does not expose the two native conflict producers; this consumer uses the real generated
order-create call and recognizes their exact response when present, without a guessed transport or ownership stub.
Constructed current-wire fixtures use actual example record IDs and declared mapped-offer money/tax/benefit facts;
historical recordings remain unchanged. Added source tests cover both recovery outcomes, response validation,
single submission, original-intent retry, price conflict distinction and the credential-bound BFF request.
They have not been executed in this interface delivery.

Web's next ordinary 390/1280, eight-locale review receives
`pages-commerce-offer--already-owned`, `pages-commerce-offer--already-owned-mobile`,
`pages-commerce-offer--acquisition-pending` and `pages-commerce-offer--acquisition-pending-mobile`;
retain `pages-commerce-offer--terms-changed` and `pages-commerce-offer--terms-changed-mobile` for comparison.
Source fixtures are not payment, protected-use, native, visual or promoted-main approval.
Independent source review found no blocking issue. The sole local verification,
`bun run --cwd apps/web typecheck`, passed on the committed implementation with no type errors in 1,163 files.
No tests, browser, Storybook, native or remote checks ran for this change.

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
and exact-money presentation are source-complete for this interface slice. Local
`bun run --cwd apps/web typecheck` passes with no type errors in 1,082 files; no other checks ran in this retry.
Native combined-journey proof and promoted-main completion remain separate obligations.

**Creator sales source and ordinary Web handoff.** The served `/creator/sales` route, signed-in BFF, minimal
accounting decoder, exact recorded-unit rows and statement/offer navigation are implemented against the
[selected private sales interface](../../services/kernel/src/commerce/README.md#private-creator-sales-history).
The native `commerceSales` producer/generated caller is absent in this checkout; the real route deliberately
returns unavailable through a typed port. No successful native response, complete zero, buyer information,
permission decision, payout or current offer availability is invented. Preparing pages retain their incomplete
meaning even with zero rows. No page/currency totals or buyer-order links are constructed. Captured old titles
remain visible without current offer mapping.

Web review IDs are `pages-commerce-creator-sales--{history,second-page,empty,denied,unavailable,error,stale,loading,
preparing,incomplete,unknown-unit,long-title,other-creator-same-route,other-creator-denied,mobile390,desktop1280,
actual-route}`. Review at 390 and 1280 in all eight locales, including long titles and the existing shell navigation.
These are explicitly constructed presentation inputs, not native recordings. `actual-route` preserves the actual
unavailable adapter rather than substituting a fake positive backend. Focused acceptance source is
`apps/web/tests/creator-sales.test.ts`; no native/browser/build campaign was run for this slice.

Controller/API/config handoff: deliver the selected native GET/default-20/max-100/signed-cursor envelope,
replace `unavailableCreatorSalesCaller` with the real generated no-store/manual-redirect GET, and confirm its actual
operation exposure. The root contribution uses exact `commerce_sale.list` admission while the binding is pending;
the existing `payout_statement.list` contribution uses its native selling group. The existing Web registration
bootstrap now shares the source scope helper with the deployment example; its exact mounted action set supplies
`commerce_sale:list` to registration and the matching authorization request when delivered. Auth rejects an
unmounted scope, and old consent/refresh is never widened. Deployment configuration and renewed consent are part
of that real-module switch, not facts implied by these stories.

Read-only reference source consulted: Ghost's indexed `content-gating.js` and `payments-service.js` under
`commerce-ownership/ghost/ghost/core/server/services/members/`, plus the retained reference index and adopted
Commerce research. No external source was copied or executed. Source delivery and local typing do not establish
native, privacy, protected-use, whole-journey, current visual or promoted-main acceptance; all remain pending.
Local `bun run --cwd apps/web typecheck` passes with no type errors in 1,156 files. The six focused acceptance
cases were written but not executed under the minimal verification contract. No separate build check was run;
route/localization generation is part of the existing typecheck command.

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

**Saved dynamic definitions.** The current adopted scope includes private create/read/edit at
`/library/rules/new` and `/collections/{id}/rule`, with native POST/PUT and a private native rule GET. The shared
filter composer preserves nested Boolean/catalogue conditions and adds released profile/state/session/holding and
current personal-label choices. Current curator/update plus all private leaf scopes/gates protect stored meaning;
private create, manual conflict reload retaining the draft, and the existing dynamic member reader remain separate
from explicit complete Publication output. Built-in rules stay immutable. The common execution producer remains
explicitly unavailable; no ready empty data or public live criteria is fabricated. Native whole-journey, privacy,
promoted-main and ordinary Web 390/1280 visual review remain pending. The obsolete shared scope-table deferral
awaits Root ownership; it does not defer this adopted definition journey.

**Progress / sessions.** [Library module](../../services/kernel/src/library/README.md) owns algorithms; [profile consumers](../library-profile-consumers.md)
own pin consumption. Delivered [abstraction research](library-abstraction.md) distinguishes rereads and sparse units.
The adopted [structure/version journey](library-progress-structure-journey.md) preserves manual history: exact scalar
values and captured totals, opaque cursor text, actual paged sparse IDs/cardinality and separate session identities.
Accepted profile pins identify original vocabulary and meaning; they do not verify content structure. Another version or reread starts an
explicitly selected new, empty session; abandoning the old session is separate and is not rolled back by a failed start.
Web's real start type/validator/form/POST now carries the existing native optional `versionSubjectId`, with selected
subject/version identities and the reference's limited scope visible before submission. Several sessions may remain active.
Detail retains lifecycle commands under their native authority, including when recording is unsupported/unavailable;
publication, entry state, copies and benefits remain independent. Withheld current summaries stay withheld.

The owner-detail presentation seam is adopted as `presentation=FULL` → `progressSession.presentation`, resolving the
original pinned meaning and advisory current input constraints. The native route's closed query and generated response
on this base still lack that seam. The consumer derives its aliases from the actual generated declarations and keeps
that opt-in binding unavailable; it reads existing FULL raw history without sending an unsupported query or resolving
today's definition as historic meaning. Positive known-meaning/current-pair fixtures and the complete acceptance journey
therefore await the native producer/declaration. No fake support/grant/pin substitutes for it.
Constructed native-declared raw-history stories cover scalar preservation at 390/1280, sparse `{1,3,7}` across actual
pages, opaque cursor text and withheld/unresolved summaries. Web owns their ordinary review; no additional capture
campaign is claimed. Verified structure, source-change detection, cross-edition conversion and reader resume remain
absent. Interface source and local typing do not establish native, whole-journey/privacy or promoted-main proof.

**Own published-log entry.** Source now exposes `/library/logs`, the missing personal entry into explicitly published
reading snapshots, through the existing `loadMyPublishedLogs`/`readMyPublishedLogs` owner reader. The signed-in shared
AppShell contribution uses native `published_log.list`; the existing Library navigation gains the same destination.
The native GET/FULL response supplies titles, covers, nullable subjects, recorded state/note/dates and signed next
cursors. No publisher selector, private session/change/unit reads, inferred progress, count or list mutation is added.
The raw list cast is replaced with the generated wire type. Native stale epochs restart once and explain the restart;
newest-page navigation clears the opaque cursor. Denied, unavailable and preparing never become a successful empty
page. Null subjects keep the shared neutral cover/title. Existing detail, publication and exact revision/Undo remain
their sole authorities. The new entry uses the existing session credential, private no-store and locale helpers.

Web's ordinary review receives `pages-library-my-published-logs--desktop`, `--phone`, `--empty`, `--long`,
`--unknown-subject`, `--denied`, `--unavailable`, `--preparing`, `--newest-page`, `--restarted` and `--signed-out`
(all suffixes use the same prefix). Review at 1280/390 with the eight locale and theme globals. Actual-route stories
derive opt-in consumer responses from `library-published-logs.json`; variations are constructed presentation inputs,
not new native recordings or grants. The signed-out story inspects the fallback; the actual route requires sign-in
before loading. Four focused source cases cover owner selection/hidden references, unsuccessful reads, native cursor
restart and route/navigation binding. Integration preserves the existing Context navigation and all unrelated
locale additions alongside the published-log entry. On the resolved committed implementation, local foreground
`bun run --cwd apps/web typecheck` passed with no type errors in 1,278 files; the four focused
`bun test apps/web/tests/library-my-logs.test.ts` cases passed with 137 assertions. No separate build or browser,
native, database or remote check ran. Story plays, ordinary Web visual review, native/privacy/runtime and
promoted-main proof remain pending.

**Copies / holdings.** Same module/profile authorities and delivered abstraction study; private owner-route copies,
`/library/copies` and `/v1/copies` exist independently of progress/state/payment rights. The existing row layout,
raw digital/physical/status values, history-unavailable notice and recorded covers remain the list baseline.
An explicit one-copy edit action now makes one current credential-bound native point read; loading the list does
not read each holding's detail. The editor keeps kind immutable, separates accepted labels/languages from current
status choices, preserves raw unknown values and distinguishes missing historic meaning, unavailable dependencies
and unsupported new status choices. Metadata edits omit unchanged status; a changed status must be a captured
native choice, and native validation remains decisive. Existing revision/key/CSRF and exact native delete/Undo
paths remain in use. A denied/concealed point response clears detail presentation while retaining the prior readable
raw list; transient failure keeps that raw view and does not imply deletion or retirement.

The generated `personal-routes.d.ts` on this base declares the existing point GET with `view=BASIC|FULL`, raw fields
and no `copy.presentation` or `presentation=FULL` query member. The producer seam is therefore **typed unavailable**:
it uses the actual raw detail once and never parses undeclared additions, invents pins/grants, looks up old labels
at the current head or sends a query the closed native schema rejects. Compile-time tripwires require replacing
that pending seam when the actual generated presentation body/query lands. No native Source, writer, authorization,
retention or profile-pin behavior is implemented here. The existing native metadata-only wire is used as declared;
its current validation failure stays visible without resending a historical status or repinning in the UI.
Fresh-copy choices remain separately resolved from the actual active release/subject, with no People/Concept defaults.

New focused source acceptance in `copies-historic.test.ts` covers one point read, unchanged list request counts,
same-edition identities/original facts, unknown versus unavailable, ignored undeclared meaning, denial/failure,
immutable kind, captured status choices and metadata-only/revisioned writes. It is written but not executed.
The positive metadata fixture uses the actual generated raw point/PATCH DTO, with no synthetic pins or grants.
Accepted-label/current-choice views are explicitly bounded constructed form inputs, not a positive native adapter.
For Web's next ordinary 390/1280 review, new `Pages/Library/Copies` exports are `HeadRenamedPairRetired`,
`KnownHistoricalLabels`, `UnknownLegacy`, `RequiredReleaseUnavailable`, `DeniedDetail` and `ExactCapturedStatusEdit`.
Every existing story play, including the real-cover/raw-digital `ManyCopies` play, remains unchanged. No capture, browser, Storybook, native/database/remote
or full test campaign is claimed. Actual accepted-label production remains unavailable until the generated native
presentation producer lands; ordinary visual review and native/promoted-main proof remain pending.

Implementation decisions: an explicit native 404 is treated like concealed detail denial, never deletion evidence;
a transient failed inspection cannot reuse old current-status choices; write responses without presentation keep
new status text raw rather than borrowing a current label. Outside the declared paths, `copies-actions.ts` adds the
existing server-function binding and stops attaching current profiles to historical rows. The shared candidate
tombstone filtering, explanation guards and terminal consent handling already present in the current base remain unchanged.
Read-only reference source:
main `.reference/INDEX.md`, `shelves/bookwyrm/bookwyrm/models/shelf.py` and Bangumi's
`shelves/bangumi-server/openapi/components/user_subject_collection{,_modify_payload}.yaml`; no reference code copied.
Local foreground `bun run --cwd apps/web typecheck` passed on the committed implementation with no type errors
in 1,325 files. This is the only verification for this source slice; the new acceptance tests and story plays remain unrun.

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

**Selected saved-dynamic publication interface.** `/collections/{id}/publish` consumes the existing private owner
Collection/members reader, retaining the actual header revision, original source IDs, disclosed canonical summaries
and supplied catalogue facts. Only the displayed page is selectable; canonical duplicates select one subject, while
curated occurrences and notes retain their separate meaning. There is no all-matching-IDs read, hidden-page selection,
query editor or snapshot-all promise. The maximum explicit selection is 100; zero requires deliberate empty intent.
Source IDs and facts are forwarded only for disclosed members in the private owner editor read; ordinary dynamic
pages retain their existing summary-only boundary, including omission of withheld original IDs.
The owner-menu integration exports typed `PublicationLink` without conferring authority.
The route uses the existing `$id_` filename convention to avoid inheriting the public Collection loader or renderer.

The BFF sends only `{revision,subjectIds}` to the declared native
`POST /v1/collections/:collectionId:publishSelected`, with current session/CSRF and the original idempotency key.
The generated native method is absent on this base; the typed exact-route adapter has no positive fallback and
an unconfigured runtime stays unavailable. The existing real Source reader may also return unavailable or preparing;
neither is empty. Native source/owner/account/original-and-terminal authorization, consent, source generation and
atomic two-generation output remain producer authority. The adapter cannot supply these checks or implement Source.
Only a validated native complete response displays Published. A failed or uncertain new selection retains the
previous completed response separately; reload makes no stored-output claim. Unknown results lock selection and
retry the identical payload/key; 409 requires manual reload and reselection. Public viewing still decides current
per-subject disclosure. Private criteria/reading facts never enter the publication request, and no grant, purchase
entitlement or source URL is created.

Focused consumer cases and six stories cover explicit empty/nonempty selection, denied, stale, Source unavailable
and uncertain retry using recorded subject summaries; they provide no positive native publication provider. Actual
native publication, full snapshot/whole-query privacy and whole-main proof remain pending. Web owns the next ordinary
390/1280 review; this source delivery does not establish visual, native, protected-use or promoted-main acceptance.
Local `bun run --cwd apps/web typecheck` passes with no type errors in 1,156 files. The focused tests and story plays
were added but not executed; no unit, native, browser, database or remote checks were run for this interface slice.

**Follows / private owner counts — shared Accounts ownership.** Edge authority: [Library module](../../services/kernel/src/library/README.md);
count authority: [private follow counts](../private-follow-counts.md); delivered [simplification research](follow-counts-simplest.md).
Follower-partition edges, implied/explicit precedence, `/library/following` and `/v1/follows` exist. Counts are designed,
not exposed: own outgoing total stays follower-local; canonical pair/support/total resides in the target partition.
Accounts owns management evaluation, account-agent resolution/state and effects admission; Commerce owns projections/maintenance;
Semantic identity/kernel health are prerequisites. Proposed `/v1/followCounts/:targetType/:targetId`, aggregate/readiness, lifecycle and native driver remain pending.
**Handoff:** where should eligible managers see private ready/unready counts with current grants and suspension/erasure updates, without another person's outgoing list or a public total?

**Shared handoff.** Deliver the adopted exact Content-edition producer and subject discovery's actual native binding through existing
Access; do not introduce a second permission engine or label research sketches as delivered signatures. Library
journeys continue under their existing sole behavior authorities and the separate owner brief. These ownership
changes preserve the commerce manager scope and every original native/interface/main obligation.

**Limits and custody.** Read owner deliveries and route/UI seams; the local interface checks above are the only new
verification. No independent native/code audit, runtime or promotion check. Named owners and existing Web producers are handoff responsibilities, not claims of live task registration or delivery proof.
The delivered reports and existing owner sources supply the design evidence; no new audit is introduced.
The linked Stripe fulfillment variant could not be fetched; no fulfillment-detail claim relies on it. REZICS eligibility is unknown.
Read-only references: main `.reference/INDEX.md`; `shelves/bookwyrm/bookwyrm/models/shelf.py`, `LICENSE.md` (Anti-Capitalist Software License 1.4);
`shelves/bangumi-server/openapi/components/user_subject_collection{,_modify_payload}.yaml`, `LICENSE.txt` (AGPL-3.0), at indexed revisions. Shelf/tag evidence only; nothing copied/executed.
