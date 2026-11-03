# App shell

Every route uses `AppShell` from the root route. The top bar keeps the existing header search, logo, shared Create actions, notifications and account controls. Account display controls use the existing theme, contrast and locale protocols; the shell keeps system preference listeners mounted while the menu is closed. The phone navigation and navigation drawer use the shared responsive Menu.

Following a Realm means following its carrying Space; the shell reads at most 100 follows, enriches at most 12 active readable Spaces, groups readable Realms separately, uses category icons, and links to Following for the full list.

Library and Collections stay visible as unavailable destinations while session or operation admission is absent.

Navigation reads are private and bound to the current account, locale and operation admission. Unread counts use the inbox's existing current-viewer query and blue badges.

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
