# State

Wrap-up checkpoint for [API](GOAL.md), 2026-10-13 06:03 UTC. Paused at the maintainer's order delivered by Program (`program-wrapup-api-20261013`), replacing the earlier widening/resume plan. No further dispatch, next step or fix round. Program will stop the coordinator after receiving this checkpoint; no watcher or worker wait is armed.

| Measure | Checkpoint |
| --- | --- |
| Rows proved / scope | **1/67** since 2026-10-13 (G-2122); main cells **6 proved, 0 pending, 0 not applicable, 396 missing**. The rest of this table is the checkpoint of the wrap-up before it |
| Rows covered by analysis | All 67 once, in 18 briefs, with every persona's operation/current inferred answer/intended answer/test lead or none; manager corrections preserved in those briefs |
| Draft outcome work | 11 Books rows / 66 candidate cells on three unmerged branches; none executed, none certified. Planner failure is infrastructure, not a pending product cell |
| Worker state | 0 live, 22 open; 15 matrix sessions idle for step two (five interrupted by Program), three blocked Books drafts, one merged/incomplete tooling task, three read design notes |
| Own attempt count | 22 first + 8 step resumes + 2 fixes = 32 invocations; no capacity/transport retry. Raw first share 22/32 = 68.75%; method excludes step resumes: **22/24 = 91.67%** |
| Attempts per landed task | G-2074: **3** (first + two fixes), one landed/incomplete task; median/max 3. No outcome task landed or closed verified |
| Own worker-token count | 55,100,802 input (52,192,640 cached), 301,488 output; sum of recorded turn.completed usage in all 32 attempt logs, excluding manager and gates. Status currently reports 53.3M/278.9k; use this explicit log count for the checkpoint. Tokens/proved row undefined |
| Landing attempts | Four merge invocations, once each: G-2074 passed; G-2075/G-2076 refused unit guards; G-2077 refused claim. No repair, override or retry |
| Durable record | Matrices/corrections and design rulings committed in 02e3868c4; archival matrix appendices intentionally exceed execution-brief length under the explicit wrap-up request |
| Retained set | Gates no outcome row. Ordinary integration starts on fresh stacks (Program loan probe passed 11.9 s); only retained growth/restore blocked |
| Scope findings | Continue preview and global year-facet gaps have candidate complete API alternatives from static reading, still unqualified; per-Work contributions/submissions discovery is later. No scope promotion inferred |

G-2074's code gates passed at first merge attempt: affected types, every affected unit file and repository guard. Merged head f7dd105d8578 contains its five claimed files. Its latest build failed after 47.871406 s at backup validation and restore refused compatibility after 5.458436 s; no fresh manifest or complete preparation timings. Passing code gates does not complete the retained-set outcome, so it remains open. The final cap decision in its brief splits the remaining backup boundary for the next plan; nothing is dispatched.

## Refusals, first line

- `G-2075 introduced unit failures; not merging:` — guard reason `Cannot resolve imported test helper at scripts/qa/cases/outcomes.ts:234: pathToFileURL`; confirmed passing on main and failing on the branch.
- `G-2076 introduced unit failures; not merging:` — same guard reason and branch/main comparison.
- `G-2077 changed files outside its claim:` — `tests/qa/support/personas.ts`; the worker's planner was also blocked. No ownership override.
- G-2074 unresolved runtime reason: `Catalogue backups must stay in this checkout .temp`. Its merge gate passed; this is the remaining rebuild blocker, not a merge refusal.

## Open tasks

Each task's durable brief is linked below. Branches are `goal/g-<number>`; all worktrees are clean. Stopped tasks have no step-two file changes; their sessions are kept. Proposed answers with unsettled decisions are explicitly held in the manager correction, not dispatched.

| Task / attempts / state | Work retained | What is left |
| --- | --- | --- |
| [G-2074](tasks/G-2074.md) / 3 / merged | Merged public home-document seed-helper repair, fixture-authorized manifest boundary and refusal evidence; five files. | Load set still absent/incompatible: backup destination refuses canonical storage. Final fix cap reached; dated split decision in brief. Keep merged/open, not verified. |
| [G-2075](tasks/G-2075.md) / 2 / conflict | Four Books declarations + shared HTTP test, 24 unexecuted candidate cells; five files. | Loader guard refusal; fix nothing. Qualify hub/ambiguous/mixed/catalogue after a new plan repairs the scanner. |
| [G-2076](tasks/G-2076.md) / 2 / conflict | Four Books declarations + shared HTTP test, 24 unexecuted candidate cells; five files. | Loader guard refusal; fix nothing. Qualify tracking/device/loan/expired-loan outcomes after scanner repair. |
| [G-2077](tasks/G-2077.md) / 2 / exited | Three Books declarations + shared HTTP test, 18 unexecuted candidate cells, plus unclaimed personas.ts GET-key change. | Claim refusal; fix/reclaim nothing. Resolve helper ownership and scanner under a new plan, then qualify import/export/resume. |
| [G-2078](tasks/G-2078.md) / 2 / stopped | No commits or dirty files; four-row matrix and corrections in brief; step two stopped by Program. | Language, thousand-chapter/episode and parts/whole tests remain unwritten; retain session idle. |
| [G-2095](tasks/G-2095.md) / 2 / stopped | No commits or dirty files; VN four-row matrix/corrections retained; step two stopped. | Declarations and HTTP tests unwritten; retain session idle. |
| [G-2096](tasks/G-2096.md) / 2 / stopped | No commits or dirty files; anime four-row matrix/corrections retained; step two stopped. | Declarations/tests unwritten, including G-2109 search/sitemap/concurrent-restriction prerequisites; retain session idle. |
| [G-2097](tasks/G-2097.md) / 2 / stopped | No commits or dirty files; manga four-row matrix/corrections retained; step two stopped. | Declarations/tests unwritten; scoped catalogue continuation/direct-year qualification remains; retain session idle. |
| [G-2098](tasks/G-2098.md) / 2 / stopped | No commits or dirty files; game four-row matrix/corrections retained; step two stopped. | Declarations/tests unwritten; retain session idle. |
| [G-2099](tasks/G-2099.md) / 1 / exited | No commits; recipe discovery/reading four-row matrix and corrections in brief. | Declare/test selected public recipe, scaling/pins, full browse and G-2111 imported-source reading slice; ordinary-reader draft selection uncertain. |
| [G-2100](tasks/G-2100.md) / 1 / exited | No commits; recipe tracking/authoring/exchange three-row matrix and corrections in brief. | Declarations/tests absent; generic whole-recipe standing accepted. Anonymous exchange/transfer provenance and cooking-step scope remain decisions, not code instructions. |
| [G-2101](tasks/G-2101.md) / 1 / exited | No commits; Realm creation/admission/roles/rules four-row matrix and corrections in brief. | Declarations/tests absent; natural founder, partial grants, localized rules and private-persona boundaries need real HTTP qualification. |
| [G-2102](tasks/G-2102.md) / 1 / exited | No commits; boards/threads/ranking/moderation four-row matrix and corrections in brief. | Boards resource/operation contract unsettled; other declarations/tests absent. Keep review/placement/moderation/appeal authorities distinct. |
| [G-2103](tasks/G-2103.md) / 1 / exited | No commits; closure direct/thread/directory/roster four-row matrix and corrections in brief. | Real closure and absent-equivalent HTTP tests absent; qualify roster status, independent publication survival and G-2109 costs. |
| [G-2104](tasks/G-2104.md) / 1 / exited | No commits; closure Zone/feed/ranking/search four-row matrix and corrections in brief. | Real composition tests absent; distinguish exact adoption from independent publication, retained populations and G-2109 costs. |
| [G-2105](tasks/G-2105.md) / 1 / exited | No commits; closure notifications/media two-row matrix and corrections in brief. | Recipient/process-notice/media-validator tests absent; G-2109 notification-page/cost prerequisite; provider-send freshness remains a limit. |
| [G-2106](tasks/G-2106.md) / 1 / exited | No commits; Zone pages/navigation/publication/home four-row matrix and corrections in brief. | Owner saves home/navigation/layout as web does, publishes, visitor reads: reported 400 must be qualified first; raw navigation draft privacy/replay/credit tests absent. |
| [G-2107](tasks/G-2107.md) / 1 / exited | No commits; Realm-less/lifecycle/revoked-editor three-row matrix and corrections in brief. | Declarations/tests absent; prove retained draft recovery and prior exact public bundle under effective revocation/lifecycle. |
| [G-2108](tasks/G-2108.md) / 1 / exited | No commits; Zone attachment/inventory/withdrawal/discussion four-row matrix and corrections in brief. | Declarations/tests absent; dual authority, either-side withdrawal, exact platform grants and mandatory-review contribution path need qualification/decision. |
| [G-2109](tasks/G-2109.md) / 1 / exited | No commits; ancestry design note and all Program conditions in brief; Read by program: 2026-10-13. | No code before prerequisite outcome cells; then choose owner behind most pending cells, one open task, whole caller set and bounded statements/retries. |
| [G-2110](tasks/G-2110.md) / 1 / exited | No commits; measured/inferred typeahead note and Program ruling in brief; Read by program: 2026-10-13. | Not a code note. Load set then exact logged identity query at two scales; joins candidate conditional, replay/owner contract unchanged absent another note. |
| [G-2111](tasks/G-2111.md) / 1 / exited | No commits; narrowed public-domain recipe note and Program ruling in brief; Read by program: 2026-10-13. | Recipes outcome cells first: text/structure, basis/source/link/credit/transcriber and platform-mandate denial; existing owners, <=400 changed lines/task. |

## Next plan and changes to practice

**Resume, decided by the program on 2026-10-13 (10:58 UTC).** The seam this checkpoint waited for is settled on `main`: declarations import `scripts/qa/cases/outcome-cells.ts`; Main owns one lifecycle (`services/main/src/lifecycle.ts`) that its entry and the persona harness both run; the persona stack initialises and runs Main's relay as production does; and `books/catalogue-browse-and-search-in-its-zone` is proved for all six personas (G-2122, 1 of 67 rows). Step two started as a pilot of three matrix tasks in fresh sessions with automatic landing: G-2099 (recipes), G-2101 (Realm foundation) and G-2106 (Zone site bundle, which qualifies the reported 400 first). Their instruction is `.temp/goal-program/steps/api-step-two.txt`: declare the six cells of each row, test each persona over real HTTP, mark what passes `proved` and what fails `pending` with the request and the answer, and write no product code. The other twelve matrix tasks resume the same way once the pilot's handoffs show the instruction holds. Of the three Books drafts, G-2075 drops the catalogue row, which is proved, and G-2077 has returned `personas.ts` to `main`'s version; they rebase and run rather than rewrite. The program's supermanager holds the waits until the api manager's role is enrolled with the coordinator.

Nothing further is ready under the wrap-up order. After a new plan, first settle the scanner/declaration-loader seam and qualify one Books candidate end to end before resuming the other tests. Resolve G-2077's unclaimed helper separately; split the retained backup boundary instead of extending G-2074 beyond its two-fix cap. Keep all 15 matrix sessions idle until then, and cut archival appendices back into one-session execution briefs. Settle boards and the other explicitly held product decisions before dispatching their affected cells.

Once outcome execution works, the Zone owner's save/publish/visitor journey must establish whether the reported 400 is a missing API step or a product failure; any pending publication cell comes first among Zone implementations. Imported-recipe reading follows every G-2111 condition. Ancestry code waits for all G-2109 prerequisites; select its first owner by demonstrated pending cells, one owner/task. Typeahead waits for the retained set and the exact two-scale logged query measurement: **18 reads is not established (23 observed, 72 allowed)**.

I would qualify the declaration import scanner with one genuine HTTP outcome before widening test writing; the first handoffs showed that common seam blocks all drafts. I would inspect both manifest and backup destination boundaries together before selecting a rebuild repair, rather than chasing them in successive rounds. Read mail before every resume/landing action: the earlier turn resumed five sessions after the wrap-up had arrived, and Program stopped them; this checkpoint preserves that mistake and does not resume them. Measure width by settled work and outcomes, never by allowance spending.

## Carried work

Unmerged work is kept as commits under `refs/archive/2026-10-12/goal/<task>`
(`git log refs/archive/2026-10-12/goal/g-1959`). Nothing below is a brief; each
becomes an outcome task or a mechanism task under the [method](../method.md), or
is dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Public Content search on one consistent cut (`g-1959`) | One P1 and thirteen P2 from its last review; a later attempt says they are closed, with no review after it; its integration and recovery runs were red on missing disclosure sources | Review, rerun on a stack with production sources, then decide. Its removal of `population` and its health-profile contract exist only on the branch |
| Ranked search that never refuses for breadth (`g-2038`) | Three P1 of one class: readers of a search result that treat an incomplete total as complete (dynamic Collection capture, fixed-site adoption filter, population correction) | One task for that class; four limits of the "first 513 by relevance" design stay on the later list |
| Production ancestry sources for disclosure (`g-2039`, `g-2040`) | Graph, content and source sources registered behind four strict cases marked failing; media and review sources stopped with six fix classes open. No owner uses the strict contract; every owner takes the previous code path | Program read G-2109: outcome prerequisites first, including independent publication survival and statement/retry independence; then one owner/task, whole caller set on composeMain before registration |
| Private Content search off the old dependencies (`g-1958`) | Growth passed, never reviewed | Rebase, rerun, review |
| An author withdraws published Content (`g-1964`) | Blocked; three P1 and nine P2 | Registry wiring, the delivery cut, the reference fence; then review |
| Realm closure on every surface | Governance side on `main`. The feed adapter and the media step are modules nothing calls; the notification adapter (`g-2017`) has eight P1, two of which break delivery that works today; sessions and search were never started | Nothing of closure is switched on. The nine closure rows have no API proof |
| Counter-notice credential binds the right report (`g-1998`) | Additive `reportId` on the branch; one P1 left when `reportId` is omitted | Reachable only after a platform moderator decides a DMCA case; whether a party can then submit without a grant is not verified |
| Erasure service, second half | First half on `main` | The 409 or 503 mapping for unsupported inventories, the composition hunk with media objects, the reverse pool-order sites |
| Security review remainder | The High finding is closed on `main` | Anonymous requests can grow a counter table without bound; a forged token with an unknown key triggers a key exchange; the others are in the archived tables |
| Imported recipe structure under decision 55 | The Gutenberg loader imports through a member's file-import route with rights basis "unknown", publishes the text as the seed author's original contribution and never publishes the structure | Program read G-2111: recipes reading slice only; public-HTTP outcome cells first, then existing sourced publication owners, at most 400 changed lines |
| Typeahead on short prefixes | The 18-read bound is not established: 23 calls observed, 72 permitted. G-2110 records five probes: a/the/b 503 near 1.5 s; 中/harry empty 200 at 60/44 ms. No populated CJK or latency-distribution qualification | Program read G-2110: historical 614 ms query text was not logged; identity attribution remains inferred. After a compatible load set, capture exact text and measure two scales before selecting the conditional bounded-join change |
| Seed set | The fixture half is on `main`; the retained load set refuses to restore on `main` | G-2074 repairs landed, but canonical backup-path refusal leaves rebuild/restore unproved; split the remaining boundary under a new plan |

## Mechanisms and their notes

| Mechanism | Note for whoever touches it next |
| --- | --- |
| Disclosure | A contract landed on 2026-10-12 with test doubles as its only implementations and made public reads unavailable for two and a half hours. A registry or contract lands with a test on the real composition |
| Work read session | Its fence replays the whole read. That is correct and costs about twice the reads; 35 callers do it (table archived with the typeahead task). Bound the number of reads for each request; do not hand-write fences |
| Relay and projections | After every restart the content projection replays for three to four minutes and search is unavailable meanwhile |
| Rate limit | The limiter refused for some seconds after a restart on 2026-10-12 (one worker fault) |

## Target architecture contracts

Where the contracts of the [target architecture](../../architecture/target-architecture.md)
stood on 2026-10-07; the full record is `state.md` of the archived program Goal.

| Contract | State |
| --- | --- |
| C0 current definitions and custody boundary | Landed |
| C1 common admission and exposure | Landed at operation level; template level was pending three tasks |
| C2 bounded SHACL and Blocks | First slice landed |
| C3 local basis, stream and cursor | First path landed |
| C4 Statement, acceptance and classification | First slice landed |
| C5 template reads and page facade | Accepted |
| C6 component history and receipt custody | Owner delivery and shared runtime accepted |

## Red on main

- Five test files still write raw SPARQL and are recorded in the guard's ceiling
  as owed; two of them have no product operation behind their writes.
- `goalctl.test.ts` and `land.test.ts` fail in the regression checkout because
  its PostgreSQL socket path is longer than 107 bytes.
