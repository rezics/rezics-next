# State

Checkpoint 6729d1e1-2010-4470-bfbd-b2964f95095a consolidates handled events
mail:8c681812-abf4-416d-859d-015787777aa1,
mail:0a58c17f-a99f-4001-90de-0dca598620c6, task:G-2325:2,
mail:3b0c4850-f395-462e-9e93-0a014eca3077,
mail:162ce331-103e-461d-a2be-f25a3bd93563,
mail:916e2a17-636c-42d0-82e1-ab0ba9835758,
mail:47004d68-8386-457d-90fd-d5eac812fdab,
mail:f272e819-8de4-4c38-a8d2-e14424abf93a,
mail:5a6c6a99-117d-44eb-b8f8-e204eeda849c,
mail:da5abac9-79f9-487d-88b3-359aad239e9e and task:G-2232:3.
Carry forward unaffected decisions from checkpoint e4472143. Program released
the two held complete gates and authorized independent installed cuts and
fresh worker contexts. G-2390 is closed verified; G-2232's third handoff is
unaccepted and its remaining cut is with Program. This checkpoint edits only
this file and decides no later event.

## Scope and measures

`task goal -- status` and a read-only ledger snapshot supply the following
measurements. Concurrent dispositions are measurements, not decisions on
later handoffs or landing results.

| Measure | Latest available reading |
| --- | --- |
| Program API scope | 47 of 67 rows proved at this checkpoint's status reading |
| Persona cells | 308 proved, 94 pending, 0 not applicable, 0 missing |
| Web surfaces | G-2390's bounded Books empty-state slice is landed and closed; G-2224/G-2243/G-2227/G-2240 resumed fresh; G-2340/G-2381 started with registered loans; G-2215's unchanged gate resumed; G-2325's second and G-2232's third handoffs remain unaccepted under these events; complete surface-row total unavailable |
| Web tool measures | Current status omits the attempt classification; last checkpoint reported 82% first share, today 50% (2 of 4), with 41 first, 20 step and 9 fix; these are historical readings |
| Raw web attempts | 80 across 44 attempted tasks: 44 first and 36 subsequent; queued work excluded; raw first share 55%; later-event attempts in this concurrent snapshot are measurements only |
| Attempts per verified task | Median 1, maximum 5 (G-2219), across 20 verified tasks in the ledger snapshot |
| Web tokens | Current per-Goal reading unavailable; last checkpoint had 675.7M input, 4.8M output and 3 unavailable sessions; tokens per proved row unavailable |
| Web recorded refusals | Current reading unavailable; last checkpoint had 0 outcome, 5 gate, 0 failing-test finding and 9 other; G-2390's missing-test refusal and G-2234's rebase conflict are documented below |
| Program measures | Current reading unavailable; last checkpoint had 63% first attempts, landed-task median 1 and maximum 9, 1330.8M input and 5.9M output; tokens per proved row unavailable |
| Program refusals | Current reading unavailable; last checkpoint had 0 outcome, 9 gate, 0 failing-test finding and 4 other |
| Accounts | codex 27%, codex-1 47% of their weekly windows |

The live API scope reading fell from 48 to 47; this establishes no web surface
regression or additional proof. Raw first share fell from 59% to 55%, still
above half; today's current tool share is unavailable. The median is within
two, but G-2219's five raw attempts exceed
the method's three-attempt cap: preserve history and authorize no further
fix round. G-2225's closed step and G-2350 split prohibit a fifth attempt;
G-2204 remains closed without a fourth. Tokens per proved row are unavailable,
so this checkpoint establishes no improvement in token efficiency or new
dispatch authority. Program's measures cover other Goals as well.

Mail:916e2a17 explicitly released G-2215's unchanged complete gate and
G-2232's final complete gate, superseding the three-passing-main-runs hold.
Startup parent/budget failures remain Program-owned; other failures remain
evidence to decide. G-2215's fourth raw attempt is gate-only recovery under
that ruling, not another implementation correction. Program's later fresh
context ruling covers the ready exited tasks individually; it establishes
no family-wide engine switch. Later handoffs, closures and landing results
retain separate events.

## Work and next actions

| Task | Decision and next action |
| --- | --- |
| G-2204 | Program's mail:20018151 started the conflict-recovery merge once; mail:dcc877d6 reports it merged at `aed28882c4bf`. Mail:84b41812 found nothing left in its brief, and the deciding turn closed verified at 22:52:51 UTC, releasing its claims. Start no fourth worker attempt or repeat landing. Preserve empty-query equivalence, completed 201/204 handling and exact queries/answers/assertions. Full-page `EmptyInventory` stays cut; G-2345's empty-Work inputs are now on main, and G-2390 owns the separate bounded surface follow-up. This closure adds no empty-Work proof. |
| G-2215 | Mail:916e2a17 supersedes the three-passing-main-runs hold and resumed attempt 4 only for one unchanged complete `task goal -- check`, rebased with `64dc60068`. Change no implementation, fixture, request, assertion or gate; repair no harness. Startup parent/budget failures remain Program's G-2389: report exact failures and run directory; other failures remain evidence. Preserve the four-row cut, collection tracking, ordered IDs, import/export credit/private metadata and continuation assertions; two-device stays in G-2338. A green complete gate precedes a separate step decision; no landing or closure accepted. Mail:f272e819 found this attempt already running and started no duplicate. |
| G-2216 | Owner list/member empty/loading/expired-return is on main at `cd490077773a`; the bounded lender-create adapter/page step landed at `d510079a1e40`. G-2255's exact `active-loans-refused` with `state=active&limit=20` is now on main: attempt 3 resumed only for that held refusal slice, preserving visitor 401 and the four foreign-person 403 outcomes through the typed client and production reader/mapping. Inspect phone/desktop and pass the complete gate; no dialog interaction or completed-return expansion. The ledger now records this attempt exited; its handoff is a separate event, not accepted here. Keep the task open and both rows incomplete. |
| G-2242 | Shared reader/mapping and recorded entry/loading merged at `1924247eb`; installed claims were released while the task stays open. Populated thread, same-persona empty entry and private refusal await G-2257 after API's G-2253 vote-schema repair. No landing restart or missing-input resume. Before an eventual resume, identify and reclaim exact production seam paths after holders exit. Stories inject the replaying typed client at the production reader boundary; production retains request-cached host access, shared mapping, acting Person, exact requests and problems. No cast, fabricated record or story-owned reader; inspect phone/desktop and pass the complete gate when records arrive. |
| G-2244 | Theme/navigation wiring landed at `e1e7df6ff602`. Mail:1bf33bd5 confirms G-2261's owner editor records at `66e41a4ca`: Zone `limit=50` 200, collection-name 200 and Work 404 because the target is a collection. Attempt 3 resumed only for editor states through client-supplied production adapters/mapping, phone/desktop inspection and the complete gate. G-2267 holds API/components; consume their existing APIs without editing them. G-2234's retained `realm/read.ts` claim prevented the public seam reclaim, so that remainder is committed/queued as G-2340. Missing editor answers go together to Program as one record request, not another hold. Editor handoff remains unaccepted; publication authoring remains G-2267. |
| G-2225 | Program's mail:890e3dfe accepted credits removal and signed-in settings replay as a step, split header integration to G-2350 and prohibited a fifth attempt. The single `land --step` succeeded at `d3598bc1d29b`; mail:4102f0e6's deciding turn found nothing remaining in this brief and closed verified at 22:29:09 UTC. The brief is archived. Start no worker or repeat landing; G-2350 owns the header remainder, so closing this step adds no header-integration proof. |
| G-2267 | Attempt 1 is blocked/unaccepted: publication/review proof does not prove save and exit-save. The owner's `POST /v1/content-drafts` was preparation outside the record. Mail:263c04d8 confirms seed types repaired at `eea281dcb` and assigns G-2346 to record save, saved-draft/head reads missing from `browserZoneAuthoring`, and the chain from configuration's `homeDocument` through saved revision to `publish-site-bundle`. Keep exited until Program mails its landing commit; then resume for save/exit-save replay and the complete gate, preserving exact revisions/digests/epochs, authority, CAS, retry keys, assertions and phone/desktop proof. Do not rewrite the correct existing publication answer. This authoring correction remains separate from G-2244/G-2340. |
| G-2231 | Program recovered the declaration-blocked conflict with `merge`, then reported it landed and closed at `b5976c9fd` in mail:34e08bee. Its brief is archived. Recovery is resolved; start no further worker or landing. |
| G-2243 | Earlier shared home assembly/rendering cut and its admitted `showcase.ts`, `realm/modules.ts` and `zone-editor/home-content.tsx` remain preserved. Mail:f272e819 verifies G-2312 on main at `b5d60a6669d2442143617b8ea13dbd51a79d9be9` and resumed attempt 2 in a fresh Grok context for the production home/frame cut, without repeat landing. Registered narrow loans in `realm/read.ts`, `realm/routes.tsx` and `realm/realm-page.tsx` allow only `SiteHomeRoute`/`loadRealmView` injection, preserving G-2232/G-2234 hunks and the single frame reader. Use whole fresh identities, exact client split/conditional reads/session header/problems/assertions; phone/desktop/full gate required. Return exact conflicts or missing requests; another partial goes to Program before more work. |
| G-2234 | Mail:f272e819 accepts `624bc1d20` and preceding rules changes only as a recorded-answer rules-page step, subject to the complete landing gate. The second production page/access cut waits only for G-2336's landing mail; use the available client now, with G-2235 moving reads when its seam lands. Prior admin-api/whole-page holds are superseded. Registered narrow loans release G-2340/G-2381's reader/routing work while preserving held rules/settings hunks. One `land --step` started; mail:5a6c6a99 reports a rebase conflict in `realm/read.ts`. Its deciding turn mailed Program recovery as `550e31ff`, changed no brief and started no retry. Keep the task/row open; this checkpoint does not decide the later recovery mail or authorize a second landing. |
| G-2237 | First handoff remains partial/unaccepted despite 18 passing stories: record-derived `language=en`/`limit=20`, the owner acting-subject header and story-owned frame do not prove production's own browse graph or the other five frames. Seed types are repaired at `eea281dcb`; that alone does not admit this surface. G-2343 browse/search and G-2344 pagination follow API's G-2268 and supply exact production queries and shared frame reads for six personas. Keep exited until landing mail and fresh records are on main, then add/reclaim exact production seams before one bounded correction. Inject replay through `RealmBrowseRoute` and production readers; remove story-owned/record-derived requests, retain client split, cached inputs, conditional reads, problems/assertions, inspect phone/desktop and pass the full gate. No landing retry. |
| G-2239 | First partial remains unaccepted. `899408225` resolves the request graph: G-2293 owns all eleven production read groups for all six personas, including cached session/language inputs; no numeric allowance remains. G-2272 landed, releasing recording but not supplying these reads. G-2294 owns bare/empty-query replay equivalence in both directions; G-2204 has released its claim. Keep exited until both land, then one bounded correction with exact seam claims/reclaim and injected `RealmBrowseRoute` flow. Preserve anonymous facets/header/resolver, production persona on eligible reads, conditional member-ban, exact queries/headers and fresh record identities; retain problems/assertions, inspect phone/desktop and pass the full gate. Member empty does not prove visitor empty. |
| G-2224 | Mail:f272e819 verifies G-2292 on main at `c7512db44818eaa4398b2928c26cfe4b977c49e1` and resumed attempt 2 in a fresh Grok context for production inventory and reachable label search. Route/contents/Books inventory/test claims admitted; `read.ts` is a narrow loan from G-2329, preserving its work. Replace every row identity together; retain exact `position=start&language=en&limit=100`, entered `q` through restart/continuation, selected language/page size, preceding reads and bounded 409 retry. Include the held Books empty-page correction; preserve problems/assertions and phone/desktop/full gate. First handoff remains unaccepted; another partial goes to Program before more work. |
| G-2233 | First partial held at `9dcd81e3e`: gate and 24 stories do not prove production queue/receipt/refusal/loading. Moderation is `/manage/r/[realm]`; `/requests` is separate. `af174991d` keeps the correct appeal gate: API must report deployment-open platform groups, then Program briefs one record correction with language-qualified headers, out-of-Realm moderator refusal, moderation context and owner's decided case/supporting reads. Owner Zone 503 is also an API fault; no pending/join-request proof is required. Keep exited until fix and records land. Claim/reclaim exact queue/frame/Realm-home/appeal seams before the bounded correction; remove record-driven readers, preserve access, actual Zone requests, problems, command keys and subsequent receipt flow, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2235 | First partial held at `9c3bfa53e`: sample-driven `loadRealmTeamRecorded` does not prove production frame or Save preview. G-2309 supplies anonymous owner profile, five other personas' `language=en` headers, owner role-impact preview and parallel invitations reads. `d0490698e` requires identities/command values from its whole fresh record. Roles/members route claims committed and reclaimed; claim/reclaim any further exact seams before bounded correction. Keep exited until records land, then inject production readers/commands, remove substitute loader/unsupported states, preserve persona, revision/digest, keys, problems and assertions, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2232 | Mail:0a58c17f supplies G-2382's omitted merge hash `9b2776c264a6`; mail:916e2a17 releases the complete gate, with startup parent/budget failures remaining Program's. Task:G-2232:3 nevertheless holds `35f71b439` partial/unaccepted: ten mapping units, 28 stories and phone/desktop inspection replace neither the unrun complete gate nor reached invitation/refused-management frames and transitions. Keep exited; no fourth worker attempt, landing or close from this handoff. Unclaimed address/session/Storybook edits remain unresolved. Seven supporting GETs and withdrawal/decision refresh remainders went together to Program in mail:e0d5a80c with the brief and remaining-cut question. Preserve HTTP 200 pending invitation, confirm bodies/generations/reasons, client/persona split, CAS, keys, requests/problems/assertions; fabricate no refresh state. The later Program ruling is a separate event. |
| G-2229 | Task:G-2229:2 remains partial/unaccepted. Mail:47004d68 supplies G-2376 at `e8449c24e69f`: replace every identity together from the whole refreshed Manga record, with canonical frame key `1Cg1BFuSog8nCaEwJY4TrN`. Visitor `search-newest` now says `current`; show that answer, or use another persona's unchanged stale sample through its complete frame. Preserve labels/counts/statuses/problems and the correct Zone-only address, attached Realm presentation and missing browse mount. This lifts only the canonical-key input hold. Keep exited until G-2381's route/links, shared frame/page wiring, G-2342 reads and G-2319 year Conditions are on main; admit remaining exact wiring claims before one bounded continuation. Consume shared corrections without editing their files; phone/desktop/full gate required. G-2377 creation is no prerequisite. |
| G-2240 | The member hub step remains installed at `76358916cd39`; do not repeat it. Mail:f272e819 verifies G-2359 on main at `f2ca783441c4713316b317fc6214ef2b8888be41` and resumed attempt 2 in a fresh Grok context for the remaining production hub/chooser/saved-page cut. Replace all identities together and reuse the supplied-client Books edition seam. The narrow `read.ts` loan preserves G-2329 and Games hunks. Preserve `limit=20` releases/realizations, successful-save detail requests, exact `zh-Hans`/`en` progress, revisions, CAS/keys/problems/assertions. No second seam or fabricated agent/rights display; report further claims before edits and pass phone/desktop/full gate. Task/row remain open. |
| G-2319 | Brief committed at `9ec3b4749`; the queue-refusal event records concurrency 34/34 and a ledger lock. Its deciding turn initiated one durable queue retry, which reported the lock; no brief change or worker registration was established. Retain the intended queued work and decide later queue events separately; do not dispatch or retry here. Shared `BrowseState`, API query, links/continuations/search retain `publicationYear` value/range as a removable Condition; clear-all removes it. `official: null` declares no year control while honoring the address. Production-model units only; required on main for G-2229's full row; mail:e5789d7d separately authorized its bounded frame resume. |
| G-2227 | First partial remains unaccepted; book-only Status is unreachable on Games. Mail:f272e819 verifies G-2357 on main at `e60fd0ee618148c6fe80cb2d955cffa10e4bc6da` and resumed attempt 2 in a fresh Grok context for production Availability/chooser/primary action. Replace all identities together; reuse the supplied-client Books edition seam through a narrow `read.ts` loan preserving G-2329. Retain six-persona `limit=20` releases, chooser realizations, reached signed-in progress/`readStart`/preference/`limit=1` parts, and foreign-refusal mapping proof. No mixed-persona frame, unsupported 202/409 or second reader. Preserve problems/assertions; report further claims before edits, inspect phone/desktop and pass the full gate. |
| G-2230 | Task:G-2230:1 holds the first partial unaccepted: the passing gate at `236e1d741` and preference mapping do not prove the omitted visitor release comparison or signed-in chooser. Mail:116f02bd assigns running G-2358 the whole production rerecording: six-persona `limit=20` releases, missing chooser realizations and empty-state progress, plus exact preference writes previously outside the recorder (concurrent CAS saves/409, winner replay, 400 language, 404 Work, foreign 403 and visitor 401, bodies and stable keys). Hold until Program's landing mail, then resume once with fresh Works/releases/Persons through existing `books-edition-page` and its production readers; no second seam. Admit exact shared OWNER CHANGES before edits, retain refusal unit proof/persona/CAS/keys, inspect phone/desktop and pass full gate. |
| G-2328 | G-2363 merged at `2527791a0081`; decision `c3d3f6be0` staged its 76 added samples, admitted/reclaimed `tracking/episode-api.ts` and `catalogue/reader-store.ts`, and resumed attempt 2 fresh. Replace every identity together from the whole current record. Reuse actual frame, controls, `writeStatus` and preceding reader-state GET; no facts-frame substitute or direct PUT bypass. Visitor/foreign refusals unreachable in production remain API-only. `library/read.ts` and `work-page/read.ts` remain read-only under other holders. Preserve requests/bodies/versions/keys/problems/assertions; phone/desktop and complete gate required. No handoff accepted. |
| G-2332 | G-2362 merged at `8e8de9892e4b`; staged its 27 added production reads and fresh identities. Decision `0fdb3c939` resumed attempt 2 for management read-only stories now, extracting supplied-client `authoring-reads.ts` with cached `zone-editor/read.ts` wrappers and a narrow `realm/read.ts` site-resolution loan outside paths. Preserve G-2234/G-2369 hunks, production route/frame, anonymous/persona split, conditional reads and problems. Public read-only visits depend only on G-2340's absent presentation/route injection; authoring actions are the later cut after G-2267. Deliver management alone if necessary, keeping task/row open. No save/publication/receipt interaction in this step; retain exact receipts, authority, credit, CAS/retry/refusal assertions for the action cut. Phone/desktop and complete affected gate required; harness-only failures remain Program-owned. No existing handoff accepted. |
| G-2325 | Mail:8c681812 resolves progress applicability and assigns G-2392 as the last whole-row recording; mail:162ce331 confirms the worker's exact request list. The five signed-in personas reach `SeriesProgressPanel` and `MediumProgress`; visitor sends none of their progress reads. Retain edition preference, definition, series summary with `language=en`, Work progress and existing releases/realizations/relations. Reading-position reads (`position=mine&limit=20`, opening `position=start&limit=20`) are conditional on parts; without parts production repeats Work progress. Task:G-2325:2 holds the no-new-commit handoff partial/unaccepted; `run-61wdb6` proves only the earlier slice. Preserve three commits/claims and keep exited until G-2392's landing mail and fresh whole record. Then rebase, mount production composition/`WorkFrame` with ratings/follow state and integrate shared edits; preserve scaling/continuation, `1 ½`, As written inapplicability and API-only owner preview. Phone/desktop/full gate required. Later record/resume events are separate. |
| G-2329 | Decisions `565a05d64`/`bf263309b` resolve the visitor ruling and resume attempt 2 after G-2385 merged at `411ae6e732d9`. Visitor sees the signed-out production page, no episode panel/control; unreachable 401/foreign 403 probes remain API-only, and `position=start&limit=1` stays its reached opening read. Replace all identities from the refreshed row, including Classification, anonymous facets, Also enjoyed and work-adoptions reads. Three exact production paths were admitted/reclaimed: `episode-progress.tsx`, `books-edition-page.read.ts`, `read.ts`. G-2328 keeps `episode-api.ts`; use its existing conflict interface without waiting for or editing it. Prove watched/stale recovery through real buttons with recorded null positions, versions, retry keys and two-device grants/Person; no forced version zero or reader-only proof. Preserve production frame and problems; phone/desktop/full gate required. Further partial goes to Program before another resume; no acceptance or landing. |
| G-2325–G-2333 | Nine briefs admitted/queued under mail:2105a9cc with `depends: []` and replay/row-file `needs:`: Recipe read (G-2325/G-2295 record), Anime hub (G-2326/G-2296), relations (G-2327/G-2297), tracking (G-2328/G-2298), two-device (G-2329/G-2299), Manga tracking (G-2330/G-2300), two-device (G-2331/G-2301), Zone publication (G-2332/G-2302), independent Zone (G-2333/G-2303). Six-persona matrices were read before admission. Automatic starts need no later dispatch; G-2333's automatic start is confirmed by mail:916e2a17. Stories consume unchanged production page/frame requests through the shared reader/mapping and typed replay; no substitute reader/frame or unsupported state. Individual handoff decisions above remain authoritative; no new handoff accepted here. |
| G-2334 | Preparation stalled, then Program started attempt 1 at 21:27 UTC; mail:930b08c5 required no restart. The handoff has no commits, seam, stories or tests. Decision `e26b43104` holds it for G-2337's exact six-persona production browse/sort/search/no-match/continuation queries, omitting both `limit` and `type`; signed-in frames also require anonymous Realm/address reads. Exact gaps were sent to Program in mail:274fb291. Fresh identities, complete frames, cached inputs, client split and unchanged cursors are required. Bare relevance without text normalizes to default, not a 400 story. Missing replay input is not a recorded failure. Before one bounded continuation, verify records on main and add/reclaim needed production injection paths; inspect phone/desktop and pass the full gate. If partial again, mail Program before another resume. No landing accepted. |
| G-2340 | Mail:f272e819 removes whole-task ordering behind G-2234/G-2244; the public reader/frame cut started automatically on codex-1 from its rewritten queue brief. `realm/read.ts` is omitted from claims and its narrow presentation/route extraction loan is registered from G-2234. Preserve rules/settings/frame/editor hunks; replace parallel readers with production flow and wire `publishedFrameModel` into the public frame. Retain client split/cache/locale/theme/authority/exact requests/problems/assertions and phone/desktop/full gate. Editor remains G-2244, authoring G-2267; no new row or handoff accepted. |
| G-2338 | Separate Books two-device surface brief committed after G-2215's cut; held outside queue with `needs: []`, `depends: []` until Program mails G-2323 landed. Then check main's six-persona declaration and complete production page/frame records before queueing. Existing files do not prove the pending owner cell. Reuse the production Library seam when present; claims provide ordering without a web task dependency. No worker starts or queue action is authorized by this checkpoint. |
| G-2350 | Shared-header remainder split from G-2225, committed at `77d2849cb` and queued; mail:dcc877d6 added the exact `books-language-recorded-page.ts` seam claim. The ledger now records its automatic start after G-2204 closed and released claims; no dispatch retry. Claim only `read.ts` and the named seam/story/test: delegate `readText` to `booksLanguageReads(await reader()).readText`, share injected `booksEditionReads.readWorkHeader` in production/stories and remove the duplicate header reader. Preserve G-2204 changes, problems, exact requests/answers/persona/language and locale assertions; inspect phone/desktop and pass a complete gate including web types. This split adds no row proof. |
| G-2369 | Task:G-2369:1 decision `3a2d1fe2d` classifies the reader-only cut as implementation and retains all 25 regression/consumer tests. Resumed attempt 2 for standard `task goal -- check`; supplemental passes do not replace it. Delivered `read.ts` extraction stays under its loan; routes/page unchanged, G-2234 hunks preserved. `loadRealmView` resolve/presentation delegation remains page-owner follow-up after G-2232, with continuation/private-resolution record gaps separate. No whole-row/frame proof. The later verified/archive disposition is concurrent measurement, not acceptance or closure by this checkpoint; start no duplicate worker or landing. |
| G-2377 | Mail:916e2a17 supplies the creation half: G-2303 merged/verified at `e9d814f478ad`, 122 samples and six passing proofs. G-2333 already started automatically. API's attachment operator proof is reported at `77b51c549`, but G-2379's complete attachment recording and Program's landing mail are still required. Keep queued with both needs gates; no duplicate start/queue or five-persona substitute. Reuse G-2333 publication and G-2381 routing; own missing creation/transition only, with exact claims. Preserve authority/bodies/keys/receipts/problems/canonical addresses and phone/desktop/full gate. |
| G-2381 | Mail:f272e819 removes whole-task waits; the attached-Realm route/link correction started automatically on codex. Borrowed `realm/read.ts`, `realm/routes.tsx`, `realm/realm-page.tsx` and `zones/site-route.tsx` are omitted from claims and have registered narrow loans from G-2234/G-2232/G-2340. Preserve their rules/settings/management and presentation-reader hunks; reuse the shared reader. Resolve attached Realm from presentation, use fallback only for the missing exact browse mount, and link Browse/Works to the canonical Zone address. Preserve real mounts/standalone/legacy/client split/cache/conditional reads/problems; replay G-2376's whole fresh Manga record/key. No fixture/API/creation redesign or whole-browse acceptance. Exact supporting misses go together to Program; complete affected gate required. |
| G-2236 | Decision `f44a82683` staged G-2314's exchange handoff (`d10db927d9d8`, 161 samples, all six personas passed unchanged, no 500+ answer) and resumed attempt 2. All three input needs are on main. Use the whole current identities and production frame/server-render requests, preserving recorded English/Work UUID/cold registry/empty official Zones and reached authority. Missing signed-in content preferences remain an exact request gap, not an invented frame. A timeout of the unchanged exchange outcome file is Program's: name file/persona/pending request/run directory and rerun once unchanged; a repeat goes to Program with both runs. Surface stories and other gates remain required. |
| G-2390 | Task:G-2390:1 accepted the bounded empty-member follow-up at `56226061e540` on complete `run-PkU3rn`, with story test declared by `573e636e1`. Mail:3b0c4850 reports the stale `tests: []` conflict refusal; its turn mailed Program recovery. Mail:f272e819 reports reclaim/recovery running once; mail:da5abac9 confirms merge at `d9a12a9f10ee` and a 28.5-second stories gate. The deciding turn found nothing left and closed verified at 01:04:58 UTC; brief archived and claims released. Select paperback by format and preserve the production seam/records. No worker or repeat landing; this closes the bounded slice, not an entire additional Books row. |

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

The earlier family, G-2325–G-2334, G-2340, G-2350, G-2377, G-2381 and G-2390 are
admitted; do not dispatch or queue them again. G-2334's empty first handoff is now held for records rather
than automatically restarted. G-2338 remains held for its proof-restoration event.
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
Mail:5fb6ce90 additionally assigns G-2369 the one reader-owned Realm frame
seam for all catalogue surfaces, under the two loans from G-2234. Those
surfaces consume it without editing its reader/routes or making another
frame. G-2232's page claim remains separate. Later verticals wait for and reuse
their Books seam. G-2169's browse seam is
landed; it is not a task dependency. G-2224's corrected row remains
`anime/navigate-a-thousand-episode-inventory-thousand-chapters`.

Shared files are read without claiming them. An OWNER CHANGES repair needs
its exact path committed in the brief, reclaim after any holder exits, and
landing after any holder lands. Never reclaim a running worker or edit a
landing brief. The surface gate includes affected consumer tests (`34d548013`).
Query parameter order is handled by `4085f1b94`; different query values still
require exact authoritative recordings. Keep admitted engines under these
handled decisions; G-2334 is one empty first handoff caused by missing exact
inputs, not authority to redispatch the family. Program cited G-2216's eight
passing stories in 75 minutes as evidence to retain them. No pending story is admitted without
recorded HTTP 202. Preserve all records and visible assertions.

Program's surface tests-step repair reruns timed-out files alone at a longer
limit and reports failures already on main at the gate base without charging
the task. Until it lands, a tests-step failure consisting only of timeouts in
unchanged files calls for another complete gate, not returning the task.
Recorded stories remain final acceptance evidence; this is no story waiver.
Mail:1c3998b9 extends the unchanged rerun rule: a gate failing only in tests
under `tests/qa/unit/` or `scripts/goal/`, with no task-claimed file in the
failing test, gets one unchanged rerun without asking. A second such failure
goes to Program with the run directory. G-2215's authorized rerun consumes
that allowance for its reported failure; harness repairs remain Program's.
Mail:916e2a17 supersedes mail:b3fb42b1's three-passing-main-runs condition
and releases G-2215/G-2232's complete gates with `64dc60068`. Startup parent
and budget failures remain Program's; other failures remain evidence to decide.
Decide the step by the complete gate alone; repair no harness in a surface task.
Landings now run outside their initiating turn and mail the result (`8b24d9212`).
Start each once; the result event closes a fully completed brief or resumes
the remaining work. This checkpoint starts or restarts no landing.
Mail:84b41812 requires the merge-result turn to close the task or state in one
line what remains. G-2204, G-2225 and G-2390 are closed; G-2242 stays open for G-2257's
populated-thread, same-persona empty-entry and private-refusal records after
G-2253, with its installed step claims already released.

Mail:930b08c5 reports six test slots since 21:15 UTC and only three passing
stacks out of 62 during 20:00–21:00 UTC on 2026-10-13. A surface gate stopped
solely on a timeout in that hour gets one unchanged rerun; no such handoff
was decided by that mail. `d22063edd` automatically recovers interrupted
preparation; "is being prepared" for over five minutes is a fault to mail
Program, not permission for duplicate admission.

Mail:2340f762 was answered in one consolidated mail with all six browse rows
across five briefs. Mail:b45114b4 assigns their exact page requests without
`limit` or record-derived language, with six-persona frames through G-2318's
shared helper:

| Surface | Production-record prerequisite |
| --- | --- |
| G-2334 Books browse | G-2337 after G-2318; the later handoff also specifies no `type`, exact sort/search/continuation and anonymous signed-in frame reads |
| G-2226 Games browse | G-2341 after API G-2271 |
| G-2229 Manga browse | G-2342 after G-2318, retaining year value/range/combined reads and G-2319 |
| G-2237 Recipes browse and pagination | G-2343 and G-2344 after API G-2268, whose changes affect counts |
| G-2239 Visual novels browse | G-2293, retaining its complete request graph and G-2294 replay prerequisite |

G-2271 and G-2268 wait behind API G-2220. Assignment and queue notices are not
landed proof; Program's landing commit is the signal to decide the relevant
resume/landing, not a missing-input worker round. Current surface `needs:` paths
stay unchanged. G-2345's two member empty-Work reads remain separate from the
cut G-2204 handoff.

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

## Queue, host and acknowledgements

Mail:20018151 confirms G-2337 carries G-2334's exact request list at
`0ae744b36`: no `limit`, `type`, `actingSubject` or body; default/newest/updated,
matching search with all three sorts, no-match alone/with relevance, unchanged
query on every cursor, no bare relevance, and anonymous Realm/address reads
for signed-in frames. Games G-2341, Manga G-2342 and Recipes G-2343/G-2344
carry the same ruling; report a further vertical-specific shape before its
record task starts. These assignments are not landed records or resume signals.

The six-slot 21:15–21:42 UTC queue stalled through a slot/memory cycle, not a
surface failure; Program restored sixteen slots and made stack starts wait
above host load 64. Mail:50caf5f3 reports G-2320 closed: a memory-refused resume
now waits and starts automatically, so start no duplicate resume. Mail:3e8afb55
reports the worker cap raised to forty at `bff1bc7d4` to clear starved ready
briefs. G-2227, G-2230 and G-2240 started; the ledger also records G-2326's
automatic start after G-2296 merged at 22:04 UTC. Queue progress accepts no
handoff. A ready brief waiting over ten minutes behind the cap is a queue fault
to mail Program, not a reason to wait or dispatch it again.

All nine supplied mail deliveries were already durably acknowledged on
2026-10-14 UTC: 8c681812 at 00:35:21, 0a58c17f at 00:40:39,
3b0c4850 at 00:47:36, 162ce331 at 00:49:15, 916e2a17 at 00:51:10,
f272e819 at 00:58:14, 47004d68 at 01:00:24, 5a6c6a99 at 01:04:50,
and da5abac9 at 01:05:07. No duplicate acknowledgement is needed;
the two task events and this checkpoint supplied no mail delivery.
Earlier acknowledgements remain recorded.

G-2215's unchanged complete gate resumed; G-2232's released gate was not run
in attempt 3, so its handoff stays unaccepted. Report startup parent/budget
failures to Program with exact failures and run directory; spend no surface
attempt repairing the harness. G-2236 has the separate one-rerun allowance for its
unchanged exchange outcome-file timeout. Outcome-test timeout handoffs name
the pending/completed `[persona-request]` lines for Program's ruling.

G-2332's whole-surface hold is superseded by three cuts: management visits
now, public visits after G-2340 only, actions after G-2267. Managers decide
independent cuts themselves; mail Program only for its records, API rulings
or tool faults. G-2377's creation record is on main; the complete attachment
record remains required despite the reported operator proof. G-2229's
canonical-key record is now on main at `e8449c24e69f`, following G-2342's
page reads (`e1a2a57058c1`); use the whole refreshed record, not intermediate
identities. The attached-Zone routing ruling and G-2381/G-2377 ownership stand.

G-2325's progress applicability is resolved; acceptance now requires G-2392's
whole production-path record, including conditional progress reads. Report
further replay misses to Program exactly as persona/method/path/query with the
brief path. G-2382's corrected merge hash is `9b2776c264a6`; G-2232's remaining
supporting-read/transition cut is with Program at its third-attempt cap.
G-2390's stopped missing-test landing recovered through reclaim/merge and
closed verified; G-2234's stopped rebase conflict was mailed to Program without
a retry. No supplied event proves
an entire additional web row. Later committed brief rulings and pending
handoff/landing/mail events remain authoritative under their own turns.
This checkpoint edits no brief, starts no worker or landing, and arms no
watcher.

Mail:f272e819's ready G-2224/G-2243/G-2227/G-2240 continuations actually
started in fresh Grok contexts: `resume --fresh` retains the registered engine,
and their briefs were corrected to record that choice without another restart.
G-2340/G-2381 started automatically from their rewritten queued briefs, then
received every narrow loan, including G-2381's site-route hunks. Their explicit
dispatch calls were not duplicate admissions. G-2242 still waits for G-2257,
G-2233 for platform-access/Zone repair and moderation/appeal records, G-2237
for G-2343/G-2344, and only G-2234's second cut for G-2336; these missing
inputs were mailed together to Program. The concurrent ledger's later
G-2325 resume and G-2234 recovery attempt are measurements, not decisions
on their later events here.
