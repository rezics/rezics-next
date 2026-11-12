# App shell

Every route uses `AppShell` from the root route. The root mounts Library's installed application boundary around the reader host, shell and route content, so the shell's current-reader consumer and route error or closed states use the same capabilities. Library owns this consumer composition; Session retains its installed reader and admission producers. The top bar keeps the existing header search, logo, shared Create actions, notifications and account controls. Account display controls use the existing theme, contrast and locale protocols; the shell keeps system preference listeners mounted while the menu is closed. The phone navigation and navigation drawer use the shared responsive Menu.

Following a Realm means following its carrying Space; the shell reads at most 100 follows, enriches at most 12 active readable Spaces, groups readable Realms separately, uses category icons, and links to Following for the full list.

Library and Collections stay visible as unavailable destinations while session or operation admission is absent.

Navigation reads are private and bound to the current account, locale and operation admission. Unread counts use the inbox's existing current-viewer query and blue badges. AppShell binds Inbox's shell port so the badge observes that same session query, and Settings' shell port so display, heading, subject addresses and exposure use the installed shell and kernel implementations.

Decision: followed-community navigation consumes `session/reader` directly, preserving the current viewer, locale,
operation and response guards. The root shell surrounds the Library route boundary; its default rail must render
without that boundary. The existing mounted `app-shell.test.tsx` case exercises the default rail rather than replacing
it with prepared communities, retaining its landmark and destination assertions. The test is registered at file
scope. Community icon assertions count the two linked category icons independently of the group folding controls.

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

Decision: Create uses the primary color in both bars, phone destination selection uses ink blue, and followed-community
groups start expanded with independent collapsible headings; group folding lasts for the mounted rail or drawer only.
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

The rail and phone drawer consume the same contributed leaves and creations. Long labels wrap with fixed-size icons;
page content reserves the measured phone bar height, which already includes the safe-area inset. Query and fragment
changes preserve the initiating control's focus; a new path focuses the page main without changing scroll position.

Selected source comparison: experiment `7c041ee376` supplied the phone session/return behavior and path-change focus
behavior. Current Book navigation, Menu dismissal, account controls and unread ownership remain the implementation
authority. Preparing, signed-out and unavailable phone Create stories supplement the installed application tests.
