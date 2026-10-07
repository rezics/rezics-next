# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`. Handover written 2026-10-07 ~05:30 CST by the Claude
manager (`rezics-next-7e`) for a GPT-6.1 Sol manager in tmux `goal-kernel`.

## Contracts

| Contract | State |
| --- | --- |
| C0 | Landed: G-1217 at e75dda7b4 (regen 4bc72dab2). |
| C2 | First slice landed: G-1226 at 7adef77bc, fix fac97ab59. Second slice (Content on any admitted target, Zone pages first) is G-1289, queued. Later: every profile off the TS DSL. |
| C3 | First path landed: G-1228 at d27907918, bf6503e96, 02542960b. |
| C4 | In flight: G-1243 (K6). |
| C5 | In flight: G-1282 (K7). |
| C6 | In flight: G-1296 (K5). Model-generation custody is part of it. |

Also merged and closed today: G-1229 (legal content never poisons
projections), G-1237 (document recovery proof), G-1244 (nested pool
checkouts), G-1249 (platform gates on generic operations), G-1272 (test
repairs), plus manager fixes a39e422f5 (search-limits import cycle),
0939aa377 (work-stats budget) and e6f2daa64 (Content test types).

## Open tasks

| Task | State at handover | Next action |
| --- | --- | --- |
| G-1243 K6 (C4) | Manager rebased it onto main (`c00d7a1c1`; kept both fields in `tests/qa/integration/media-support.ts`). Its merge was running in the background; log `.temp/kernel/merge-G-1243.log`. | If merged: `task gen`, `task main:typecheck`, `task web:typecheck`, regeneration commit, `task dev:refresh -- --wait` (Access migration 1499 and the automatic Statement conversion in prepare-storage), close it, send the program C4's acceptance. If refused: retry, or resolve conflicts in its worktree. Then K8a. |
| G-1271 | Done (private names on kernel reads). Merge retry was running; log `.temp/kernel/merge-G-1271.log` (the first try failed only because main moved during the gate). | Merge, `task gen` (served `creditedName` is now lexical or `{ reference, status: 'unavailable' }`), close, tell launch its web must render a withheld `creditedName` as unavailable. |
| G-1245 K8a | Done except two files it could not hold. | After G-1243 closes: `task goal -- reclaim G-1245 docs/goals/kernel/tasks/G-1245.md` (brief already claims `structure-schema.test.ts` and `discovery/effects.ts`), resume on `codex-1` high for the `item-list` expectation and "populated libraries migrate to point revisions" in `structure-schema.test.ts`, and classifying the `membership-normalized` event in `discovery/effects.ts`. Membership converts automatically in `dev:refresh`. On merge tell launch its ID (episode acceptance). |
| G-1282 K7 (C5) | Attempt 2 running: binding layer done; building the seek index, the three templates, web callers and the fourth (followed-Concept feed) template. Its migration range was not reclaimed (reclaim refuses while running). | Merge with `--allow-scope` (goalctl renumbers migrations). Then send launch the feed template's query IRI and the program C5's acceptance. Next slice for the same worker: more template views. |
| G-1290 | Running: public-name projection with parent fences and resumable batches. | Review, merge, close. |
| G-1296 K5 (C6) | Running (`xhigh`): slim command with compact proof, proof retirement after owner custody, model-generation custody. | Merge, send the program C6's acceptance. Next slice for the same worker: chapter paging seek qualification (record §10 Q2-tail) and the default-graph qualification (record §3). |
| G-1297 | Running (`grok`): `complete` on three kernel collection reads. | Merge, close. |
| G-1289 (C2) | Queued; `depends: [G-1284, G-1288]` (launch, trust-ops), enforced by goalctl. | Dispatch on `codex-1` high when both merge; stage their function signatures (from their handoffs) into its `.temp/ref/`. |

## Promises to other Goals

- launch: K8a ID and episode acceptance; K7 feed query IRI; G-1271's
  `creditedName` shape; G-1289 for Zone-page documents (launch owns the
  publication receipt binding and published-revision membership in G-1284).
- trust-ops: the Person-owned scheme variant ships behind
  `platform:person-schemes` (recorded in GOAL.md, classification item);
  G-1289 uses G-1288's `zone.edit` bridge, never `requireZoneEditor` directly.
- program (`rezics-next-7b`): contract landings with commit and acceptance.

## Do not miss

- Codex workers cannot read the main checkout's `.temp/`. After a dispatch
  succeeds, copy references into `.temp/worktrees/<id>/.temp/ref/`; creating
  that directory before dispatch makes dispatch refuse.
- After any merge that regenerates model artifacts or adds a migration: `task
  gen`, type checks, regeneration commit, `task dev:refresh -- --wait`. Upgrades
  never need a manual step: relay scope initializes at Fuseki startup,
  membership and Statement conversions run in `dev:refresh` prepare-storage.
- `goalctl merge` runs the unit gate and repository guards and renumbers
  migrations itself; many test files already fail on main and are reported as
  "also fails on main". `g-630-zone-restore.test.ts` hangs on main (launch's).
- After G-1243 merges, `classification/resolve.ts` can import
  `work/search-limits.ts` directly (the import-cycle fix left it alone).
- When a task next touches `scripts/datasets/bootstrap.ts`, replace its direct
  platform-administrator rows with G-1265's designation and
  `tests/qa/fixtures/platform-grant.ts`.
- Later kernel work, not yet briefed: reply restore after deletion; Discover
  re-measure after Structure changes; external search documents; cold history
  export (RDF Patch); Jena CLI and `tdbstats` in Task and CI with the program;
  the classification capability; record §10's remaining population-scale
  queries (event histogram, follows recipients, verification walk, purge
  campaign, hot-category ordering, ranking full-history rebuild, EventTime
  precision).
- Scouts and notes from today: `.temp/kernel/scouts/`, `.temp/kernel/K2-inputs.md`.
