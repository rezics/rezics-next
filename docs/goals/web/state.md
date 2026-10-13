# State

Checkpoint 3cc7f8af-804c-4b81-8d30-d97ac442625a consolidates handled events
mail:952086e3-202d-417d-9af2-518e6dccf352,
mail:3f59a233-00b7-416c-8668-51bb4ea66830, task:G-2234:2,
mail:094ee3a8-56bc-4405-bd31-de86ad896736,
mail:daf78947-c10e-4454-9d7d-1da0661a7635,
mail:2105a9cc-e12f-4934-9ab4-af9017c8498f,
mail:724be367-a2de-412a-97a3-e6420f8d6004 and
mail:6bb4e19e-773e-4185-b9fd-f2ca2be94350.
Carry forward unaffected decisions. The program's 2026-10-13
restart withdrew the earlier wrap-up prohibition. This checkpoint edits only
this file, starts no worker or landing, and decides no pending event.

## Scope and measures

`task goal -- status` returned only `waiting for ledger lock`, so scope,
persona cells, account allowances, tokens, refusals and program attempt measures
are carried from the preceding checkpoint. A fresh read-only ledger snapshot
supplies raw attempt and closure counts. These readings
describe concurrent progress; they do not decide later handoffs or landing mail.

| Measure | Latest available reading |
| --- | --- |
| Program API scope | 43 of 67 rows proved |
| Persona cells | 304 proved, 98 pending, 0 not applicable, 0 missing |
| Web surfaces | 26 earlier admitted family page briefs plus ten committed/queued briefs G-2325–G-2334; G-2338 separately briefed and held; G-2242/G-2244 partial steps installed; complete surface-row total unavailable; G-2267 authoring and G-2319 year Conditions remain separate |
| Raw web attempts | 47 across 29 attempted tasks: 29 first, 4 step, 11 fix, 3 historical unclassified subsequent attempts; queued work is excluded |
| Raw first attempts | 29 of 47, 62%; distinct from the tool's step-adjusted share |
| Attempts per verified task | Median 1, maximum 5 (G-2219), across 13 verified tasks |
| Web tokens, carried | 42.1M input, 291.7k output; tokens per proved row unavailable |
| Recorded refusals, carried | 0 outcome, 0 gate, 0 failing-test finding, 1 other |
| Program measures, carried | 58% first attempts (85%, 70 of 82, for the preceding snapshot's day); attempts per landed task median 1, maximum 9; 1120.9M input, 5.1M output with 70 sessions unavailable; tokens per proved row unavailable |
| Program refusals, carried | 0 outcome, 8 gate, 0 failing-test finding, 2 other |
| Accounts, carried | codex 18%, codex-1 32% of their weekly windows |

The carried API count is program progress, not web surface proof. It decreased
from an earlier 44-row reading to 43; no fresh scope reading is available here.
The raw initial share rose from 61% to 62%, remains above half, and the median
is within two, but G-2219's
five attempts exceed the method's three-attempt cap in the raw history. Its
history includes design reading, host-input discovery and repair steps;
do not silently relabel those attempts or treat that history as permission
for another fix round. G-2225 ended its third attempt partial; do not use a missing
second handoff to authorize an extra attempt beyond the committed ruling.
The current ledger includes G-2225's fourth attempt and G-2215's recovery;
their new handoffs remain separate events. Other concurrent attempts are
measurement only, not acceptance. The last available efficiency report
is still the 15:40–18:46 UTC program-wide window (283.9M input, 49% no-decision
share), not a new web tokens-per-row reading. Tokens per proved row remain
unavailable, so this reading establishes no
improvement in token efficiency and authorizes no new dispatch. Program's
counts cover other Goals and do not replace the web counts above.

## Work and next actions

| Task | Decision and next action |
| --- | --- |
| G-2204 | G-2255's visitor `availability-releases` with `limit=20` is on main and closed; G-2219 is verified, so both prerequisites hold. Claims were reclaimed from the committed G-2215/G-2204 briefs and attempt 3 resumed for the one bounded correction. Retain the empty-query replay correction and `260ff71af`'s completed 201/204 handling, exact query values, records and assertions; inspect repaired visitor stories on phone/desktop and pass the complete affected gate. No Zone repairs or extra replay scope. No landing is accepted; decide the next handoff separately. |
| G-2215 | The first partial landing stopped: main's two-device owner cell is pending, and two gate references were stale. Both references now name `apps/web/tests/g-891-library-shelf.test.ts` and `apps/web/tests/library-state.test.ts`; retain these and `library/read.test.ts`. Program's mail:6bb4e19e supersedes the hold: the two-device row is cut out to G-2338, claims reclaimed, and attempt 2 resumed once to remove only that row's stories/replay inputs/supporting reads and hand off the four proved rows for a step. Preserve collection tracking, records/assertions and the three exact owner-record remainders (ordered work-state IDs, import without `cursor=-1`, unchanged export cursor/snapshot without `limit`), import credit/private metadata and export continuation. Rebase, inspect phone/desktop and pass the complete affected gate. No retry of the stopped landing or merge; decide the next handoff separately. Tracking adapter ownership stays with G-2204. |
| G-2216 | Owner list/member empty/loading/expired-return is on main at `cd490077773a`; the bounded lender-create adapter/page step landed at `d510079a1e40`. G-2255's exact `active-loans-refused` with `state=active&limit=20` is now on main: attempt 3 resumed only for that held refusal slice, preserving visitor 401 and the four foreign-person 403 outcomes through the typed client and production reader/mapping. Inspect phone/desktop and pass the complete gate; no dialog interaction or completed-return expansion. The ledger now records this attempt exited; its handoff is a separate event, not accepted here. Keep the task open and both rows incomplete. |
| G-2242 | Shared reader/mapping and recorded entry/loading merged at `1924247eb`; installed claims were released while the task stays open. Populated thread, same-persona empty entry and private refusal await G-2257 after API's G-2253 vote-schema repair. No landing restart or missing-input resume. Before an eventual resume, identify and reclaim exact production seam paths after holders exit. Stories inject the replaying typed client at the production reader boundary; production retains request-cached host access, shared mapping, acting Person, exact requests and problems. No cast, fabricated record or story-owned reader; inspect phone/desktop and pass the complete gate when records arrive. |
| G-2244 | Mail:952086e3 superseded the recovery's landing prohibition and started the accepted theme/navigation-wiring partial step with current-main gates. Mail:724be367 reports success; the ledger records `e1e7df6ff602`. Keep open: editor states and production frame identity remain unaccepted, and G-2267 owns home-document authoring. Unchanged editor API/navigation/theme/helper claims were released by the partial-step decision. The result turn mailed Program the brief and authorized-remainder question; it started no resume, close or repeat landing. Future editor work needs G-2261's owner Zone `limit=50`, collection-name and acting-owner Work records and exact reclaimed integration paths. Decide later Program replies separately. |
| G-2225 | G-2277 is verified at `2136bda4b09b`, including reader settings. Mail:952086e3 supersedes the prerequisite hold only for bounded preparation in unblocked claimed paths; attempt 4 resumed while G-2204 retains `read.ts`. Remove the withdrawn credits read from the production reading page and stories, replay signed-in settings with production acting Person, and prepare admitted reading states in `en`/`zh-Hant` with exact header/selection queries, unchanged answers and problems. Do not edit/reclaim G-2204 paths, add a header reader or accept a substitute header. Preserve the shared-header integration findings; inspect phone/desktop and run the whole gate once. Hand off the slice and exact shared-header remainder; no landing accepted. This is the committed cut at the attempt cap, not repeated-fix permission: if partial, mail Program before any further resume. |
| G-2267 | Committed at `6eec305d3` and queued; G-2244's partial-step decision released the overlapping unchanged `api.ts` and `navigation-editor.tsx` claims. No new start or handoff is decided here. Own the prepared home-document identity through draft save/reload, publication, navigation publication and review; preserve the Zone endpoint, exact revisions/digests/epochs, authority, CAS and retry keys. Prove all four production actions by exact unchanged recorded answers through typed client/replay, with units, stories and phone/desktop evidence. The contract and owner's HTTP 201 record are correct; no new API proof or recording is required. G-2245 is verified and holds none of these authoring paths. This separate correction does not complete G-2244. |
| G-2231 | Program recovered the declaration-blocked conflict with `merge`, then reported it landed and closed at `b5976c9fd` in mail:34e08bee. Its brief is archived. Recovery is resolved; start no further worker or landing. |
| G-2243 | The admitted/reclaimed `showcase.ts`, `realm/modules.ts` and `zone-editor/home-content.tsx` remain part of the accepted shared home assembly/rendering step. Mail:094ee3a8 reports `land --step` refused the old conflict state and declaration text; the deciding turn mailed Program recovery and started no retry. Mail:6bb4e19e resolves recovery: Program's `merge G-2243` is running once for exactly that step; `ca1c01bad` already repaired the declaration. Do not restart it; decide its result separately. Keep the production frame correction behind G-2312's six-persona published/empty home records. Then claim/reclaim the actual `SiteHomeRoute`/`loadRealmView` seam and resume once as a cut with fresh identities, exact client split/conditional reads/session header, phone/desktop inspection and full gate. If partial again, mail Program before another resume. |
| G-2234 | Attempt 2 at `624bc1d20` remains partial/unaccepted: twelve mapping units, six stories and types do not replace the complete gate, which did not run. Program's G-2336 supplies six production page-read groups after G-2318's frame helper lands; keep exited until Program reports the record on main. Fresh identities replace historical requests. Use the row record's language and withdraw the extra `zh-Hans` management-header demand unless its proofs read it. Replace supplied `settingsAllowed` with the production management access read; preserve client split, exact queries and problems. `safety-pending.ts` was admitted and reclaimed. `admin-api.ts` stays G-2235's; its client-factory correction belongs there or waits for its landing. No further resume/landing now; eventual recovery must retain accepted rules, CAS/keys/persona, inspect phone/desktop and pass the complete affected gate. |
| G-2239 | First partial remains unaccepted. `899408225` resolves the request graph: G-2293 owns all eleven production read groups for all six personas, including cached session/language inputs; no numeric allowance remains. G-2272 landed, releasing recording but not supplying these reads. G-2294 owns bare/empty-query replay equivalence in both directions after G-2204 releases it. Keep exited until both land, then one bounded correction with exact seam claims/reclaim and injected `RealmBrowseRoute` flow. Preserve anonymous facets/header/resolver, production persona on eligible reads, conditional member-ban, exact queries/headers and fresh record identities; retain problems/assertions, inspect phone/desktop and pass the full gate. Member empty does not prove visitor empty. |
| G-2224 | First partial remains unaccepted. `f7dfe4509` assigns six-persona headers, pre-inventory contents, exact `position=start&language=en&limit=100` pages/continuations and search windows to G-2292. Old `limit=2` is a record gap; unreachable label search is web's gap. Keep exited until records land and G-2204 releases `read.ts`, then add/reclaim exact reader/route/contents and Books inventory/test claims and resume once as a cut. Production carries entered `q` through restart/continuation with selected language/page size; injected replay preserves preceding reads and bounded 409 retry. Include held Books empty-page change, retain problems/assertions, inspect phone/desktop and pass full gate. If partial again, mail Program before more work. |
| G-2233 | First partial held at `9dcd81e3e`: gate and 24 stories do not prove production queue/receipt/refusal/loading. Moderation is `/manage/r/[realm]`; `/requests` is separate. `af174991d` keeps the correct appeal gate: API must report deployment-open platform groups, then Program briefs one record correction with language-qualified headers, out-of-Realm moderator refusal, moderation context and owner's decided case/supporting reads. Owner Zone 503 is also an API fault; no pending/join-request proof is required. Keep exited until fix and records land. Claim/reclaim exact queue/frame/Realm-home/appeal seams before the bounded correction; remove record-driven readers, preserve access, actual Zone requests, problems, command keys and subsequent receipt flow, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2235 | First partial held at `9c3bfa53e`: sample-driven `loadRealmTeamRecorded` does not prove production frame or Save preview. G-2309 supplies anonymous owner profile, five other personas' `language=en` headers, owner role-impact preview and parallel invitations reads. `d0490698e` requires identities/command values from its whole fresh record. Roles/members route claims committed and reclaimed; claim/reclaim any further exact seams before bounded correction. Keep exited until records land, then inject production readers/commands, remove substitute loader/unsupported states, preserve persona, revision/digest, keys, problems and assertions, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2232 | First partial held at `10238c248`; address reader/page claims added. `6d40868ef` accepts the correction and assigns six exact request groups to G-2311: inbox/refusals at `limit=50&q=`, owner continuation, stranger/operator join support, reached withdrawal/decision commands and joined member/moderator frame. Use identities from its whole fresh record; unreached invitation/202 remains a gap. Keep exited until Program mails landing, then reclaim and resume once as a cut: inject `readSpacePage`, `loadRealmView` and `readRequestsAtAddress`, preserve production frames/sign-in/authority/problems/assertions and remove unreachable visitor basis branch/stories/test. Claim additional seams first, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2229 | First partial at `1da77e8fc` held in `c354d0863`. `b9f61223d` resolves frame/year questions: G-2318 records complete six-persona frames through `frame-reads.ts`; G-2319 separately owns year state/Conditions. Use fresh identities and anonymous facets/header/site resolver (`scope=space`, Zone key/capability), with production persona on presentation/routes/eligible reads. Keep exited until Program mails G-2318 landed and G-2319 is on main, then claim/reclaim exact seams and resume once as a production correction cut. Remove parallel frame/record-derived requests and fabricated facets, retain problems/assertions, replay value/range/combined year requests, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2319 | Brief committed at `9ec3b4749`; the queue-refusal event records concurrency 34/34 and a ledger lock. Its deciding turn initiated one durable queue retry, which reported the lock; no brief change or worker registration was established. Retain the intended queued work and decide later queue events separately; do not dispatch or retry here. Shared `BrowseState`, API query, links/continuations/search retain `publicationYear` value/range as a removable Condition; clear-all removes it. `official: null` declares no year control while honoring the address. Production-model units only; required on main before G-2229 resumes. |
| G-2325–G-2334 | Ten separate briefs committed and queued under mail:2105a9cc, each with `depends: []` and replay/row-file `needs:`: Recipe read (G-2325/G-2295 record), Anime hub (G-2326/G-2296), relations (G-2327/G-2297), tracking (G-2328/G-2298), two-device (G-2329/G-2299), Manga tracking (G-2330/G-2300), two-device (G-2331/G-2301), Zone publication (G-2332/G-2302), independent Zone (G-2333/G-2303), and Books browse (G-2334, existing record). All ten six-persona matrices were read before admission. Automatic starts need no later manager dispatch. Each story consumes unchanged production page/frame requests through the shared reader/mapping and typed replay; no substitute frame/reader or unsupported state. Books was reported starting; Program immediately received its exact request gap: production browse/search/no-match/continuation omits `limit`, while recorded samples use 10/1. Keep the record/query unchanged and hand off partial if missing. No surface handoff accepted here. |
| G-2338 | Separate Books two-device surface brief committed after G-2215's cut; held outside queue with `needs: []`, `depends: []` until Program mails G-2323 landed. Then check main's six-persona declaration and complete production page/frame records before queueing. Existing files do not prove the pending owner cell. Reuse the production Library seam when present; claims provide ordering without a web task dependency. No worker starts or queue action is authorized by this checkpoint. |

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

The earlier family and G-2325–G-2334 are admitted; do not dispatch or queue
them again. G-2338 remains held for its explicit proof-restoration event.
Every surface requires the replay and each row's outcome record on main, using
its `needs:` gates. Before dispatching a surface not yet written, check its
row's `frame-*` samples for the complete production frame reads; mail Program
the row in one line if missing, before a worker discovers the gap. Record tasks
use G-2318's shared `tests/qa/support/frame-reads.ts` helper. Whole recording
runs replace identities; use the replayed record's identities and preserve
production's anonymous/persona client split, exact queries and conditional
reads. Cached session and language inputs require records too. The admitted
family keeps `depends: []` except G-2225's
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
G-2244 were then landing and untouched. G-2244's recovery and G-2242's installed
step decisions now carry the rule for future story work. Add it in G-2222's
result turn if its brief remains open, never while its landing lock exists.
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
and settings for each signed-in persona whose header succeeds. The later
f3beab1a ruling withdraws the visitor/member `zh-Hant` credits stories: `/read`
and `TextReader` request no credits. Those GET samples stay unchanged and
unused; Work hub credits use `POST /v1/query` and require their own surface
record when built. G-2225's stories run in `en` and `zh-Hant` for its own text.
No surface needs a story per locale. This
row's Work has no chapter and promises none, so it asks none; no chapter story
or gap remains. Preserve existing eight-locale support and exact records.
The production text
selection sends only `language=sv`, without `actingSubject`; authenticated
clients, headers and signed-in `TextReader` retain their production persona.
The five private-header refusals are 404 and stop selection; the owner's
private header succeeds 200 but its selection is 404, proving missing text.
The SQL-relation guard timeout is repaired on main at `a0afe60a3`.
Program permits `merge` retries for stopped "retry merge" landings, with the
workspace-change repair at `4c68c738e`. G-2244's later partial-step decision
superseded its recovery's landing prohibition, and that step has succeeded;
its result authorizes no repeat landing or remainder resume.

Program repaired main's `zone/site-pages` owner declaration at `ca1c01bad`
using `outcomeTest`; the cell stays pending and its 32-page proof and assertions
are unchanged. This clears the declaration-reader error, not the owner proof
or a surface gate. Program resolves stopped `conflict` landings with `merge`:
G-2231 is reported closed, G-2242's step is installed and remains open, and
G-2243's running merge result remains separate. Do not repeat those merges.

Recipes catalogue/authoring/collection records landed at 19:08 UTC and all
four Visual novels records at 18:54. Program additionally reports Recipes
pagination G-2279 on main for G-2237 and Visual novels catalogue G-2272 landed
without the transient 503; its removed 64 member card reads are no longer in
the production proof. Reports of nine further records being written are not
landed records. Queued surfaces start through
`needs:` without a new mail or checkpoint dispatch. These records are inputs,
not additional web surface acceptance.

Program's mail:6bb4e19e reports eight late-answer recording failures from
20:00–20:55 UTC with eleven stacks and load 85–103. Anime contents/relations,
Manga collection and Zone home returned partial solely for host timing.
Program lowered test slots to ten, briefed the load-start limit as G-2335,
and resumes those record tasks one at a time. Inputs are delayed by about an
hour; this changes no web brief, acceptance criterion or queue action.

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

All seven supplied mail deliveries are already acknowledged in durable mail:
952086e3 at 20:44:30, 3f59a233 at 20:48:08, 094ee3a8 at 20:52:15,
daf78947 at 20:52:10, 2105a9cc at 20:59:58, 724be367 at 21:10:11 and
6bb4e19e at 21:12:38 UTC on 2026-10-13. No duplicate acknowledgement is
needed. Task:G-2234:2 had no attached mail and its task inbox was empty.
G-2243 recovery and G-2215 proof/cut questions are resolved by the supplied
Program reply; G-2244's authorized-remainder question and Books browse's
exact no-limit requests remain with Program. G-2336 supplies the rules-page
record inputs; that assignment is not landed proof or a resume authorization.
Earlier checkpoint acknowledgements remain recorded. Pending mail, handoffs
and landing results retain separate decision events. This checkpoint waits
on nothing and arms no watcher.
