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


## Integrated ordinary round

Goal: accounts. Manager: content. Tested source `0eb618cfd609c2abb281bbd3ced29e73e685fd71` includes Auth40c038, native fixtures65d590 and allocator6948a892. Ordinary `REZICS_WALK_DEFER_FRONTENDS=0 bun apps/web/scripts/accounts-goal-walk.ts --launch` ran on the worker host, without a remote check ID; observation began2026-11-07T11:53:10.775Z, launcher completed2026-11-07T12:12:11Z with exit0 after supported teardown. Exit0 is process completion, not nineteen-outcome acceptance. Admission succeeded in1320ms on allocated slot1; database, migrations, native Auth, real Kernel worker/relay and API driver were reached. Auth pages became ready. Evidence: `.temp/accounts/journeys.json`, `.temp/accounts/launcher.log`, `.temp/walk/e249c4cc-302e-4529-8b4a-d7453450a8fa/stack.log`. Full per-row UTC/persona/revision/elapsed values are retained in the table and JSON. No screenshots.

Native/API census:12/19 PASS (J01,J02,J05,J06,J07,J08,J09,J11,J12,J17,J18,J19),7 FAIL. These are API-stage assertions, not complete native/browser/growth or promotion acceptance. Slowest FAIL J13,32319ms, public target omitted subject.id. Authoritative launcher next hourly due2026-11-07T12:50:52Z is based on round start; the inner driver printed provisional13:09:49Z before launcher teardown, which is not a second schedule. No watcher or second walk was created.

Repair owner: existing Web/Library application composition through Content; existing Semantic startup25545be8 coordinates startup receiving. Auth pages became ready. Web message readiness completed and Vite bundled, but root readiness never reached<500; first retained render cause is Library requires application reading capabilities at apps/web/src/library/application.tsx:40 via useHistoryCurrentOrigin and FollowedCommunities at shell/side-nav.tsx:87. Web ten-minute readiness timed out. Chromium was not launched; pages=[]; desktop1280/phone390 controls were not inspected. Restore installed real reading capabilities around the mounted shell, then complete original Home/security/public identity/Settings controls and hydration in this same walk without screenshots. Retain original native/API, current authority, replay and growth acceptance. The old cloudflare:workers error is not the current measured cause; no speculative dependency upgrade.
