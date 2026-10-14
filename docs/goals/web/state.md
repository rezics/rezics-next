# State

Checkpoint e4472143-74aa-44a4-be04-74e9315983bf consolidates handled events
mail:068df819-546b-4eac-8c13-ee2a9c891fc8, task:G-2369:1,
mail:c8f0578a-edbd-4bfe-a808-1662f9f19acd,
mail:b3fb42b1-8a36-46cd-a1a6-27fe38e0dfcf,
mail:11765aad-e6b6-43c8-8a5b-c4e649501908,
mail:79928e2a-3630-4fb7-b089-dd479c963780,
mail:301a24b2-30ca-4202-a141-bcba3078fdb4,
mail:a4d4d2a3-3183-48f6-96fd-96ee9d08062b,
mail:ae45fb24-bde1-481c-be68-b2165543ce06,
mail:51c4f051-01c0-48a8-9573-dbc3418784b2 and task:G-2390:1.
Carry forward unaffected decisions from checkpoint 1d108917. The attached
Zone fixture stays; G-2381 corrects routing and creation uses an independent
Zone. Program's restart withdrew the earlier wrap-up prohibition. This
checkpoint edits only this file and decides no later event.

## Scope and measures

`task goal -- status` and a read-only ledger snapshot supply the following
measurements. Concurrent dispositions are measurements, not decisions on
later handoffs or landing results.

| Measure | Latest available reading |
| --- | --- |
| Program API scope | 48 of 67 rows proved |
| Persona cells | 309 proved, 93 pending, 0 not applicable, 0 missing |
| Web surfaces | Earlier admitted families retained; G-2390 adds the bounded Books empty-state slice; G-2328/G-2329/G-2236/G-2332/G-2232 resumed; G-2325's resumed second attempt is now exited, with its later event separate; G-2369's later verified closure is measurement only; complete surface-row total unavailable |
| Web tool measures | First-attempt share 82% (today 50%, 2 of 4); 41 first, 20 step, 9 fix; 2 fixes inferred from unavailable handoffs; no capacity, transport or handoff attempts |
| Raw web attempts | 70 across 41 attempted tasks: 41 first and 29 subsequent; queued work excluded; raw first share 59%, distinct from the tool's step-adjusted share |
| Attempts per verified task | Median 1, maximum 5 (G-2219), across 19 verified tasks in the ledger snapshot; later closures are measurement only |
| Web tokens | 675.7M input, 4.8M output; 3 sessions unavailable; tokens per proved row unavailable |
| Web recorded refusals | 0 outcome, 5 gate, 0 failing-test finding, 9 other |
| Program measures | 63% first attempts (today 75%, 6 of 8); attempts per landed task median 1, maximum 9; 1330.8M input, 5.9M output with 70 sessions unavailable; tokens per proved row unavailable |
| Program refusals | 0 outcome, 9 gate, 0 failing-test finding, 4 other |
| Accounts | codex 26%, codex-1 45% of their weekly windows |

API scope rose from 44 to 48; this establishes no additional web surface
proof. The raw first share remains above half, while today's tool share is
exactly half. The median is within two, but G-2219's five raw attempts exceed
the method's three-attempt cap: preserve history and authorize no further
fix round. G-2225's closed step and G-2350 split prohibit a fifth attempt;
G-2204 remains closed without a fourth. Tokens per proved row are unavailable,
so this checkpoint establishes no improvement in token efficiency or new
dispatch authority. Program's measures cover other Goals as well.

G-2215's consumed unchanged-gate allowance and harness failures remain
Program-owned. G-2281 is merged, but the complete-gate release now requires
Program's three consecutive passing main harness runs. G-2232 may correct
its surface on landed records meanwhile; only its final complete gate waits
for that mail. G-2334's missing-input handoff does not establish a family-wide
engine-switch trigger. Later handoffs, closures and landing results retain
separate events.

## Work and next actions

| Task | Decision and next action |
| --- | --- |
| G-2204 | Program's mail:20018151 started the conflict-recovery merge once; mail:dcc877d6 reports it merged at `aed28882c4bf`. Mail:84b41812 found nothing left in its brief, and the deciding turn closed verified at 22:52:51 UTC, releasing its claims. Start no fourth worker attempt or repeat landing. Preserve empty-query equivalence, completed 201/204 handling and exact queries/answers/assertions. Full-page `EmptyInventory` stays cut; G-2345's empty-Work inputs are now on main, and G-2390 owns the separate bounded surface follow-up. This closure adds no empty-Work proof. |
| G-2215 | Task:G-2215:3 remains partial with six Program-owned harness failures; the earlier unchanged-rerun allowance is consumed. G-2281 merged at `13436f6dc80b`, but mail:b3fb42b1 reports main's seven harness files still failed 5/1/2 across three runs. Hold the one unchanged complete gate until Program mails three consecutive passing main runs; no harness repair or charged worker rerun. Name harness-only failures in one line. Keep four rows open and two-device in G-2338, retaining exact collection tracking, ordered work-state IDs, import/export requests, credit/private metadata and continuation assertions. Decide the step by the eventual complete gate alone. |
| G-2216 | Owner list/member empty/loading/expired-return is on main at `cd490077773a`; the bounded lender-create adapter/page step landed at `d510079a1e40`. G-2255's exact `active-loans-refused` with `state=active&limit=20` is now on main: attempt 3 resumed only for that held refusal slice, preserving visitor 401 and the four foreign-person 403 outcomes through the typed client and production reader/mapping. Inspect phone/desktop and pass the complete gate; no dialog interaction or completed-return expansion. The ledger now records this attempt exited; its handoff is a separate event, not accepted here. Keep the task open and both rows incomplete. |
| G-2242 | Shared reader/mapping and recorded entry/loading merged at `1924247eb`; installed claims were released while the task stays open. Populated thread, same-persona empty entry and private refusal await G-2257 after API's G-2253 vote-schema repair. No landing restart or missing-input resume. Before an eventual resume, identify and reclaim exact production seam paths after holders exit. Stories inject the replaying typed client at the production reader boundary; production retains request-cached host access, shared mapping, acting Person, exact requests and problems. No cast, fabricated record or story-owned reader; inspect phone/desktop and pass the complete gate when records arrive. |
| G-2244 | Theme/navigation wiring landed at `e1e7df6ff602`. Mail:1bf33bd5 confirms G-2261's owner editor records at `66e41a4ca`: Zone `limit=50` 200, collection-name 200 and Work 404 because the target is a collection. Attempt 3 resumed only for editor states through client-supplied production adapters/mapping, phone/desktop inspection and the complete gate. G-2267 holds API/components; consume their existing APIs without editing them. G-2234's retained `realm/read.ts` claim prevented the public seam reclaim, so that remainder is committed/queued as G-2340. Missing editor answers go together to Program as one record request, not another hold. Editor handoff remains unaccepted; publication authoring remains G-2267. |
| G-2225 | Program's mail:890e3dfe accepted credits removal and signed-in settings replay as a step, split header integration to G-2350 and prohibited a fifth attempt. The single `land --step` succeeded at `d3598bc1d29b`; mail:4102f0e6's deciding turn found nothing remaining in this brief and closed verified at 22:29:09 UTC. The brief is archived. Start no worker or repeat landing; G-2350 owns the header remainder, so closing this step adds no header-integration proof. |
| G-2267 | Attempt 1 is blocked/unaccepted: publication/review proof does not prove save and exit-save. The owner's `POST /v1/content-drafts` was preparation outside the record. Mail:263c04d8 confirms seed types repaired at `eea281dcb` and assigns G-2346 to record save, saved-draft/head reads missing from `browserZoneAuthoring`, and the chain from configuration's `homeDocument` through saved revision to `publish-site-bundle`. Keep exited until Program mails its landing commit; then resume for save/exit-save replay and the complete gate, preserving exact revisions/digests/epochs, authority, CAS, retry keys, assertions and phone/desktop proof. Do not rewrite the correct existing publication answer. This authoring correction remains separate from G-2244/G-2340. |
| G-2231 | Program recovered the declaration-blocked conflict with `merge`, then reported it landed and closed at `b5976c9fd` in mail:34e08bee. Its brief is archived. Recovery is resolved; start no further worker or landing. |
| G-2243 | The admitted/reclaimed `showcase.ts`, `realm/modules.ts` and `zone-editor/home-content.tsx` remain part of the accepted shared home assembly/rendering step. Mail:094ee3a8 reports `land --step` refused the old conflict state and declaration text; the deciding turn mailed Program recovery and started no retry. Mail:6bb4e19e resolves recovery: Program's `merge G-2243` is running once for exactly that step; `ca1c01bad` already repaired the declaration. Do not restart it; decide its result separately. Keep the production frame correction behind G-2312's six-persona published/empty home records. Then claim/reclaim the actual `SiteHomeRoute`/`loadRealmView` seam and resume once as a cut with fresh identities, exact client split/conditional reads/session header, phone/desktop inspection and full gate. If partial again, mail Program before another resume. |
| G-2234 | Attempt 2 at `624bc1d20` remains partial/unaccepted: twelve mapping units, six stories and types do not replace the complete gate, which did not run. Program's G-2336 supplies six production page-read groups after G-2318's frame helper lands; keep exited until Program reports the record on main. Mail:5fb6ce90 and decision `48c120afa` lend only the frame extraction/necessary route hunks in `realm/read.ts` and `realm/routes.tsx` to G-2369; no landing releases the other claims. Preserve held rules/settings changes, then rebase after the seam lands and reuse it. G-2232 retains `realm-page.tsx`. Use fresh record identities and the row's language; withdraw the extra `zh-Hans` management-header demand unless its proofs read it. Replace supplied `settingsAllowed` with the production management access read; preserve client split, exact queries and problems. `safety-pending.ts` was admitted/reclaimed; `admin-api.ts` stays G-2235's. Records, command integration and full-gate holds remain; no further resume/landing here. |
| G-2237 | First handoff remains partial/unaccepted despite 18 passing stories: record-derived `language=en`/`limit=20`, the owner acting-subject header and story-owned frame do not prove production's own browse graph or the other five frames. Seed types are repaired at `eea281dcb`; that alone does not admit this surface. G-2343 browse/search and G-2344 pagination follow API's G-2268 and supply exact production queries and shared frame reads for six personas. Keep exited until landing mail and fresh records are on main, then add/reclaim exact production seams before one bounded correction. Inject replay through `RealmBrowseRoute` and production readers; remove story-owned/record-derived requests, retain client split, cached inputs, conditional reads, problems/assertions, inspect phone/desktop and pass the full gate. No landing retry. |
| G-2239 | First partial remains unaccepted. `899408225` resolves the request graph: G-2293 owns all eleven production read groups for all six personas, including cached session/language inputs; no numeric allowance remains. G-2272 landed, releasing recording but not supplying these reads. G-2294 owns bare/empty-query replay equivalence in both directions; G-2204 has released its claim. Keep exited until both land, then one bounded correction with exact seam claims/reclaim and injected `RealmBrowseRoute` flow. Preserve anonymous facets/header/resolver, production persona on eligible reads, conditional member-ban, exact queries/headers and fresh record identities; retain problems/assertions, inspect phone/desktop and pass the full gate. Member empty does not prove visitor empty. |
| G-2224 | First partial remains unaccepted. `f7dfe4509` assigns six-persona headers, pre-inventory contents, exact `position=start&language=en&limit=100` pages/continuations and search windows to G-2292. Old `limit=2` is a record gap; unreachable label search is web's gap. G-2204 has released `read.ts`; keep exited until records land, then add/reclaim exact reader/route/contents and Books inventory/test claims and resume once as a cut. Production carries entered `q` through restart/continuation with selected language/page size; injected replay preserves preceding reads and bounded 409 retry. Include held Books empty-page change, retain problems/assertions, inspect phone/desktop and pass full gate. If partial again, mail Program before more work. |
| G-2233 | First partial held at `9dcd81e3e`: gate and 24 stories do not prove production queue/receipt/refusal/loading. Moderation is `/manage/r/[realm]`; `/requests` is separate. `af174991d` keeps the correct appeal gate: API must report deployment-open platform groups, then Program briefs one record correction with language-qualified headers, out-of-Realm moderator refusal, moderation context and owner's decided case/supporting reads. Owner Zone 503 is also an API fault; no pending/join-request proof is required. Keep exited until fix and records land. Claim/reclaim exact queue/frame/Realm-home/appeal seams before the bounded correction; remove record-driven readers, preserve access, actual Zone requests, problems, command keys and subsequent receipt flow, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2235 | First partial held at `9c3bfa53e`: sample-driven `loadRealmTeamRecorded` does not prove production frame or Save preview. G-2309 supplies anonymous owner profile, five other personas' `language=en` headers, owner role-impact preview and parallel invitations reads. `d0490698e` requires identities/command values from its whole fresh record. Roles/members route claims committed and reclaimed; claim/reclaim any further exact seams before bounded correction. Keep exited until records land, then inject production readers/commands, remove substitute loader/unsupported states, preserve persona, revision/digest, keys, problems and assertions, inspect phone/desktop and pass full gate. No landing accepted. |
| G-2232 | Decision `ccde49eed` resumed attempt 3 on G-2382's landed whole-row records, superseding the earlier worker hold; final complete gate alone awaits Program's three passing main runs and repair commits. Use the eighteen added samples and exact identities/requests in the staged accounting. Invitation is HTTP 200 with `invitation.state: pending`, never 202; preserve withdrawal/decision confirm bodies and generations/reasons, four refused-frame `language=en` Realm reads, CAS, keys, client/persona split and full problems. Report missing supporting requests together; inspect phone/desktop and return with the gate explicitly pending if its release mail has not arrived. No acceptance, landing restart or close. |
| G-2229 | Task:G-2229:2 remains partial/unaccepted. Mail:17fa0946 and `4039189a8` supersede mail:0c47c098's route-preservation/new-fixture decision: the Zone-only address with presentation naming its attached Realm and missing `browse` mount is correct across Spaces. G-2381 corrects production route selection and canonical Browse/Works links; G-2376, after G-2342, re-records only the address request's canonical key, preserving the fixture. Keep exited until those corrections, G-2369's shared seam/page wiring, G-2342 page reads and G-2319 year Conditions land. Verify whole-record fresh identities/exact production requests on main before one bounded continuation. Consume the shared correction without editing its files; admit exact remaining wiring claims first. Preserve client split, conditional reads, problems/assertions and phone/desktop/full gate. No landing or immediate resume; G-2377's separate creation flow is no prerequisite. |
| G-2240 | Task:G-2240:1 accepted only the proved member hub slice at `8fab8e6d9`, with complete `run-SYlS40` (24 units, ten stories, phone/desktop inspection); decision `24fd19c14` started one `land --step`. Mail:33ca2180 reports success at `76358916cd39`; its deciding turn retained the open brief because production reads remain, with no close, resume or repeat landing. Work/both releases/empty preference/options/stale refusal are proved through the Books seam; visitor complete hub, successful-save pages, agent name and rights basis are not. Mail:457bb231 assigns G-2359 the other five personas' releases/realizations with `limit=20`, saved-choice release/realization detail reads for four choosers, and member empty-state progress in `zh-Hans` plus `en`; those locales were mailed to Program while the landing brief stayed untouched. Hold until Program's landing commit and fresh identities, then admit required exact seam claims before continuation, preserve requests/problems/revisions/assertions and pass phone/desktop/full-gate proof. Row stays incomplete. |
| G-2319 | Brief committed at `9ec3b4749`; the queue-refusal event records concurrency 34/34 and a ledger lock. Its deciding turn initiated one durable queue retry, which reported the lock; no brief change or worker registration was established. Retain the intended queued work and decide later queue events separately; do not dispatch or retry here. Shared `BrowseState`, API query, links/continuations/search retain `publicationYear` value/range as a removable Condition; clear-all removes it. `official: null` declares no year control while honoring the address. Production-model units only; required on main for G-2229's full row; mail:e5789d7d separately authorized its bounded frame resume. |
| G-2227 | Task:G-2227:1 holds the first partial unaccepted despite its passing gate: release list/chooser are missing and book-only Status is unreachable on Games. Mail:7ad5edce resolves the conditional progress question: `PrimaryAction` does read progress for every signed-in person. Program's G-2357 records the whole production graph: six-persona `limit=20` release list, chooser realizations, progress, `readStart`, preference and `limit=1` parts where reached. Hold until its landing mail, then one bounded continuation with all fresh identities and exact production injection claims admitted/reclaimed first. Render non-book Availability and reachable primary action through the shared seam; retain foreign-refusal mapping proof without fabricating a mixed-persona frame. No unsupported 202/409, second reader or story-owned frame; preserve problems/assertions, inspect phone/desktop and pass full gate. |
| G-2230 | Task:G-2230:1 holds the first partial unaccepted: the passing gate at `236e1d741` and preference mapping do not prove the omitted visitor release comparison or signed-in chooser. Mail:116f02bd assigns running G-2358 the whole production rerecording: six-persona `limit=20` releases, missing chooser realizations and empty-state progress, plus exact preference writes previously outside the recorder (concurrent CAS saves/409, winner replay, 400 language, 404 Work, foreign 403 and visitor 401, bodies and stable keys). Hold until Program's landing mail, then resume once with fresh Works/releases/Persons through existing `books-edition-page` and its production readers; no second seam. Admit exact shared OWNER CHANGES before edits, retain refusal unit proof/persona/CAS/keys, inspect phone/desktop and pass full gate. |
| G-2328 | G-2363 merged at `2527791a0081`; decision `c3d3f6be0` staged its 76 added samples, admitted/reclaimed `tracking/episode-api.ts` and `catalogue/reader-store.ts`, and resumed attempt 2 fresh. Replace every identity together from the whole current record. Reuse actual frame, controls, `writeStatus` and preceding reader-state GET; no facts-frame substitute or direct PUT bypass. Visitor/foreign refusals unreachable in production remain API-only. `library/read.ts` and `work-page/read.ts` remain read-only under other holders. Preserve requests/bodies/versions/keys/problems/assertions; phone/desktop and complete gate required. No handoff accepted. |
| G-2332 | G-2362 merged at `8e8de9892e4b`; staged its 27 added production reads and fresh identities. Decision `0fdb3c939` resumed attempt 2 for management read-only stories now, extracting supplied-client `authoring-reads.ts` with cached `zone-editor/read.ts` wrappers and a narrow `realm/read.ts` site-resolution loan outside paths. Preserve G-2234/G-2369 hunks, production route/frame, anonymous/persona split, conditional reads and problems. Public read-only visits depend only on G-2340's absent presentation/route injection; authoring actions are the later cut after G-2267. Deliver management alone if necessary, keeping task/row open. No save/publication/receipt interaction in this step; retain exact receipts, authority, credit, CAS/retry/refusal assertions for the action cut. Phone/desktop and complete affected gate required; harness-only failures remain Program-owned. No existing handoff accepted. |
| G-2325 | Decision `c6c4fed59` resumed attempt 2 after G-2383 merged at `a4f94572da1e`; follow-state target is the Recipe Work IRI with acting Person, no body/kind, and visitor sends none. Use the whole fresh record and identity map. Admitted/reclaimed `types/recipe.tsx` and `work-views.tsx`; `work-page/read.ts` remains with G-2329. Replace substitute composition with production page/frame including ratings and follow state. Owner preview stays API-only without an entry/story/remainder; preserve scaling/continuation, `1 ½` and As written inapplicability. Program received the progress-read applicability question; no missing answers or permission to hide reached controls. Phone/desktop/full gate required; a further partial goes to Program before another resume. The ledger's later exited disposition is measurement only, with its decision event separate. |
| G-2329 | Decisions `565a05d64`/`bf263309b` resolve the visitor ruling and resume attempt 2 after G-2385 merged at `411ae6e732d9`. Visitor sees the signed-out production page, no episode panel/control; unreachable 401/foreign 403 probes remain API-only, and `position=start&limit=1` stays its reached opening read. Replace all identities from the refreshed row, including Classification, anonymous facets, Also enjoyed and work-adoptions reads. Three exact production paths were admitted/reclaimed: `episode-progress.tsx`, `books-edition-page.read.ts`, `read.ts`. G-2328 keeps `episode-api.ts`; use its existing conflict interface without waiting for or editing it. Prove watched/stale recovery through real buttons with recorded null positions, versions, retry keys and two-device grants/Person; no forced version zero or reader-only proof. Preserve production frame and problems; phone/desktop/full gate required. Further partial goes to Program before another resume; no acceptance or landing. |
| G-2325–G-2333 | Nine briefs admitted/queued under mail:2105a9cc with `depends: []` and replay/row-file `needs:`: Recipe read (G-2325/G-2295 record), Anime hub (G-2326/G-2296), relations (G-2327/G-2297), tracking (G-2328/G-2298), two-device (G-2329/G-2299), Manga tracking (G-2330/G-2300), two-device (G-2331/G-2301), Zone publication (G-2332/G-2302), independent Zone (G-2333/G-2303). Six-persona matrices were read before admission. Automatic starts need no later dispatch. Stories consume unchanged production page/frame requests through the shared reader/mapping and typed replay; no substitute reader/frame or unsupported state. G-2325/G-2329 now have held first-handoff decisions above; no handoff accepted here. |
| G-2334 | Preparation stalled, then Program started attempt 1 at 21:27 UTC; mail:930b08c5 required no restart. The handoff has no commits, seam, stories or tests. Decision `e26b43104` holds it for G-2337's exact six-persona production browse/sort/search/no-match/continuation queries, omitting both `limit` and `type`; signed-in frames also require anonymous Realm/address reads. Exact gaps were sent to Program in mail:274fb291. Fresh identities, complete frames, cached inputs, client split and unchanged cursors are required. Bare relevance without text normalizes to default, not a 400 story. Missing replay input is not a recorded failure. Before one bounded continuation, verify records on main and add/reclaim needed production injection paths; inspect phone/desktop and pass the full gate. If partial again, mail Program before another resume. No landing accepted. |
| G-2340 | G-2244's public reader/frame remainder is separately committed and queued after G-2234/G-2244. Own the exact presentation-reader/public-route seams, replace parallel story readers with the production flow and wire `publishedFrameModel` into the existing public frame. Preserve client split, cache, locale, theme, authority, exact requests/problems/assertions and phone/desktop/full-gate evidence. Editor states remain G-2244 and authoring remains G-2267. This transfers a remainder, not a new row or accepted handoff. |
| G-2338 | Separate Books two-device surface brief committed after G-2215's cut; held outside queue with `needs: []`, `depends: []` until Program mails G-2323 landed. Then check main's six-persona declaration and complete production page/frame records before queueing. Existing files do not prove the pending owner cell. Reuse the production Library seam when present; claims provide ordering without a web task dependency. No worker starts or queue action is authorized by this checkpoint. |
| G-2350 | Shared-header remainder split from G-2225, committed at `77d2849cb` and queued; mail:dcc877d6 added the exact `books-language-recorded-page.ts` seam claim. The ledger now records its automatic start after G-2204 closed and released claims; no dispatch retry. Claim only `read.ts` and the named seam/story/test: delegate `readText` to `booksLanguageReads(await reader()).readText`, share injected `booksEditionReads.readWorkHeader` in production/stories and remove the duplicate header reader. Preserve G-2204 changes, problems, exact requests/answers/persona/language and locale assertions; inspect phone/desktop and pass a complete gate including web types. This split adds no row proof. |
| G-2369 | Task:G-2369:1 decision `3a2d1fe2d` classifies the reader-only cut as implementation and retains all 25 regression/consumer tests. Resumed attempt 2 for standard `task goal -- check`; supplemental passes do not replace it. Delivered `read.ts` extraction stays under its loan; routes/page unchanged, G-2234 hunks preserved. `loadRealmView` resolve/presentation delegation remains page-owner follow-up after G-2232, with continuation/private-resolution record gaps separate. No whole-row/frame proof. The later verified/archive disposition is concurrent measurement, not acceptance or closure by this checkpoint; start no duplicate worker or landing. |
| G-2377 | Remains queued under `754e7ee82`: independent Zone creation waits for G-2303 after API's G-2339; attachment waits for API's G-2166 operator proof, then one complete six-persona G-2379 recording and Program's landing mail. Five proved personas cannot substitute for the pending operator. Keep both needs gates; do not start or queue again. Reuse G-2333 publication and G-2381 routing; own only missing creation/transition, with exact claims before edits. Preserve authority, bodies, keys, receipts, problems, canonical addresses and phone/desktop/full gate. |
| G-2381 | Committed at `9672b4534` and queued once. Shared correction under six browse rows: resolve the Realm from Zone presentation, let only missing exact `browse` mount reach its Realm browse/frame, and make Browse/Works links use attached Zone's canonical address. Preserve real mounts, standalone and legacy shapes, client split/cache/conditional reads/problems. Depends on G-2369/G-2232 and exact claims held behind G-2234/intervening holders; no implicit loan or reclaim. Replay current unchanged Manga six-persona answers through the production chain; if G-2376 landed, use its whole fresh record/key. No fixture/API/creation redesign or whole-browse acceptance. G-2229 consumes the correction; supporting missing reads go together to Program. Complete affected gate required; no queue retry. |
| G-2236 | Decision `f44a82683` staged G-2314's exchange handoff (`d10db927d9d8`, 161 samples, all six personas passed unchanged, no 500+ answer) and resumed attempt 2. All three input needs are on main. Use the whole current identities and production frame/server-render requests, preserving recorded English/Work UUID/cold registry/empty official Zones and reached authority. Missing signed-in content preferences remain an exact request gap, not an invented frame. A timeout of the unchanged exchange outcome file is Program's: name file/persona/pending request/run directory and rerun once unchanged; a repeat goes to Program with both runs. Surface stories and other gates remain required. |
| G-2390 | G-2345's two empty-member reads merged at `fa67039bf928`; the bounded follow-up was committed/queued and started under G-2204's Books hub row. Select paperback by format, never list index; use fresh identities and existing Books reader/status seam. Task:G-2390:1 decision `573e636e1` declared the omitted story test and accepted `56226061e540` on complete `run-PkU3rn` (all checks, 15 stories, reported phone/desktop inspection). One `land G-2390` invocation was made; its result is a separate mail event. No new worker implementation, repeat landing or close here. |

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
G-2281's merge is now reported; mail:b3fb42b1 supersedes that release
condition with Program's three consecutive passing main harness runs.
Decide the step by the eventual unchanged complete gate alone.
Landings now run outside their initiating turn and mail the result (`8b24d9212`).
Start each once; the result event closes a fully completed brief or resumes
the remaining work. This checkpoint starts or restarts no landing.
Mail:84b41812 requires the merge-result turn to close the task or state in one
line what remains. G-2204 and G-2225 are closed; G-2242 stays open for G-2257's
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
2026-10-14 UTC: 068df819 at 00:08:04, c8f0578a at 00:13:22,
11765aad at 00:17:47, b3fb42b1 at 00:18:00, 79928e2a at 00:18:53,
a4d4d2a3 at 00:24:57, 301a24b2 at 00:25:16, ae45fb24 at 00:30:18,
and 51c4f051 at 00:34:06. No duplicate acknowledgement is needed;
the two task events and this checkpoint supplied no mail delivery.
Earlier acknowledgements remain recorded.

G-2215's unchanged complete gate and G-2232's final complete gate await
Program's three consecutive passing main harness runs. G-2232 works on
landed records meanwhile; G-2281's merge alone releases neither gate.
Harness-only failures belong to Program; name them and spend no worker
attempt repairing them. G-2236 has the separate one-rerun allowance for its
unchanged exchange outcome-file timeout. Outcome-test timeout handoffs name
the pending/completed `[persona-request]` lines for Program's ruling.

G-2332's whole-surface hold is superseded by three cuts: management visits
now, public visits after G-2340 only, actions after G-2267. Managers decide
independent cuts themselves; mail Program only for its records, API rulings
or tool faults. G-2377 stays behind complete creation and attachment records;
the latter's pending operator cell cannot be bypassed. G-2229 still awaits
G-2376's final canonical-key record after G-2342's landed browse-page reads
(`e1a2a57058c1`); do not replay intermediate identities. The attached-Zone
routing ruling and G-2381/G-2377 ownership stand.

G-2325's progress applicability question was sent to Program at once with
its brief. G-2383 follow-state records lift that specific hold; they do not
supply unsampled progress reads. G-2382's input landing lifts G-2232's worker
hold, with pending invitation from HTTP 200 state. The supplied mail left its
merge hash blank; this checkpoint neither invents it nor decides the later
correction mail. G-2390's accepted handoff started one landing invocation;
its result and any tool fault are separate events. No supplied event proves
an entire additional web row. Later committed brief rulings and pending
handoff/landing/mail events remain authoritative under their own turns.
This checkpoint edits no brief, starts no worker or landing, and arms no
watcher.
