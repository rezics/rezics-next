# State

Checkpoint 42f56e4a-ad0f-4644-8875-cd982fa18447 consolidates handled events
mail:25697081-4a36-4954-8a16-bb7483ea0e50,
mail:b7be6c9e-d1e2-40fd-8f15-622c8c42fbd7,
mail:41ba0806-3f69-4e05-938c-19f52878b0bd,
mail:46ede5ce-46b6-42eb-87ca-76aeb623fd17,
mail:70d81852-ead6-4e82-a3a9-1fe29f3a8fbb,
mail:24e191cf-192d-4e1c-9463-5d54404cc1c0, task:G-2232:4,
mail:945b006c-1aa5-49c3-8b19-24f8d478fc85 and
mail:4ee31d64-6dbd-4f21-9bde-023c87740a31.
Carry forward unaffected decisions from checkpoint e94b9672. Program resumed
G-2243/G-2240/G-2329/G-2328/G-2235/G-2267; no duplicate resume ran.
G-2333 awaits G-2422 and G-2227 awaits G-2424. Program resolved G-2215's
memory-admission and G-2234's tool/main refusals without worker attempts and
owns their recovery merges. Task:G-2232:4 started its rebased first-cut
`land --step` once. G-2237's reported landing leaves its production correction
unmet; Program received the bounded-landing question. Running-worker decisions
are judged at handoff; G-2240's third attempt needs no dated decision.
None of these events proves an additional complete web row. Concurrent or later
handoffs, rulings and landing results retain their own event decisions.
This checkpoint edits only this file.

## Scope and measures

`task goal -- status` was read at this checkpoint. Its scope, tool measures,
tokens and allowances below are concurrent snapshots, not acceptance of later
events. The raw web-attempt reading is retained from the preceding checkpoint.

| Measure | Latest available reading |
| --- | --- |
| Program API scope | 50 of 67 rows proved; 319 persona cells proved, 83 pending, 0 not applicable, 0 missing; concurrent ledger reading |
| Web surfaces | Complete surface-row total unavailable; G-2240's landed step and G-2332's accepted management evidence are not whole-row proof; G-2215's landing failed, and G-2381 is a mechanism with no rows |
| Raw web attempts | Retained: 84 across 44 attempted tasks, 44 first and 40 subsequent; queued work excluded; raw first share 52% (previous 54%); not refreshed here |
| Attempts per landed web task | Tool reading: median 1, maximum 5 (G-2219); previous verified-task sample was 21 tasks |
| Web tool measures | 73% first share, today 38% (6 of 16); 45 first, 32 step, 17 fix; 4 fixes inferred from unavailable handoffs; not the raw ledger reading |
| Web tokens | 973.4M input, 6.9M output, 5 unavailable sessions; tokens per proved row unavailable |
| Web recorded refusals | 0 outcome, 8 gate, 0 failing-test finding, 13 other in retained reports; Program owns the classified tool/main/host faults below |
| Program measures | 64% first attempts, today 72% (23 of 32); landed-task median 1, maximum 9 (G-1427); 1412M input, 6.3M output, 70 unavailable sessions; tokens per proved row unavailable |
| Program refusals | 0 outcome, 9 gate, 0 failing-test finding, 4 other in retained reports |
| Accounts | codex 33%, codex-1 58% of weekly windows |
| Audit 5 web interval | 21:50–00:48 UTC: 22 starts for 7 landings (3.14 per landing); 13 of 16 ended handoffs not done, 12 without handoff text; exit-to-command median 56 minutes, maximum over 155, first mention after 3 minutes |

The concurrent API reading is 50 of 67; these handled events establish no new
complete web row. The raw attempts above remain a retained snapshot; current
tool classifications use a different denominator. Audit 5 measures delayed executable disposition;
it does not measure tokens per proved row. Its deciding turn accounted for prior
commands and found all eight queued surfaces missing prerequisites on main.
The retained raw first share is 52%; the current tool's daily share is below
half at 38%, requiring classification of repeated work. Repeated work
comes from incomplete production-path records, omitted layout decisions,
shared routing and test-order or host-pressure gate failures. The recorded
dispositions remove those causes: landed whole-visit inputs admit bounded
corrections, missing inputs stay with Program, and tool/main/host faults consume
no surface attempt. Program owns G-2413 and the Recipe whole-visit records;
G-2399/G-2411/G-2412 have landed.
No worker runs merely to rediscover missing answers. G-2381's shared home/frame
correction and G-2416's module helper are on main. G-2234's fourth attempt
correctly stopped on main's reproduction; no fifth attempt was spent. Program
classified G-2215's run-qcp7XA failures as quiet-host timing assumptions and
repaired them at 0be50c8c4. Later supplied refusals were also Program-owned:
G-2215's memory-admission tests failed under the 02:35–02:55 host stall;
G-2234 hit the qualified-RESULT parser and main's Realm-member tests.
Program repaired the parser at `d081e2dec` and the tests at `3d36fe9e8`
(908 pass, 0 fail in the gate's order), relieved host pressure and restarted
both merges. No worker attempt or duplicate recovery follows here.
The verified-task median remains within two; G-2219's five raw attempts exceed
the method's three-attempt cap and authorize no further fix round. G-2225's
closed step/G-2350 split prohibits a fifth attempt, and G-2204 stays closed
without a fourth. Unavailable tokens per proved row establish no efficiency
improvement. Program's measures cover other Goals as well; concurrent status
and ledger measurements do not decide later handoffs or landing results.

## Work and next actions

| Task | Decision and next action |
| --- | --- |
| G-2204 | Program's mail:20018151 started the conflict-recovery merge once; mail:dcc877d6 reports it merged at `aed28882c4bf`. Mail:84b41812 found nothing left in its brief, and the deciding turn closed verified at 22:52:51 UTC, releasing its claims. Start no fourth worker attempt or repeat landing. Preserve empty-query equivalence, completed 201/204 handling and exact queries/answers/assertions. Full-page `EmptyInventory` stays cut; G-2345's empty-Work inputs are now on main, and G-2390 owns the separate bounded surface follow-up. This closure adds no empty-Work proof. |
| G-2215 | The unchanged four-row cut remains partial under `3b986cd34`/`07de002dd`. Mail:25697081 reports the false `[locale]` claim refusal repaired at `2e7e4b609` and Program's restarted merge. Mail:70d81852's run-K0mVhf refusal was held/referred by decision `547895cef`; claims reclaimed, with no worker/gate/merge restart in that turn. Mail:4ee31d64 disposes of the hold: memory-admission count/timeout/database-lock failures are Program's host-stall faults, consume no attempt, and Program already restarted the merge. If they recur, Program repairs them before another run. Preserve the complete gate, every assertion, three exact owner-record remainders, imported credit/private metadata and export continuation. Keep task/four rows open; two-device remains G-2338 and active-copying budget G-2389. No duplicate recovery or close; the result mail decides what follows. |
| G-2216 | Owner list/member empty/loading/expired-return is on main at `cd490077773a`; the bounded lender-create adapter/page step landed at `d510079a1e40`. G-2255's exact `active-loans-refused` with `state=active&limit=20` is now on main: attempt 3 resumed only for that held refusal slice, preserving visitor 401 and the four foreign-person 403 outcomes through the typed client and production reader/mapping. Inspect phone/desktop and pass the complete gate; no dialog interaction or completed-return expansion. The ledger now records this attempt exited; its handoff is a separate event, not accepted here. Keep the task open and both rows incomplete. |
| G-2242 | Shared reader/mapping and recorded entry/loading merged at `1924247eb`; installed claims were released while the task stays open. Populated thread, same-persona empty entry and private refusal await G-2257 after API's G-2253 vote-schema repair. No landing restart or missing-input resume. Before an eventual resume, identify and reclaim exact production seam paths after holders exit. Stories inject the replaying typed client at the production reader boundary; production retains request-cached host access, shared mapping, acting Person, exact requests and problems. No cast, fabricated record or story-owned reader; inspect phone/desktop and pass the complete gate when records arrive. |
| G-2244 | Theme/navigation wiring landed at `e1e7df6ff602`. Mail:1bf33bd5 confirms G-2261's owner editor records at `66e41a4ca`: Zone `limit=50` 200, collection-name 200 and Work 404 because the target is a collection. Attempt 3 resumed only for editor states through client-supplied production adapters/mapping, phone/desktop inspection and the complete gate. G-2267 holds API/components; consume their existing APIs without editing them. G-2234's retained `realm/read.ts` claim prevented the public seam reclaim, so that remainder is committed/queued as G-2340. Missing editor answers go together to Program as one record request, not another hold. Editor handoff remains unaccepted; publication authoring remains G-2267. |
| G-2225 | Program's mail:890e3dfe accepted credits removal and signed-in settings replay as a step, split header integration to G-2350 and prohibited a fifth attempt. The single `land --step` succeeded at `d3598bc1d29b`; mail:4102f0e6's deciding turn found nothing remaining in this brief and closed verified at 22:29:09 UTC. The brief is archived. Start no worker or repeat landing; G-2350 owns the header remainder, so closing this step adds no header-integration proof. |
| G-2267 | Mail:b7be6c9e confirms owner's `save-home-draft` and `save-home-draft-over-head` at `8556ec02f`, plus the three `PlatformGrantSession.token` type repairs at `0372843fc`. Program already resumed attempt 2 for the owed save/exit-save replay and complete gate; its brief was locked when that mail was decided, so no edit, duplicate resume or landing ran. G-2421's unnecessary record was cancelled by Program. Keep the task open for its own handoff/result event, preserving exact revisions/digests/epochs, authority, CAS, retry keys, assertions and phone/desktop proof. Do not rewrite the correct publication answer. This authoring correction remains separate from G-2244/G-2340. |
| G-2231 | Program recovered the declaration-blocked conflict with `merge`, then reported it landed and closed at `b5976c9fd` in mail:34e08bee. Its brief is archived. Recovery is resolved; start no further worker or landing. |
| G-2243 | Mail:25697081 reports Program already resumed the bounded correction with G-2381's reader at `430f062575`; the old input hold is released, with no duplicate resume. Mail:a6092cc7's branch ruling remains: a Zone-only address is correct; published presentation naming a Realm selects attached-Realm home/header/modules, while null selects standalone home. Consume the corrected production route and whole six-persona record; `attached-realm-site.test.ts` remains a need. Header with no query, facets and browse `limit=1` already have answers. Report further reached unanswered reads once to Program. Preserve shared assembly/loans, client split, assertions, phone/desktop and complete gate; fabricate no address capability/frame or duplicate correction. No new handoff or landing accepted. |
| G-2234 | Decision `1a611e9b0` retains the accepted recorded-answer rules step and all gates/assertions; attempt 4 stopped on main's reproduction, with no fifth attempt. Mail:46ede5ce's ambiguous-RESULT refusal went to Program as mail:11ee8a00. Mail:24e191cf/945b006c/4ee31d64 resolve it: the parser selected attempt 3's qualified done; `d081e2dec` admits that under `--step`, and main's failing Realm-member shape tests were repaired at `3d36fe9e8` (908/0 in gate order). Program already restarted the merge; no worker or duplicate landing. G-2336's full six-persona rules/management/settings-access/identity/frame record is on main at `a5f25c4f7e`. Keep task/row open pending the result and the independently authorized production page/access cut. In that continuation convert `hub-access.test.ts` to G-2416's delegate-table helper, reset cleanup, preserve real exports/assertions and admit/reclaim the guard before removing only its exception. Preserve loans/rules/settings and the shared reader's kept concealed `realm_unavailable` 404; no reader change was selected. |
| G-2237 | Mail:41ba0806 reports Program restarted the merge after `0372843fc` repaired its three type failures. Mail:945b006c reports main at `f1dc985e9d`; its deciding turn found the story-owned frame and record-derived requests still present, so the brief remains open and Program received the brief-path/bounded-landing question. No close or duplicate landing. The production correction remains held for G-2343 browse/search and G-2344 pagination after API G-2268, supplying exact six-persona queries/frame reads. Then add/reclaim exact production seams before one bounded correction through `RealmBrowseRoute`/production readers; remove record-derived `language=en`/`limit=20`, owner acting-subject substitution and the story-owned frame. Preserve client split, cached inputs, conditional reads, problems/assertions, phone/desktop and the full gate. The reported commit alone proves no complete row. |
| G-2239 | First partial remains unaccepted. `899408225` resolves the request graph: G-2293 owns all eleven production read groups for all six personas, including cached session/language inputs; no numeric allowance remains. G-2272 landed, releasing recording but not supplying these reads. G-2294 owns bare/empty-query replay equivalence in both directions; G-2204 has released its claim. Keep exited until both land, then one bounded correction with exact seam claims/reclaim and injected `RealmBrowseRoute` flow. Preserve anonymous facets/header/resolver, production persona on eligible reads, conditional member-ban, exact queries/headers and fresh record identities; retain problems/assertions, inspect phone/desktop and pass the full gate. Member empty does not prove visitor empty. |
| G-2224 | Task:G-2224:2 remains partial/unaccepted despite supplemental passes; the complete gate refused because the thousand-episode row is not proved on main. Mail:bd5211f4 confirms production contents 503 `work_read_unavailable`/`composition_mapping_differs`: API G-2323 lands, then G-2355 repair, then row-cell promotion, then Program G-2413 whole-path recording/landing and labels. Keep exited with no attempt, resume or landing until that Program mail and one dated decision. G-2413 supplies six contents/headers, page-size-100 first/continuation windows, distant search with each persona's own cursor and reached private/cursor refusals, plus other whole-path reads; Program decides unreachable probes API-only. Pending visibility is not 202. Eight exact message paths were checked unclaimed, committed and reclaimed for narrow search copy. Preserve injected production inventory, entered q/language/page size/preceding reads/409 retry/problems/assertions and phone/desktop/full gate. No transplanted cursor, manufactured answer or SEO/Zone follow-up. |
| G-2233 | First partial held at `9dcd81e3e`: gate and 24 stories do not prove production queue/receipt/refusal/loading. Moderation is `/manage/r/[realm]`; `/requests` is separate. `af174991d` keeps the correct appeal gate: API must report deployment-open platform groups, then Program briefs one record correction with language-qualified headers, out-of-Realm moderator refusal, moderation context and owner's decided case/supporting reads. Owner Zone 503 is also an API fault; no pending/join-request proof is required. Keep exited until fix and records land. Claim/reclaim exact queue/frame/Realm-home/appeal seams before the bounded correction; remove record-driven readers, preserve access, actual Zone requests, problems, command keys and subsequent receipt flow, inspect phone/desktop and pass full gate. Mail:31f41691 decision `c04fe59f0` additionally requires `realm-appeal/read.test.ts` to use G-2416's single delegate-table helper inside its next independently authorized continuation, preserving real exports/assertions and removing only its shrinking guard exception after exact admission/reclaim. No resume or landing accepted. |
| G-2235 | Mail:41ba0806 supplies G-2309's whole record at `e29e2e52df`; Program already resumed attempt 2. Decision `8edd6741d` requires its unchanged identities/command values and the recorded Zone 404 branch for all six personas: keep problem information, with no presentation/editor read after it. Actual roles/members readers, parallel invitations, anonymous owner profile, language-qualified headers and owner's Save preview remain required; remove sample-driven `loadRealmTeamRecorded` and unsupported states. Roles/members claims were reclaimed; claim or loan any additional exact seam. Preserve persona, revision/digest, keys, problems/assertions, phone/desktop and the complete gate. No handoff/landing accepted; apply the committed decision at handoff without stopping or resuming the running worker again. |
| G-2232 | Mail:25697081 reports Program repaired the false `[locale]` claim refusal at `2e7e4b609` and restarted the merge. Mail:b7be6c9e confirms the real `realm-page.tsx` conflict received Program's dated rebase-only decision and attempt 4: preserve G-2381's Zone reader plus membership changes, with nothing new. Task:G-2232:4 handed off that rebased first cut done; its deciding turn found no landing and started one `land --step`. No repeat landing or closure; the result is a separate event. The accepted cut remains ten mapping tests/28 stories subject to the complete gate. Keep task/row open for G-2397's production invitation/refused-management and withdrawal/decision refresh reads; G-2352's repair is on main at `a3560dedf1`. That record's landing mail permits the dated second-cut decision. Preserve exact claims, commands, keys, CAS, problems, assertions and client/persona split. |
| G-2229 | Task:G-2229:2 remains partial/unaccepted. Mail:47004d68 supplies G-2376 at `e8449c24e69f`: replace every identity together from the whole refreshed Manga record, with canonical frame key `1Cg1BFuSog8nCaEwJY4TrN`. Visitor `search-newest` now says `current`; show that answer, or use another persona's unchanged stale sample through its complete frame. Preserve labels/counts/statuses/problems and the correct Zone-only address, attached Realm presentation and missing browse mount. This lifts only the canonical-key input hold. Keep exited until G-2381's route/links, shared frame/page wiring, G-2342 reads and G-2319 year Conditions are on main; admit remaining exact wiring claims before one bounded continuation. Consume shared corrections without editing their files; phone/desktop/full gate required. G-2377 creation is no prerequisite. |
| G-2240 | Prior bounded step installed at `1df3192e57ff`: visitor release comparison and signed-in empty chooser, with whole hub/frame remainder open. G-2412 `341058dc6d` supplies 188 whole-visit samples, post-save releases/realizations and empty `zh-Hans` progress. Mail:25697081 confirms Program resumed attempt 3; deciding turns found its landing lock and left the brief untouched. Mail:945b006c answers mail:495718f1: attempt 3 requires no dated decision; Program's resume is recorded, so write nothing during landing. Its result decides any further attempt and then needs a decision. No duplicate resume/landing or new acceptance. Preserve fresh identities together, exact requests/CAS/keys/problems/assertions and phone/desktop/full gate; no second seam or fabricated agent/rights display. |
| G-2319 | Brief committed at `9ec3b4749`; the queue-refusal event records concurrency 34/34 and a ledger lock. Its deciding turn initiated one durable queue retry, which reported the lock; no brief change or worker registration was established. Retain the intended queued work and decide later queue events separately; do not dispatch or retry here. Shared `BrowseState`, API query, links/continuations/search retain `publicationYear` value/range as a removable Condition; clear-all removes it. `official: null` declares no year control while honoring the address. Production-model units only; required on main for G-2229's full row; mail:e5789d7d separately authorized its bounded frame resume. |
| G-2227 | Decision `d349b51ac` keeps the second handoff blocked/unaccepted. Mail:24e191cf assigns G-2424 to the missing visitor/stranger/owner/moderator/operator resource-page projections and all other reached missing reads, with each acting Person and visitor anonymous. Wait for Program's landing-commit mail, then one bounded continuation; ten green stories/reverted guards replace no complete gate. Browser failures `process is not defined`/`node:net.isIP` belong to this surface: the supplied client must import no Node module. Relocation to `games-hub-recorded-page.ts` carries two continuation/two selection findings unchanged. Inventory claims remain G-2215's until landing/release; `read.ts` remains G-2329's narrow loan. Resolve exact hunks by loan/reclaim after inputs arrive. Preserve cached client/language, real personas/conditional reads, whole-record identities/assertions, phone/desktop and full gate. No workaround, exemption, invented refusal, book Status or unsupported 202/409; no resume or landing from the promise alone. |
| G-2230 | Task:G-2230:1 holds the first partial unaccepted: the passing gate at `236e1d741` and preference mapping do not prove the omitted visitor release comparison or signed-in chooser. Mail:116f02bd assigns running G-2358 the whole production rerecording: six-persona `limit=20` releases, missing chooser realizations and empty-state progress, plus exact preference writes previously outside the recorder (concurrent CAS saves/409, winner replay, 400 language, 404 Work, foreign 403 and visitor 401, bodies and stable keys). Hold until Program's landing mail, then resume once with fresh Works/releases/Persons through existing `books-edition-page` and its production readers; no second seam. Admit exact shared OWNER CHANGES before edits, retain refusal unit proof/persona/CAS/keys, inspect phone/desktop and pass full gate. |
| G-2328 | Mail:41ba0806 supplies G-2399's whole six-persona production visit at `0dfd22ef33` (288 new labels); Program already resumed attempt 3. Decision `aadcc9597` requires unchanged fixture identities/labels together, actual Work/frame and Library/session/custom-shelves/watching reads, real status/watched/clear controls with preceding reads and refreshes. Remove parallel sample-driven readers, mount-triggered writes and substituted shelves requests. Keep production `episode:<n>` bodies; lawful null-position samples remain API-only. G-2215 holds the Library reader until successful landing/release; additional edits need exact claims or loans. Preserve applicability, requests/versions/keys/problems/credit/assertions and phone/desktop/full gate. No handoff/landing accepted; another partial at the cap needs cut/split/design. Apply the decision at handoff without another resume or interruption. |
| G-2332 | Task:G-2332:3 accepts only management read-only evidence at `35d0e632f` plus type repair `7b2965f22`; decision committed at `04b379027`. Production layout and recorded page share authoring/lifecycle frame decisions. Units assert one owner configuration read, two exact reads for stranger/member/moderator/operator, lifecycle and draft-provider decisions; complete `run-k5GXBR` passed with fourteen inspected phone/desktop management stories including loading/German. Do not land; preserve all six commits. No Agent-profile or visitor Zone-read proof, and parallel public stories prove no production public visit. Public visits/subsequent mandated-publication presentation remain after G-2340; publication, lost acknowledgement, competition, receipt replay, mandated owner credit and refusal interactions remain after G-2267. Keep task/row open; no further worker attempt or landing authorized until the prerequisite events decide remaining cuts. Preserve cached clients/proxy headers/acting Person, conditional return-address, exact cuts/receipts/authority/credit/CAS/retry/refusal assertions. |
| G-2333 | The partial handoff stays unaccepted under `64b063451` and mail:b7be6c9e decision `b68779ca6`. The existing published-home correction starts no further attempt here; wait for Program's G-2422 landing commit, then resume once from unchanged fixture labels/identities. G-2422 records every signed-in management/saved-preview visit: configuration, Zone with acting Person, owner's subsequent address, complete `loadCompleteZoneNavigation` and composition reads; editor-reaching personas add save/reopen/stale-draft 409/publication. Visitor management redirects before reads, with no invented editor refusal. Share the production supplied-client reader, `mapZoneSiteHome`/`ZoneHomeContent`, frame/authority/body; home sends no `routes?path=/`. Preserve cached/proxy/cookie/theme/nonce inputs, conditional reads, continuation, standalone identity/credit, six personas, phone/desktop/full gate. Even a corrected published-only handoff does not complete the row or permit landing before the record mail. G-2267 owns shared authoring; G-2377 creation/attachment. |
| G-2325 | Mail:3bb8058a supplies G-2392 merged/verified at `a88a2f655c80`: 295 samples, 51 added, unchanged assertions/cells and no 5xx. Decision `03d77b31a` resumed the bounded production-page correction fresh; the initial ledger-lock response was not retried and the subsequent handling confirmed attempt 3 running. Replace all 133 identities together, retaining actual WorkFrame, ratings/follow state and both progress controls. Signed-in edition preference/English summary/progress answer 200; Work progress is read twice, with no parts, reading-position or episode read. Visitor sends none; all six read types. Preserve recorded definition 404 and production's missing-definition behavior; mail:5b1972bf confirms lawful 404 `definition_unavailable` when bootstrap has not installed the definition, and the panel renders without it; no record change or worker hold follows. Retain scaling/continuation, `1 ½`, As written inapplicability, API-only owner preview, exact client split and assertions. Phone/desktop/full gate remain required. Report further misses exactly to Program; no handoff accepted. |
| G-2329 | Mail:7c2d45c2 decision `d856300ae` authorizes one bounded production-control continuation from G-2411 `4cdc53de3f` (175 samples); mail:25697081 confirms Program's already-running attempt 3. Mail:945b006c answers the decision-delivery question: judge the committed brief at handoff, without stopping or resuming this worker again. Derive identities/labels from the whole main fixture; show both reachable mark/clear conflict chains for all five signed-in personas with barrier order, distinct sessions of the same Person, preceding reads, first write, stale real-control click, refusal, recovery and refresh. Visitor gains no panel/requests. Preserve `markPosition`: clear omits position only in the control argument; the adapter retains current position in the recorded body. Original race labels/winners remain API-only. Replay the full Work/frame and exact follow-state query without `kind`; no missing-sample relationship fallback. Drop the unnecessary shared-story hunk, preserving original `episode:41`; retain claims/facets boundary and separate G-2399/G-2328 inputs. Phone/desktop/full gate and every body/version/grant/key/problem/assertion remain required. Another partial needs cut/split/design; no handoff/landing accepted. |
| G-2325–G-2333 | Nine briefs admitted/queued under mail:2105a9cc with `depends: []` and replay/row-file `needs:`: Recipe read (G-2325/G-2295 record), Anime hub (G-2326/G-2296), relations (G-2327/G-2297), tracking (G-2328/G-2298), two-device (G-2329/G-2299), Manga tracking (G-2330/G-2300), two-device (G-2331/G-2301), Zone publication (G-2332/G-2302), independent Zone (G-2333/G-2303). Six-persona matrices were read before admission. Automatic starts need no later dispatch; G-2333's automatic start is confirmed by mail:916e2a17. Stories consume unchanged production page/frame requests through the shared reader/mapping and typed replay; no substitute reader/frame or unsupported state. Individual handoff decisions above remain authoritative; no new handoff accepted here. |
| G-2334 | Preparation stalled, then Program started attempt 1 at 21:27 UTC; mail:930b08c5 required no restart. The handoff has no commits, seam, stories or tests. Decision `e26b43104` holds it for G-2337's exact six-persona production browse/sort/search/no-match/continuation queries, omitting both `limit` and `type`; signed-in frames also require anonymous Realm/address reads. Exact gaps were sent to Program in mail:274fb291. Fresh identities, complete frames, cached inputs, client split and unchanged cursors are required. Bare relevance without text normalizes to default, not a 400 story. Missing replay input is not a recorded failure. Before one bounded continuation, verify records on main and add/reclaim needed production injection paths; inspect phone/desktop and pass the full gate. If partial again, mail Program before another resume. No landing accepted. |
| G-2340 | Mail:f272e819 removes whole-task ordering behind G-2234/G-2244; the public reader/frame cut started automatically on codex-1 from its rewritten queue brief. `realm/read.ts` is omitted from claims and its narrow presentation/route extraction loan is registered from G-2234. Preserve rules/settings/frame/editor hunks; replace parallel readers with production flow and wire `publishedFrameModel` into the public frame. Retain client split/cache/locale/theme/authority/exact requests/problems/assertions and phone/desktop/full gate. Editor remains G-2244, authoring G-2267; no new row or handoff accepted. |
| G-2338 | Separate Books two-device surface brief committed after G-2215's cut; held outside queue with `needs: []`, `depends: []` until Program mails G-2323 landed. Then check main's six-persona declaration and complete production page/frame records before queueing. Existing files do not prove the pending owner cell. Reuse the production Library seam when present; claims provide ordering without a web task dependency. No worker starts or queue action is authorized by this checkpoint. |
| G-2350 | Shared-header remainder split from G-2225, committed at `77d2849cb` and queued; mail:dcc877d6 added the exact `books-language-recorded-page.ts` seam claim. The ledger now records its automatic start after G-2204 closed and released claims; no dispatch retry. Claim only `read.ts` and the named seam/story/test: delegate `readText` to `booksLanguageReads(await reader()).readText`, share injected `booksEditionReads.readWorkHeader` in production/stories and remove the duplicate header reader. Preserve G-2204 changes, problems, exact requests/answers/persona/language and locale assertions; inspect phone/desktop and pass a complete gate including web types. This split adds no row proof. |
| G-2369 | Task:G-2369:1 decision `3a2d1fe2d` classifies the reader-only cut as implementation and retains all 25 regression/consumer tests. Resumed attempt 2 for standard `task goal -- check`; supplemental passes do not replace it. Delivered `read.ts` extraction stays under its loan; routes/page unchanged, G-2234 hunks preserved. `loadRealmView` resolve/presentation delegation remains page-owner follow-up after G-2232, with continuation/private-resolution record gaps separate. No whole-row/frame proof. The later verified/archive disposition is concurrent measurement, not acceptance or closure by this checkpoint; start no duplicate worker or landing. |
| G-2377 | Creation inputs are on main from G-2303 at `e9d814f478ad` (122 samples, six proofs); G-2333 started automatically. Mail:41ba0806 holds G-2379 attachment recording on API's two-Zone/one-Realm 503 defect: Program ruled official Zone, else inventory's first, never 5xx. Keep queued until API repair, the complete recording and Program's landing mail; no duplicate queue/start or five-persona substitute. Reuse G-2333 publication and G-2381 routing; own missing creation/transition only with exact claims. Preserve authority/bodies/keys/receipts/problems/canonical addresses, phone/desktop and full gate. |
| G-2381 | Mail:7c2d45c2 confirms the shared home/frame correction on main at `430f062575`; `frame-reads.test.ts` is green. This replaces the prior unlanded-mechanism status, with no surface-row proof (`rows: []`). Preserve the installed Realm-from-published-presentation resolution, null standalone selection, address capabilities, shared reader/route wiring, current fixture-derived identities and other holders' hunks. Start no duplicate worker or landing. Catalogue/page consumers retain their independently decided production records, claims and continuation prerequisites; G-2410 Manga browse recording started on this correction. |
| G-2236 | Mail:0799ce3b decision `dc90d3541` keeps the partial handoff unaccepted and exited for both whole-production-visit records, now G-2418 authoring/G-2419 exchange. They own each authoring persona's types, owner destination resource-page/Work/resource/metadata with acting Person and every other reached Main request; replace labels/identities together. Account-origin `GET /api/account/content-preferences/viewer` is a shared signed-in frame read, not a Main row-sample prerequisite: use the existing frame seam pending Program's separate Account-contract/frame-record tooling. This supplies no Main read or editor authority. Program rules `file-import-stale` from authoring's handoff; borrowed visitor-frame stale panels remain excluded. Exchange's two retained member/owner timeout runs go to its record task, which quotes slow request-watch requests before recording. No surface rerun, timeout/assertion change, landing or further attempt before both records and the ruling; then decide the bounded full-production continuation with phone/desktop/full gate. Both rows stay open. |
| G-2390 | Task:G-2390:1 accepted the bounded empty-member follow-up at `56226061e540` on complete `run-PkU3rn`, with story test declared by `573e636e1`. Mail:3b0c4850 reports the stale `tests: []` conflict refusal; its turn mailed Program recovery. Mail:f272e819 reports reclaim/recovery running once; mail:da5abac9 confirms merge at `d9a12a9f10ee` and a 28.5-second stories gate. The deciding turn found nothing left and closed verified at 01:04:58 UTC; brief archived and claims released. Select paperback by format and preserve the production seam/records. No worker or repeat landing; this closes the bounded slice, not an entire additional Books row. |
| G-2416 | Program's shared Bun module-cleanup repair is on main at `e7c3d203f`, verified by the mail:31f41691 deciding turn. One helper delegates module replacements to a table reset in cleanup; the guard and fifteen converted files retain assertions. G-2234's Hub and G-2233's appeal tests convert in their next independently authorized continuations and are the shrinking exceptions. This tooling proves no web surface row and starts no worker or landing here. |

## Retained boundaries and prerequisites

Every surface consumes unchanged main outcome records through the typed replay
client supplied at its production reader boundary. Production keeps its
request-cached host client, anonymous/persona split, acting Person, conditional
reads, cached session/language inputs and exact queries/bodies/problems.
Stories own no reader or frame and show only states the production route
reaches. Unreachable API probes retain their proof without surface stories;
pending requires recorded HTTP 202. Whole re-recordings replace identities
together. Never normalize a request to fit a sample or hide a reached control.
Missing reads go once to Program with brief path, row, persona, method and
complete path/query/body. Check each row's frame coverage before admission.

The admitted surface family and G-2340/G-2350/G-2377/G-2381/G-2390 are not
queued or dispatched again. Automatic queue starts require no duplicate
admission. G-2338 stays outside the queue until Program's G-2323 landing and
six-persona/production-path verification. Existing task rows above retain
all their holds. G-2332's independent cuts are management visits now, public
visits after G-2340, and actions after G-2267. G-2332's third handoff accepts
management read-only evidence without landing; its remaining cuts await their
prerequisite events. G-2333's published-home correction admits no missing-input slice.

Mail:f26b8384's audit requires an executable disposition within five minutes of
an exited surface: missing reads go immediately to Program; outside-scope gate
files get `owner` plus reclaim, loan or drop in that turn. Start eligible queued
surfaces within capacity. Its deciding turn accounted for earlier ruling commands
and reported to Program in mail:6183db3f; no command was repeated. At that reading,
G-2226 lacked Games browse, G-2228/G-2238/G-2241 the Books Library unit,
G-2327 Anime relations, G-2330/G-2331 Manga tracking/two-device and G-2377
Zone attachment. Six web workers were live with no global place free. The audit
reported later G-2416 harness prerequisites and running continuations as concurrent
dispositions; their authorizing/result events retain their own decisions.

G-2369 owns the one shared Realm frame reader; G-2381's installed correction
uses the Realm's Zone answer. Catalogues consume these without another
reader/frame. Shared files are read without claims. Exact OWNER
CHANGES paths must be committed/reclaimed when unclaimed; held hunks need
an explicit loan or are dropped. Never take a running worker's claim or edit
a landing brief. G-2232's five admitted paths and G-2329's facets path follow
these ownership readings. G-2381/G-2416 add no row proof. G-2227's inventory
relocation carries existing debt unchanged; its exact G-2215-held hunks must
be resolved only after the projection inputs or ruling arrive.

The affected gate includes consumer tests, web types, named units/stories,
lint and guards; passing supplemental tests or screenshots replace no complete
gate. Parameter order may vary, values may not. Keep every recorded assertion,
rights/credit and the eight locales; inspect surface stories at phone/desktop.
Program's timeout isolation/main-failure classification is no story waiver.
Mail:24e191cf reports main's `qa-runtime-pools.test.ts` repaired at
`1fb0b1b77`; its deciding turn authorized no duplicate retry from that repair.
Outcome-test timeout reports name pending/completed `[persona-request]` lines
and run directory. G-2236's two exchange timeout runs belong to G-2419;
no new surface rerun is authorized. Mail:0799ce3b classifies G-2215's two
core failures as repaired harness faults, not a branch correction. With
G-2381/G-2416 on main, mail:31f41691's deciding turn started one complete
partial landing each for G-2215/G-2234 without another worker or gate waiver.
The helper's two shrinking exceptions convert only in their own tasks'
next authorized continuations, not in a new repair round.
Mail:916e2a17's gate release supersedes the old
three-passing-main-runs hold; startup parent/budget faults remain Program-owned.

Landings run outside the initiating turn and mail their results. Start once;
the result turn closes a fully completed brief or resumes its remainder.
G-2204/G-2225/G-2390 are closed verified; do not restart them. G-2242's installed
step stays open for G-2257, after API G-2253, with its step claims released.
G-2240's installed step and later locked landing, Program's G-2215/G-2234
recovery merges and the single G-2232 rebased-step landing are decided above.
Their result mails and remainders are not closed here. Mail:945b006c resolves
the G-2240/G-2329/G-2328/G-2235 questions: third attempts need no tool-required
dated decision, and decisions committed after a resume are applied at handoff.
Do not interrupt a running worker to deliver them; judge the brief, land a
bounded accepted step where justified and decide any owed continuation there.
No unanswered question authorizes a duplicate resume or locked-brief edit.
G-2237's reported landing remains open for Program's bounded-landing answer.
Current ledger measurements may already show a later landing
or refusal and do not decide its result mail.

Program's exact browse records remain prerequisites: G-2334 needs G-2337,
G-2226 G-2341 after API G-2271, G-2229 G-2342/canonical-key refresh plus
G-2319 (G-2381 is installed), G-2224 G-2413 after API G-2323/G-2355 and row promotion,
G-2236 G-2418/G-2419 and Program reachability ruling, G-2237 G-2343/G-2344
after API G-2268, G-2239 G-2293/G-2294. G-2411/G-2412 are landed inputs
for the separately decided G-2329/G-2240 continuations. G-2399 and G-2309 are
landed inputs for the already-resumed G-2328/G-2235 corrections; G-2336 is
landed input for G-2234's independent second cut after its step result.
G-2227 instead awaits G-2424's landing mail; G-2333 awaits G-2422's.
Account viewer
preferences use the existing signed-in frame seam pending shared tooling;
they are not a Main row-record hold for G-2236.
Queries have no added `limit` or `type`, retain search/sort/query on every
cursor and anonymous Realm/address reads in signed-in frames; bare relevance
without text normalizes to default. G-2341–G-2344 assignments are not landed
inputs. G-2318 supplies the shared recording helper. Owner Zone read/API
faults and platform-access/moderation/appeal gaps remain with api/Program;
no frontend workaround, invented pending/join-request proof or record patch.

The host's timing/load failures and queue memory/cap waits establish no
surface fault. Memory-refused resumes wait/start automatically; start no
duplicate. Preparation stalled over five minutes or a ready brief behind
worker capacity over ten minutes is a tool fault to mail Program. Existing
worker engines and registered fresh contexts remain as individually decided,
without a family-wide switch.

Retain canonical-href, continuation, identity and filter guards from
G-2094/G-2090/G-2092/G-2093; G-2201's eight-locale D080 copy and G-2200's mounted
shelf test are installed. Twelve continuation remainders, 18 identity debts
and 81 filter expressions need bounded independent evidence. Debt is not a
product fault or scope: unproved findings stay in `later.md`, API gaps with
api, and guards retain benign passing/class-violation failing fixtures.
Recipe's As written/fraction behavior stays under its row proof. Zone
publication's `configuration.homeDocument` identity is web authoring in
G-2267; keep the owner's correct record unchanged.

## Acknowledgements

All eight supplied mail deliveries were durably acknowledged on 2026-10-14
UTC: 25697081 at 03:02:31, b7be6c9e at 03:07:39, 41ba0806 at 03:08:38,
46ede5ce at 03:14:09, 70d81852 at 03:14:58, 24e191cf at 03:19:38,
945b006c at 03:25:22 and 4ee31d64 at 03:32:41. Task:G-2232:4 started
its authorized step landing once; its supplied stop mail was already acknowledged.
There are eight mail deliveries and one task event in this checkpoint.
Earlier acknowledgements remain durable in mail history. This checkpoint
supplies no new mail delivery and needs no duplicate acknowledgement.
It edits no brief, starts no worker or landing, waits for no result and
arms no watcher.
