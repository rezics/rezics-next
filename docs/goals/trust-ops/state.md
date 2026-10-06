# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-07 07:00 CST) |
| --- | --- |
| Manager | `rezics-next-9b` (ref `[e004e6]`; an idle session shares the name) in tmux `goal-trust-ops`, registered 02:50. |
| Running | T5 G-1235 attempt 2 (`codex-1`): now that T6 has merged, resume it for the rate-limit family and the `store.ts` administrator read, then drop the singleton. G-1246 (`grok`, inherited Access unit repair plus `controller_continuity`). T4 G-1221 dispatches by watcher when trust-ops drops below 2 live. |
| Done | T1 G-1215 merged e64b08472 (C1 first half; evidence sent to the program). T7 G-1219 merged 92f127733 (kernel adds the `actingSubject` line in `work/read-session.ts` with K4). T6 G-1218 merged f0616aaa3 (nested-checkout sites: kernel G-1244, launch G-1230). T2 G-1220 merged c3cf4a388: C1 complete (e64b08472 + c3cf4a388), reported to the program. T3 G-1216 merged 3f156bea0 (Account migration 166). Shared stack: run `task dev:refresh -- --wait` after every merge with a migration; 890 and 166 are pending. Fixes on main: G-722 artifact test 64efc2af6; G-543 rate-limit 1d57e720c, 91d458844. |
| Launch matrix | Approved by the program: 517 public and 247 closed of 764 Main operations (`.temp/trust-ops/launch-matrix-approved.md`, Appendix A plus "launch: answers", plus kernel's composition split). T5 applies it in the same change as the gate. Exposure summary shape sent to launch. |
| Deployment wave | Bootstrap seeds `platform:grant` and the platform-admin grant for the maintainers' principals, and production refuses to start without them (program condition 4). External conditions: 28 in `.temp/trust-ops/external-conditions.md`; the maintainer has been asked about the long-lead ones. |
| Merge notes | When T7 merges, tell kernel (`rezics-next-7e`): it adds `disclosureViewer(principal, this.options.actingSubject)` in `work/read-session.ts`. T3's and T7's owner changes (Account `app.ts`; disclosure, export reader, media and resource routes, QA media fixtures, the observability worker name, Main `index.ts`) were reviewed; merge T3 with `--allow-scope`. |
| Merge notes (T5) | T5's route declarations are owner changes across `services/main/src/routes/*.ts`: merge with `--allow-scope`, then `task gen` and `task main:typecheck`, and tell kernel and launch that new routes need an `exposure`. Send C1 evidence to the program when T1 lands. |
| Lessons | Workers cannot read the main checkout's `.temp` from their worktrees. Quote the needed facts in the brief, or copy files into `<worktree>/.temp/goal/inputs/` and name that path. Exclusive `shared:` slots are not labels. Overflow cap is 10 live; resume also needs a slot. |
| Follow-ups (design) | After T5 and T6: carry each route's rate-limit family in the same per-route declaration as `exposure`, replacing the separate inventory in `rate-limit/routes.ts`. The G-543 guard was red on main from a missing family and an anonymised hook; both were fixed in 1d57e720c and 91d458844. |
| Critical path | T1 → T5 → launch L4, L7 and the web hide-closed task; T1 → T2 → C1 complete (launch L6); T1 → kernel K5, K6, K8 and launch L5, L8. |
