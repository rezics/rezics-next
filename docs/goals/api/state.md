# State

The checkpoint for [this Goal](GOAL.md). Not started; written on 2026-10-12 from
the end-of-run tables of the kernel and trust-ops managers, which are archived at
`archive/goals:program-2026-10-06/study-2026-10-12/`.

| Field | State (2026-10-12) |
| --- | --- |
| Manager | None. The program starts one after its first three tasks |
| Rows | 67 in scope; 50 have an API proof, each with one persona; 17 have none ([GOAL.md](GOAL.md#order-of-work)) |
| Shared stack | Carries `main` as the program's state file says |
| Not verified | No main-wide integration or fault/recovery run was made on the final `main`: the retained seed set refuses to restore there (compatibility digest), so those tiers are unqualified until the seed set is rebuilt |

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
