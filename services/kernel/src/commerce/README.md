# Commerce

Commerce owns the purchase journey: offers, captured orders, payment evidence, account-bound benefit entitlements
and attributed creator royalty statements. This is the current owner contract, adopted from the delivered
[ownership and benefits research](../../../../docs/research/commerce-ownership-entitlements-benefits.md) and
[payment evidence research](../../../../docs/research/commerce-payment-evidence-settlement.md).
Research is evidence; this document owns purchase behavior. The [Commerce Goal](../../../../docs/goals/commerce.md)
owns delivery, native acceptance and promotion requirements. [Library and Collections](../../../../docs/library-and-collections.md)
owns personal facts; the separate [Library Goal](../../../../docs/goals/library.md) retains those obligations under
the same commerce manager. [Future modules](../../../../docs/commerce-modules.md) owns the unimplemented financial
module map. Specified behavior, source presence, native proof and delivery on main are separate states.

## What is bought

Keep these identities separate:

- A **subject** is the public catalogue identity, not protected content or authority to sell it.
- An **offer** is a creator-owned acquisition proposal with a revision, price and terms.
- An **order** records one buyer's accepted, immutable offer terms and acquisition intent.
- **Payment evidence** records provider observations and financial movements; it is neither an entitlement nor cash
  available to pay a creator.
- A **benefit** identifies exactly the promised target, action and immutable delivered version. A purchase-derived
  **entitlement** records that buyer's current eligibility for that benefit through existing Access.
- Library states, copies, labels, progress, Collections and follows are independent personal facts.
- A future **transferable item** has its own identity and ownership generation. Today's licence is not such an item.

The first sale is one-time, account-bound, **one immutable fixed-version benefit, quantity one**, at a positive price.
No bundles, gifts, subscriptions, consumables, wallet, issued token/points, market, exchange or ledger implementation
is included. This adopts the research's fixed-version recommendation without adopting its illustrative benefit-kind
union, update-channel promise or proposed shared API signatures. There is no general benefit-kind registry to build.

The creator home owns the immutable captured Content-edition terms alongside its offers; Content owns the actual edition definition and publication. Its immutable version must identify the subject,
exact owner resource/version, adopted action, delivery promise and accepted terms. Offer publication needs both
Commerce selling authority and the target owner's current authority to license that target; an offer grant or a
subject reference alone is insufficient. Accounts owns the Access mechanism and the target owner owns final use.

An order captures offer ID/revision, creator, subject, title, currency, unit amount, tax code and royalty basis.
The benefit extension must also capture the exact benefit/version, quantity, target/action and terms/delivery
promise. Repricing or delisting changes future acquisition, never captured terms or a paid order's identity.
Current account eligibility, target availability, rights restrictions and takedown remain separate current facts.
Historic subject-only orders have **UNKNOWN benefit mapping** until an explicit authorized creator/target-owner
mapping is adopted and recorded. Show “purchase recorded; benefit unavailable” rather than grant all subject content.
Buying creates no Library copy, state, progress or public activity; Library Undo cannot reverse payment truth.

## Journey, APIs and native homes

Commerce delivers its journey pages with Web's shell, shared UI and patterns. Web owns navigation, design-system
patterns, Storybook organization and visual review; its existing checkout/history producers remain handoffs to
integrate, not duplicate rewrites. Shared subject-page changes coordinate with its owner. Every journey needs real
API/storage behavior plus reviewed pages; an interim fake or an entitlement row is not final-use proof.

| Person's step                      | Existing surface and remaining work                                                                                                                                                                                                                                                                                                                                   | Native authority                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find a benefit on a subject        | The declared subject-offer page and shared public/private entry are described below. The generated producer binding is unavailable in this base. Public descriptions and private ownership use separate responses/cache keys.                                                                                                                                         | Semantic owns subject identity/disclosure; creator homes confirm exact active offer/benefit keys. No all-creator or buyer scan.                                                                             |
| Find a benefit on a subject        | `GET /v1/subjects/:id/offers` supplies eventual positive discovery with current native confirmation, as specified below. The Subject slot still needs integration and reviewed native journey evidence. Public terms contain no ownership state.                                                                                                                      | Semantic owns subject identity/disclosure; creator homes confirm exact active offer/benefit keys. No all-creator or buyer scan.                                                                             |
| Review the offer                   | `GET /v1/offers/:offerId`, existing `/offers/$id` page. Add the captured benefit/version, delivery promise and terms display using the adopted native target.                                                                                                                                                                                                         | Creator home; `offer:read`, `gate:purchases`, subject disclosure separately. Delisted public reads match unknown `404`, even for the seller, before subject-summary reads.                                  |
| Accept and pay                     | `POST /v1/orders` requires `{offerId, expectedOfferRevision}` and the idempotency header. The positive integer revision comes from the displayed public offer read. Changed terms require explicit reload/review and new consent; unresolved retries retain their original intent. No fresh Checkout is available while the Content authority adapter is unavailable. | `order:create` on the offer, `gate:purchases`, verified active buyer; buyer-home order/receipt before provider I/O. Selling/target authority is confirmed through owner ports, never a cross-home SQL join. |
| Return and find the purchase later | Existing `/orders/$id`, `/orders`, `GET /v1/orders/:orderId`, `GET /v1/orders`. Display captured terms, pending/unknown honestly and link current entitlement. Redirects have no fulfilment power.                                                                                                                                                                    | Buyer home; actor equality and `order:read`. No arbitrary buyer selector, including accounts sharing a route.                                                                                               |
| Inspect owned benefit              | `GET /v1/entitlements` and `GET /v1/entitlements/:entitlementId` exist. Complete private owned-benefit navigation and detail with mapped benefit/version, active/revoked/unavailable explanation and a disclosed use link.                                                                                                                                            | Buyer home, authenticated owner and `entitlement:read`; other owners supply permitted target summaries. History or a cached entitlement response grants no use.                                             |
| Actually use it                    | Target-owner page and protected server endpoint must enforce existing Access with current exact-benefit eligibility. The exact edition/action/version is adopted; native producer and Access use integration remain pending.                                                                                                                                          | Buyer home supplies current eligibility; target home owns resource/action/lifecycle and final protected serialization or delivery. No second Access engine.                                                 |

Creator minimums are an offer/benefit editor and owned-offer list, a bounded private sales view, and statement/detail
views. Existing HTTP mutations are `POST /v1/offers`, `PATCH /v1/offers/:offerId` (price), and
`POST /v1/offers/:offerId:delist`, under `offer:create`/`offer:manage` and `gate:selling`.
Owned-offer listing is `GET /v1/offers`, described below. The offer/benefit editor,
benefit publication/versioning remain incomplete. The creator-sales source implementation is described below. Creator-home sales projections use stable buyer-order effects,
show lag/unknowns and only necessary accounting/order locators, not buyer email, Library activity or use telemetry.
They cannot authorize use or establish complete provider settlement. Existing statement APIs are
`GET /v1/payoutStatements`, `GET /v1/payoutStatements/:statementId`,
`GET /v1/payoutStatements/:statementId/lines` and `POST /v1/payoutStatements/:statementId:markPaid`, with the existing
`payout_statement:list/read/mark_paid` checks. A statement read grants no arbitrary buyer-order access.

### Subject offer entry

The selected discovery interface is `GET /v1/subjects/:id/offers`, with an opaque `cursor`, default limit 10 and
maximum 20. Its closed response is `{offers,next,projectionState:'ready'|'preparing'}`. Each public offer contains
`id,targetSubjectId,title,currency,unitAmountMinor,moneyUnit,taxBehavior,revision,contentEdition`, where the final
field is the existing sanitized fixed-edition terms DTO, nullable for unknown historical mapping. Recorded money
and tax metadata remain nullable. Discovery is eventual positive evidence, never a count or completeness promise.
Current native disclosure, exact offer confirmation and creation target authority remain the source authorities.

Web's `checkout/subject-offers.ts` exports `SubjectOffersApi`, the closed reader and
`nativeSubjectOffersApi`, bound to the generated `KernelClient.subjects({id}).offers.get` caller. Its page, query
and options types derive from that caller; a missing body never becomes ready/empty. The BFF preserves the actual request
credential and named native refusal, uses private no-store, and reads one bounded page without per-card lookups.
Native original/terminal identity confirmation owns directory membership; Web preserves each returned offer's actual
captured target and validates its terms against that target, without rewriting it to the requested Subject.
The illustrative `kernel.local` transport explicitly returns 503 until an actual native page can be recorded.
The served offer review now also carries current credentials and preserves named denials; it retains the existing
observed revision, consent and uncertain-creation retry path.

`checkout/subject-purchase.ts` exports `SubjectOffersRegion`, `SubjectOwnedBenefitsRegion` and the immutable
`subjectPurchaseRegions` configuration. Root passes it through `AppShell.subjectPurchase` and the existing shared
`ComponentType<{subjectId,subjectType,locale}>` seam. Public discovery waits for hydration/session preparation;
actor/session-bound browser queries cancel and discard old responses on session change. No personal query or opaque
entitlement fact enters shared SSR data. Native denial/unavailability/preparation and a successful page with no
listed offers remain separate. Exact known recorded prices, fixed-version/quantity-one terms and known exclusive
tax wording lead to the actual `/offers/{id}` review; no slot interaction creates a charge.

The private region mounts through the shared signed-in seam and links to the existing own `/entitlements` records.
There is no declared bounded native owned-benefit batch in this base, so it fetches no ownership list, makes no
owned/absent claim and never infers entitlement from Library. The existing entitlement detail alone links mapped
active benefits to `/editions/{benefit.resource.id}`; Content's guarded reader remains responsible for final use.
Constructed public-wire stories and interface acceptance source cover these states. Native whole-journey, privacy,
protected-use, visual and promoted-main proof remain pending.

### Positive subject offer discovery

`GET /v1/subjects/:id/offers`, operation `subject_offers.list`, reuses the native Subject `id` segment,
`subject:read` and `gate:purchases`. The only query fields are signed `cursor` and `limit` (default 10, 1–20).
It returns exactly `{offers: PublicOfferCard[], next: string | null, projectionState: 'ready' | 'preparing'}`.
`PublicOfferCard` is `{id,targetSubjectId,title,currency,unitAmountMinor,moneyUnit,taxBehavior,revision,contentEdition}`:
unit/tax metadata remains actually nullable, and `contentEdition` uses `contentEditionTermsView`, including only
`source.licence`. It contains no thread/post IDs, body, native receipt, buyer selector, owner selector or owned bit.
A displayed title or price grants neither sale permission nor protected bytes. Every response defaults to
`private, no-store`; signed-in named denials never fall back to an anonymous request.

[Subject offers](subject-offers.ts) uses Semantic's published `readIdentityMappings` and
`readCurrentSubjectSummaries` producers for actual current original and terminal disclosure, before and after
point confirmation. Pending/unavailable identity is preparing or typed unavailable, never guessed self/absence.
Each request examines at most 20 raw reference rows, and rejects consume that allowance. The expiring signed raw
cursor binds operation, requested Subject, actual terminal/identity epoch, directory owner epoch and ordering.
A full raw page can return an empty `offers` array with `next`; there is no post-filter first-N or completeness claim.
There is no total/count, private ownership query or buyer scan.

Commerce owns one subject-home `subject_offer_reference` directory of offer IDs, original Subject IDs, source
revisions, Semantic identity epochs, live CAS versions and listing tombstones. It stores no prices, Content payload, permission,
private Actor, credential or eligibility criteria. Creator-home offer rows remain truth. Each positive point reads
its current active creator and unfenced native source, exact active offer/revision/immutable association, current
`offer:read` through native Access and the existing active public terms floor, current Subject disclosure and
Content's actual caller-aware sale authority (which also restores the publisher's mechanical sale authority).
Source, identity and disclosure are confirmed again before return. Null UNKNOWN historical captures are never mapped.
No prior directory observation, old approval, receipt or capture authorizes delivery. Content retains final byte authority.
These are sequential bounded observations after independently releasing each home, not a cross-home snapshot.

The default [projection worker](subject-offer-work.ts) consumes the SAME native offer created/revised/delisted
outbox events, even with Stripe unconfigured. Duplicate/out-of-order events reread current creator-home source;
source revision and live reference-version CAS reject older writes. Semantic epochs are compared for exact current
proof, never ordered across independent control homes. Delisting and indexed moves retain minimal CAS tombstones;
an older writer cannot overwrite a completed move, and failed final proof retires only its own written version.
The default bounded recovery service pages at most 100 raw offer keys on one actual source home through
`offer_discovery_source`. One scalar `home/offerId` frontier and version CAS checkpoint independently of released
source and destination homes; a changed source/identity or owner epoch cannot advance a successful step. Empty
home exhaustion is local source progress, never custody completion. Late inserts behind the frontier have their
ordinary native outbox effect, and repeated recovery passes revisit retained mapped rows. Semantic's actual
published identity events and `identityEpochStore.pageChanges` drive indexed original-reference moves; no second
mapping engine, all-original sweep or identity participant ACK is introduced.

`preparing` means initial/recovery completeness is unavailable. Individually current confirmed positives can still
be returned. `ready` means only that a native directory bootstrap pass has completed, never complete current offers,
Semantic Scope70/FAA, Search, Source, paid eligibility or current Content/use readiness. A missing bootstrap record
stays preparing; missing/moved/fenced directory storage stays typed unavailable. This positive index cannot answer
negative authority, catalogue counts or current complete membership.

The directory participates in Commerce's existing financial source inventory as derived offer-key copies. Native
source creator/account fences are checked before and after projection and again on reads; terminal creators supply
no visible offer. References carry only the immutable source locator, never party payload or a cached Actor. Their
foreign subject-home cleanup/custody remains part of the existing unresolved financial-role inventory: neither
queue dispatch, recovery exhaustion, timer nor an identity move acknowledges private/shared custody. No retention
exception, erasure completion or new financial destination ACK is claimed. Existing owner retention/economics and
all native privacy/physical/whole-journey/main obligations below remain in force.

The focused acceptance is `test/commerce/subject-offers.test.ts`. Source delivery and typing do not establish
native sale, protected use, privacy, reviewed Subject slot, whole-suite acceptance or promoted-main completion.

### Private creator sales accounting

`GET /v1/commerceSales` publishes operation `commerce_sale.list`, the exact `commerce_sale:list` consent/action,
`gate:selling`, nonanonymous `own-account` authority and `access.account` resource type. It evaluates the existing
Access formula on the actual actor account before the native read and again after leaving its snapshot. Principal,
current consent, assignment, account floor and denials remain with Accounts. There is no new grant, role, client or
evaluator. Neither a buyer nor another creator can be selected, including a creator sharing the actor's route.

The exact response is `{sales: CreatorSaleView[], next: string|null, projectionState: 'ready'|'preparing'}`.
`CreatorSaleView` has only `orderId`, `offerId`, `title`, `targetSubjectId`, `currency`, `unitAmountMinor`, nullable
captured `moneyUnit`, `taxBehavior: 'exclusive'|null`, `settlement: 'pending'|'paid'|'failed'|'unknown'`, and `createdAt`.
These locators and captured terms describe historical purchase settlement. They reveal no buyer account/email,
current Library, reading/use telemetry or entitlement fact. Historical `paid` does not establish cash availability,
creator payability, net refund finality or a full refund. Statement adjustments keep their separate actual source;
there is no public aggregate, FX conversion or currency summation.

The private no-store page seeks `(route, creator_account_id, order_id)` in the one native creator-home derived
`creator_sale` source. It defaults to 20, caps at 100 and 256 KiB, and signs a descending keyset bound to viewer,
operation, view/order, requested limit and native creator-home epoch. Buyer-home order IDs may carry another route.
Current native partition/session fences apply before and after the read. No buyer source fanout occurs on GET.

Default Commerce composition, including an unconfigured Stripe worker, admits actual committed order-created and
order-updated events through existing native effects. Admission verifies the exact log slot; native
`creator_sale_receipt` and `creator_sale_work` locators remain pending after dispatch. A fresh exact admitted
`purchase_order` read, native revision/transaction and its current actual write-basis/outbox provenance supply
financial truth, never copied event JSON. The source snapshot is released before a creator write. The local DAO
fences the native creator account, rejects immutable-term conflicts and only advances a lower source revision;
duplicate/late events cannot roll it back. It creates no command receipt, financial event or second order authority.

Initial/recovery work uses existing maintenance workflows/schedules and an epoch-bound native partition/key
frontier. Each bootstrap step admits at most 100 raw order keys; a separate delivery step processes one exact pending locator. No GET scans
buyer history, counts rows, uses offset, or drives bootstrap. Exhausting that frontier proves only local key coverage.
Missing transaction or current-revision event provenance defers that exact work generation with a named gap and
retry time, so other due locators can progress. A newer admitted generation cannot be delayed by that older proof
failure. A fenced foreign live-copy home defers the same source work generation with
`commerce-creator-sale-live-copy-home-unavailable`, its observed revision and retry time. Any partial holds and
committed receiver result remain untouched for exact recovery; the gap is neither cancellation nor an ACK. A
fenced source home still fails the step, since it cannot commit even that pending checkpoint. Infrastructure
errors also fail rather than being treated as missing proof. The pending update is the same indexed work-key/
generation CAS used for unavailable source provenance, with no additional scan or receiver write.
The closed History receiving APIs continue to certify erased artifacts only. The default Commerce factory now
installs the separate [native live-copy transition](../access/README.md#native-live-business-copies): the buyer-home
source transaction stages the exact business/event/transaction/revision and native work generation, original role
roster and receiver incarnation, together with local role holds. Other role homes are admitted individually after
release. The factory observes all durable admissions and releases those checkouts. The creator transaction then
locks its current account, arbitrates the exact receiver gate, and commits projection, inverse inventory and immutable terminal result together. Source connections
are released before receiver work; receiver connections are released before exact hold consumption. Cancellation
and first apply use the same native key. A late event cannot reopen a terminal effect or rewrite an equal revision.
A native projection trigger additionally binds every insert/update, including old prepared DAO calls, to the exact
current-transaction open gate and immutable financial payload. A newly admitted event advances the native work generation by CAS; it cannot manufacture financial revision truth.

`access.liveCopy.recover`, installed by the default Accounts erasure WorkModule, recovers maintained pending keys,
including a crash before enqueue or after receiving commit. Its inputs contain only native partition/frontier
coordinates. The existing raw100 buyer frontier remains; missing original provenance or temporarily fenced buyers
leave its exact native frontier pending with a retry time. A scheduler yield is not covered state. GET never drives
this work. `projectionState` remains `preparing` while historic or complete cross-home coverage is unknown, including
on an empty page. Verified rows may be shown. Dispatch, a timer, a complete local key frontier and an immutable
receiver result each have their own meaning; none supplies a complete accounting coverage certificate.

Bounded creator-home recovery also revisits one historic sale row per step through the same authentic source and
receiver adapters. Missing original proof retains coverage debt; a terminal buyer allows only exact negative legacy
removal. Accounts discovery cannot seal an unknown historical role frontier.
Source work and original event receipts have their own raw1 primary-key role-coverage frontiers, independent of
the creator-row frontier. A retained receipt requires its exact original native event and role basis, even after
the order advanced to a later revision. Missing original proof keeps that precise frontier pending. New source
intents require native buyer/creator inverse inventory and a locked active buyer at deferred commit; native update
guards preserve their original keys. After actual buyer T, coverage can only delete exact old work or minimize its
receipt, and only after its exact pending-transition check. No new personal intent is admitted by this cleanup.

The producer enrolls source transition/roster, each role hold, actual creator row and receiver payload under every
retained native personal role. Exact source work and event receipts have separate role-first inverse locators.
Accounts' existing bounded discovery seals each visited home before paging and minimizes these copies independently
of financial participant readiness. If historic role coverage prevents that seal, a bounded known-key page still
minimizes enrolled copies under the original native root, without advancing discovery or claiming closure. The
ordinary sealed page retains the same minimizer:
terminal holds first, payload before inverse removal, and source work only after
its pending transitions resolve. Receipt minimization retains only the original event slot/identity for duplicate
refusal. Permanent source digest and receiver/role terminal tombstones bar replay after personal payload removal;
the full native effect keys are compared before any positive effect, including a digest match. A retired digest
collision refuses rather than joining effects. Existing bounded `purgeSales` remains in Commerce erasure too.

Original core outbox, command receipt, write-basis, durable work and record custody retain their independent owner
obligations. The financial participant and shared event owner still report their genuine pending qualifications;
this live-copy result is neither a History receipt nor an all-copy/financial ACK, retention exception or payability
rule. No Actor, JWT or allow assertion is serialized into this work. Native/physical/privacy/protected-use,
whole-suite and promoted-main proof remain deferred; source delivery and typing establish none of them.

The internal checkout record, refresh and apply writers intentionally omit actor write-basis attribution. Their
actual `core.receipt` commit is the source adapter's selected provenance for that exact native order transaction,
buyer-owned receipt, epoch and outbox position. Two narrow unique partial indexes seek those three command kinds
by transaction or position. No receipt response supplies financial truth: the current native order and its exact
committed revision event remain mandatory. Ordinary actor writes use their original native write basis and
principal plus original event-role inventory; delegated attribution with missing native role inventory is pending,
never interpreted as an Account id. Internal receipt ownership does not create a worker principal or Access grant.
These provenance reads leave financial retention and the shared receipt/outbox minimizer qualifications intact.

### Private creator offer history

`GET /v1/offers` is `offer.list`, exact scope/action `offer:list`, `gate:selling`, nonanonymous,
with `x-authority-anchor: own-account` and `x-authority-resource-types: [access.account]`.
The actual mounted action catalogue supplies the existing own-account Access operand on the verified acting
account, never an owner query parameter. Clients must register and obtain consent for `offer:list` explicitly;
first-party status or an older offer scope supplies no consent. A distinct principal still needs its independent
current formula operand. No role, grant, source writer or alternative authorization mechanism is added.

The closed response is `{offers,next}`. Each seller row contains exactly
`{id,targetSubjectId,title,currency,unitAmountMinor,moneyUnit,taxBehavior,taxCode,royaltyBasisPoints,state,revision,contentEdition}`.
`contentEdition` is the actual sanitized `contentEditionTermsView` or explicit `null` for UNKNOWN historic mapping.
It never includes native source thread/post IDs, revision bodies, transactions, receipts or other account metadata.
Captured title/terms remain readable when the current target is unavailable; they assert neither current sale
eligibility nor permission to read bytes. There is no Content or subject HTTP fanout or foreign metadata join.

One fenced `REPEATABLE READ` page seeks the exact `(route,creator_account_id,offer_id)` index with native actor
equality, descending exclusive offer-ID keyset and `limit + 1` bound. Default limit is 20, maximum 100. No count,
offset, filtering walk or all-creator scan is used. The signed cursor binds `offer.list`, acting account, route,
seller-terms view/version, ordering and partition epoch; page size may change. Current Access runs before private
SQL and again outside the snapshot before serialization, alongside final partition/epoch and session-position
fences and the fixed request deadline. Missing/fenced/moved source is unavailable, never an empty list.
Both ACTIVE and DELISTED offers appear. Public `GET /v1/offers/:offerId` still conceals DELISTED offers.

The served `/creator/offers` route uses `requireSignedIn`, private no-store BFF reads, current credentials, signed
pagination, retry/restart, unavailable/empty and explicit UNKNOWN states in all eight locales. Shared `ListRow`
and exact minor-amount formatting keep each currency separate. Active rows link to the existing public offer
page when `offer.get` is currently admitted; that page rechecks disclosure. Delisted rows are history without a
Checkout link. Root navigation adds the immutable `commerce.creator-offers` personal signed-in contribution at
order 15 for `offer.list`.

Caller seam: `loadCreatorOffers` / `readCreatorOffers` in Web's `checkout/creator-offers.ts`.
The generated client in this base has no `offers.get`; the authorized exact typed unavailable adapter is used,
without hand-editing generated declarations or inventing a public-read substitute. Controller API/client generation
must replace that adapter with the actual generated binding. Stories `pages-commerce-creator-offers--history`,
`--second-page`, `--empty`, `--denied`, `--unavailable`, `--error`, `--stale`, `--preparing`, `--long-title`,
`--mobile390` and `--desktop1280` describe contract-shaped source states, not recorded native evidence.
390/1280 browser visual review, native acceptance and promoted-main proof remain controller work under minimal
verification. The private-sales source producer is described above; target use and native sale/use proof remain open.

### Served creator sales

The served `/creator/sales` page calls `kernelClient().commerceSales.get` through
`checkout/creator-sales.ts`, using the existing signed-in BFF, `prepareSession` and `viewerCredential`.
Each call uses `cache: no-store` and `redirect: manual`; both the route and response prohibit private retention
and indexing. The server prepares a session once, binds the normalized cursor and subject to the page, checks
the advertised Sales operation under selling exposure and uses the same credential for both native reads. The existing current-origin
observer retires reads synchronously on viewer, admission or locale/cursor replacement, including ABA before
React commits. Healthy same-viewer credential renewal can retain an accepted read but never an in-flight result.

The existing list/card family renders captured titles, separate recorded currency amounts, explicit historic
unknowns, signed continuation, retry/restart and genuine denial/error/stale/unavailable outcomes. Preparing can
show verified rows but never claims completed zero sales. Rows add neither guessed offer links nor buyer-order
links. `/creator/offers` and `/creator/statements` retain their separate management and royalty destinations.
The mounted catalogue and existing website registration/request helpers supply exact `commerce_sale:list`;
old consent and refresh tokens never widen themselves. Kernel exposure uses `gate:selling`; website navigation requires the advertised `commerce_sale.list` operation.

The native endpoint DTO is authoritative. The existing transport uses a narrow consumer-local typed bridge while
canonical bindings are unavailable. The controller regenerates OpenAPI and the client after
mounting the endpoint; the unused standalone `creator-sales.d.ts` is not an alternative contract. Source delivery,
constructed Web responses and permitted workspace typing establish no native, privacy, browser, physical or
promoted-main acceptance. Original acceptance remains required after integration.

A current refresh that returns a different viewer or address is unavailable. It replaces the accepted page and
continuation, including the retained same-viewer workspace, so a later healthy credential renewal cannot revive
the old sale. Initial loader data seeds the query once; it is never a fallback after a completed refresh.

The canonical compiler's `typecheck --emit-client` composes mounted native routes into the generated client using
the same admitted compiler database. This is declaration emission, not a substitute transport or a second DTO.
The exposure read advertises `commerce_sale.list` only when that mounted operation is visible through the existing
`gate:selling` discovery. Group admission alone never enables Sales navigation; the frozen Web assertions remain valid.

### Adopted native Content edition and delivery state

The first target is native `content.edition`, action `edition:read`, naming an actual authored Content post revision
by `{revisionId, sha256}`. Edition ID, source tuple, creator and immutable revision licence never retarget. Creating
another edition is necessary to sell another revision. Images, origins, URLs, Library copies and generic subject
permission are not this product. The selected edition must have an actual native subject binding; an unrelated
public subject cannot relabel it. Fresh `POST /v1/offers` accepts `contentEditionId` and ordinary commercial terms,
not client-supplied benefit/source/version/creator/licence/action/subject or a sale-authority boolean.

Content owns immutable edition creation/publication and the sole current sale port
`content/edition-sale.ts:readContentEditionSaleAuthority`. It must establish authenticated creator equality with
both native post/revision authors, current `edition:sell` and `post:revise`, exact source/digest/licence, active
account, creator-readable current ancestry, and available published or explicitly protected source. A delegated
publisher, moderator, imported author field or ordinary grant cannot establish authorship or copyright. This
metadata is a declared licence, not an exclusive rights claim. Commerce does not implement that verifier.

The canonical closed benefit type is `ContentEditionBenefit` in
[Accounts](../access/authenticated-benefit.ts); [model](model.ts) re-exports it. Commerce's captured DTO is:

```ts
type CapturedContentEdition = Readonly<{
  benefit: ContentEditionBenefit;
  creatorAccountId: string;
  targetSubjectId: string;
  source: Readonly<{ threadId: string; postId: string; licence: string }>;
  saleTermsReference: string;
  delivery: 'fixed-content-edition';
  acquisition: 'one-time-account-bound';
  quantity: 1;
}>;
```

`contentEdition` on offer/order/entitlement HTTP reads is this object with `source` projected to `{licence}`
(or explicit null). Source thread/post IDs stay internal; Content alone discloses source metadata with current
native authority. The public terms DTO never contains a revision body. Creator/title/subject,
offer revision, accepted currency/price/tax/royalty terms remain captured by the existing order fields. Capture is
stored atomically in creator-home offer and buyer-home order/entitlement rows, never an authoritative cross-home
join. The JSON is bounded to 4096 UTF-8 bytes; licence/terms reference are at most 256 characters each; revision
body is forbidden. Immutable SQL guards include null historical mapping. No migration infers an edition from
subject, newest revision, label or payment metadata. Historical reads/authorized receipt replays retain identity;
a new subject-only create cannot silently create a benefit. Price changes never change the capture.

**Native sale source and Commerce binding.** [benefit](benefit.ts) imports the exact
`readContentEditionSaleAuthority({pool, access, clock?}, editionId, {actor, deadline})` and server-only
`readContentEditionMechanicalSaleAuthority({pool, access, clock?}, editionId, {deadline})` owner entrypoints.
The [Content module](../content/edition-sale.ts) supplies the bounded native verifier, restoring the real original
publisher independently for `edition:sell` and `post:revise` using current Auth consent. Commerce manufactures no
seller/buyer Actor.

The default [worker](work.ts), reached through [its registered module](work-module.ts), constructs its existing
commands with `context.getAuthorization().access`. Accounts owns
[`WorkerAuthorization`](../work/authorization.ts) and the lazy getter, memoized once per actual `WorkContext`.
Its factory captures the existing kernel's Access only after mounted action/role validation through
`createKernel.onAccessReady`, with the same current native Auth consent reader supplied to Content. Commerce
retains the complete context and its pool/client/clock/registries; it creates no Access root, action map, listener,
pool, client or work engine. The mechanical sale wrapper supplies no delivery Actor, and the native buyer fact
reader never calls Content. Missing genuine authorization configuration is typed unavailable, never an empty or
permissive Access fallback. The Accounts factory body and registry getter remain a producer dependency; their
absence in this source checkout does not establish native paid fulfilment or protected use.

`captureContentEditionSaleAuthority` copies only the native benefit/creator/subject/source/licence and rejects
inconsistent source revision/hash or edition identity. `saleTermsReference` is a JSON tuple of the actual native
edition ID, immutable revision ID/hash and publication `editionRevision`. It is a publication reference, never a
permission token. `sameCapturedContentEdition` compares every immutable field, including that reference. The
`captureCurrentContentEdition` / `requireCurrentContentEdition` helpers use the actual request Actor;
`requireMechanicalContentEdition` uses only Content's mechanical entrypoint for trusted order work.

The private `withSalePreparation` composition in [commands](commands.ts) forwards parent `prepare`, `authorize`
and `finalize` with the exact original evidence, preserving the creation registry and account floor before receipt
disclosure. Content I/O runs after parent preparation and before resource checkout, once per physical command
attempt. An opaque in-memory handle binds its result/error to that exact attempt and native transaction. Known
fresh-target refusal/unavailability is retained until the fresh body, so normal currently authorized exact receipt
replay can return history without another sale. Successful preparation is bounded to at most one second and never
stored as permission in a receipt. The body compares the immutable binding and native buyer/order revision;
order creation retains the exact offer read by its existing parent anchor at the attempt's T. The sole consent
writer supplies `expectedOfferRevision` and the command digest; the fresh body checks that revision after receipt
replay and before target binding/capture. No second price writer is added.

Each physical Checkout create/retry prepares mechanical authority before buyer/order locking, then admits the
immutable provider attempt under current buyer/revision/time fences. `consumeCheckoutCreationAdmission` consumes
a process-local one-use deadline immediately before provider I/O in [creation-attempt](creation-attempt.ts).
Serialized/replayed admission objects and expired continuations cannot call Stripe. Missing authority creates no
provider effect or automatic failed payment; earlier uncertainty remains unknown. Existing immutable parameters,
provider key, conservative 23-hour window and expiry rules remain in force.

These are sequential bounded native reads, not a cross-home simultaneous snapshot. The target may change after
Content releases its read and before Commerce commits or the provider call begins; Commerce's one-second fence
limits reuse but cannot lock Content across homes. Final Content byte delivery always rechecks current native
buyer scope, subject/ancestry, exact source/version/licence and final authority. No native client spans Content or
provider I/O, and no stored capture or earlier sale approval authorizes bytes.

Paid financial truth, named evidence and refund/dispute revocations still apply when target authority is missing.
Absent/revoked entitlements cannot be granted/restored without complete paid evidence AND current Content sale
authority. Paid application prepares mechanical authority after released provider evidence and before buyer apply.
Verified exact bindings permit the existing atomic grant/restore; unavailable/null/mismatched bindings suppress
only grant/restore, including a mismatched retained entitlement. A last-verified active entitlement is preserved
through transient target unavailability; unavailable
mapping does not fabricate payment failure/refund or erase history. Full-refund/dispute revoke the same row with
its original binding; partial-refund and terminal account/receipt/admission rules remain unchanged.

### Native fixed-edition buyer fact

The selected benefit is Content's immutable `content.edition`, action `edition:read`, bound to its native
`resource {route,id}` and `version {revisionId,sha256}`. Commerce imports the canonical
`ContentEditionBenefit` and `ContentEditionBuyerFactReader` from Access's `authenticated-benefit.ts`.
The capture producer's `content_edition` JSONB is immutable across offer, order and entitlement; SQL NULL
means UNKNOWN historical mapping and never supplies an edition fact. Current sale authority and final source
availability remain Content's independent responsibility; their actual native producer and full paid-use proof
are pending. Subject discovery's generated producer binding remains pending as described above. Public/free
authority is unchanged.
are pending. Subject discovery uses the positive-only directory below; its whole/native/main evidence remains pending. Public/free authority is unchanged.

`createContentEditionBuyerFactReader({pool,clock?})` in `content-edition-buyer-fact.ts` is the sole native current
Commerce reader. The kernel resolver constructs it once with its existing pool/clock and supplies it to the same
Access instance alongside the full mounted catalogue and Realm role reader. Its only input is the exact canonical
benefit, buyer account, caller's live Core `AuthoritativeTime` and unchanged finite request deadline. It neither
mints a replacement T nor calls Content, Access, provider services or a source checkout.

One released read-only repeatable-read transaction checks the buyer-home partition, current active account and
native authentication fence, then seeks the exact route/account/benefit composite index. All these reads address
that same buyer home. `entitlement_edition_buyer_lookup` excludes revoked and UNKNOWN rows, indexes every benefit
operand and orders by entitlement ID. A limit of two detects ambiguous active purchases without examining history
or performing per-order reads; ambiguity is unavailable, rather than choosing one purchase arbitrarily. A verified
empty range returns null. Missing/fenced/moved dependencies, malformed current tuples, future grants and ambiguous
matches throw existing typed 503 errors. The reader validates native account/entitlement/order routes, immutable
source/version/hash binding and actual positive safe-integer entitlement revision. It calls only Accounts'
opaque issuer, after commit and connection release, with the original live T and fixed deadline.

Access reads each distinct applicable actor/principal once; a fact supplies only its exact buyer grant operand.
Scopes, principal authority, denials, assignments, account eligibility and deadlines remain mandatory. Content must
independently enforce current edition/source/licence and complete parent/Realm/Space authority immediately before
byte disclosure. The fact cannot change scope, public floor, history, Library facts or source availability.
No cache, mirror, grant SQL or client fact/selector endpoint is introduced.

The focused native acceptance is retained in `test/commerce/content-edition-buyer-fact.test.ts`.
Current Content use, full journey/native evidence and promoted-main proof remain required;
no supplied fact alone establishes delivered paid use.

Unpublish/erasure makes delivery unavailable without inventing a refund; no alternate revision is substituted and
no Library record is created. Current Content use, native/interface gates and promoted-main proof remain required.

### Private buyer history

`order.list` uses `gate:purchases` and `order:read` before private SQL. It returns `{orders,next}`, default 20,
maximum 100, descending immutable routable order UUIDs and a strict exclusive keyset. Its signed expiring cursor
binds operation, viewer and partition epoch; changed epoch yields `stale_cursor`. Limit may change between pages.
Malformed/foreign cursors fail closed. The generated caller is `client.orders.get({query:{limit,cursor}})`.
Rows contain captured terms, nullable fulfilled tax, settlement, creation/Checkout navigation and entitlement ID.
History reads no current offer, price, subject summary or provider Session and cannot revive a delisted offer.

One read-only repeatable-read snapshot reads epoch and `(route,buyer_account_id,order_id)` keyset, at most `k+1`
orders, followed by at most one same-route unique-order entitlement probe per selected row. No count, offset,
history walk, global Session index or client held across foreign/provider reads. Indexed blocks are
`O((k+1) * L(N))` with bounded page sorting, not constant physical latency.

## Seller and provider boundary

Use one direct US Stripe account, hosted Checkout and Managed Payments with **REZICS as direct licensed seller**.
Creator royalties occur outside Stripe; Connect is not required merely to pay those royalties. Actual distribution
rights, business/product eligibility, account activation and setup are **EXTERNAL and unproved**. This model does
not authorize collecting on behalf of independent sellers. Stripe's MoR services cover the supported payment/tax,
refund and dispute responsibilities described in the provider report; REZICS still owns lawful supply, product
support, fulfilment, creator agreements and residual obligations outside that coverage. Ordinary automatic tax
is a different merchant-responsibility configuration, not MoR approval. Preserve its existing compatible fixture
without treating the fallback as first-slice Managed Payments qualification.

REZICS remains catalogue authority: captured inline `price_data`/`product_data`, one item and no Product/Price sync.
Inline product creation can still create a Stripe Product. The pinned dependency is **stripe 23.1.0**, whose default
request/type version is **2026-10-28.endive**. The webhook snapshot endpoint version is configured separately and
must be explicitly recorded/validated; the actual deployed endpoint version is not established here.
`event.api_version` is diagnostic provenance, not an upgrade mechanism.
An older Event's snapshot does not become current by retrieval. No silent SDK, API or status-union upgrade.
Bounded evidence of actual Session Managed Payments configuration is required before claiming deployment readiness.

External configuration: `STRIPE_SECRET_KEY`, `STRIPE_MANAGED_PAYMENTS`, `CHECKOUT_SUCCESS_URL`,
`CHECKOUT_CANCEL_URL`, `STRIPE_WEBHOOK_SECRETS`, configured `STRIPE_ACCOUNT_NAMESPACE` (default `direct`) and
`STRIPE_LIVEMODE` (default `false`, explicitly set for live). Namespace/mode come from configuration, never payload
or key text. Current config accepts `sk_test_`/`sk_live_`; restricted-key support is not established.
`STRIPE_API_HOST` is a fixture override. Missing/invalid/partial config leaves provider operations unavailable.
Public HTTPS ingress, trusted arrival time, endpoint-specific rotating secrets, migrations and the existing
worker/effects relay are external setup; signed-fixture implementation does not wait for private keys.

Success/cancel URLs are absolute HTTPS, allow `{ORDER_ID}` substitution and pass Stripe's `{CHECKOUT_SESSION_ID}`
through; other brace placeholders fail startup. Provider bank payout (`po_`), account transfer (`tr_`) and an external
creator payment reference remain separate identities. Neither a Stripe payout status nor a statement row proves
an outside-Stripe creator payment.

### Private receipt transaction amounts

Decision: expose actual captured customer presentment separately from the integration total and tax; absent
presentment stays unavailable, with no conversion or assumption that integration currency was charged.
`GET /v1/orders/:orderId` returns nullable `recordedPresentment` with `currency`, captured `moneyUnit` and
`amountTotalMinor`. It is independent of nullable `recordedCharge` (integration total and tax). Both require a
historically paid order, never a benefit record or redirect. The receipt keeps current Access independent.
Web consumes this additive field through the named `ReceiptOrderRead` wire seam, including retained client declarations.
The existing ordinary buyer authority and list/cursor contract are unchanged; history lists do not load this evidence.

The financial projection's static producer bounds are one full `(route,order_id)` order anchor plus one retained
interpretation per exact `(route,order_id,checkout_session_id,context)` key, each using the money observation index
and `LIMIT 1`. Two contexts give a composed ceiling of **3 examined rows**, raised from 2; one statement, two scalar
seeks, no fan-out or history pagination. Internal/status-independent command reads skip both evidence seeks.
`test/commerce/order-receipt-financial.test.ts` covers retained tuples and growth at 1, 8 and 64 unrelated histories.
This projection adds no offer, provider, subject, Access or entitlement reads to the existing composed route.

## Native money policy and captured prices

[money.ts](money.ts) owns `StripeMoneyUnit` (`system:'stripe-api'`, `exponent:0|2`,
`factsVersion:'stripe-money-v1'`), contextual immutable evidence rows and sale admission. Evidence lookup returns
null for an unadopted currency/context; it never enables selling. USD/EUR have exponent 2 in integration price,
Checkout integration/presentment and balance contexts. CAD presentment has separately adopted exponent 2. The
documented zero-decimal charge group and ISK/UGX/HUF/TWD charge facts establish no exceptional balance unit.
No ISO/Intl/default exponent or historical tax inference is permitted.

Trusted `COMMERCE_SALE_CURRENCIES` and `COMMERCE_SETTLEMENT_CURRENCIES` are unique comma-separated lowercase
subsets of `usd,eur`, each defaulting to `usd`. Every sale currency requires its declared settlement currency.
Enabling EUR also requires explicit boolean `STRIPE_LIVEMODE` and `STRIPE_MANAGED_PAYMENTS` declarations.
These declarations describe deployment setup; they prove no live account qualification, Managed Payments approval,
product eligibility or actual settlement capability. External provider setup remains external.

Fresh base prices are positive safe integers, minimum 50, maximum 99_999_999 raw Stripe units, multiple 1.
Native create/reprice bodies derive `moneyUnit` and `taxBehavior:'exclusive'` after ordinary authorization and
receipt replay. Currency, benefit and non-price terms remain immutable. Explicit repricing of an old UNKNOWN offer
captures the adopted metadata and increments its revision even at the same numeric price. Unsupported old currencies
remain readable but unavailable for fresh sale. Fresh orders require the captured known tuple and the displayed
`expectedOfferRevision`; old orders and receipt results are never rewritten. Native offer, seller and buyer DTOs expose
nullable `moneyUnit`/`taxBehavior`; absent historical metadata always reads as null, never today's interpretation.

`GET /v1/commerceMoney`, operation `commerce.money_schema`, uses normal `gate:selling` exposure and the existing
anonymous `offer:read` route label, without a second Access evaluator or new scope. Its closed response is
`{factsVersion:'stripe-money-v1',taxBehavior:'exclusive',configuredSaleCurrencies:[{currency:'usd'|'eur',unit:StripeMoneyUnit,minAmountMinor:50,maxAmountMinor:99999999,chargeMultiple:1}]}`.
It contains only static/trusted money configuration, no provider identity, credentials, approval or permissions;
it cannot authorize a sale.

### Creator input and recorded display

The Web editor consumes this generated schema and actual published Content metadata. Its pure
`parseCreatorPrice(text, ConfiguredSaleCurrencyRule)` accepts at most 32 ASCII characters: a canonical whole
(`0` or a nonzero digit followed by digits), optionally a dot and one through the recorded exponent's fraction
digits. Whitespace, signs, exponent notation, grouping, localized digits and excess precision (even zeroes) fail.
BigInt scaling, quantum and range validation precede safe Number conversion; the server still validates raw integers.
Changing currency clears the amount and requires new intent. The localized preview names the currency and says
before tax. Current native create/manage, gates, consent and Content sale rights remain authoritative.

Display uses each recorded unit's exponent with exact signed quotient/remainder and Intl placement/digits;
absent metadata is localized unknown, never an inferred `/100` amount. Integration price, actual customer
presentment and actual settlement stay separate currency/unit tuples; this convention adopts no UI FX or money math.
Repricing captures a new revision for future purchases without rewriting accepted purchases or immutable attempts.

New immutable physical creation intents capture the complete request, money tuple and separate API baseline
`2026-10-28.endive`. New inline `price_data` explicitly sends `tax_behavior:'exclusive'`. A retained first physical
attempt retries its original request/key/URLs/expiry/mode, including a captured `2026-09-30.endive` API version
and historical omission of API, tax and unit metadata.
The forward API-version migration accepts both dates without updating any captured request or row.
Old uncertainty without first-call evidence or captured unit provenance cannot start a fresh charge. Price adoption
never backfills history or rescales raw amounts. The base-price ceiling does not cap genuinely observed paid totals
when actual tax raises them above it; payment evidence retains its existing safe-integer and association validation.

## Commands and creation uncertainty

### Explicit buyer repair of a known order

`POST /v1/orders/:orderId:reconcile` (`order.reconcile`) accepts exactly `{}` and the ordinary idempotency header.
Its exact action and consented client scope are `order:reconcile`, with `gate:purchases`, nonanonymous security,
normal write rate/admission and the current request deadline. Mounted metadata declares `own-account` authority
on `access.account`; read/create scopes and first-party registration confer no repair authority.

[The command](order-reconcile.ts) prepares the installed Access formula on the verified actor's native account.
Every physical attempt locks that account before the exact order, checks active state/fence/current authentication
floor, evaluates actor and distinct principal authority, then re-reads stored buyer equality before any receipt.
Wrong, unknown and other same-route buyers receive concealed `not_found`. No buyer selector or provider locator,
callback, consent flag or token is accepted in the intent. The current authorization also governs exact replay.
The digest includes the exact order target; changing it with a reused key conflicts.

A fresh command requires a recorded Session and configured repair service. It commits one closed
`com.rezics.commerce.order.repair_requested.v1` event (`{orderId,name}`) and its queued response together through
the existing command outbox fence. `name` is the native transaction UUID, independent of order revision and bounded
to the existing repair-name contract. The default `commerce_repair_order` effect relays through
`enqueueKnownOrderRepair` to `commerce.repairOrder`, identity `order:<orderId>:repair:<name>`. Native receipt replay
returns the original `202 {orderId,reconciliation:'queued'}` without another effect, even after a worker changes
the order. Eligibility is checked only after authorized receipt handling. No database connection spans DBOS,
provider I/O or a foreign checkout.

Pending and historically paid records can both request this distinct repair trigger. The existing known-order
resolver, refresh admission, current revision/binding, provider evidence and terminal fences remain authoritative.
Repair creates no order, Checkout Session, charge, consent, entitlement or bytes. Missing Session/lost creation
binding returns unavailable and needs legitimate existing correlation recovery; this action never resets a
creation key. Source unavailability preserves financial truth and last verified entitlement. A queued request
establishes neither payment nor fulfilment, and Content still performs its exact current buyer and final use checks.

The existing order page exposes **Check payment/access status** only from the current native `viewerActions`
decision for `order:reconcile`/`order.reconcile` on the actual signed-in account. Its explicit POST server function
uses the current session, Origin/CSRF protection and private no-store responses. One distinct key survives timeout
and retry. GET, hydration and polling never request repair. Queued repair uses only the existing status reads and
does not reset the original sixteen-read budget; current access requires the ordinary page refresh.

The generated client in this checkout does not yet contain `$reconcile`. The controller owns generation;
`nativeOrderReconcile` in `apps/web/src/checkout/order-reconcile.ts` is the exact typed unavailable adapter until
that binding lands. Replace it with `client.orders({orderId}).$reconcile.post({}, {headers: {authorization,
'idempotency-key': JSON.stringify(idempotencyKey)}})`, admitting only the exact 202 queued response and preserving
denied/conflict/unavailable/uncertain results. There is no cast client or guessed HTTP transport. The default caller
is `requestOrderReconciliation`; the kernel default effect is already registered. Website registration and renewed
consent must explicitly include the new scope before visibility is available; existing sessions are not upgraded.

Commerce/Web handoff: operation `order.reconcile`; caller `requestOrderReconciliation`; Storybook IDs
`pages-commerce-order--reconciliation-queued`, `pages-commerce-order--reconciliation-unavailable`,
`pages-commerce-order--reconciliation-denied`, `pages-commerce-order--reconciliation-retry`. These signed-in
component examples retain the recorded pending order and substitute only the operation response. Web owns the
390/1280 visual review; source and local typing are not native, integrated-journey or promoted-main proof.

### One-time exact benefit acquisition

The adopted account-bound quantity-one policy serializes fresh acquisition on the buyer home by the full native
ContentEditionBenefit resource, immutable revision ID and complete SHA-256, and action. Offer IDs, prices, request
keys, reloads and devices do not distinguish that benefit. Subjects, titles, latest versions and UNKNOWN historical
subject-only mappings never supply equivalence. Holding an entitlement supplies no independent permission.

After current ordinary buyer/parent authorization, exact receipt replay, actual offer/revision and Content capture,
the same create-order transaction locks one native acquisition slot and rechecks indexed exact active entitlements
and unreleased mapped orders. An authorized same-key replay returns its original order first. A different key returns
`409 benefit_already_owned` for a current exact active entitlement, or `409 acquisition_pending` for an unresolved
acquisition, including unknown creation, paid without resolved benefit, and failed without verified release.
Neither response creates an order, receipt, business event, Session or charge. It never silently substitutes a prior
order's price/revision/terms for newly displayed consent. Existing matching mapped history is conservative pending;
there is no history scan or fabricated legacy mapping. Public offer responses and `{offerId,expectedOfferRevision}`
request bodies are unchanged.

These private Problems have `effect_status: not_applied`. After the current authorized own source and native IDs
are validated, `orderId` identifies the actual prior order when the credential has `order:read`; owned problems may
also include `entitlementId` with `entitlement:read`. Missing read scope omits that locator. No buyer selector,
public owned bit, Session locator or other account detail is exposed. The UI must navigate to the prior order's
actual terms or owned entitlement; it must not mint another key to retry purchase.

Only verified native disposition releases an order: first physical definitive no-creation rejection with matching
unretried creation evidence; terminal cancelled PaymentIntent with a terminal unpaid Session and complete no-charge
associations and no retained native cash; or a completed full successful refund/final lost dispute with associated native movements and no
pending refund/dispute obligation. Revision-fenced creation/refresh application records this atomically. Mere failed
settlement, expiry, elapsed time, pending adverse evidence and missing associations retain pending and known-order
repair. Unsupported release proof remains pending; no cancellation or new payment engine is added. A late old
payment still records actual money and reconciliation debt, but the current slot and active exact entitlement fence
grant/restore so it cannot create a duplicate active benefit or imply an automatic refund. Historical receipts,
purchases and native cash/entitlement evidence remain intact.

Slot and order-disposition metadata have buyer-leading native locators in Commerce's existing terminal inventory.
Bounded terminal minimization removes private slot keys alongside entitlements; financial disposition remains with
its existing order under the pending financial field/expiry policy and custody obligations.

### Revision-bound seller changes

Seller `PATCH /v1/offers/:offerId` requires a positive safe-integer `expectedRevision` beside `unitAmountMinor`.
Withdrawal `POST /v1/offers/:offerId:delist` requires `{ expectedRevision }`. Both bodies are closed. The revision
is the private owned-offer revision the creator reviewed, never a server-inferred replacement. Invalid or omitted
preconditions return `400 invalid_request`. No current terms appear in a conflict problem.

After current authorization and exact receipt replay, both commands lock the selected native offer row in their
command transaction, compare the submitted revision and mutate under that same lock. A mismatch returns
`409 offer_revision_conflict` before business mutation, history, events or receipts. The digest includes the target,
expected revision and price operand where applicable; changed intent under an existing key conflicts. Exact
authorized replay returns the original result even after later edits or withdrawal. Accepted orders and captured
benefits remain immutable. These operations touch one offer, one keyed receipt and the existing bounded event work.

The connected creator controls retain the reviewed offer, price draft, submitted CSRF credential, key and operands
through uncertainty. A conflict keeps the draft and disables mutation until an explicit review fetches current
permitted private terms. Failed, absent or older reads retain the conflict. Successful review displays the newer
row, preserves the typed price and allocates new keys; a separate deliberate action submits the new intent.
Review is a private read and remains available without CSRF; every mutation still needs a current credential.

Decision: require revision preconditions on both seller HTTP operations while preserving existing trusted native
command signatures through optional preconditions; new seller callers always submit them.

### Existing command identities

Use shared native command receipts, scoped by partition, verified principal kind/ID, command kind and key.
Hash complete semantic intent including path targets. Reauthorize client replay before receipt lookup/disclosure;
changed tokens do not change principal identity. Revoked/suspended authority cannot replay private results.
Create-order includes both `offerId` and `expectedOfferRevision`; revise/delist include their offer; mark-paid includes statement/payment reference.
Generic internal offer reads remain for authorized management/history; public delisting concealment is separate.

Public `GET /v1/offers/:offerId` adds `revision: number` (positive integer) to its existing closed offer DTO;
mutation DTOs retain their existing shape. Every fresh `POST /v1/orders` and BFF `POST /checkout` requires
`expectedOfferRevision: number` (positive safe integer). The BFF also receives the existing `idempotencyKey`.
The native signatures are `createOrder(actor, offerId, expectedOfferRevision, requestKey)` and
`checkout(dependencies, actor, offerId, expectedOfferRevision, requestKey)`; there is no omitted-revision bypass.

Use the invocation's existing parent anchor offer snapshot at `authoritativeT`. After current parent/buyer
authorization and exact receipt replay, a fresh active offer whose revision differs returns typed
`409 offer_revision_conflict`, with no new order, entitlement, durable intent or provider I/O. The problem carries
no current offer terms or revision. Unknown/unauthorized and delisted offers retain their existing concealment
and denial behavior. The digest binds the offer ID and expected revision: an exact authorized replay retains its
captured order after repricing, while a changed revision under the same key is `422 idempotency_conflict`.
No lock or native connection spans provider I/O or a foreign-home checkout.

A retained native create-order receipt from before revision consent used `{offerId}` in the semantic digest.
Only a real modern digest conflict permits one additional `runCommand` invocation with that old digest, in the
same principal/kind/key/partition namespace. It prepares and runs the full current parent, principal, assignment,
scope, account-floor and buyer account-T authorization again at its own attempt T, then returns Core's
`receipt-only` mode. It performs no fresh sale preparation or business execution. Missing old evidence preserves
the original idempotency conflict; current denials and unavailable/erased evidence propagate normally. A missing
current offer cannot bypass parent authorization. No alternate key, Session, inferred revision or receipt rewrite
is admitted. Before returning the genuine old response, Commerce requires its captured native `offerId` and
`offerRevision` to equal the submitted intent exactly; a mismatch remains an idempotency conflict without disclosure.

Old responses retain their original UNKNOWN or mapped benefit and money provenance. Native checkout reads the
current owned order after replay; it does not return the receipt's pre-Checkout state or treat history as authority
for a fresh charge. Existing immutable physical request/expiry and 23-hour retry guards still apply. Focused
[historical replay cases](../../test/commerce/legacy-order-replay.test.ts) use real current Auth/Access and Content
setup plus immutable historical order/receipt data only. These cases await controller-owned native/full proof;
source implementation and local typing alone do not establish compatibility acceptance.

The offer page displays the observed terms/revision and submits that revision once through CSRF/BFF/client.
A revision conflict shows localized terms-changed copy and an explicit reload/review action. Reload obtains a
new displayed snapshot and intent key, and buying requires another deliberate action. Uncertain retries keep
the original key/revision/order; they never refresh terms or automatically create another intent. Browser amounts
and currencies are never accepted. Web review stories are `pages-commerce-offer--terms-changed` and
`pages-commerce-offer--terms-changed-mobile`. Derived client/OpenAPI and recorded-response regeneration, Web
screenshots, native acceptance and promoted-main proof are separate controller deliveries.

Commit immutable order/receipt before external creation. The required creation correction captures first physical
attempt time, exact key `order:<orderId>`, parameters, resolved return URLs, tax mode and expiry in the buyer home
before I/O. HTTP and worker paths must share it, release native clients before I/O and reuse exact captured semantics
after configuration changes. Provider idempotency, native receipt lifetime, Event dedupe and movement uniqueness
are distinct. Retry must never change parameters/key or outlive the safe idempotency/expiry window.

The local safety policy is earlier of first attempt +23 hours and captured expiry -30 minutes, reserving another
20 seconds for provider work. Expiry remains order creation +1 hour, not a renewed promise. A never-started expired
intent can fail without creating; a started or historically uncertain intent without trustworthy attempt evidence
stays unknown and requires reconciliation. Lost success response is not permission for a fresh Session/key.
A definitive no-creation rejection must be supported for this attempt and cannot erase prior uncertainty.
**StripeIdempotencyError, mismatched old retry, in-flight conflict, cached server failure and network loss are
unknown/unavailable, not definitive no-session rejection.** Ambiguity is never rejection.

A recorded Session uses exact native binding. Lost binding recovery needs an authorized exact Session candidate
validated against order, configured namespace/mode and provider correlations; there is no public arbitrary binding
API, metadata-based buyer selection or global search. Automatic creation stopping does not prove the payment failed.

## Signed ingress, refresh and recovery

`POST /v1/webhooks/stripe` verifies exact raw bytes before JSON/domain routing, with a 256-KiB body limit,
8192-byte UTF-8 signature limit and at most four distinct nonempty configured secrets. Oversize/invalid signatures
have no durable/payment effect. Pinned SDK tolerance rejects age over 300 seconds against trusted arrival time;
it is not a symmetric future-skew rule. Await durable enqueue before acknowledging. Signed body payment claims
schedule fresh reads; they do not fulfil orders. Event ID dedupes delivery, not every future change of its object.
Retain bounded type/object/version/account/mode provenance; validate object kind/type and correlation.

Resolve direct Session, PaymentIntent-derived adverse events, initial/expiry, event recovery and named repair to
one immutable native order/Session binding. Locator fields are untrusted correlation, never buyer authority or
financial truth. The existing unexpanded `readCheckoutLocator` and exact-order resolver validate routable order,
matching client reference/metadata, configured mode and recorded Session before full financial reads.
PaymentIntent routing additionally charges a filtered Session list. Missing/foreign correlation is unavailable,
never a successful empty anchor or a sweep. No native client spans provider I/O.

Use existing DBOS `effects`, `partitionConcurrency:1`, with
`commerce:<configured-account>:<live|test>:<Session>` keys; event/order/expiry/repair parents stay on `workflows`.
Different Sessions can progress concurrently. Each trigger has a distinct stable refresh identity: completing one
Session workflow forever would suppress later refunds. Queue occupancy alone does not exclude overlapping abandoned
bodies, timeouts or recovery; native revision fencing remains authoritative.

<a id="receipt-aware-native-refresh-admission-implementation-pending"></a>

One combined physical attempt resolves, admits, reads fresh provider evidence and applies:

1. Take buyer `shareAccount` before exact order lock. Authorize the immutable service apply intent and, under that
   lock, use shared `hasOwnCommandCompletion` metadata before any write. Completed intent exits read-only without
   old response, revision claim or provider read; an old completed A cannot claim over admitted B.
2. For an uncompleted intent, conditionally advance order revision, emit the real order-updated event and commit
   native receipt/envelope. It is a coordination write even if business state will not change. Generate fresh physical
   attempt identity; SQL retries retain it. Fail on overflow/ambiguous admission; no authority from an uncertain claim.
3. Release the connection, then read and validate current Session/payment/adverse evidence against captured terms.
   Separate provider GETs are **not an atomic multi-object snapshot**. Changed/mixed observations need convergence,
   reconciliation and another fresh attempt, never event/arrival timestamps as object revisions.
4. Apply `commerce.checkout.apply` with original `wf:{id}:apply` and digest `{orderId}`. Receipt replay precedes body.
   Fresh body locks order, keeps the captured revision/Session through commit and SQL retry, and atomically changes
   buyer order, named transactions, entitlement and receipt/outbox. Superseded apply rolls back without apply receipt;
   retry requires new admission/read. Business no-op rolls back apply but retains committed admission.

`beginCheckoutRefresh` and `applyClaimedCheckoutSnapshot` in [commands](commands.ts) supply this native contract;
legacy `applyCheckoutSnapshot` retains timestamp behavior for compatibility and is not the production guarantee.
The local order lock ensures old evidence cannot commit after a newer admission, even when the newer apply fails,
is cancelled or does nothing. `observedAt` and `event.created` are diagnostic, not authority.

DBOS `5.4.6-preview` recovery/cancellation may overlap live bodies; checkpoint ownership is not a native commit fence.
Resume/fork/rewind must preserve `effects` and Session routing explicitly. Fork preserves the source; rewind requires
terminal history and cannot undo native money/receipts. Cancellation is cooperative, not an atomic cancel-to-commit
barrier. Physically drain old unfenced binaries before relying on admission. Retained old split-step adapters discard
cached financial output and delegate with the original stable apply intent; supported function cuts and recorded
application version must be preserved. No new queue/runtime/receipt engine is introduced.

Paid orders remain repairable through `enqueueKnownOrderRepair(orderId,name)` with a new bounded repair identity;
reusing a name dedupes it. Initial/expiry paid/failed shortcuts are not late-payment recovery.
`recoverSignedEventPage` admits at most 100 signed deliveries, verifies the whole page before dispatch, and returns
count/last Event ID. Each delivery keeps the raw-body/signature limits and current valid signature. Use real resend;
never synthesize signatures, bypass stale signatures or widen tolerance for archived bodies.

Authenticated provider Event enumeration/retrieval is a **different, pending recovery port**, requiring explicit
account/mode/version provenance and the same bound refresh path. It is not signed HTTP ingress. Recommended outage
slices of 24 hours, 100 Events per invocation within provider Event retention, checkpoint/continuation and operator
escalation require owner/Root adoption before runtime bodies. Outside retention or missing metadata remains visible
unresolved debt; use exact known-order repair where possible. No global paid-history sweep or promised resolution time.

## Historical payment and current entitlement

Settlement is `pending | paid | failed | unknown`; reconciliation is work, not a fifth state. `paid` is monotonic
historical purchase payment, not bank settlement, current access or irreversible financial finality. Unpaid/processing
never grants; failed describes the current attempt, not permanent impossibility of later verified payment.
Positive-price offers do not admit `no_payment_required` as fulfilment.

Grant/restore requires correctly bound complete paid evidence and complete adverse-state evidence. The
[adapter](stripe.ts) validates the payment-mode Session → expanded PaymentIntent → expanded Charge, including
identity, mode, presentment currency, positive integer amounts and captured paid evidence. Before flattening,
each Refund/Dispute must match that exact PaymentIntent and Charge. Both adverse lists must be complete under the
100-refund/10-dispute and 111-logical-read bounds; charge refund totals and adverse lists must agree. Validation is
O(k) over bounded evidence and does not expand the existing transaction, request, byte or deadline caps.

Missing/unexpanded required associations, foreign association/currency, unsupported adverse status, malformed,
repeated, nonadvancing or capped pagination, and mixed/incomplete evidence are unavailable through the existing
sanitized `StripeUnavailableError`. Nullable associations never prove adverse-none for a historically paid order.
Both native apply ports validate after current authorization, receipt replay and claim fencing. Unavailable evidence
writes no settlement/entitlement/transaction decision or apply receipt: active stays active, revoked stays revoked,
historical payment truth and committed admission remain, and durable retry/reconciliation debt stays visible.
It grants/restores nothing and never speculatively classifies an unsupported dispute as active, lost, won or absent.
A currently revoked entitlement **never restores from unavailable evidence**. Missing a Balance Transaction alone
is separate from paid/use evidence: a complete associated paid purchase may grant before provider cash is available;
financial incompleteness can hold accounting without inventing an unpaid purchase. Record only actual associated
balance movements, never a debit/reversal inferred from status. These requirements retain the delivered
[payment-evidence corrections](../../../../docs/research/commerce-payment-evidence-settlement.md#findings-requiring-a-correction-or-explicit-adoption)
without claiming a new native or promoted-main result.

Compatible indivisible-benefit policy:

- Partial refunds retain the whole benefit. Aggregate full same-charge/currency pending or requires-action refunds
  provisionally revoke; full succeeded refunds revoke. Failed/cancelled refunds may restore only with complete current
  evidence and no other blocker. Provisional revocation does not manufacture a cash debit.
- Known active (`needs_response`, `under_review`, `appeal_needs_response`, `appeal_under_review`) and lost disputes
  revoke. Verified won may restore absent other blockers; “lost” is blocking while lost, not a promise that a late verified win is impossible. Warnings/inquiries
  and prevented disputes retain access under current policy. Unsupported future status is unavailable, preserving
  last verified state; it cannot mask known active/lost evidence or restore a currently revoked entitlement.
- Terminal buyer T always prevents grant/restore and private reads. Use the real account share barrier in the same
  transaction, account before order, reacquired on retry. Catch only actual `LifecycleDeniedError` to remove personal
  benefit effects; availability/SQL/deadline errors roll back. Permitted financial reconciliation continues without
  recreating private relations. This barrier is not whole-account erasure proof.

## Financial evidence and creator statements

Use actual signed Balance Transaction economics once per scoped movement ID, including refund/dispute reversals.
Status alone creates no debit/credit. Compare retained order association, source/kind, currency, signed amount,
fee/net, FX, provider creation time and fee classifications/amounts. Fee-detail order and mutable descriptions do not
change immutable economics. Exact duplicates have one transaction/creator-line/aggregate effect, including later
months. Conflicting retained economics require typed integrity failure, rollback and reconciliation, never overwrite
or silent skip. A real correction/reversal has its own evidenced movement identity.

Creator attribution independently binds creator, order, offer, captured royalty rate, provider time and calculated
amounts. Named buyer evidence feeds creator-home immutable lines and incremental per-UTC-recording-month/currency
statements, not cross-partition joins/transactions. Late adjustments enter the recording month and never rewrite
paid prior statements. Existing Accounts `grantAccountRole` after statement upsert stays in the creator transaction;
modules do not write Access SQL.

Keep these distinct: **provider cash movement**, **historically paid purchase**, **current entitlement**,
**attributed creator earnings**, **reserves/payability**, **external payment attestation**. Order-linked movements
are not the full Stripe account ledger: standalone fees, reserves, adjustments, availability and bank payout batches
need their own reconciliation, not allocation to arbitrary buyers.

Current [royalty calculation](royalty.ts) is identified compatibility policy: it separates documented withheld tax,
uses a Session-derived conservatively rounded tax reserve when withheld evidence is missing, treats `tax` fee detail
as fee tax, and excludes non-withheld dispute-movement fees from creator deductions (REZICS bears them). These are
local allocation/reserve assumptions, **not provider facts**. Preserve actual provider gross/fee/net separately;
unknown classifications/FX/tax evidence cannot justify payment. A full customer refund need not zero net receipts
or earnings because tax/fees may remain. Do not fabricate tax credits, zero fees or full reversal evidence.
Further commercial/shared adoption is required before runtime bodies for provider allocation versus reserves,
release conditions, same-currency negative carry and positive evidence-complete payable rules; and richer external
attestation with actual date/method/amount/currency/reference. These are the provider
report's recommendations, not hidden adopted economics. Reserve duration, clawback, thresholds, partial external
payment, correction states and FX netting remain unchosen. Existing mark-paid records an authorized external reference
on a statement; it sends no Stripe transfer and does not prove payability or external finality.

### External payment evidence form

The Web statement inspector records only the existing `paidReference` through native `markPaid`; native authorization
decides whether the current creator or operator may attest. It captures the exact non-blank reference (at most 256
characters), statement ID, submitting session subject and UUID command key before sending. Web replays retain the original
sender and CSRF token with those same operands; native replay reauthorizes the current session, and a different session
subject cannot execute the old original.
The form shares the statement reader's viewer/address lifetime and retains its captured original in that workspace.

Decision: only a definitive validation rejection on the first dispatch permits an explicit editor initialized with the
exact rejected reference; submitting a changed valid reference starts a fresh request/key. Retries retain the original
sender, headers, operands and key after uncertainty or any other outcome, saved evidence is terminal, and conflicts
offer evidence refresh without replacement; reads never resolve uncertainty. Only a valid markPaid response matching
the captured statement and exact reference confirms the command; refreshed statement evidence remains separate from
that result and from provider payouts or payability.

The form's static native HTTP ceiling is **3**: one `markPaid` call plus the existing reader's one full-ID statement
read and one line-page read. Each explicit retry repeats that finite operation; no automatic write retry, cursor walk,
per-line fan-out or new producer query is added. The producer uses full `(route, statement_id)` seeks; its line page
uses the full route/statement prefix, an exclusive transaction key and `limit + 1` (Web limit 20, at most 21 raw rows).
Thus refresh makes two point-read observations of the selected statement and examines at most 21 selected line rows,
independent of unrelated history.
The producer's existing Access/session and command-receipt bounds remain inside each native operation.

### Provider money observations

[Money](money.ts) exports the closed `StripeMoneyUnit = Readonly<{system:'stripe-api'; exponent:0|2;
factsVersion:'stripe-money-v1'}>` meaning. Unit facts version and actual provider API baseline are distinct.
Nullable or absent historical metadata is unknown. The read-only evidence mapping recognizes USD/EUR exponent two
for Checkout integration and balance amounts, and CAD exponent two for actual local presentment. It does not admit
sales, qualify deployment, infer ISO/Intl units or apply charge/payout quanta to fees. Unproven exceptional balance
contexts retain their raw amount, fee and net with unknown units.

`CheckoutSnapshot.integrationMoneyUnit` applies to Session `currency`, `amount_subtotal`,
`total_details.amount_tax` and `amount_total`. Optional `presentment` captures only actual `presentment_details`
`presentment_currency`/`presentment_amount` as `{currency,amountMinor,moneyUnit}`; absence is null. It is neither a
copy of integration amounts nor an FX calculation. `StripeTransaction.moneyUnit` describes the balance object's
`currency`, `amount`, `fee`, `net` and same-currency `fee_details[].amount`. `providerApiVersion` records the
response baseline when supplied, otherwise the actual pinned SDK request baseline. `moneyProvenance` separately
records request and response versions, namespace, live/test mode, exact native object ID/type and field context.
The SDK version is unchanged; expanded balances inherit the response/page carrying them. No account ledger or
bank payout collection is added.

[Native observations](money-observation.ts) append these sanitized tuples and an economics hash in buyer-home
`commerce.money_observation`; original movements never change. A historical unknown acquires meaning only from a
fresh matching provider read, after native revision/claim, receipt and account fences and raw economics comparison.
Terminal buyers cannot append interpretations. Metadata-only refreshes commit `moneyMetadataChanged`, their receipt,
order revision and registered `money.observed` effect without extra payment or entitlement effects. Exact observation
replay adds nothing. Existing royalty effects consume both new movements and interpretations; known matching source
interpretations flow through the same named-transaction read and repair paths.

Royalty lines, totals and statement DTOs expose optional nullable `moneyUnit`. Projection requires recorded known
units and refuses incompatible same-currency grouping. Tax reserves use recorded exponents; allocation and rounding
policy is unchanged. Missing unit/tax interpretation is a typed unavailable royalty obligation, never successful
empty work or permission to pay. It cannot erase historical paid/refund/dispute truth or existing safe entitlement
eligibility. Legacy statement/line units remain null, including paid identities; their numbers are never relabelled
by a current lookup. Existing unknown/incompatible statement grouping blocks new aggregation rather than absorbing
known money. Missing interpretation remains repair debt with retained source transactions.

`moneyObservationOwnership` declares the existing financial `commerce` participant as owner, with bounded indexed
buyer-home page/probe and minimization queries. Its native ownership proof includes observations even if no parent
financial root remains. Fields are only route/buyer/order and provider object/context/version
keys, unit/amount evidence, economics hash and native command times/ID; there are no URLs, tokens, provider bodies or
fee-description copies. No new retention exception is granted. Observations share the participant's pending
financial field/expiry schedule; its current entitlement cleanup does not remove financial observations or
acknowledge erasure. These bounded minimization queries require the owner's resolved retention decision and fence.
Each snapshot supplies at most 256 balance objects plus integration and actual presentment. Reads use named
route/order/object/context index seeks with one recorded known interpretation per key; buyer cleanup touches at most
100 indexed rows per page.

The [module map](../../../../docs/commerce-modules.md#preserve-todays-facts-for-a-later-ledger) owns future immutable
party/capacity, benefit/terms, money/unit, source/effect and royalty evidence requirements. Historical incomplete
facts stay unknown. Future reconstruction versus reconciled opening balances is an explicit accounting choice;
no synthetic historical balanced postings or current ledger implementation.

<a id="deletion-and-account-private-minimization-first-public"></a>

## Privacy, lifecycle and cost

Orders, entitlements and use history are private; public offer/subject caches exclude private ownership.
Disclosure/rights stay with existing Access and target owners. [Shared deletion](../../../../docs/deletion.md) and
[Accounts erasure](../access/README.md#erasure-consumers) govern T, restricted retention and fixed-participant completion.
Financial Commerce is separate from Library's erasure participant. It must acknowledge actual minimized cleanup
or no applicable data, never mere dispatch; minimal completion outside workflow history prevents late resurrection.
The native live-copy purpose extends existing lifecycle coordination; it adds no account restore, workflow engine or lifecycle service.

At T conceal private orders/statements/entitlements and fence late producers. Minimize offer party data, buyer/target
relations and Checkout payloads, entitlement relations, immutable transaction/royalty source relations and statement
payment references except the restricted legally necessary fields with purpose and expiry. Immutable guards do not
create retention exemptions. Enumerate exact shared receipt/outbox/write-basis/work payload locators; actual store
owners minimize and acknowledge them. Account-linked indexed child pages and atomic checkpoints must replace global
principal/JSON/history scans. Full financial erasure participant, shared custody and retained-field expiry remain
undelivered; the account barrier alone does not close them. A jurisdiction/category/field retention schedule and
provider metadata deletion limits are external conditions, not a reason to omit deterministic fence/cleanup work.

Every provider attempt charges all sends/retries/body parsing, expansions, abandoned work and capacity until physical
settlement. Existing transport limits are a shared 20-second maximum deadline (respect shorter caller deadline),
256-KiB per body, 16-KiB request/response headers and aggregate input strings, no redirects, at most two network retries,
4096 nested containers/depth 16 and 256 total fee details. Full read admits at most 111 logical requests
(1 Session +100 refunds +10 disputes), other operations one; total sends are at most logical maximum times
`max(2,1+retries)`, with shared logical-maximum-times-256-KiB byte budgets. Eight physically unsettled provider operations
share process capacity; eight physical refresh bodies per worker registration are separately bounded. Native apply
admits at most 256 named transactions (257-key lookahead). Caps are local work limits, not provider population promises;
exceeding one returns unavailable with visible reconciliation debt, never truncation to “no adverse evidence.”

Native reads/writes name owner-leading indexed keys; creator recording touches only named movements and incremental
aggregates. Charge account/order/receipt/outbox probes, partition counter contention, provider work and DBOS system
persistence separately. No constant-row/cross-machine claim follows from key predicates or timeouts. Existing locator
and combined-refresh growth evidence contains unresolved native/DBOS examined-row failures; queue/backlog/partition
fanout and full erasure bounds remain unproved. Do not raise allowances or subtract workflow work to disguise them.
Serializable command retries are deadline-bounded; the cost bound is the per-attempt work, not a fixed contention-attempt count.

### Payment path growth cost

Each operation has independent 1×/8×/64× series for unrelated orders, provider events, receipts and DBOS workflow
history. The anchor order, provider snapshot, payload and retry configuration stay fixed.

#### Signed webhook ingest

- Touches: one bounded raw body, signature verification, event classification and one durable DBOS event enqueue.
- Bound: The 256-KiB body cap bounds input parsing; native statements and rows stay constant and blocks grow logarithmically with unrelated history.
- Growth check: [payment-path-growth.test.ts](../../test/commerce/payment-path-growth.test.ts), `Commerce signed webhook ingest / unrelated …`.

#### Order reconciliation

- Touches: one order/session anchor, the fixed fake Stripe Checkout snapshot and the production reconcile/refresh workflow steps.
- Bound: Native statements and rows stay constant and blocks grow logarithmically with unrelated history; DBOS persistence is inside the measured workflow.
- Growth check: [payment-path-growth.test.ts](../../test/commerce/payment-path-growth.test.ts), `Commerce order reconciliation / unrelated …`.

#### Payment settlement

- Touches: one buyer/order, the fixed provider snapshot, its named transaction IDs and the resulting entitlement/payment evidence.
- Bound: Native statements and rows stay constant and blocks grow logarithmically with unrelated history.
- Growth check: [payment-path-growth.test.ts](../../test/commerce/payment-path-growth.test.ts), `Commerce payment settlement / unrelated …`.

#### Offer price revision

- Touches: one creator offer revision and its command receipt/outbox effect.
- Bound: Native statements and rows stay constant and blocks grow logarithmically with unrelated history.
- Growth check: [payment-path-growth.test.ts](../../test/commerce/payment-path-growth.test.ts), `Commerce offer price revision / unrelated …`.

## Cost

### Creator sales page

- Touches: `creator-sales.sql` seeks `commerce.creator_sale` by `(route,creator_account_id,order_id)` in one
  creator home, reads at most `limit+1` (101) rows, and trims before the 256-KiB serialized sales cap. The read
  also dispatches two existing Access evaluations and two `core.partition` points, RR BEGIN/COMMIT or ROLLBACK,
  and deadline controls. Signed cursor verification performs no database enumeration. It reads no buyer home.
- Bound: default 20/max 100, one signed descending keyset, one home, fixed native points and no refill. The eight
  accounting axes are the actual composed `candidateKeys`, `identityMetadataRows`, `nativeRows`, `nativePoints`,
  `witnessKeys`, `statements`, `bytes`, and `emptySeeks`: page candidates include the rejected lookahead; native
  rows/points include the partition and Access children; identity/witness work belongs to those exact Access
  children, not an assumed zero. Every dispatched control, error, repeat and rollback is charged. Failed empty
  seeks still count. Complete allowance totals remain unknown until those existing children supply their actual
  complete terms; Accounts' selected local admission is fully spent and cannot fund these children.
- Growth check: `test/commerce/creator-sales.test.ts` authors the real native order/default-work/current-viewer,
  signed old-epoch, same-route isolation and genuine unavailable outcomes. Execution and measured physical work
  are deferred to controller acceptance; key predicates and typing alone are no growth proof.

### Native order admission, copy and recovery

- Touches: exact `purchase_order`, `creator_sale_work`, native `core.outbox`, original `editorial.write_basis`
  and event-role inventory, with the narrow buyer-owned `core.receipt` provenance alternative for the three
  internal Checkout commands. These feed exact full-key `access.live_copy_transition`, source/role holds,
  immutable receiver gate, `commerce.creator_sale` and account-first inverse inventory. All four historical
  coverage frontiers and durable pending scheduling retain their own work. The live-copy owner lists direct
  and nested SQL in [Access](../access/README.md#new-statement-and-row-bounds).
- Bound: one order per effect, <=64 distinct roles, <=1-KiB effect key, <=8-KiB payload and <=8-KiB roster; each
  foreign-home transaction is released before another home is acquired. Source event-role lookahead is 65;
  raw100 buyer backfill and raw1 historical work/receipt/sale frontiers never turn missing proof into coverage.
  On all eight axes above, role fanout, original provenance, nested SQL guards, inverse enrollment and DBOS
  persistence must be added to the same actual invoking frame. Candidate/identity/witness costs are the actual
  original native role lookups, not borrowed Semantic Source or erased-artifact History allowance. Point/row
  bounds are not examined-version bounds. Failed/duplicate admission, savepoint rollback, cancelled apply,
  consume repeat, operational rollback followed by a public command and retries all charge their entire dispatch.
  Complete end-to-end totals are explicitly unknown; no new funded parent allowance is claimed.
- Growth check: `test/access/live-copy.test.ts` authors positive default Commerce/foreign Library, exact repeat,
  crash-after-receive, cancel-before-apply, delayed result, payload conflict, native activation fence and deletion
  outcomes. Original History custody/source/inventory/recovery acceptance remains independent and unchanged.
  Native physical and composed cost acceptance is deferred, including failure/repeat/rollback measurements.

## Delivery and acceptance

Creation uncertainty, complete evidence, immutable movement economics and bounded signed ingress require
focused outcome evidence from [creation attempt](creation-attempt.ts), [Stripe adapter](stripe.ts),
[settlement](settlement.ts), [payouts](payouts.ts), [webhook](webhook.ts) and [configuration](config.ts).
Offer concealment/revise HTTP and buyer-history navigation remain part of the native journey.

Retain [frozen Commerce outcomes](../../../../specs/commerce-outcomes.test.ts) and
[native entry/driver](../../test/commerce/outcomes.test.ts). Signed loopback provider fixtures substitute only for
Stripe, while native acceptance uses real Auth/Access personas, kernel, PostgreSQL, DBOS and official SDK.
The narrow accepted test-contract exceptions are idempotency/mismatched-old-retry uncertainty and unavailable future
dispute status with last verified state preserved. No other frozen Root outcome changes are claimed or authorized.

Remaining owner deliveries must prove buyer/same-route other buyer, refunded buyer, seller/other seller,
creator/other creator, anonymous, suspended/terminal and authorized/unauthorized repair personas; exact-byte forgery,
replay/restart, enqueue failure, lost creation/cutoff, complete adverse association/cap cases, conflicting movements,
partial/full refund and dispute changes, terminal no-restoration, receipt reauthorization, native revision/queue
recovery races and three-scale physical cost. Subject discovery, benefit capture, owned navigation, actual protected
use and creator views also require API-to-storage-to-page evidence under the adopted shared target. Final native,
reviewed interface and promoted-main completion require the combined native and interface evidence.
