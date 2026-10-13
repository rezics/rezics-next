# State

Running again since 2026-10-13 15:34 UTC, started by the program. The wrap-up direction
of the morning (dispatch nothing) is withdrawn. The table and lists below are the
wrap-up checkpoint and are corrected by the manager's first checkpoint.

**Direction from the program.** Books is proved on `main` (13 of 13 rows; 37 of
67 in all: `task goal -- scope`), so surfaces start. Keep both Codex accounts
busy with work that can land; a brief that the tool refuses is corrected in the
same turn.

1. Three tasks written by the program are running: G-2199 (module mocks, D030),
   G-2200 (shelf preview, D060) and G-2201 (service name in copy, D080; official
   Zone import, D129). Their handoffs are yours.
2. G-2091: its refused merge named two files outside its claim. Decide from the
   diff whether they belong to the task; if they do, add them to the brief, run
   `reclaim G-2091 <brief>` and land it.
3. Surfaces. The path is: a row's answer record
   (`tests/qa/fixtures/outcomes/<vertical>/<row>.json`, written by the row's
   outcome test), the replaying fetch (`apps/web/features/stories/recorded-fetch.ts`,
   program task G-2160, running), stories fed by the record through the web's own
   typed reader, and the surface gate (`task goal -- check` on a `kind: surface`
   brief). The program's G-2169 is the first surface, for the Books catalogue row;
   its brief is the model for yours. Program tasks G-2189 to G-2198 are recording
   the other 36 proved rows now. Write one surface brief for each page that shows
   proved rows, Books first, then Recipes, Visual novels, Games, Realm and Zone;
   name the rows, the page's route and its readers. Dispatch each as soon as
   G-2160 and the row's record are on `main`; a brief does not wait for G-2169.
4. Brief, in pieces that land alone, the twelve continuation remainders, the
   eighteen identity debts and the 81 `owner-audit` expressions, each with the
   evidence that makes it a fault; a gap in the API goes to the api Goal by mail
   and gets no workaround.

## Scope and measures

| Measure | Checkpoint |
| --- | --- |
| Rows | 0 of 67 proved through persona API outcomes; no surface row started |
| Persona cells | 0 proved, 0 pending, 0 not applicable, 402 missing |
| Attempts, manager count | 5 first + 3 fixes = 8; first-attempt share 62.5% |
| Attempts per landed task | G-2094: 1; G-2090: 2; G-2092: 2; G-2093 partial landing: 1; median 1.5, max 2 |
| Last token reading | 35.1M input, 247.6k output; tokens per proved row n/a |
| Tool discrepancy | Status still calls two conformance fixes steps and reports 83%; Program accepts the manager count and is correcting the records |
| Refusals this wrap-up | One scope refusal, G-2091; types/unit gates did not start |
| Host | Shared stack was healthy at `task urls`: Main 3001, Account 3002, web 3000, Storybook 6006 |

## Open tasks

| Task | State, branch work, what remains |
| --- | --- |
| G-2091 | Exited, attempt 2, partial, clean branch with 3 unlanded commits: structural admission guard; retained pending keys; Manage/Zone/proposal and Recipe admission fixes/tests. First merge refused: `G-2091 changed files outside its claim:` (recipe-editor/api.ts and accepted-command.test.ts). Leave unchanged; exact Library/rating/Studio and unresolved-alias debt remains on the branch. |
| G-2093 | Merged partial at `a91993670e54`, attempt 1; clean branch, no unlanded task code. Structural filter guard/test/inventory passed scripts types and all 35 merge unit/guard files on the first try. Remains open: 81 of 144 inventoried expressions need owner evidence and API gaps prevent some consumer fixes; no resume, split or fix during wrap-up. **Closed as verified by the program on 2026-10-13** to release `apps/web/features/zones/**` and `apps/web/features/discover/**` for the first surface: the landed guard stands, the branch held nothing unlanded, and the 81 expressions marked `owner-audit` in `scripts/static/web-page-filtering.inventory.json` are this Goal's to brief in pieces when it resumes |

## Landed and converged

- G-2094: `775d67f79132`, closed verified; canonical href expectations in two browser tests and the entity story; 16 story cases and 31 merge unit/guard files passed. Browser files remain for nightly execution.
- G-2090: `5124002cd676`, closed verified; structural continuation guard and bounded Library/loan read fixes; web/scripts types and all 33 merge unit/guard files passed.
- G-2092: `bef644b340a5`, closed verified; structural identity guard and Work-page Realm-header identity fix; web/scripts types and all 34 merge unit/guard files passed.
- G-2093: `a91993670e54`, partial landing on first try; structural capped-page filter guard plus exact expression inventory. Its unfinished audit keeps the task open.
- Four guard entries are registered on main; continuation, identity and page-filter guards are on main, accepted-command guard remains unlanded. Closed briefs are archived, their claims released; no backend refresh was needed.

## Held work

Twelve exact continuation remainders are in `scripts/static/web-continuations.inventory.json`;
18 named identity analyzer debts are in `scripts/static/web-acting-identity-debt.json`.
These remain unresolved; analyzer debt is not 18 proved product failures.
The filter inventory has 144 expressions, 81 marked owner-audit; those are held
findings without sufficient evidence, not 81 proved product failures. Its API
gaps repeat the year eligibility and per-Work listing gaps already sent to api.
[Later](later.md) holds findings without a proved persona outcome. Program sent
the Home continuation, Realm/Conditions year paging and per-Work contribution/
submission API gaps to api for matrix checks. No workaround was built.

- `recipe-authoring.e2e.ts`: published Recipe reader lacks the "As written" radio; hold until recipe row proofs.
- `recipe-exchange.e2e.ts`: ASCII `1 1/2` and `1/3` expectations disagree with `1 ½` and `⅓`; hold until recipe row proofs.
- Program's nightly vertical selection has seven passing journeys and recipes missing; Zone publishing's 400 belongs to api.
- Other carried work remains under `refs/archive/2026-10-12/goal/<task>`; the detailed carried table is preserved in this file's history at `709dd3a4f` and the launch tables at `archive/goals:program-2026-10-06/study-2026-10-12/`. Nothing from it was resumed.

## From the regression of 2026-10-13

Added by the program from its reading of the run on `main` d2a2e3166: four
causes in this Goal's sources, six failing files.

- D030, 3 files: Bun UI module mocks omit real exports (notFound/readReviewer) or replace the real browse route used later in the batch. Source: `apps/web/tests/showcase-zone-editor.test.tsx`.
- D060, 1 file: Mounted Collection shelf preview loader reports failed rather than ready and does not retain its paging state. Source: `apps/web/features/zones/`.
- D080, 1 file: Localized about-discussion copy exposes internal service name Content. Source: `apps/web/features/zones/messages/`.
- D129, 1 file: Official ai-workshop slots imports outside the allowed React/SDK/UI/icon/local boundary. Source: `apps/web/zones/official/`.

## Next plan and what I would change

All current attempts have been handled under the single-try wrap-up rule.
In a new plan, settle G-2091's claim/debt and G-2093's audit scope before touching
their branches, then follow proved persona rows into surfaces. No action on those
is authorized now.

My guard briefs left acceptance examples underspecified. Three first handoffs
used source hashes and needed conformance fixes. I would supply benign-edit and
new-correct-consumer passing fixtures plus class-violation failing fixtures before
dispatch, bound structural analysis more narrowly, and settle owner-change paths
before handoff. Keep types/unit/guard/story gates and Program's nightly journeys;
do not turn each frontend diff into a model review.
