# Walk Web resolves Worker bindings for desktop and phone Home

goal: accounts
manager: accounts

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T08:27Z.
Auth pages became ready. Web `dev` on walk port 20050 printed ready, then Vite
failed to resolve `cloudflare:workers` from `src/kernel/client.ts` and
`src/features/catalogue/definition-guide-actions.ts`. Chromium then saw
`Failed to fetch dynamically imported module: .../src/client.tsx`. Home and the
public person page answered HTML 200 at 1280 and 390 without hydration; Settings
`/en/settings/notifications` answered 404 at both widths. Desktop and phone
controls were not inspectable. Native API is 12/19 and stays separate. Teardown
exited `dev` with code 143.

Repair: Web `dev` on the admitted walk ports must resolve Worker bindings and
stay running through Home and the public person page at 1280 and 390. Keep one
Chromium process. Do not open a second walk. Upgrade only with a matched
failure, version and upstream fix, coordinated Web/Semantic lockfile.
