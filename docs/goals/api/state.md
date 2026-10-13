# State

The checkpoint for [this Goal](GOAL.md). Running since 2026-10-13. Carried work
below comes from the kernel and trust-ops end-of-run tables, archived at
`archive/goals:program-2026-10-06/study-2026-10-12/`.

| Field | State (2026-10-13) |
| --- | --- |
| Manager | `api`, registered and coordinator-enrolled; end a turn when nothing is ready |
| Rows proved | 0/67 under the six-persona method; 50 legacy API proofs, 17 without one |
| Rows in work | All 67 covered once by 18 two-to-four-row outcome briefs: G-2075–G-2078 and G-2095–G-2108. Step one is read-only persona matrices, not declaration/test writing |
| Dispatch | G-2075–G-2077 and the three mechanism analyses started at the checkpoint; the remaining admitted matrix batch runs serially via `.temp/api/dispatch-wide.sh`, pid recorded in `.temp/api/wide-dispatch.pid`. It stops on refusal and mails API; completion also mails API. No watcher or worker wait is armed |
| Mechanism analyses | G-2109 disclosure ancestry; G-2110 typeahead (costly Fuseki query log first); G-2111 public-domain/source/credit import under decision 55. No file changes; manager copies handoff notes into briefs and mails their paths for Program to read before code |
| Tooling in work | G-2074 exited blocked, first handoff: checkpoint:site-publication:4:4 returns 400 invalid_zone_configuration because the builder does not configure its Zone home document. No backup or restore proof. Program asked to assign the exact helper from its QA area before a fresh fix round; gates no row |
| Measures | Checkpoint snapshot: 7 tasks with 7 first attempts (100%); dispatch batch adds only first attempts. No landed API task or proved row, so landed-task attempts and tokens per proved row are undefined. Rebuild attempt: 1,444,430 input (1,393,280 cached), 5,822 output tokens |
| Shared stack | `task urls`: Main 3001, Account 3002, all six resources healthy; Program's main d2a2e3166 loan integration probe passed in 11.9 s |
| Retained set | Static reading: compatibility refusal affects growth consumers and retained-checkpoint restore verification, not integration startup. `scripts/qa/cli.ts` starts and bootstraps fresh stacks; only the specific growth files read `seed-checkpoints.ts` |
| Not verified | No main-wide integration or fault/recovery qualification claimed; ordinary outcome tests can run independently of the retained set |
| Next action | On task exit read each six-person matrix as product owner and write corrections into its brief. G-2070 is on main and its rowId matches every brief; hold step two until Program confirms both G-2070 and G-2071. Resume G-2076 for only the expired-loan pilot, land it, correct the template, then widen books |
| Following waves | Matrix analysis already covers every vertical and all 17 rows without a proof. Declaration/test writing follows books, other verticals, then the 17 proofless rows. A step resume is not a fix round |
| Width | At most 22 API live workers, 34 globally; full batch plus rebuild is 22 tasks, split 11 per Codex account, Sol/high/default service tier. No Claude, top-up or credits |
| Landing and cap | Tooling/outcome tasks use `merge`, no review; enforce two fresh fix rounds until G-2072 does. Stop dispatch below half first-attempt share; no task with an unsettled dependency or decision |

Outcome briefs are at most 36 lines and claim only future row declarations and
API tests. Step one changes no file and returns current answer, intended answer,
operation and real proving test (or none) for all six personas. Route inference
and mocked tests are labelled, never promoted to public-API proof. Publishing
rows include rights and credit. Both Program mails received this turn were acted
on; `program-api-wide-matrix` confirms the books count is 13 and is acknowledged.

## Carried work

Unmerged work is kept as commits under `refs/archive/2026-10-12/goal/<task>`
(`git log refs/archive/2026-10-12/goal/g-1959`). Nothing below is a brief; each
becomes an outcome task or a mechanism task under the [method](../method.md), or
is dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Public Content search on one consistent cut (`g-1959`) | One P1 and thirteen P2 from its last review; a later attempt says they are closed, with no review after it; its integration and recovery runs were red on missing disclosure sources | Review, rerun on a stack with production sources, then decide. Its removal of `population` and its health-profile contract exist only on the branch |
| Ranked search that never refuses for breadth (`g-2038`) | Three P1 of one class: readers of a search result that treat an incomplete total as complete (dynamic Collection capture, fixed-site adoption filter, population correction) | One task for that class; four limits of the "first 513 by relevance" design stay on the later list |
| Production ancestry sources for disclosure (`g-2039`, `g-2040`) | Graph, content and source sources registered behind four strict cases marked failing; media and review sources stopped with six fix classes open. No owner uses the strict contract; every owner takes the previous code path | A design note first. An owner switches only when, on the real composition, a search with more than 64 matches, the sitemap, a notification page and a read concurrent with an unrelated restriction all pass |
| Private Content search off the old dependencies (`g-1958`) | Growth passed, never reviewed | Rebase, rerun, review |
| An author withdraws published Content (`g-1964`) | Blocked; three P1 and nine P2 | Registry wiring, the delivery cut, the reference fence; then review |
| Realm closure on every surface | Governance side on `main`. The feed adapter and the media step are modules nothing calls; the notification adapter (`g-2017`) has eight P1, two of which break delivery that works today; sessions and search were never started | Nothing of closure is switched on. The nine closure rows have no API proof |
| Counter-notice credential binds the right report (`g-1998`) | Additive `reportId` on the branch; one P1 left when `reportId` is omitted | Reachable only after a platform moderator decides a DMCA case; whether a party can then submit without a grant is not verified |
| Erasure service, second half | First half on `main` | The 409 or 503 mapping for unsupported inventories, the composition hunk with media objects, the reverse pool-order sites |
| Security review remainder | The High finding is closed on `main` | Anonymous requests can grow a counter table without bound; a forged token with an unknown key triggers a key exchange; the others are in the archived tables |
| Imported recipe structure under decision 55 | The Gutenberg loader imports through a member's file-import route with rights basis "unknown", publishes the text as the seed author's original contribution and never publishes the structure | Design how an import states "public domain, from this source" before any route or grant |
| Typeahead on short prefixes | Reads for each request are bounded on `main` (18 for any prefix). Measured on the shared stack after that change, at host load 7: `harry` answers in 0.04 s, but `a`, `the`, `b` and a single Chinese character take 1.3 to 1.5 s and answer 503 at the 1.5 s deadline about half the time | One query of about 0.6 s dominates the request and the fence replays it. Find it in Fuseki's request log before changing anything; the number of reads was not the cause |
| Seed set | The fixture half is on `main`; the retained load set refuses to restore on `main` | Rebuild the seed population and its growth axes; until then growth checks run at the set's source commit |

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
