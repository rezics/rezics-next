# State

The checkpoint for [this Goal](GOAL.md). Running since 2026-10-13 under manager
`web`, enrolled with the coordinator. The carried work below comes from the
launch manager's 2026-10-12 table, archived at
`archive/goals:program-2026-10-06/study-2026-10-12/`.

| Field | State (2026-10-13) |
| --- | --- |
| Manager | web; no watcher, polling or held task wait; coordinator wakes on mail/task exits |
| Rows | 0 of 67 proved through persona API outcomes; old browser proofs do not prove rows under today's method |
| Shared stack | Cold-started today, serving main; Account 3002, Main 3001, web 3000 and Storybook 6006 healthy (`task urls`) |
| Measures | Program confirms 4 first + 3 fixes = 57% (4/7); last status reported 80% because it mislabeled two fixes as steps. Landed median/max 1 (G-2094); last reading 22.3M input / 156.1k output tokens, one session unavailable; tokens/proved row n/a |

## Authorized work now

Only the four client-contract classes and stale canonical-href expectations are
authorized before rows are proved. Every task is `kind: tooling`, Sol on
`codex`/`codex-1`, high effort (medium for href expectations), default service
tier. At most eight live web workers. Briefs are at most forty lines.
Program's `program-web-reset-early` mail voids the leftover-spending order: both
Codex accounts reset around 04:58 UTC. Dispatch width depends only on settled
work and the measures; no task is added to spend allowance.

| Task | Claim and next action |
| --- | --- |
| G-2090 | First handoff partial: bounded Library read fixes and twelve-instance inventory, unlanded. Fresh attempt 2 is fix round 1: replace the whole-source hash review gate; benign-comment fixture fails in QA `20261013t050302-bdbdd8` |
| G-2091 | First handoff partial, unlanded; pending key/Manage/Zone/proposal fixes preserved. Fresh attempt 2 is fix round 1: replace adapter hash reviews; comment-only fixture fails in QA `20261013t051545-d31a21`. Minimal proposal file added to claim via reclaim |
| G-2092 | First handoff done, unlanded; Work-page Realm-header identity fix preserved. Fresh attempt 2 is fix round 1: replace hash-based exception reviews; harmless-comment fixture fails in QA `20261013t052140-4a2e0c`. Minimal Work-page file added via reclaim |
| G-2093 | Capped-page filtering; brief ready, dispatch after G-2090 closes because zones claims overlap |
| G-2094 | Landed at `775d67f79132` on attempt 1; canonical suffix expectations in both tests/story; 16 story cases, web types and all 31 merge unit/guard files pass; e2e execution stays with nightly regression |

G-2090, G-2091 and G-2092 run fresh fix round 1. G-2094 is
landed and closed. Program's mail `program-web-guards-released` confirmed G-2071 landed
and released `scripts/qa/repository-guards.ts`. This manager appended all four
inventory guard entries there; existing absent-file filtering allows each guard
to join the gate when its task lands. Workers do not edit that registry.
An API gap goes to Program as one operation/persona line, never a client workaround.
Mail `web-continuation-api-gaps-20261013` reports three G-2090 gaps: continuing
ranked Home candidates, Realm/Conditions-constrained year paging, and a writer's
contributions/submissions for one Work. The exact twelve remaining instances
are retained in G-2090's inventory; no further surface work in this fix round.
Program forwarded all three gaps to api to check against each row's matrix.
G-2091's exact remaining client instances are Library collection/change/rating
commands, scoped-rating projection/observation keys and Studio metadata/create
keys. No extra work on them in this guard fix round; Library remains claimed by
G-2090. The worker's reload-persistence proposal has no proved persona outcome
and is recorded in later.md rather than dispatched.
All three initial guards used source hashes requiring review after harmless
edits; concrete comment-only fixtures fail. Each brief now requires executable
rules accepting correct edits automatically. Program was mailed
`web-partial-conformance-fixes-measures-20261013`: the tool labels the two fixes
after partial handoffs as steps; manager uses the stricter 57% measure meanwhile.
Program's `program-web-measure-classification` confirms that count. Guards must
state executable rules over code structure; source/hash exception inventories
requiring harmless-change reviews are refused. If still needed at fix round 2,
cut to structurally expressible violations and put the remainder in later.md.

G-2072 step 1 is on main (kind validation, landing rules and attempt cap). The
manager continues to enforce the web rules in every brief: merge
with `task goal -- merge`, no model diff review or task browser journey, targeted
types/unit tests/guards and changed stories. Two fix rounds maximum, fresh
resumes; then write cut/split/design note in the brief. On an exited task's wake,
read its immediate `wait` handoff, merge on gates, close verified and record
attempts. Under-half first-attempt share stops dispatch and gets a cause mail.
Nothing else in the carried list starts before Program mails a proved row.

## Carried work

Unmerged work is kept as commits under `refs/archive/2026-10-12/goal/<task>`.
Each item becomes a surface task after its row is proved through the API, or is
dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Visual novel hub and release choice (`g-2035`) | Its API proof and the phone and desktop journey passed; the last review left one P1: the shared preference form erases a valid retained release pin when the release's languages change in a later revision | Compare the pin against its own edition revision; the registry row stays unproved until it lands |
| Games: platform scheme, facts and facets (`g-1855`) | Stopped before its handoff; an earlier review left a P1 | Rerun its integration and journey on `main`; a genre can still show among the platforms |
| Recipe one-button publish and the editor's native ingredient rules (`g-1961`) | Integration and the publish journey passed; the gate is red on a coverage declaration that names an old test title; the commits after its first review were never reviewed | Fix the declaration, review, land. The recipe reader still flattens sections |
| Library lists continue in place; one Access-plus-disclosure shelf reader (`g-2048`) | Its reads pass; the gate is red because the new shelf read is not in the hidden-id inventory | Register it and land: until then the shelf directory on `main` can show a private shelf's name after its access was closed. Six further groups (Home Continue, tracking, ratings, Discover and invitations, the managed rail and attached Zones) were never started |
| A saved release filter keeps its choices (`g-2055`) | One P1: applying a held URL with a retired facet still drops that choice | Fix or drop |
| Recipe export and import round trip (`g-1987`) | A test commit only | Route sections at the root, a partial import restarting, export importability unused in the interface |
| Zone home document identity | On `main`; two commits after its last review are unreviewed | The joint authority and disclosure fence race is a named expected failure; the discussion and browser proofs were not made |
| Realm write isolation and closure acceptance | Steps on `main` | The Realm browser journeys; the closure notification store was never built |
| Public hub parts and relations | On `main`; the relation link was fixed after the journey last failed | Rerun the journey |
| Gutenberg recipes | 30 Works on the shared stack at `/en/z/launch-recipes/browse`; readers see the text only | Structure waits for the decision 55 design in the [api](../api/state.md) Goal; ten Italian recipes have no recognised amounts |
| Search page "at least N" and the tests under the disclosure contract | Briefs only | Wait for the api Goal's search work |

## Known on main

- `recipe-authoring.e2e.ts`: published Recipe reader lacks the "As written" radio; hold until the recipe rows are proved, no dispatch now.
- `recipe-exchange.e2e.ts`: expects ASCII `1 1/2` and `1/3`, while the reader shows `1 ½` and `⅓`; hold until the recipe rows are proved, no dispatch now.
- Program's nightly vertical regression has seven passing journeys on a clean QA profile and recipes recorded as missing; Zone site publish's 400 is with api.
- Related-Work links and the two browser tests (`g-841-q04-reboot-spinoff`,
  `g-841-q03-identity`) plus `entity-page.stories.tsx` now expect canonical
  addresses with readable suffixes. The story passes; nightly regression will
  execute both browser tests. The anime pointer case still runs on a Book-typed
  fixture, and part and whole links are not clicked in any test (outside this task).
- Anime and manga browse one year at a time through the API; the "all years"
  list still stops after a few pages.
- Home "Continue" shows six items and followed authors eight, with no "see all".
- A journey's setup fails on the QA profile ("Safety responders are not
  configured", "Work name scope is not prepared"); the profile lacks a
  preparation, which is the program's to fix.

## What the web got wrong on 2026-10-12

Every defect was the client not following the API's contract. They are the
rules a surface task checks, in the client or by a guard:

| Class | Example |
| --- | --- |
| A continuation dropped or invented | Import review rows built later cursors by arithmetic (a guard refuses it now); capped lists with no way to the rest |
| `202` shown as done | A moderator saw content as removed while its effects were pending |
| A read sent without the acting identity | A private Realm's member could not read its decisions |
| A filter applied in the client over a capped page | Year browse lost eligible Works |
| A stored draft outliving its basis | Realm rule drafts overwrote another moderator's publication; drafts now live in the page only |
