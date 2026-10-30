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
Do not turn deferred feeds, recommendations or personal saved queries into implicit requirements. Backend contracts
stay with their product owners; preparation and privacy changes must remain visible in the interface.

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
