# State

Checkpoint dd1801c5-0f22-4ec4-bc4e-a8b8332ba9f4, consolidating the handled
mail:95568f67-04fc-41c1-b09c-6033e5e2050d, task:G-2204:1,
task:G-2219:3, mail:83b308b7-2637-4563-9207-3468f3922956 and
mail:26c3a3cf-884a-45d5-b021-840cb8958a00 decisions in
`tasks/G-2204.md`, `tasks/G-2219.md` and `tasks/G-2091.md`.
Carry forward the preceding checkpoint's unaffected decisions.
The program restarted this Goal on 2026-10-13; the earlier wrap-up prohibition
on dispatch and resume is withdrawn. This checkpoint grants no duplicate
worker attempt and decides no pending mail event.

## Scope and measures

`task goal -- status` refreshed the scope and persona counts below, then
encountered a ledger lock. It was interrupted without waiting. Other measures
are carried from checkpoint f54f7729-9c57-453a-bd81-0b62a6183c61; they are
not a fresh reading of attempts, tokens, refusals or allowance.

| Measure | Latest available reading |
| --- | --- |
| Program API scope | 45 of 67 rows proved |
| Persona cells | 305 proved, 97 pending, 0 not applicable, 0 missing |
| Web surfaces | Program admitted the 26 committed page briefs; no new surface proof accepted by these decisions |
| Web attempts, tool count | 9 first, 2 step, 3 fix; first-attempt share 75% (9 of 12) |
| Attempts per landed task | Median 1, maximum 2 (G-2092) |
| Web tokens | 42.1M input, 291.7k output; tokens per proved row n/a |
| Recorded refusals | 0 outcome, 0 gate, 0 failing-test finding, 1 other |
| Accounts | codex 11%, codex-1 21% of their weekly windows |

The API scope is the program's progress, not 45 web surface proofs. The carried
attempt share and median did not meet the method's stop thresholds; this
checkpoint authorizes no new dispatch from stale measures. G-2091's third
attempt only repaired its handoff token, and G-2219's
resumed attempt found missing host input without implementation; neither
establishes a new product outcome. Keep these distinctions when comparing
the tool's counts with the earlier manager count in this file's history.

## Open work

| Task | Decision and next action |
| --- | --- |
| G-2091 | The bounded structural guard, retained keys and Manage/Zone/proposal/Recipe fixes are accepted subject to gates. The latest handled mail records the program's `land G-2091 --step` in progress; no completed landing is proved. Do not duplicate it. Decide its result separately: close verified on success to release G-2236's claim, or assign only the concrete in-scope repair on failure. Deferred inventory no longer keeps this task open and needs a separate evidenced slice. |
| G-2199 | Running, attempt 1; D030 module mocks must retain real exports and routes. Decide its handoff when delivered. |
| G-2204 | Attempt 1 supplied blocker evidence: seven regressions passed, six failed, and the surface remained unfinished. Program resolved query-order applicability with replay fix `4085f1b94` and assigned the HTTP 200 null-preference correction in `features/tracking/api.ts` to this task; attempt 2 is already resumed for that correction, the page seam, recorded stories, phone/desktop review and full gate. Preserve records and assertions. After G-2215 exits, reclaim G-2215 and then G-2204 from their briefs to align reader ownership before landing. No duplicate resume or accepted surface is inferred. |
| G-2219 | D129's committed optional SDK destination and asynchronous host Hub adapter follow the approved design; keep request-cached host access, synchronous `cardRenderer`, optional `tryHref` only when open and the SDK free of gates, evaluators and operation identifiers. Attempt 3 lacked official-package story validation and a passing cover-parity gate, so it was not landed. Program superseded the proposed repair split: optional SDK cover credit, parity regression and reclaimed `card.tsx` repair belong here. Attempt 4 is already resumed for that repair, official-package story screenshots and the full gate. Preserve the parity assertion and import boundary; report unclaimed host credit paths or missing API credit rather than changing them. Decide its subsequent handoff separately. |

Worker and landing states above describe the latest handled decisions, not a
fresh ledger reading. Pending events and concurrent turns retain their own
decisions.

G-2091's Library/rating/Studio and unresolved-alias inventory is deferred,
not proof of product faults. G-2093 is closed: its landed structural filter
guard stands, and its 81 `owner-audit` expressions belong to future evidenced
slices of this Goal.

## Surface decisions

The replay and every row record must exist on `main` before a surface starts:
`apps/web/features/stories/recorded-fetch.ts` and
`tests/qa/fixtures/outcomes/<vertical>/<row>.json`. Verify each path with
`git cat-file -e main:<path>`. Keep `depends: []`; neither another Goal's task
ID nor G-2169 is a dependency. Read the six-persona matrices before dispatch.
Stories consume unchanged answers through the replay, the web typed client
and the production reader and mapping named by each brief.

The start event wrote G-2204 for Books Work and edition choice. The surface
mail wrote G-2215 (Books Library/backup), G-2216 (loans), G-2222 (contents) and
the other page drafts: Books languages, Recipes, Visual novels, Games, Realm,
Zone, Manga and Anime. The program has since assigned the drafts G-2224 through
G-2245; there are 26 committed page briefs in total. G-2169 is the program's
Books catalogue surface, not a prerequisite for these pages.

The program completed admission with `needs:` file gates and narrowed claims
at `fa718a419`, superseding the earlier holds. The admission mail recorded
G-2215, G-2216, G-2242, G-2244 and G-2245 running, and G-2204, G-2222,
G-2224 through G-2241 and G-2243 queued; later prerequisite mail resumed
G-2204. Do not dispatch or queue them again. G-2236 also requires G-2091's
accepted step to release its Recipe claim. G-2224's corrected row is
`anime/navigate-a-thousand-episode-inventory-thousand-chapters`.

Later verticals consume the seam extracted by their Books surface and wait
for it on main as their briefs specify. G-2169's browse seam is landed.
Shared files are read without claiming them; for a handoff's OWNER CHANGES,
add the exact file to the brief, commit, reclaim and land after any open holder
lands. Do not reclaim a running task. The surface gate runs affected consumer
tests even when the brief did not name them (`34d548013`). Query parameter
order alone no longer makes a recorded request unmatched (`4085f1b94`);
resume a surface with that exact blocker against the fix, preserving records.

Keep admitted engines. If a Grok surface hands off empty or twice partial,
switch queued surface briefs to `codex`, commit each separately and send one
program mail. None of these handled decisions establishes that trigger.

## Landed and held findings

- G-2201: D080 copy step merged at `bbf3996be156`, closed verified. All eight
  locales name the message language; story assertions retain their behavior
  checks. D129 is G-2219, not unfinished copy work.
- G-2200: closed; mounted Collection shelf test correction is on main at
  `333b187bf`. Its handoff was handled separately from the listed events.
- G-2094, G-2090, G-2092 and G-2093 retain their landed canonical-href,
  continuation, identity and filter guards. The accepted-command guard is
  not yet counted as landed.
- Twelve continuation remainders, 18 identity analyzer debts and 81 filter
  owner-audit expressions still need exact evidence and independently landing
  briefs. Analyzer debt alone is not a product failure. Findings without a
  proved persona outcome stay in `later.md`; API gaps go to api, with no
  client workaround.
- Recipe journey findings remain held for their row proofs: the published
  reader lacks the "As written" radio, and exchange assertions disagree with
  displayed fraction glyphs. Zone publishing's 400 belongs to api. Carried
  archived work was not resumed.

## Next action and acknowledgements

Decide the program-started G-2091 landing result when delivered and close
verified on success. Decide G-2204 and G-2219's subsequent handoffs separately;
their assigned work is already resumed. Surface admission is complete under
the program's file gates. Brief continuation, identity
and filter pieces only with evidence of the fault. Correct refused briefs in
their decision turn and keep API gaps with their outcome owner.

The three supplied mail deliveries, 571b93a0-e936-483a-9c5d-3355d04c63f9,
407b475e-3295-4fab-978d-7b564f5f79aa and
1dd26204-3839-4d64-bc16-bfc7f61970f6, are already acknowledged in durable
mail. Their queue, additive SDK and main-file rulings are consolidated above.
Pending deliveries and later handoffs retain their own decision events.

The supplied mail 6d5b70e8-43ad-491d-bc80-552a2cc25c11 is already acknowledged
in durable mail at 2026-10-13 16:28:50 UTC. Its asynchronous host-adapter ruling
and the preceding blocked handoff are consolidated here; no reply or further
program ruling is needed for these handled events.

The three supplied mail deliveries 95568f67-04fc-41c1-b09c-6033e5e2050d,
83b308b7-2637-4563-9207-3468f3922956 and
26c3a3cf-884a-45d5-b021-840cb8958a00 are already acknowledged in durable mail
at 2026-10-13 16:51:03, 17:08:16 and 17:19:46 UTC respectively. Their
admission, prerequisite, cover-credit and landing-execution decisions are
consolidated here. No further program ruling or reply is needed.

For future required `land`, `resume`, `reclaim` or `queue` commands, the
program permits one 180-second ledger-lock acquisition before reporting a
blocked action. This checkpoint requires none of those commands and waits
on no result.

Keep structural guards bounded, with benign-edit and correct-consumer passing
fixtures and class-violation failing fixtures. Settle owner paths before a
handoff; use recorded API answers for surfaces instead of source hashes or
hand-authored response bodies.
