# Software opening completes on the walk Auth host

goal: accounts
manager: accounts
owner: Accounts
reuse: SDK e18, Auth c883

Walk revision `0c4c52c14eb51ff21d901d69060b1fc08d83a341` at 2026-11-07T07:56Z.
J09 passed: automated create, operator opening and outsider-denied open completed
in 2056ms (`software 29dfdb50-e1dd-8417-a388-545a26d83a2e; outsider open HTTP 403`).
Organization create, owner transfer, rename and personal delete also passed
(J06–J08, J18). No remaining SDK e18 repair from this round.


## Integrated ordinary round

Goal: accounts. Manager: content. Tested source `0eb618cfd609c2abb281bbd3ced29e73e685fd71` includes Auth40c038, native fixtures65d590 and allocator6948a892. Ordinary `REZICS_WALK_DEFER_FRONTENDS=0 bun apps/web/scripts/accounts-goal-walk.ts --launch` ran on the worker host, without a remote check ID; observation began2026-11-07T11:53:10.775Z, launcher completed2026-11-07T12:12:11Z with exit0 after supported teardown. Exit0 is process completion, not nineteen-outcome acceptance. Admission succeeded in1320ms on allocated slot1; database, migrations, native Auth, real Kernel worker/relay and API driver were reached. Auth pages became ready. Evidence: `.temp/accounts/journeys.json`, `.temp/accounts/launcher.log`, `.temp/walk/e249c4cc-302e-4529-8b4a-d7453450a8fa/stack.log`. Full per-row UTC/persona/revision/elapsed values are retained in the table and JSON. No screenshots.

Native/API census:12/19 PASS (J01,J02,J05,J06,J07,J08,J09,J11,J12,J17,J18,J19),7 FAIL. These are API-stage assertions, not complete native/browser/growth or promotion acceptance. Slowest FAIL J13,32319ms, public target omitted subject.id. Authoritative launcher next hourly due2026-11-07T12:50:52Z is based on round start; the inner driver printed provisional13:09:49Z before launcher teardown, which is not a second schedule. No watcher or second walk was created.

Current J06-J09 and J18 API assertions passed: organization create/member management, new owner management, new handle/old-handle retirement, automated operator opening with outsider403, personal erasure/sign-in refusal and independent public attribution. J09 elapsed1993ms; J18 elapsed4421ms. No new SDK e18 repair was exposed. Native command/replay/growth, complete downstream erasure and browser/promotion obligations remain distinct and are not passed by these HTTP observations.
