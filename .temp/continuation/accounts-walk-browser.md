# Walk Web resolves Worker bindings for desktop and phone Home

goal: accounts
manager: accounts

Walk revision `50d6ddce544ba428e2f64de731703520790f5d9c` at 2026-11-07T07:15Z.
Auth pages became ready. Web `dev` on walk port 20050 printed ready, then Vite
failed to resolve `cloudflare:workers` from `src/kernel/client.ts` and
`src/features/catalogue/definition-guide-actions.ts`. Chromium then saw
`Failed to fetch dynamically imported module: .../src/client.tsx`. Desktop 1280
and phone 390 were not inspected. J01 native HTTP already passed. Teardown
exited `dev` with code 143.

Repair: Web `dev` on the admitted walk ports must resolve Worker bindings and
stay running through Home and the public person page at 1280 and 390. Keep one
Chromium process. Do not open a second walk.
