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
- Pages render useful preparation, empty, denied and unavailable states; metadata, sitemaps and sharing reflect only
  permitted public representations. Safe JSON-LD agrees with rendered content.
- Reviewed running pages and recorded-response stories demonstrate accessible phone/desktop layouts, both themes,
  representative content and all launch locales.

Completion requires the scoped outcomes on main with recorded checks covering the promoted commit. Specified,
implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.

## Scope

Includes `apps/web` and `apps/auth`, shared UI/document components, BFF/media transport, product routes, library
pages and SEO. Follow [public scope](../scope.md), [subject pages](../subject-pages.md) and [SEO](../seo.md).
The adopted mixed Home journey below is in scope; personalized recommendations and personal saved queries remain
deferred. Backend contracts stay with their product owners; preparation and privacy changes must remain visible
in the interface.

## Ownership

Owns `apps/web/**`, `apps/auth/**`, `packages/ui/**` and `packages/document/**`.
[UI](../../packages/ui/README.md) and [document](../../packages/document/README.md) own shared components.
Search owns composition and presentation templates; agree named slots and sequence edits in shared page features.
Accounts owns Auth behavior; content owns media and communities; commerce owns library and checkout semantics;
semantic owns definitions and Zones. Correct shared visual defects as a class across consuming surfaces.

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
establish visual quality. A full web check is required only when the task contract names it.

## External conditions

Production Worker bindings, object storage, abuse prevention and deployment configuration must be supplied through
supported interfaces. Private provisioning is external; functional and visual acceptance uses isolated fixtures.
