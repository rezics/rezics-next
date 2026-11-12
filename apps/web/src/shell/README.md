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

## Phone navigation clearance

`PhoneNavigationClearance` scopes one `--bottom-nav-height` value around the shell and observes only its own phone
navigation. It uses a 5rem SSR fallback plus the safe-area inset; the measured navigation box includes that inset,
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
