# Web and Auth interfaces

## Outcome

People can discover, contribute, discuss, collect and buy through accessible, localized interfaces, using the same
capabilities and disclosure rules on every page and device.

## Done when

- The site and Auth applications run locally through documented commands. Routing, navigation, localization and
  shared UI/document components provide a usable shell in every launch locale.
- Every launch vertical has subject pages from shared definitions/composition, plus search, facets, typeahead,
  boards, threads, posting/replies and the scoped community, Zone, moderation and notification surfaces.
- Collections, the personal library, independent labels, holdings, progress and explicit publication are usable
  through their real APIs. Filters remain available wherever the common Collection abstraction appears.
- Checkout start/return and entitlements expose the commerce outcomes without treating a redirect as fulfilment.
- Auth pages support sign-in, sign-up, consent, security settings and step-up through the accounts contract.
- The session BFF, upload completion and every download preserve caller identity and current API decisions.
- A Realm icon or banner retry keeps the original file only in that appearance caller and finishes the same
  reservation when its container is that Realm. Purpose stays the caller slot because the site media read omits it,
  and a rejected image drops the retry without saving appearance.
- Pages render useful preparation, empty, denied and unavailable states; metadata, sitemaps and sharing reflect only
  permitted public representations. Safe JSON-LD agrees with rendered content.
- Reviewed running pages and recorded-response stories demonstrate accessible phone/desktop layouts, both themes,
  representative content and all launch locales.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes `apps/web` and `apps/auth`, shared UI/document components, BFF/media transport, product routes, library
pages and SEO. Follow [public scope](../scope.md), [subject pages](../subject-pages.md) and [SEO](../seo.md).
The adopted mixed Home journey below is in scope; personalized recommendations remain deferred. This Goal adopts
the complete second-scope features opened in [public scope](../scope.md): saved dynamic queries, advanced facets,
scopes, Realm rating order, board pins, slow mode, watch, Collection/review/Space discovery and the moderator
workbench. Backend contracts stay with their product owners; preparation and privacy changes must remain visible
in the interface.

### Second-scope interfaces

The [second-scope plan](../research/web-second-scope-plan.md) divides these outcomes into independent interface
slices. It follows [public scope](../scope.md), including the newly admitted features; older first-scope deferral
wording in topic documents does not close them again. Admission to scope does not establish native availability.
Existing editors, refinement, rows, report queues and their original acceptance remain the starting point.

Decision: extend the existing routes through small owner-backed consumer seams; keep all ten interface slices
independent rather than making shared files or unfinished producer delivery into scheduling dependencies.

- **Save a query.** `/library/rules/new` and `/collections/$id/rule` use the existing rule editor. An admitted
  Collection filter and displayed type transfer through a one-use browser-memory handoff bound to the initiating
  viewer, with `id` order; private predicates never enter the destination URL, browser storage or shared hydration.
  Text, resource and non-`id` sort selections stay on the source with an explanation; reload discards the handoff and
  shows guidance. First save creates one private dynamic Collection after title/rule review. Existing rules retain
  their accepted release when reopened; new handoffs use the current release, and explicit edits are readmitted under
  the current release with the draft kept on incompatibility. Built-in identities have no rule editor. Create uses
  `POST /v1/collections` `{membershipKind:'dynamic', visibility:'private', rule:{filter,sort:'id'}}`; edit uses
  `PUT .../rule` with CAS revision. Confirmed creation offers members and rule destinations. Ordinary saved identities
  use the existing Dynamic Collection reader at `/collections/{id}` with distinct preparing, empty, unavailable and
  stale-cursor recovery states. Public readers receive only published permitted membership, never the owner
  predicate. An admitted owner reaches the existing `/collections/{id}/publish` selected-members route through
  `SavedQueryPublicationAction` consumed by saved-query management; rule edits do not auto-publish. The reader exposes owner management only for the current owner of an ordinary saved dynamic Collection
  with current native update/delete admission. Management rereads current metadata and revision, edits only title and
  description, and preserves the rule's accepted release. Delete has explicit review and returns to the same bounded
  directory page; the Collection delete does not delete Library facts. Existing metadata update and delete commands
  remain Commerce-owned. Commerce still owns complete paged dynamic owner metadata, dynamic member preparation,
  publication and native outcome proof. The Web lifecycle is documented in [saved-query directory](../../apps/web/src/library/saved-query-directory.md);
  the results seam remains in [saved-query results](../../apps/web/src/library/saved-query-results.md).
- **Advanced facets.** Extend the common Collection filter surface with released property selection and native
  count-free value continuation for that exact Collection. Eight active properties is a UI window; changing the
  property window does not discard applied operands. This is shared by curated and built-in dynamic readers. The
  installed `subjects:facets` client has no Collection resource scope, so Web keeps this read unavailable until
  Search binds it and never requests Global values.
- **Scopes.** Search offers viewer-self Library and exact Collection, Realm or Zone resource conditions using the
  adopted request-only grammar. Review an explicitly resolved identity before applying it; retain a refused
  selection for correction or removal. Choice metadata grants no membership or read authority.
- **Rating order.** Keep the current Global standard-question order and add one explicitly selected readable Realm
  population at a time. Native order and privacy states remain authoritative. Realm population selection is private
  to the mounted visit and never enters public metadata or a public Search index.
- **Board pins.** The initial board page renders Content's disclosed `pinnedThreads` (at most five, native
  newest-first order) above the existing active/hot/new continuation, excluding those identities from ordinary rows.
  Concealed pins are omitted with no placeholder. Pin/unpin confirmation and exact-command retry bind
  `boards({ id }).threads({ threadId }).pin` POST and the same board-threads GET; listing capability fields are still
  absent, so controls appear only from explicit producer actions. Content owns cap (currently three), storage, order
  and authorization. Details: [board pins](../../apps/web/src/threads/board-pins.md).
- **Slow mode.** Show the native board posting interval (`off`, 30, 60 or 300 seconds) and the caller's next
  permitted attempt beside new-thread and reply writing. An admitted moderator inspects and changes that interval on
  the board. Waiting preserves the draft; countdown text is display guidance; Send and Retry stay explicit, so a
  clock reaching the displayed time never proves permission or submits automatically. Native 429 `Retry-After` is the
  refusal authority. Content owns policy, eligibility, exemptions and the setting command. Web binds
  `KernelClient.boards({ id }).slowMode` GET/PUT when generated, and otherwise shows unavailable. Edits, mute/block,
  penalties and watch stay out of this slice. Details: [board slow mode](../../apps/web/src/threads/slow-mode.md).
- **Watch.** The default thread route shows the current confirmed watch state beside its title and offers one explicit
  watch or stop action to the current signed-in reader. Private reads stay in the mounted client and outside SSR/shared
  caches; target, access or session replacement retires the result. Unknown commands retain their immutable identity
  for exact retry, while refusal requires a fresh status read. Watching grants no read access or email delivery;
  existing notification preferences still govern in-app notices. Content's generated watch read/command API remains
  the named missing producer behind the installed unavailable seam. Board-wide watching is a later extension.
- **Collection discovery.** Home consumes disclosed Collection summaries through the existing ContentItem adapter
  and exact `kind` selection. Following Collections are delivered: title, description and `/collections/{id}` are
  used as supplied. Membership, rules, covers, authors and ratings stay omitted when absent. Public discovery
  Collection hits remain Search/Content's pending registration; Home types that discovery branch locally and does
  not invent a successful native page. Home visibly labels the unavailable public discovery branch and keeps the
  current Following Collection variant.
- **Review and Space discovery.** Home renders a review as its thread identity (`key.kind` stays `thread`,
  destination `/threads/{id}`) with a Review label, current optional author/excerpt and a reviewed-Subject link only
  when that Subject is disclosed. It never substitutes the Subject as the primary row or reconstructs a hidden
  association. Space rows use the named `HomeSpaceFeedItem` seam: destination `/spaces/{address}` when the address
  is readable, Realm title as carrier text only. Search has not registered public review or Space discovery kinds
  and Content has not delivered Space feed rows; Home shows those discovery branches as unavailable. Missing
  author, excerpt, image and rating stay omitted.
- **Home return.** Back/Forward and owner-destination return restore only the current stream, native selectors and
  opaque page frontier from bounded same-origin history state. Home never puts selected filters or private feed rows
  in the URL or history state. Kind/Space changes retire the displayed page before the next request; expired cursors
  offer restart with the same selectors. The descriptor is capped at 32,768 cursor characters; larger frontiers
  return as explicit restart. Space and rating-question identities are revalidated through their existing point
  readers.
- **Collection discovery.** Add native public Collection hits to existing Search and mixed Home rows, with the
  supplied title, description and canonical destination. A dedicated localized `/collections` route browses the
  native Collection-kind page and links to the existing public Collection route. Membership and private rule facts
  are not row enrichment; the page contract is [Public Collection discovery](../../apps/web/src/library/public-collection-discovery.md).
- **Review and Space discovery.** Add native review and Space hits through the same consumers. A review keeps its
  native thread identity and reviewed-Subject context; an exact Space destination keeps native address/lifecycle
  meaning. A Realm-backed Space does not become a second Realm hit.
- **Moderator workbench.** `/moderation/workbench` is the one signed-in navigation entry. Choose one currently
  permitted Realm board from the paged membership Realm list and that Realm's board directory, or the Global
  catalogue. Submitted reports, pending appeals and resolved cases are exclusive native queues with their own
  cursor; a board moderator is not given catalogue authority. Rows carry a stable report or appeal ID into the
  existing review routes. Resolution forms stay on those pages. Catalogue has no appeal list. There is no
  aggregate case search or platform-wide adjudication. Decision: board decision history is reachable only from a
  selected board; the Global catalogue has no history queue. The Web entry stays explicitly unavailable until
  Content delivers its private native history reader. It never
  derives history from report or appeal scans.

Consumer seams carry only native disclosed summaries, operation availability, revision/continuation and outcomes
needed by that slice. Bind the generated owner API when available; otherwise keep the small boundary explicit and
show unavailable in the installed route. An illustrative success fixture or unavailable seam alone does not complete
the positive native journey. Producers retain all permission, execution, delivery and lifecycle semantics.
Each slice updates this section with its delivered interface contract and the corresponding topic owner document
where its scope or interface wording changes. Page stories cover only the brief's named states with actual native
recordings when available; illustrative responses stay labelled as such. All launch locales and the current
phone/desktop, keyboard, private no-store and session-retirement requirements continue to apply.

### Personal Library export

Web owns the signed-in `/library/export` visit that consumes Commerce's private `libraryExports` capture. It is
distinct from public Collection ItemList export and from personal-list import writers. The page reviews supported
native coverage, creates only on explicit intent, traverses pages sequentially, assembles a local versioned JSON
file after the final manifest, and offers download, save retry, replay of the original first cursor, cancellation and
deliberate restart. Native storage, fences, expiry, limits and admission stay with Commerce. Missing typed methods
render unavailable. Decision: bind the installed Eden `libraryExports` surface when present; do not add a second
export engine or copy missing fields from other private reads. Details and Cost live in
[personal Library export](../library-export.md).

## Ownership

Owns `apps/web/**`, `apps/auth/**`, `packages/ui/**` and `packages/document/**`.
[UI](../../packages/ui/README.md) and [document](../../packages/document/README.md) own shared components.
Search owns composition and presentation templates; agree named slots and sequence edits in shared page features.
Accounts owns Auth behavior; content owns media and communities; commerce owns library and checkout semantics;
semantic owns definitions and Zones. Correct shared visual defects as a class across consuming surfaces.

### Catalogue recovery

Adopt the [catalogue family quality follow-up](../research/catalogue-family-quality-followup.md): retire refused
StoryArc current readings first, then complete Game creation recovery. Deliver precise Album, Manga and Screen
creation-error recovery as three separate pages. These five outcomes retain the source-present family composition,
existing Semantic ownership of Character current-reading and reference renderers, and the original Done when.

StoryArc public identity, facts and links require a successful current read. A refused or unavailable reload removes
that public markup, including hidden descendants and attributes, and permanently retires its callbacks and pending
results. Recovery renders only the newly admitted reading. Private editor holders may stay mounted while rendering
nothing, retaining drafts and exact sealed retry credentials, keys and operands; a resumed work editor rereads its
original address before using current authority. Creation and selected-reader recovery remain independent. Keep
Global editing and native Realm refusal unchanged; viewer or CSRF-session epoch changes release the whole mount.

StoryArc explicit keyboard reload keeps its surviving focused header opener; if disabling it loses focus, orient
only to the completed same-selection arc, work, creation or failure boundary. Focus movement, pointer use,
selection confirmation and editor or reader changes cancel that intent; other reads never move focus.

Album and Manga classification correction reuses the delivered Character writer. The private holder stays
mounted across reading loss and total classification withdrawal, rendering nothing until a matching current
read; compatible drafts and citations resume, withdrawn assertions stay inspect-only, and explicit keyboard
recovery orients to the classification summary. A hidden reading does not construct a review session.
Viewer or CSRF replacement and deliberate departure retire the
holder. Creation and selected-reader recovery remain independent. Semantic owns native Concept suggestion,
proposal, review, selection and command identity; Web binds the existing generated candidate methods.

The research demonstrates source transitions and error-address mismatches. It supplies no passing browser, native,
visual, accessibility or publication proof; those remain separate integration obligations for each outcome.

### Adopted quality round three requirements

The [quality round three findings](../research/quality-round3-backlog.md) are adopted here and in the
[shared-family migration contracts](../research/home-and-list-items.md#ordered-complete-implementation-slices).
The research's [complete 91-class crosswalk](../research/quality-round3-backlog.md#disposition-of-every-retained-round-two-review-class)
retains every review-class disposition and its original owning journey's acceptance; it is supporting evidence,
not a second product authority or 91 new implementation tasks. The original Done when above remains unchanged.

**Evidence boundary.** The research inspected source `4761a82e99595ca2cd4878ca26914e0f427bb634`, while publication
was `d1d188d5316129d585a39bba43fca50eb358c0b3`. Its 1,354 published stories occupied 147 folders versus 151 in
source; four source folders had no published counterpart. Of 294 folder/viewport capture cells at 1280×720 and
390×720, 106 mechanically accepted images were inspected and six rejected: **100 usable images, 88 desktop and
12 phone, with 11 usable pairs**. Fifty-eight published folders had no usable image. Wrong-viewport captures and
exhausted historical CDP failures remain rejected; no historical image is reused as current evidence. The 97
truncated accessibility-reporter failures are capture failures, not 97 established accessibility defects.
Folder coverage proves neither all stories/states/locales/viewers nor keyboard, screen-reader, 320px reflow,
native, full-suite or privacy acceptance. Source presence, integration, checks, native proof, visual review and
publication remain separate. A matching page file alone does not prove equality of its renderer, shared UI,
stories or deployed revision; stale publication must not recreate a source defect already repaired.

**Identity and disclosure.** Recognizable supplied human identity leads; a missing label is honestly unavailable,
never an invented name. Known, unknown and explicitly deleted records remain distinct; only an explicit deletion
reason permits a deleted tombstone. Withheld identity must not enter markup or attributes, even inside a closed
disclosure. Technical details may be optional, but essential warnings, permission/status, unknown outcomes and
decision identity remain visible beside the action. Full exact dangerous operands must be inspectable before
confirmation. Presentation changes add no row hydration, name lookup or fabricated richer fields.
Creator offer rows expose the supplied offer ID and revision in a labeled keyboard-operable disclosure, adding the
supplied captured edition route/ID only when present.

- **Resource access — Web consumer, Accounts authorization.** Deliver the complete identity presentation in
  `accounts/resource-access/page.tsx` (including `identityName`, `subjectTitle`, `SubjectName` and the ready
  resource/acting-as area), consistent `owner-transfer.tsx` labels, stories and regressions. Show a known resource
  kind or an honest generic resource when the DTO has no title; lead with supplied recognizable account labels
  and retain visible organization/Realm role meaning. Full resource ID, route/type and subject IDs belong in
  labeled technical details, including exact transfer operands inspectable before confirmation. Use only the
  existing 20-grant/22-identity DTO; add no identity lookup or I/O and preserve the existing explicit transfer
  lookup. Keep adapters, native/API authorization, session/credentials, mutation and uncertain retry semantics
  unchanged. New locale keys are confined to `access_identity_*`.
- **Search selected labels — sequential Web consumer delivery.** Change only selected-filter presentation in
  `search/search.tsx`, preserving delivered `results.tsx`. Missing kind/property/value labels use human unavailable
  wording; exact selection, URL and constraint remain intact and inspectable in labeled technical details.
  Preserve clear-one/all, existing local header authority, closed result rows, one bounded native request and SSR
  fences. Add no per-chip fetch, substitute constraint or broadened query. New locale keys are confined to
  `search_constraint_identity_*`; Search retains native scope without a competing writer.
- **Progress index — Commerce handoff.** Carry `progress-page.tsx` `SessionRow`'s `!unitLabel` case and the plain
  continuation anchor into the next complete current-source Progress index contract. Preserve the source-present
  human unavailable-unit label and accessible mode/unit details; historical meaning stays honestly unavailable,
  stored amount/position unchanged, with no invented percentage, total, rescaling or unit conversion. Require an
  actual 44px phone/coarse-pointer target for the standalone Next anchor without changing its cursor. Do not
  repeat completed index work; detail/helper/profile, native, Labels and buyer list/detail remain separate owners.
  Index rows show the supplied version title, or Unavailable when that identity is withheld, and the localized started
  datetime in ContentItem metadata; a null version choice is omitted.
- **Auth transfer — receive delivered hierarchy.** Entry forms already lead and the general walkthrough follows
  in an accessible disclosure. Keep local-file, untrusted-file, approval, responsibility and unknown-outcome
  warnings beside their actions. This source-present repair creates no new writer or native/browser proof.
- **Catalogue creation — waiting complete journey.** Bundle the `create-subject-entry.tsx` target correction into
  the next complete creation journey, never a standalone writer or retry of a completed delivery. Preserve its
  ordinary SSR anchor and destination; require an explicit 44px phone/coarse-pointer target, full label wrapping
  and visible focus without editing frozen generated button variants. This is a source-only geometry finding,
  not a measured current visual result.

**Waiting journeys and shared family.** Slices 4–10 consume the present `ContentItem` family and lower parts with
real identity, independent actions, native order/budgets and truthful loading, partial, denied, unavailable,
empty and recovery states. Retire parallel bodies only after actual default consumers demonstrate equivalence.
Home/Realm/Space/question retain Search's Source/native, Content's predicate/choice and Web's sole renderer
boundaries below: page ≤20, candidates ≤160, conjunctive exact kind/Space/question, signed selection/revision/viewer
cursor, bounded real coverage/frontier, one retained page, cancellation/retirement and public/private SSR fences.
A directory, helper or safe refusal is not positive installed default-feed proof. No browser qualification,
hidden refill or history scan supplies missing authority. `RealmHomeHeader` source differs from stale publication;
that image does not justify another hero rewrite.

Source-present provider choices, independent ratings, Spoiler Show/Hide, adjacent candidate confirmation, human
curation guidance, Search filter entrance, creator offer titles, edition terminal recovery, shelf sorting, exact
MyZones navigation, richer moderation and shared slotted 44px controls supersede their historical repair claims.
Their original owner verification remains owed. Sales' default 503/native Client generation, Source/Home/question,
History, erasure, Library bulk/preparation and private SSR retain their producer owners and original acceptance.
Accounts alone may reconcile its lifecycle transport fixture to delivered private review/readback ports; preserve
all security, current credential/key, uncertainty, `not_applied`, effect-count and first native lifetime-cleanup
assertions. No Web retry or competing lifecycle writer follows from this adoption.

### Shared navigation and subject purchase entry

Journey owners supply leaves and creation links through `AppShellProps.navigation` in
[`shell/shell.tsx`](../../apps/web/src/shell/shell.tsx). The shell retains desktop, phone and script-free rendering;
owners do not copy its layout, menus, settings or Appearance controls. Phone CreateSheet consumes the same
`NavigationEntries` with `kind="creation"`; the current navigation also renders contributed creation links.

[`shell/navigation.ts`](../../apps/web/src/shell/navigation.ts) exports `NavigationContribution`,
`NavigationContext`, `NavigationOperation`, `NavigationSession`, `ResolvedNavigationEntry`, `createNavigation`,
`resolveNavigation` and `navigationPathname`. Contributions have a stable owner-namespaced `id`, `kind`, `group`,
finite `order`, plain-text `label`, unprefixed local `href`, optional icon, `match`, `signedIn` and existing
`operation`. Navigation groups are `primary` then `personal`; creation entries use `create`, last. Within a group,
order then id determines placement. Label/href functions receive only `{locale, pathname}` with the current locale
prefix removed. Returning a null href omits an unsupported context. Matching is exact by default; `prefix` includes
descendants at a path-segment boundary. Query/fragment links retain their suffix and use the path for current state.
Duplicate ids and destinations within the same kind are rejected. Snapshots copy and freeze metadata; callbacks
must be pure, route-static functions, never close over account data, credentials or request state.

[`shell/navigation-view.tsx`](../../apps/web/src/shell/navigation-view.tsx) exports `defaultNavigation`,
`NavigationProvider({contributions?, children})`, `NavigationEntries({context, session, kind?, children})` (a render
function receiving `ResolvedNavigationEntry`) and `NavigationLinks({context, session, kind?, label, className?})`.
The default ids remain `shell.home`, `shell.search`, `shell.library`, `shell.orders`; Library and Orders keep their
existing signed-in operation gates and descendant matching. Public leaves render SSR anchors without JavaScript.
Signed-in entries wait for hydration and session preparation; operations use existing Exposure and its bounded,
private no-store viewer read. An offered entry grants no read or command permission. There is no user registry,
account-menu fetch, new permission engine or private data in static configuration.

Fixed Subject, Realm and provider-review entries use exact operation markers from the existing Exposure read, like Sales, because their public native routes have no gate group.

`AppShellProps.subjectPurchase` accepts `SubjectPurchaseRegions` from
[`features/pages/subject-slots.tsx`](../../apps/web/src/features/pages/subject-slots.tsx): optional `publicRegion`
and `privateRegion`, each a React component with `SubjectPurchaseContext` props `{subjectId, subjectType, locale}`.
`SubjectPurchaseSlot({context})` renders the named `data-slot="subject-purchase"` at the end of the current subject's
successful composition header, after its existing actions. `useSubjectPurchaseContext()` returns the same public
fields inside the region, or null outside it. Missing regions render nothing. `publicRegion` may render from those
public fields during SSR; `privateRegion` mounts only after hydration and a prepared signed-in session. The native
owner then prepares its own admitted offer/entitlement reads through the existing private BFF/no-store boundary.
The slot fetches nothing, derives no entitlement from Library and provides no purchase or benefit fallback.
[`shell/feature-slots.tsx`](../../apps/web/src/shell/feature-slots.tsx) exports
`FeatureSlotsProvider({subjectPurchase?, children})` and `useFeatureSlots()` for isolated hosts and patterns.
Semantic keeps subject composition and neighboring editor, relations and review regions; Commerce keeps the supplied
purchase/benefit components, native data and authorization.

A root composition can accept a real Commerce-owned private component and add a contextual native creation link
without changing the shell (all imports below exist):

```tsx
import { AppShell, type AppShellProps } from '../../shell/shell';
import { createNavigation } from '../../shell/navigation';
import type { SubjectPurchaseRegions } from './subject-slots';
import { m } from '../../paraglide/messages.js';

const navigation = createNavigation([
  {
    id: 'library.create-collection',
    kind: 'creation',
    group: 'create',
    order: 0,
    label: ({ locale }) => m.library_collection_new({}, { locale }),
    href: ({ pathname }) => (pathname.startsWith('/library') ? '/collections/new' : null),
    signedIn: true,
    operation: 'collection.create',
  },
]);

function JourneyRoot({
  children,
  PurchaseEntry,
}: {
  children: AppShellProps['children'];
  PurchaseEntry: NonNullable<SubjectPurchaseRegions['privateRegion']>;
}) {
  return (
    <AppShell navigation={navigation} subjectPurchase={{ privateRegion: PurchaseEntry }}>
      {children}
    </AppShell>
  );
}
```

The shared patterns are `Patterns/Navigation/Contributions` (public leaf, private pending, offered/gated creation,
locale/path) and `Patterns/Subjects/Purchase entry slot` (empty, populated, private pending). They use the delivered
components and recorded public subject composition; the owner-region fixture makes no business claim. These
patterns and source integration do not establish native journey acceptance or full page/visual review.

## Subject rating sources and populations

Adopt the rating journey selected by the [first-scope audit](../research/first-scope-remaining-backlog.md), under
[Subject scores](../subject-pages.md#scores-on-pages). Web owns independent anonymous question/headline/Global/
imported-source outcomes and targeted retries, plus the actual bounded native population chooser, current Realm
labels, exact selected aggregates and mounted reader lifetime. Global stays separate; at most twenty selected
Realms enter one aggregate call. Sparse pages retain opaque next and explicit navigation, with no hidden refill,
search, membership scan or history aggregation. Healthy sources and existing private vote drafts survive sibling
failure. Genuine zero, suppression, updating/as-of, absence, unavailable and terminal states stay distinguishable.

Source delivery includes the real generated-client BFF wire and route/context/view binding, source-isolated caches,
private actual-reader comparison, fresh anonymous/null-CSRF read admission, monotonic retirement and bounded current labels.
Eight-locale copy and full-page phone390/desktop1280 stories cover selection, removal, sparse continuation and
source failure. Connected assertions cover native wire operands and refusal, independent recovery/public head,
selection bounds, delayed work, equal-success and ABA replacement, QueryClient/visit/unmount and useful ordinary
notifications. They are authored **UNRUN**; source presence and local typing are not whole-feature acceptance.
Native/browser/growth/physical verification and integration proof remain deferred. Private first-render/SSR and
unobserved cross-cache credential history remain unresolved, rather than proved by an in-memory fixture.

Content retains questions, privacy/math, aggregates and native vote authority; Accounts/Auth retain session and
Realm disclosure authority; Search retains public composition/canonical frame and its shared-file regions. The
existing reaction and personal-vote consumers remain intact. The public figure/head receive no private credential,
population payload or provenance. The audit's broad shared-UI migrations are already integrated and stay closed.
Creator Sales remains Commerce's native/page journey, Space-selected Home remains Search-led with Content/Web,
provider review remains Semantic with Imports, and redirected-population maintenance remains Performance with
Content/Semantic. Library retained preparation and whole-selection bulk stay conditional on actual producer,
confirmation ABI and inclusive cost; this Subject consumer does not install those dependencies.

## Mixed Home delivery

Home is one bounded mixed stream of public discovery, Following and Continue, with one renderer. Kind, Space and
rating-question Context select candidates conjunctively on the same primary item; they do not create separate
sections. [Home and Following feeds](../feeds.md) owns the wire, producer semantics, disclosure, lifecycle and
candidate/frontier bounds. Native kind selection is delivered. Space and question Context are adopted requirements
whose producer installation and positive default journeys require independent evidence. Consumer implementation against
settled interfaces is authorized in parallel; source presence, generated receiving and native proof remain separate. Preserve kind and actual
Space delivery independently of Context.

Question Context means one exact native rating-question identity. A Subject qualifies through at least one live,
currently readable review of that exact Subject, whose currently readable opening revision has an immutable citation
of the selected question. A review thread requires its own current opening citation and a readable reviewed Subject;
a post or reply requires that qualifying review thread and its own current disclosure. Catalogue Agents use Subject
membership. Native Accounts, Collections and ordinary discussions have no membership in this version. A Subject's
Space witness and question-review witness may be different threads; selection does not assert that its cited review
was posted in the selected Space. Private votes, aggregates, question grain/applicability, Realm populations and
editorial Contexts are not substitutes for these witnesses. The exact optional request field is `ratingQuestionId`;
the server resolves its current revision. Metadata supplies no stored-reference predicate, permission or rating
threshold. Detailed producer admission belongs to the feed owner, rather than a Web-derived membership rule.

Before a dependent consumer promises completion, preflight the complete positive DEFAULT call graph, including:

- The actual retained native Source, all three default public-filter readers and privacy reduction, current candidate
  coverage, current eligibility and lifecycle/refusal behavior, including carried Realm and Zone authority. A factory,
  point read, declared dependency or safe unavailable response alone does not establish positive membership.
- The installed native request literal and current feed/review-witness/question-choice admission, preserving native
  candidate and examined-frontier bounds rather than filtering a downloaded page in the browser.
- Bounded real choices under current definitions authority: `definitions:read` before question enumeration, current
  metadata and signed choice keysets. A downloaded-first-page directory or selectable placeholder supplies no choice
  or membership capability.
- Cursor binding to the exact selection, revision and current viewer/credential authority, plus real default
  composition and generated client wiring through the existing Home consumer. An injected adapter or helper alone
  does not complete that path.

Search owns the retained Source, scoped Search and Space journey; Content owns feed admission, current review
witnesses and question-choice admission. Web owns the sole existing Home consumer and its launch-locale, phone and
keyboard states. Implement that consumer against settled owner contracts now, then receive actual producer source and its normally
generated client closure through controller integration; do not duplicate the Source, feed
producer, directory or renderer. Preserve private no-store reads, honest preparation/unavailable states, usable
independent ready sources and current disclosure. A selection change resets cursors and retires old rows and stale
request generations; late responses cannot restore a previous selection or viewer's content. Missing authority must
remain fail closed rather than becoming known empty, an all-candidate fallback or fake browser filtering.

The default consumer source now includes a labelled rating-question choice, explicit bounded directory paging,
selected metadata, clear and exact-identity refresh. It sends optional singular `ratingQuestionId` alongside kind and Space
through public and prepared private server functions and keeps it through continuation, retry and restart. A new
selection, observed metadata revision, kind, Space or stream retires the previous rows and feed cursor. Selected metadata
survives absence from a later directory page; a denied or lost exact identity remains selected with a refusal and
refresh/clear actions. Directory errors remain distinct from successful empty pages. Reads are abortable and fenced
by selection and the route's locale, subject and CSRF remount. No selected/private response enters shared cache,
hydration, URLs or persistent state. The initial anonymous preload remains unselected.

The implementation holds one directory page of at most twenty questions plus selected metadata. Each explicit feed
load reads one native page of at most twenty rows; there is no browser qualification, refill or parallel feed. The
exact question point route is used at selection and explicit currentness refresh, not per option. Labels use native
question text; grain, revision, scale and all control/error text have all eight launch-locale messages.

The existing default-route composition regression has additional authored cases for question propagation, bounded
paging, conjunctive kind/Space/question propagation, sparse continuation, revision/lost identity and stale request isolation. It has not been executed for this
source delivery. Home-only illustrative native-format envelopes support the interactive PageStory IDs
`pages-discovery-home--question-selection`, `pages-discovery-home--question-choices-unavailable` and
`pages-discovery-home--question-choices-next-page`; existing IDs remain. These are consumer fixtures, not native
recordings or visual proof.

The mounted native question directory and its normal generated Client declaration have now been received. The
consumer uses the generated directory and point routes without handwritten declarations, casts or generator changes.
The exact `spaceId` and `ratingQuestionId` selections remain independent request fields; no Realm or carrier authority
object is sent. Content's native question predicate, readable-review witnesses, all three lane bindings, retained
Source coverage/privacy reduction, current authority and signed question/revision cursor binding still require
producer delivery through the controller. Until then, actual native refusal/unavailable responses remain visible;
the directory alone cannot establish a successful selected feed. Original acceptance, native/default proof, visual
review and promotion remain owed separately from this consumer source.

The [integrated quality review](../research/terra-period-quality-review.md) supports retaining useful mixed-feed work,
safe refusals and corrected UI, including edition admission, optional naming, qualified credits, phone controls and
typography. It is limited source evidence, not a causal model benchmark. Adopted meaning, installed source,
integration, authored regression, native proof, visual review and public delivery are separate facts. This owning
document establishes neither native/browser proof nor the contents of a current deployment; the Goal's original
acceptance and promoted-source obligations remain intact.

### Home content-item presentation

The actual Home consumer uses `@rezics/ui/content-item`, which exports `ContentItem` and `ContentItemProps`. The
component accepts ordinary `li` attributes other than `title` and `children`, plus `title`, optional `href` and
`titleLang`, `headingLevel` (2, 3 or 4; default 2), `visual`, `context`, `metadata`, `preview`, `state`, `actions`,
`trailing` and `forceOverlay` slots/props. It renders one semantic list item. Home passes the existing `FeedItem`
directly through this adapter and keeps `homeFeedTitle`, `homeFeedDestination` and `homeFeedResume` as its only title
and local-destination authorities; it does not add a Home DTO or per-row hydration.

The row's supplied summary determines its content: subjects keep their proportional cover, accounts use a supplied
avatar when present, and text-only discussions have no blank visual column or fabricated image. Collections, reviews
and Spaces share that adapter: a Collection stays a Collection, a review stays a review thread, and a Space keeps
its readable Realm carrier rather than becoming a Realm hit. Supplied subject descriptions remain short previews.
Continue rows use the existing human progress label and a distinct Continue action. The item title is a real
level-two heading and the only stretched primary link; independent actions remain
usable above its overlay. Home adds no resting border, divider or card background and does not label ordinary rows
with discovery/Following/Continue protocol names.

Home and Following share one compact mode band. Kind, exact-address Space and rating-question Context controls sit
inside one labelled Filters disclosure. When it is closed, each active selection's human label remains visible;
opening it exposes the existing bounded choices and their selected-value, clear, refresh and retry controls. The
selected question label remains visible by default; its grain, scale and revision sit in a closed, accessible
information disclosure. Space guidance tells people what to enter without explaining address parsing or review
witnesses. The reading column stays approximately 720–800 px wide and uses the same composition on phone. The row
visual is 80 px wide on phone and 96 px on desktop for subjects, and 64 px for supplied account avatars.

Remove the permanent feed-horizon explanation and successful Ready source ledger. When sources are incomplete, keep
usable rows and show one concise notice with a real Retry. A blocked selected Space or question is explained and
recovered by its own control, without a duplicate generic Home error. Whole-request denial, unavailability,
expired-page recovery, sparse continuation, unknown progress and genuine empty results keep their truthful
distinctions; a restart preserves current filters, and an unavailable selection stays selected until refreshed or
cleared. Native ordering, the 20-row page limit, one-page replacement, exact conjunctive filters, viewer/CSRF remount,
private no-store behavior and late-response fencing are unchanged. The composed Home regression covers row order and
identity, primary/Continue links, absence of technical scaffolding, accessible filter and question-information
disclosure, selected-label visibility, partial-result retry, refusal recovery and expired-page restart. Its source
and the updated Home stories are authored evidence only until the permitted integration checks run.

### Exact Home Space consumer

Home owns a labelled exact-address lookup, one reviewed result, explicit selection, current-identity refresh, clear
and retry. It calls `spaceAddresses({address}).get` once, then `spaces({spaceId}).get` once; refresh uses only the
latter. Supported same-origin `/spaces/<address>` URLs are admitted before network work; external origins, unrelated
paths and extra segments are rejected. Address normalization stays native. Former reserved claims are not forwarding
results. No Space page loader, directory, follows enumeration or per-option reads supply this choice.

The selection retains the actual Space id, title/current address, head revision and independently viewer-derived
Realm id. Realm-backed Space is a genuine scope. A null or unreadable Realm makes the selected scope unavailable;
it never becomes Global, unselected success or known empty. The schema has no Zone id. Content owns the native
Space association tuple, attach/replace/remove authority, versioned read and lifecycle; Semantic owns independent
Zone meaning and ports, and Search owns server continuity and current-primary eligibility. Current Space lifecycle
is remove/restore. Account remover-attribution cleanup is not terminal Space erasure or an association ACK prerequisite.
The browser does not map Space or Realm into Zone. Choice metadata
supplies no membership or authority. The [feed contract](../feeds.md) retains native currentness, original/terminal
binding and authority/witness/cost obligations.

The exact optional `spaceId` travels through the same mixed public/private feed request as kind and question,
including next/retry/restart; clear omits it. Head and Realm observations are compared independently of ETag.
Selection/currentness changes synchronously retire displayed rows and cursor and abort/fence earlier feed and point
work. Locale and viewer/session/CSRF changes remount the consumer; selected metadata and private rows remain outside
shared caches, SSR hydration, URLs and persistent storage. Sparse empty pages with a next frontier remain continuable.

The authored Home composition regression extends the actual consumer/read/server seams for exact bounded lookup,
carrier refusal, conjunctive selectors, generation changes and late private results. It is unexecuted source under
the current implementation policy. The interactive `pages-discovery-home--space-selection`,
`pages-discovery-home--space-unavailable` and `pages-discovery-home--space-identity-changed` stories mount the actual
PageStory/default Home with explicitly illustrative native-format data. They are neither native recordings nor
visual review. The Home/Space consumer and real directory declarations are received; actual native scoped Space
and question predicate/default producer receiving remain distinct obligations. Positive native/default journey proof, original
acceptance, visual review and public delivery are separate prerequisites for whole-feature completion; local typing
establishes only source consistency. Preserve the parallel question consumer and all original Goal outcomes.

### Adopted critical-path outcomes

Adopt the [integrated critical-path attempts review](../research/critical-path-attempts-review.md). Search owns two
ordered Source outcomes: first, complete captured-prefix repair, independent successor/Source verification and
actual Search settlement with contiguous ACK; second, a useful installed default page using maintained indexed
population and a single real coverage root with all dispatched/failed child work inside its bounds. Newer work and
changed old cuts remain blocked. Neither helper exports nor the first checkpoint alone establish public Source
closure. Search owns those bodies, Content owns feed composition, and Web owns Home; independent consumers proceed
against settled interfaces while actual installation and positive proof are tracked separately.

The repeated creator-sales generated-file landing refusal belongs to controller classification/reconciliation,
not a product-test failure. Preserve paid source and existing owners; do not replace product work to evade a derived
artifact refusal. Sales completion does not close independent Library expected-effects/current-seal or History
retirement. Source, integration, typing, authored regressions, native proof, visual review and public delivery must
remain distinct evidence categories.

### Home Space cost

#### Explicit lookup and selected refresh

- Touches: the exact native address key and one Space point read; refresh touches the selected Space key only.
- Bound: at most one address resolution plus one point per explicit lookup, one point per refresh; one selection and
  one reviewed result, no hidden fanout, enumeration, all-download or per-option calls.
- Growth check: authored regression asserts request counts, zero network for invalid URLs and replacement/fencing
  of old lookup generations. Execution and native indexed-cost proof remain deferred to the owning integration.

#### Selected mixed-feed page

- Touches: one existing feed request per explicit page/retry/restart with the complete exact selection.
- Bound: one displayed page, P<=20, existing native B<=160, fixed lanes/dedup/consumed frontier and no refill; Space
  selection adds no browser population scan. Native composed authority/witness/cost stays with its producer.
- Growth check: authored regression asserts exact selectors, page bounds and cursor retirement/retention, preserving
  existing privacy assertions. Native examined-work/growth and positive default-path proof are separate obligations.

## Composed Collection and Library member continuation

Each composed Members node owns its explicit More/Retry request, opaque cursor and retained pages. A request makes
one existing bounded page read, without prefetch, refill, member scans or per-row reads. Keep native row order,
deduplicate by canonical subject identity and render supplied facts without deriving additional authority or totals.

A persistent node-local polite status stays empty on hydration. After each successful explicit request it reports
the actual number of newly visible unique items and whether continuation remains, including zero for duplicate-only
or empty pages. Reuse the localized relation completion and end messages in all launch locales. Loading clears the
previous completion; failures keep the existing preparing, invalid, unavailable and changed-reading semantics.
Retiring responses remove retained private rows as before; concealed nodes remain absent. Recovery uses the current
native reading and never reuses a retired cursor.

More and Retry have wrapped labels, visible keyboard focus and targets at least 44px in both dimensions. Keep the
trigger focusable while pending and guard repeated activation. While More remains, focus stays on that button.
When it disappears after exhaustion, a reader still focused on that requesting button moves to a local, visibly
focusable end marker after the rows; Tab then continues in document order. A reader who moved elsewhere keeps
their focus. Target, node/configuration, initial section, viewer state/identity and locale boundaries retire the
accumulated pages, completion and any late request's focus effects. Each mounted node's request cache identity is
isolated so a new reading cannot inherit an old in-flight page.

The canonical composed-member Continued and Exhausted stories use explicit illustrative native-format responses
through the default renderer. The focused `apps/web/tests/member-list-continuation.test.tsx` regression authors
unique/duplicate/empty completions, independent streams, keyboard focus, request bounds, reading retirement and
native-status recovery. These fixtures and authored interactions are not native proof; execution, visual review,
assistive-technology review and original acceptance remain separate integration obligations.

## Dependencies

Requires the typed kernel client and real owner APIs, exposure discovery, BFF sessions, definition releases,
presentation profiles and composition slots. Use typed fakes only as interim implementation aids; recorded fixtures
must be refreshed with their producer changes. A fake alone cannot prove authorization or native API behavior.

## Acceptance

Run focused interface and integration suites through the owning app/package check runners. Connect native
[page outcomes](../../specs/pages-outcomes.test.ts), [search outcomes](../../specs/search-outcomes.test.ts),
[library outcomes](../../specs/library-outcomes.test.ts) and [media outcomes](../../specs/content-media-outcomes.test.ts)
to their corresponding running pages. Review screenshots and Storybook evidence in all launch locales, both themes
and phone/desktop layouts. Include keyboard access, loading, empty, preparing, unavailable and hidden-resource
states. [Verification](../development/verification.md) owns commands and review cadence; automated assertions do not
establish visual quality. Auth capture filenames retain existing desktop names and the light-login phone name; other
phone captures use `<state>.<locale>.<theme>.phone.png`. A full web check is required only when the task contract names it.

## External conditions

Production Worker bindings, object storage, abuse prevention and deployment configuration must be supplied through
supported interfaces. Private provisioning is external; functional and visual acceptance uses isolated fixtures.
