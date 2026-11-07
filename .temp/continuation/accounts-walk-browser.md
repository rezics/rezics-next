# Walk Web resolves Worker bindings for desktop and phone Home

goal: accounts
manager: content

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

## Received Library root; next actual shell composition frontier

Actual ordinary source70f7c7e9c7fc6ff08025044be46763221763f9d3 includes named Library88e80 through f81392a78f. Native/API observation began2026-11-07T13:27:02.282Z; all nineteen rows are retained,12/19 API-stage passes. Launcher and journey JSON are the current safe artifacts, with the preceding round archived under .temp/accounts/rounds/0eb618cfd609c2abb281bbd3ced29e73e685fd71/. No remote check ID exists for this ordinary supported walk. Auth pages became ready and Web message preparation completed35768ms. Web reached SSR, whose first current render failure is:

`Error in renderToReadableStream: Error: Recent Search requires a mounted host`

Stack: useRecentSearchOperation at apps/web/src/search/recent-host.tsx:45, useRecentHistory at search/recent-history-hook.ts:26, ShellSearch at search/header-search/shell-search.tsx:25. The prior Library provider error has not recurred in the current trace; this does not establish complete Library native/browser recovery. First per-error UTC is unretained; the driver native observation UTC and eventual launcher finish are retained separately. No screenshot.

Existing Search/Web composition ownership through Content receives the complete repair: install the actual Recent Search host around the mounted shell through the existing production adapter and current viewer observation. Preserve per-reader authority, synchronous credential/exposure retirement, uncertainty, bounded native lifetime and original receiving/growth assertions. Establish root HTTP readiness, then complete original authenticated Home/security, public identity and Settings desktop1280/phone390 control and hydration inspection on this same walk. Do not replace Search authority with a stub, infer a pass from typing, weaken the strict consumer or create a second walk. Auth catalogue/lifetime, J03/J04/J10 and public Subject/Realm repairs retain their separate existing owners. Final browser frontier and teardown are appended after this bounded round settles.

Final frontier: Web was not ready after ten minutes; pages=[] and Chromium never launched. Supported teardown settled2026-11-07T13:45:54Z with launcher exit0, not a product pass. First safe Search-render log inspection was2026-11-07T13:40:47Z; error-origin UTC is unretained. Current artifacts are archived under .temp/accounts/rounds/70f7c7e9c7fc6ff08025044be46763221763f9d3/. Authoritative next hourly due2026-11-07T14:20:56Z, same handle/controller refresh; inner14:44:06Z was provisional. No additional walk is scheduled here.


## Paid composition received; runtime verification remains open

The authenticated final receiving packet names64fd7d5011's existing root composition. This walk receives its delta relative to88e80: one actual RecentSearchBinding now covers AppShell and outlet inside LibraryApplicationBoundary. Source/credential retirement and current viewer authority remain owned by the existing adapter. The prior70f7 runtime evidence and pages=[] remain unchanged until dev verification runs the original handle.

Pre-receive focused check b45c3404-50ba-4903-8400-a5b77b6f3b27 on21217b31231741818fb70fe17892dcb25002b030 additionally exposed producer root fixture setup: router.options.context was absent at buyerHistory access, scrollTo was absent during restoration, and Ordinary root page was never reached (42.58ms). Existing Search/root owner receives complete anonymous/current-viewer replacement fixture repair without weakening assertions. Per-case UTC is unretained; safe check submission UTC2026-11-07T13:47:17.747Z and full log .temp/check-logs/b45c3404-50ba-4903-8400-a5b77b6f3b27.log are retained. Final worker policy is changed-workspace typing only; actual SSR/desktop/phone/native/browser/growth closure remains dev verification, not another unchanged worker proof.
