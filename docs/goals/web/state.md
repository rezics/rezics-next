# State

Checkpoint f54f7729-9c57-453a-bd81-0b62a6183c61, consolidating the handled
start, G-2091:3, G-2201:1, G-2219:1 and three mail events named in the event.
The program restarted this Goal on 2026-10-13; the earlier wrap-up prohibition
on dispatch and resume is withdrawn. This checkpoint grants no duplicate
worker attempt and decides no pending mail event.

## Scope and measures

Reading from `task goal -- status` at this checkpoint:

| Measure | Checkpoint |
| --- | --- |
| Program API scope | 42 of 67 rows proved |
| Persona cells | 290 proved, 112 pending, 0 not applicable, 0 missing |
| Web surfaces | No worker started by the listed decisions; 26 page briefs committed |
| Web attempts, tool count | 9 first, 2 step, 3 fix; first-attempt share 75% (9 of 12) |
| Attempts per landed task | Median 1, maximum 2 (G-2092) |
| Web tokens | 42.1M input, 291.7k output; tokens per proved row n/a |
| Recorded refusals | 0 outcome, 0 gate, 0 failing-test finding, 1 other |
| Accounts | codex 11%, codex-1 21% of their weekly windows |

The API scope is the program's progress, not 42 web surface proofs. The attempt
share and median do not meet the method's stop thresholds; continue settled
work. G-2091's third attempt only repaired its handoff token, and G-2219's
resumed attempt found missing host input without implementation; neither
establishes a new product outcome. Keep these distinctions when comparing
the tool's counts with the earlier manager count in this file's history.

## Open work

| Task | Decision and next action |
| --- | --- |
| G-2091 | Attempt 3 exited partial. The bounded structural guard, retained keys and Manage/Zone/proposal/Recipe fixes are accepted subject to gates. Both Recipe files belong to the reclaimed claim; the standalone result token resolves the handoff refusal. Status still reports exited, so do not count the accepted three commits as landed. Complete `land G-2091 --step`; keep the task open for deferred debt. No further worker work is authorized without a reproducible pending/completion or retained-key failure. |
| G-2199 | Running, attempt 1; D030 module mocks must retain real exports and routes. Decide its handoff when delivered. |
| G-2219 | D129 split from G-2201. Program approved one optional host-supplied Try destination, with no SDK gate, evaluator or operation identifier. Attempt 1's reading was accepted; the mail turn already resumed attempt 2, so the older handoff required no second resume. Attempt 2 exited blocked without edits because synchronous card construction lacks viewer-access input. The adapter-versus-threading question was mailed with the brief's path under `web-g2219-host-decision-input`. Handle the host-ruling delivery in its own event; no implementation is accepted here. |

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

The listed decisions held these briefs outside the queue because it would
immediately start an empty-dependency brief. Program task G-2217 supplies the
`needs:` file gate. The program's later admission direction takes ownership
of adding `needs:` and queuing these committed briefs when that gate lands;
stop retrying ID reservations. If the replay lands first, the earlier ruling
allows manual dispatch only after all required files are verified on `main`.
At this checkpoint G-2160 and G-2217 are in landing gates; no release is
inferred from their handoffs.

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

Handle the accepted G-2091 landing and the regression/SDK handoffs; release
surfaces through the program's file admission. Brief continuation, identity
and filter pieces only with evidence of the fault. Correct refused briefs in
their decision turn and keep API gaps with their outcome owner.

The three supplied mail deliveries, 571b93a0-e936-483a-9c5d-3355d04c63f9,
407b475e-3295-4fab-978d-7b564f5f79aa and
1dd26204-3839-4d64-bc16-bfc7f61970f6, are already acknowledged in durable
mail. Their queue, additive SDK and main-file rulings are consolidated above.
Pending deliveries and later handoffs retain their own decision events.

Keep structural guards bounded, with benign-edit and correct-consumer passing
fixtures and class-violation failing fixtures. Settle owner paths before a
handoff; use recorded API answers for surfaces instead of source hashes or
hand-authored response bodies.
