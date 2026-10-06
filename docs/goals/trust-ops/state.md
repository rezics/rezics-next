# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07 06:30 CST) |
| --- | --- |
| Manager | `rezics-next-9b` (ref `[e004e6]`; an idle session shares the name) in tmux `goal-trust-ops`, registered 02:50. |
| Running | T3 G-1216 round 2 (`codex`); T6 G-1218 (`cursor`); T5 G-1235 attempt 2 (`codex-1`; its inputs are copied into the worktree's `.temp/goal/inputs/`; the rate-limit family and the `store.ts` administrator read are deferred until T6 merges, and the singleton table stays until then). |
| Done | T1 G-1215 merged e64b08472 (C1 first half; evidence sent to the program). T7 G-1219 merged 92f127733 (kernel adds the `actingSubject` line in `work/read-session.ts`). Fixes on main: G-722 artifact test 64efc2af6; G-543 rate-limit 1d57e720c, 91d458844. |
| Briefed, waiting | T2 G-1220 (next free slot; launch keeps `space/create-authority.ts` unclaimed; launch's G-1238 claims `space/create.ts`: tell launch if T2 changes what that file calls). T4 G-1221 (after T3; also carries the g-543 Turnstile browser regression). |
| Launch matrix | Approved by the program: 517 public and 247 closed of 764 Main operations (`.temp/trust-ops/launch-matrix-approved.md`, Appendix A plus "launch: answers", plus kernel's composition split). T5 applies it in the same change as the gate. Exposure summary shape sent to launch. |
| Deployment wave | Bootstrap seeds `platform:grant` and the platform-admin grant for the maintainers' principals, and production refuses to start without them (program condition 4). External conditions: 28 in `.temp/trust-ops/external-conditions.md`; the maintainer has been asked about the long-lead ones. |
| Merge notes | When T7 merges, tell kernel (`rezics-next-7e`): it adds `disclosureViewer(principal, this.options.actingSubject)` in `work/read-session.ts`. T3's and T7's owner changes (Account `app.ts`; disclosure, export reader, media and resource routes, QA media fixtures, the observability worker name, Main `index.ts`) were reviewed; merge T3 with `--allow-scope`. |
| Merge notes (T5) | T5's route declarations are owner changes across `services/main/src/routes/*.ts`: merge with `--allow-scope`, then `task gen` and `task main:typecheck`, and tell kernel and launch that new routes need an `exposure`. Send C1 evidence to the program when T1 lands. |
| Lessons | Workers in worktrees cannot rely on reading the main checkout's `.temp`: copy inputs into `<worktree>/.temp/goal/inputs/`. Overflow cap is 10 live; resume also needs a slot. |
| Follow-ups | Access unit manifest has 21 inherited failures (T1 reproduced them on the original sources): g-1005-fixture-consent, g-512-native-language, g-596-localized-rules, g-963-memberships, g-964-joining-policy, g-964-private-leave. Brief a repair task. |
| Follow-ups (design) | After T5 and T6: carry each route's rate-limit family in the same per-route declaration as `exposure`, replacing the separate inventory in `rate-limit/routes.ts`. The G-543 guard was red on main from a missing family and an anonymised hook; both were fixed in 1d57e720c and 91d458844. |
| Critical path | T1 → T5 → launch L4, L7 and the web hide-closed task; T1 → T2 → C1 complete (launch L6); T1 → kernel K5, K6, K8 and launch L5, L8. |
