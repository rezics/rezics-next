# App shell

Every route uses `AppShell` from the root route. The top bar keeps the existing header search, logo, shared Create actions, notifications and account controls. Account display controls use the existing theme, contrast and locale protocols; the shell keeps system preference listeners mounted while the menu is closed. The phone navigation and navigation drawer use the shared responsive Menu.

Following a Realm means following its carrying Space; the shell reads at most 100 follows, enriches at most 12 active readable Spaces, groups readable Realms separately, uses category icons, and links to Following for the full list.

Library and Collections stay visible as unavailable destinations while session or operation admission is absent.

Navigation reads are private and bound to the current account, locale and operation admission. Unread counts use the inbox's existing current-viewer query and blue badges.
