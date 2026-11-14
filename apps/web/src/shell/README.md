# App shell

Every route uses `AppShell` from the root route. The root mounts Library's installed application boundary around the reader host, shell and route content, so the shell's current-reader consumer and route error or closed states use the same capabilities. Library owns this consumer composition; Session retains its installed reader and admission producers. The top bar keeps the existing header search, logo, shared Create actions, notifications and account controls. Account display controls use the existing theme, contrast and locale protocols; the shell keeps system preference listeners mounted while the menu is closed. The phone navigation and navigation drawer use the shared responsive Menu.

## Compact global sidebar

Decision: desktop, script-free fallback and phone drawer share the explicit `global-sidebar` placement policy:
Home, Books, Search and signed-in Library only. Library retains an unavailable state while its native operation is
closed. Inbox stays in the top bar and phone tabs. Creation menus and contextual navigation keep their existing
placement and admission rules. Account tools on Settings receives the remaining registered navigation leaves;
one link in the existing account menu opens that section. Collections, Orders, Drafts, Studio, management and
import/editor destinations remain reachable there with their existing operation admission and native route checks.
No native authorization changes or CSS-based admission are involved. TODO: receive future user-customized sidebar
placement through the policy seam when its native preference contract exists; there is no new preference state.

The sidebar has one compact Following section in native order and one Manage following link. It requests one
12-row FULL Follow page with the indexed `targetType=space` filter through Library's shared follow transport.
Subject follows cannot displace Spaces before filtering. FULL supplies the current target label and canonical
Space-address or Realm-ID destination; unavailable/withheld targets or destinations produce no link. The shell
uses no Space/Realm point reads, UUID fallback addresses, owner-based Realm inference or invented alternate paths.
Native label language annotations survive the projection. The drawer receives that same projection, status and
manage link. Rows keep 44px targets, visible keyboard focus, segment-boundary current-path matching and current
theme tokens; collapsed rails retain named icons and an accessible manage control.

The generic Follow engine is the subscription authority for Subject, Collection, Space and Zone targets.
A Realm-backed Space can supply a Realm destination; an ordinary Space can supply its address. Zone is an
independent identity under [Zones](../../../../docs/zones.md). This Space-filtered shell receiver accepts only
Space and Realm destinations; other native destination kinds produce no link.

Navigation reads are private and bound to the current account, locale and operation admission. Unread counts use the inbox's existing current-viewer query and blue badges. AppShell binds Inbox's shell port so the badge observes that same session query, and Settings' shell port so display, heading, subject addresses and exposure use the installed shell and kernel implementations.

Decision: followed-community navigation consumes `session/reader` directly, preserving the current viewer, locale,
operation and response guards. The root shell surrounds the Library route boundary; its default rail must render
without that boundary. The existing mounted `app-shell.test.tsx` case exercises the default rail rather than replacing
it with prepared communities, retaining its landmark and destination assertions. The test is registered at file
scope. Focused shell assertions cover compact placement, both native destination kinds and the single manage link.

Decision: locale selection uses router-managed document navigation, preserving the current page, query and fragment
in browser history and honoring leave-page blockers. The destination rereads native data and renders translated UI;
supplied names and source text keep their original language. The focused locale regression covers the production
rewrite/provider as well as the injected reader lifetime; seeded native/browser acceptance remains required.

Decision: the root mounts the existing RecentSearchBinding around both AppShell and its route outlet. Header
search and route consumers share one QueryClient-owned host, session observer and retirement boundary. Mounting it
inside the outlet leaves the header without a host and makes ordinary `/en` SSR fail; the focused Web startup and
existing header tests retain this receiving contract.

## Navigation contributions

Journey owners supply leaves and creation links through `AppShellProps.navigation` in
[`shell/shell.tsx`](shell.tsx). The shell retains desktop, phone and script-free rendering;
owners do not copy its layout, menus, settings or Appearance controls. Phone CreateSheet consumes the same
`NavigationEntries` with `kind="creation"`; the current navigation also renders contributed creation links.

[`shell/navigation.ts`](navigation.ts) exports `NavigationContribution`,
`NavigationContext`, `NavigationOperation`, `NavigationSession`, `ResolvedNavigationEntry`, `createNavigation`,
`resolveNavigation` and `navigationPathname`. Contributions have a stable owner-namespaced `id`, `kind`, `group`,
finite `order`, plain-text `label`, unprefixed local `href`, optional icon, `match`, `signedIn` and existing
`operation`. Navigation groups are `primary` then `personal`; creation entries use `create`, last. Within a group,
order then id determines placement. Label/href functions receive only `{locale, pathname}` with the current locale
prefix removed. Returning a null href omits an unsupported context. Matching is exact by default; `prefix` includes
descendants at a path-segment boundary. Query/fragment links retain their suffix and use the path for current state.
Duplicate ids and destinations within the same kind are rejected. Snapshots copy and freeze metadata; callbacks
must be pure, route-static functions, never close over account data, credentials or request state.

[`shell/navigation-view.tsx`](navigation-view.tsx) exports `defaultNavigation`,
`NavigationProvider({contributions?, children})`, `NavigationEntries({context, session, kind?, children})` (a render
function receiving `ResolvedNavigationEntry`) and `NavigationLinks({context, session, kind?, label, className?})`.
The default ids remain `shell.home`, `shell.search`, `shell.library`, `shell.orders`; Library and Orders keep their
existing signed-in operation gates and descendant matching. Public leaves render SSR anchors without JavaScript.
Signed-in entries wait for hydration and session preparation; operations use existing Exposure and its bounded,
private no-store viewer read. An offered entry grants no read or command permission. There is no user registry,
account-menu fetch, new permission engine or private data in static configuration.

Fixed Subject, Realm and provider-review entries use exact operation markers from the existing Exposure read, like Sales, because their public native routes have no gate group.

The [Subject purchase slot](../features/pages/README.md#subject-purchase-entry-slot) owns optional purchase regions and their public/private boundaries.

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

The shared navigation pattern is `Patterns/Navigation/Contributions` (public leaf, private pending, offered/gated creation, locale/path). It uses the delivered components; source integration and prepared patterns establish neither native journey acceptance nor full page/visual review.

## Current workspace navigation

Decision: Book and Studio declare `ShellContextNavigation({ label, children })` from
`shell/contextual-navigation.tsx` inside their existing route, reader and data providers. The shell places that
one current region after global links and before Following, in the expanded desktop sidebar or the existing open
phone navigation Menu. Reading and editing stay in the center canvas without another route sidebar.

The declaration portals its children from the consumer's React tree; the shell stores only live owner identities
and the admitted host, never navigation elements, callbacks carrying private data or copied reader state. The
deepest mounted router match owns the region. Within one match the latest mounted declaration wins; removing it
restores the remaining owner. Path replacement retires the previous scope before layout effects, while query and
fragment changes keep the current scope. Registration cleanup removes only its exact owner instance, including
effect replay. Unmounting or retiring a reader removes its portal in the same commit without waiting for shell
registration cleanup. Labels and children update directly from consumer props and retain the consumer's contexts.

The collapsed desktop rail has no contextual tree; its existing expand control restores the region. On phones,
opening the existing navigation Menu admits its host, and closing it removes that tree. Changing viewport removes
the old host before admitting the other surface. Keep editable state and dirty-page protection in the route, above
the declaration, so drawer and collapse changes cannot discard an editor draft. Consumers use ordinary anchors or
router Links for selection, with their existing blocked-departure behavior. Menu owns dismissal and keyboard focus
return, including physical DOM capture for links rendered through a portal; the region schedules no focus work.

The consumer owns its localized label and row copy, exposure checks and private mount gates. There are no added
shell strings, I/O, persistence, navigation contributions or per-row projection. Cost is one live region and
O(rendered navigation). Focused regression source covers replacement/removal, nested owner selection, context
retention and single desktop/phone placement. App Shell stories cover the current region, collapsed rail and phone
keyboard close/return; runtime and integrated Book/Studio acceptance are separate verifier work.

## Phone navigation clearance

`PhoneNavigationClearance` scopes one `--bottom-nav-height` value around the shell and observes its own phone
navigation and header. It uses a 5rem SSR fallback plus the safe-area inset; the measured navigation box includes that inset,
so fixed selection surfaces use the measured value directly. Resize and phone/desktop transitions update the value
only when it changes. Unmount disconnects the observer, removes media listeners and clears the inline value. Desktop
and standalone displays use zero clearance, and standalone hides phone navigation.

Decision: Standalone display mode hides phone navigation and uses zero selection clearance; ordinary phone pages use measured navigation height with a 5rem SSR fallback.

Decision: Create uses the primary color in both bars, phone destination selection uses ink blue, and followed communities use one non-collapsible section without empty category headings.
Unknown sessions reserve account-control space with reduced-motion-aware skeletons; failed sessions show a visible
unavailable message rather than an indefinite loading placeholder.

Decision: The phone You destination is a real settings link hidden while script runs; noscript CSS reveals it so
the fallback never prints markup as text.

## Session and navigation continuity

Decision: both Create menus share the same session panel: preparing shows progress, signed-out offers sign-in,
unavailable explains the failure and offers sign-in recovery, and signed-in shows the current admitted creations.
The phone Inbox waits while preparation is pending or unavailable. Shell sign-in links receive the router's existing
localized public URL, including its admitted query and excluding its fragment; they do not rebuild it from pathname.
Account and unread queries retain their existing owners, private exposure and viewer retirement.

The rail and phone drawer consume the same essential leaves and followed destinations. Creation menus retain contributed creations. Long labels wrap with fixed-size icons;
page content reserves the measured phone bar height, which already includes the safe-area inset. Query and fragment
changes preserve the initiating control's focus; a new path focuses the page main without changing scroll position.

Selected source comparison: experiment `7c041ee376` supplied the phone session/return behavior and path-change focus
behavior. Current Book navigation, Menu dismissal, account controls and unread ownership remain the implementation
authority. Preparing, signed-out and unavailable phone Create stories supplement the installed application tests.

## Responsive header and shared recovery

Decision: below 1024px, identity and account actions occupy the first header row and search owns the full second
row. Desktop uses flexible side columns with a bounded action group; translated labels may wrap without consuming
the search entrance. Unavailable-account text is visible at every width beside the safe sign-in recovery anchor.
Create in the header and phone tabs uses `ShellCreationMenu`, the existing contribution contract and the same
Menu focus/dismissal owner. Standalone phone displays retain header account and appearance entrances when tabs are hidden.

The shell measures both header and phone navigation. `--shell-header-height` positions the desktop rail, bounds its
scrolling area and offsets heading/recovery anchors; the bottom measurement still includes the safe area exactly
once. Before hydration the header reserves 7.5rem below 1024px and 4rem above it. Loading uses `PageHeading` like
ready pages. Route recovery stays in the page's content column with shared Empty slots and wrapping actions,
without imposing a card around route content. The shell does not change private reads, session/exposure admission,
account internals or navigation destinations. All control copy uses the existing eight-locale messages.

Decision: this source batch adds focused plays to the actual shell stories and runs only the Web workspace typing
command under the brief's final minimal-verification instruction. Runtime, keyboard, visual, native and broader
regression execution is deferred to the dev verifier. Existing regression sources remain unchanged.
