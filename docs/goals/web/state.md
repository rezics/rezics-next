# State

Checkpoint 99caf4a8-eee0-410b-87ac-359acd44a8f0 consolidates handled events
mail:0ca3c179-5c86-494c-b73e-bcc9d01e6e62, task:G-2216:2,
task:G-2225:3, mail:d5771f1e-4249-420d-b068-187bb38960b6,
task:G-2244:2 and mail:de6409a1-c248-4337-b0ab-94dd70a589bd.
Carry forward unaffected decisions. The program's 2026-10-13
restart withdrew the earlier wrap-up prohibition. This checkpoint edits only
this file, starts no worker or landing, and decides no pending event.

## Scope and measures

`task goal -- status` reported the scope and allowances below. A read-only
ledger snapshot supplies raw attempt and closure counts. Tokens and refusals
are carried from the preceding checkpoint, not fresh readings. These readings
describe concurrent progress; they do not decide later handoffs or landing mail.

| Measure | Latest available reading |
| --- | --- |
| Program API scope | 43 of 67 rows proved |
| Persona cells | 303 proved, 99 pending, 0 not applicable, 0 missing |
| Web surfaces | 26 admitted family page briefs, carried; G-2267 separately queued for authoring; these events establish no complete new surface row |
| Raw web attempts | 39 across 26 tasks: 26 first, 3 step, 7 fix, 3 historical unclassified subsequent attempts |
| Raw first attempts | 26 of 39, 67%; distinct from the tool's step-adjusted share |
| Attempts per verified task | Median 1, maximum 5 (G-2219), across 11 verified tasks |
| Web tokens, carried | 42.1M input, 291.7k output; tokens per proved row unavailable |
| Recorded refusals, carried | 0 outcome, 0 gate, 0 failing-test finding, 1 other |
| Program measures, fresh | 58% first attempts (today 85%, 70 of 82); attempts per landed task median 1, maximum 9; 1120.9M input, 5.1M output with 70 sessions unavailable; tokens per proved row unavailable |
| Program refusals, fresh | 0 outcome, 8 gate, 0 failing-test finding, 2 other |
| Accounts, fresh | codex 16%, codex-1 28% of their weekly windows |

The API count is program progress, not web surface proof. It decreased from
the preceding 44-row reading; this checkpoint supplies no attribution. The
raw initial share is above half and the median is within two, but G-2219's
five attempts exceed the method's three-attempt cap in the raw history. Its
history includes design reading, host-input discovery and repair steps;
do not silently relabel those attempts or treat that history as permission
for another fix round. G-2225 ended its third attempt partial; do not use a missing
second handoff to authorize an extra attempt beyond the committed ruling.
Tokens per proved row remain unavailable, so this reading establishes no
improvement in token efficiency and authorizes no new dispatch. Program's
counts cover other Goals and do not replace the web counts above.

## Work and next actions

| Task | Decision and next action |
| --- | --- |
| G-2204 | Attempt 2 remains partial: named units and twelve stories do not replace the failed full affected gate or the two failed visitor stories. Program accepted the six OWNER CHANGES paths and the bounded empty-query replay correction. Hold one resume until G-2255's visitor releases request with `limit=20` is recorded on main and G-2219's Zone repairs are on main. G-2219 is now ledger-verified; the missing record remains an independent prerequisite. Rebase retaining both the empty-query correction and `260ff71af`'s completed 201/204 handling, preserve query values and assertions, inspect repaired visitor stories on phone/desktop and pass the complete gate. G-2215 has exited: align its released tracking claim, then G-2204's reader and six approved paths by reclaim before further work. No landing is accepted. |
| G-2215 | First handoff remains partial. API's G-2263 is queued after G-2255 releases the collection proof to supply the three exact owner records: work-state IDs in production order, import rows without `cursor=-1`, and unchanged export continuation with its opaque cursor/snapshot and no `limit`. Wait for API's actual main commit; assignment is no record proof. Program superseded the harness-repair prerequisite: `37402a45c` and `5d930e42c` supply the two repairs, and the other seven reported failures are host timing failures. Do not assign harness investigation to this worker. Reclaim the committed route/inventory claims, rebase, prove import credit/private metadata and export continuation through production, inspect phone/desktop captures and pass the full gate. Tracking reader ownership stays with G-2204. No resume, landing or close was accepted by these mail events. |
| G-2216 | Owner list/member empty/loading/expired-return is on main at `cd490077773a`. Attempt 2's bounded lender-create step was accepted in `d4556072f` and landed at `d510079a1e40`: unchanged HTTP 201 through typed client, production `openLoan` adapter, reader and shared mapping; five units, ten recorded stories, phone/desktop inspection and complete gate passed. This proves the adapter/page, not dialog interaction or completed return. Keep the task open; neither row is complete. Resume refusal only after program mails that G-2255's exact `state=active&limit=20` records are on main. Preserve visitor 401 and foreign-person 403; no workaround or additional round before that input. |
| G-2242 | Program accepts only the existing shared reader/mapping and recorded entry/loading story as a step, subject to the full landing gate. Its stopped landing received a `merge` retry in the de6409a1 event; decide the result separately, never restart it here. Keep the task open. Populated thread, same-persona empty entry and private refusal await G-2257's authoritative records after API's G-2253 vote-schema work. Resume when program reports those records on main; no cast, fabricated record or repeated missing-input round is authorized. |
| G-2244 | The first partial landing stopped after main changed type-checked web workspaces again. `53080d757` reclaimed manage-route claims and resumed attempt 2 only for rebase and complete gate recovery. `a2f5c544b` accepts the recovered partial at HEAD `03ff36611e30` against tested base `d826c2c08043`, with complete gate and phone/desktop evidence; it explicitly authorizes no landing, merge retry, close or further worker work. The task is exited and no landing lock remains. Editor stories still await G-2261's owner Zone `limit=50`, collection-name and acting-owner Work records. Production frame identity and the injected shared-reader seam remain unproved; G-2267 separately owns home-document authoring. The row remains incomplete. |
| G-2225 | Attempt 3 remains partial: duplicate header reader, missing acting-person parity in signed-in `TextReader` stories and exact record gaps block acceptance (`2b922f9c7`). Program's bounded cut is committed at `16cf46474`: stay exited until both G-2204 and G-2277 land, then add/reclaim the exact `work-page/read.ts` claim and resume once for the injected production `loadWork`/`read.ts` header, retained problem details, removal of the duplicate reader and production acting subject in stories. Admit only G-2277's page states described below; run the whole gate once at the end. Nothing else is in scope. If partial again, mail program before any further resume. No landing is accepted. G-2204 itself awaits G-2255's two Books records. |
| G-2267 | Committed at `6eec305d3` and queued behind G-2244's overlapping `api.ts` and `navigation-editor.tsx` claims. Own the prepared home-document identity through draft save/reload, publication, navigation publication and review; preserve the Zone endpoint, exact revisions/digests/epochs, authority, CAS and retry keys. Prove all four production actions by exact unchanged recorded answers through typed client/replay, with units, stories and phone/desktop evidence. The contract and owner's HTTP 201 record are correct; no new API proof or recording is required. G-2245 is verified and holds none of these authoring paths. This separate correction does not complete G-2244. |

These rows summarize decisions and current recorded dispositions, not new
acceptance of later handoffs. Later committed brief rulings remain authoritative
under their own events. No brief is edited during this checkpoint or a landing.

G-2219's listed fourth handoff was not accepted: 189 unit passes did not clear
seven official-story timeouts or missing captured Workshop actions. Its decision
authorized a bounded resolved-host story composition repair, preserving real
package slots, production mapping, request-cached access, synchronous
`cardRenderer`, optional `tryHref` only when open, import boundaries and cover
parity. Program assigned the unclaimed Realm `zoneImage` credit repair to the
same task, superseding its earlier exclusion; no separate task was needed.
The latest ledger records G-2219 closed verified at 2026-10-13 18:05:16 UTC,
and its brief is archived. Do not duplicate its worker or landing; this
checkpoint does not adjudicate its later handoff.

The ledger also records G-2091 closed verified at 17:44:01 UTC and G-2199
closed verified at 16:55:28 UTC. The previous G-2091 landing-progress hold is
obsolete; its accepted structural guard releases G-2236's Recipe claim.
G-2091's deferred Library/rating/Studio and alias inventory remains debt,
not additional product proof. Decide other handoffs in their own events.

## Surface and retained decisions

Admission is complete; do not dispatch or queue the admitted family again.
Every surface requires the replay and each row's outcome record on main, using
its `needs:` gates. The admitted family keeps `depends: []` except G-2225's
explicit shared-path order after G-2204; G-2267 separately orders its authoring
claims after G-2244. Read six-persona matrices before dispatch.
Stories consume unchanged answers through the replay, typed client and the
production reader/mapping. Program's standing rule supplies the client at the
production reader boundary: request-cached host client in production, replaying
client in stories, preserving production behavior and recorded problem details.
A story file has no reader of its own and shows only states its production
route reaches from unchanged records. Remove unsupported empty/refusal states
and name their record gaps. G-2225 sends its gaps together to program with
persona, method and path including parameters; program briefs the record task.
The rule was committed separately in 22 editable briefs; G-2222, G-2242 and
G-2244 were then landing and untouched. G-2244's recovery decision now carries
the rule for future story work. Add it in G-2222 and G-2242's result turns if
their briefs remain open, never while their landing lock exists.
Later verticals wait for and reuse their Books seam. G-2169's browse seam is
landed; it is not a task dependency. G-2224's corrected row remains
`anime/navigate-a-thousand-episode-inventory-thousand-chapters`.

Shared files are read without claiming them. An OWNER CHANGES repair needs
its exact path committed in the brief, reclaim after any holder exits, and
landing after any holder lands. Never reclaim a running worker or edit a
landing brief. The surface gate includes affected consumer tests (`34d548013`).
Query parameter order is handled by `4085f1b94`; different query values still
require exact authoritative recordings. Keep admitted engines: no listed
event establishes an empty or twice-partial Grok surface handoff that triggers
the queued-brief switch. Program cited G-2216's eight passing stories in
75 minutes as evidence to retain them. No pending story is admitted without
recorded HTTP 202. Preserve all records and visible assertions.

Program's surface tests-step repair reruns timed-out files alone at a longer
limit and reports failures already on main at the gate base without charging
the task. Until it lands, a tests-step failure consisting only of timeouts in
unchanged files calls for another complete gate, not returning the task.
Recorded stories remain final acceptance evidence; this is no story waiver.
Landings now run outside their initiating turn and mail the result (`8b24d9212`).
Start each once; the result event closes a fully completed brief or resumes
the remaining work. This checkpoint starts or restarts no landing.

Program's de6409a1 ruling supplies G-2277's exact requests for
`books/read-non-ui-languages-non-ui-languages`: published headers for all six
personas (visitor without a query, others with acting subject), each successful
header's selected-language read (omit language when none), owner's private
header and selection, private-header refusal for the other five personas,
visitor/member `zh-Hant` credits, and settings for each signed-in persona whose
header succeeds. G-2225's stories run in `en` and `zh-Hant`; other-locale credits
are neither recorded nor shown. No surface needs a story per locale. This
row's Work has no chapter and promises none, so it asks none; no chapter story
or gap remains. Preserve existing eight-locale support and exact records.
The SQL-relation guard timeout is repaired on main at `a0afe60a3`.
Program permits `merge` retries for stopped "retry merge" landings, with the
workspace-change repair at `4c68c738e`; G-2244's specific committed recovery
decision nevertheless accepts no retry from its handoff.

Recipes catalogue/authoring/collection records landed at 19:08 UTC and all
four Visual novels records at 18:54. Program reported Manga and Anime landing;
that report is not a landed record. Their queued surfaces start through
`needs:` without a new mail or checkpoint dispatch. These records establish
no additional complete web surface row in the handled events.

G-2201's eight-locale D080 copy is landed at `bbf3996be156`; G-2200's mounted
Collection shelf test is landed at `333b187bf`. G-2094, G-2090, G-2092 and
G-2093 retain their canonical-href, continuation, identity and filter guards.
Twelve continuation remainders, 18 identity analyzer debts and 81 filter
owner-audit expressions need independent evidence and bounded slices.
Keep structural guards bounded, with benign-edit/correct-consumer passing
fixtures and class-violation failing fixtures. Debt alone is not a product
fault; unproved findings stay in `later.md`, and API gaps stay with api.

Recipe's missing "As written" radio and fraction-glyph assertion discrepancy
remain held for row proofs. The Zone publication identity discrepancy is now
resolved as web authoring: the prepared `configuration.homeDocument` is the
page identity, and G-2267 owns its correction. The owner's record stays
unchanged. Archived work is not resumed by this checkpoint.

## Acknowledgements

All three supplied mail deliveries are already acknowledged in durable mail:
0ca3c179 at 18:59:46, d5771f1e at 19:14:26 and de6409a1 at 19:22:25 UTC
on 2026-10-13. Their acknowledgements need no duplicate reply or program
question. Earlier checkpoint acknowledgements remain recorded in durable mail. Pending mail
and landing results retain separate decision events. This checkpoint waits
on nothing and arms no watcher.
