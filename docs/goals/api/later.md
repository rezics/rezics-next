# Later

Findings no row's persona meets today. One line each; the supermanager promotes
one into scope when a row's stated outcome fails because of it. Detail and file
positions are in the archived end-of-run tables
(`archive/goals:program-2026-10-06/study-2026-10-12/end-of-run/`).

## Security review remainder

- Anonymous requests can grow a counter table without bound.
- A forged token with an unknown key triggers a key exchange.
- An application installation write races a narrowed grant.
- A trusted device is replaced across authenticators without a policy.
- An operator has no second factor.
- A rights assessment can still be submitted after its grant ended.
- An original image has no total-pixel limit.

## Cost

- Every command carries about 24 fixed SQL statements (baseline-member admission and Agent fences).
- 35 readers replay a whole read at their fence and make about twice the reads they need.
- Structure reads fetch page size times tree depth nodes; an order-aligned layout would not.
- Ranked search: the 513-entry Lucene cut precedes the language, author and context filters; ties break only inside it; the hydration budget gates a batch's start only; field discovery scans the live relation.
- Native Lucene ranking with a page and a count.
- A request-scoped memo of immutable Structure objects would save one read.
- The wiki reader counts withheld members toward its inventory budget.

## Recovery and delivery

- G-2175 Anime search availability lead: population-33 `GET /v1/search/catalogue?q=Lanternanime34afb7bcbec648a0bd9faeb84485b0bf&realm=https%3A%2F%2Frezics.com%2Fid%2F01a135d0-cb23-77b6-8e10-99efdab59e5d&limit=5` returned 503 search_index_unavailable in QA 20261013t150959-2296cb; final QA 20261013t152444-5ef4e4 returned all 65 Works. G-2220 classifies whether it shares the Realm browse 503 cause and folds it into that task only if so; otherwise retain this distinct exact-request lead without a separate speculative repair. Program decision mail:28522889-e0fd-4971-8622-81501e9ba367; full answers remain in `.temp/goal-api/G-2175/`.
- Seven findings on restored-backlog delivery: a missing custody object, a weaker completion policy at Zone startup, startup healing clearing a deferral, a cold poll walking acknowledged history, the no-consumer fallback's scope, a missing metric assertion, the startup Fuseki budget.
- The content projection replays for three to four minutes after every restart.
- The rate limiter refuses for some seconds after a restart.
- Model bootstrap does not wait out a Fuseki restart.

## Tests and guards

- Five test files write raw SPARQL; two have no product operation behind their writes.
- The cursor guard has no test that a file-wide exclusion was restored; a hand-written data-flow analyser should become a conservative syntactic rule.
- The seed set lacks axes for unrelated Works and Posts, own mounts and Collection Works; the retained set's compatibility has thirteen open findings.
- The growth check for ranked search consumes declarations it should verify.
- Two findings on the frozen-identity check of legacy disclosure submissions.
- A QA run records a directory when its preparation fails; fixture validation uses the default small corpus; three callers of the dependency analysis are not limited.

## Product

- Merging a Work whose title is under title control is refused; whether it should be is the maintainer's question.
- An owner closing or privatising their own Realm (only platform closure is in scope).
- The Italian Gutenberg recipes record no amounts, because the importer reads only a leading amount.
- Occurrence progress is Account-principal-keyed while library status is Person-keyed; shared-Person progress across different principals is outside the current same-reader two-device outcome.
- Disclosure freshness across stores and after the final fence into streaming/provider delivery remains a named limit; no mechanism for it is in this slice.
- Public-domain Recipe import: new territory or use assessments are outside the accepted reading/publication slice.
- Public-domain Recipe import: portable export provenance sidecars are outside the accepted reading/publication slice.
- Public-domain Recipe import: later corrections and translations with their own source basis and credits are outside this slice.
- Public-domain Recipe import: corpus-wide clearance is not established by pins or tests and is outside this slice.
- Contributions/submissions cannot list one Work without scanning a capped population; no present row requires that discovery path.
- `/v1/me/continue` has six preview candidates without a tail cursor; static inspection identifies complete shelves/follows traversal plus per-Work resume as the candidate full path; public-HTTP qualification is still missing.
- `work-publication-years` lacks Realm/Condition-scoped continuation; static inspection identifies complete Realm browse and direct year filters as the candidate full path; public-HTTP qualification is still missing. Complete year-facet enumeration is outside the present rows.

## Regression of 2026-10-13

### G-2153 qualification — 2026-10-13

Decision `task:G-2153:1`: all twelve remain unconfirmed for promotion. Evidence is under `.temp/goal-api/refs/regression-personas/`; captures served `5af1784d`, not the later runtime. No cell or owner changes. Exact prerequisites and current stable-main requalification are held in G-2153's brief.

- D007 — books/catalogue-browse-and-search-in-its-zone / visitor: unconfirmed; nonempty adoption 200, card truncated, full recapture cancelled; evidence D007.json.
- D018 — books/navigate-a-thousand-chapter-inventory-thousand-chapters and books/continue-progress-across-devices-two-device-progress / owner: prerequisite not reached; thousand chooser 200, grouped second device and consumed graph bound absent, Mine unanswered; evidence D018.json.
- D040 — books/library-import / owner: prerequisite not reached; review 400 missing GET key, catalogue matches/apply/re-import not reached; evidence D040.json; distinct from G-2148.
- D048 — books/collection-tracking-and-progress / owner: unconfirmed; empty Continue and explicit resume 200 lack candidate-source/excluded-Book preparation; seed counter proves no reader failure; evidence D048.json.
- D005 — anime/anime-manga-and-vn-hub-parts-wholes-and-relations / stranger: prerequisite not reached; subject creation 403, granted stranger projection absent; evidence D005.json.
- D028 — anime/catalogue-browse-and-search-in-its-zone and anime/work-hub-and-edition-choice / owner: prerequisite not reached; both property submissions 403, neither catalogue nor edition journey prepared; evidence D028.json.
- D034 — realm/create-a-realm / owner: unconfirmed; founded Realm listed and owner read 200 on earlier runtime; evidence D034.json.
- D049 — realm/threads-and-replies / member: unconfirmed; sibling continuation after unrelated write 200 on earlier runtime; evidence D049.json.
- D052 — zone/attached-realm-discussion / member: prerequisite not reached; about target 422 target_not_bound, canonical closing race absent; evidence D052.json.
- D082 — realm/moderation-and-appeal / moderator: prerequisite not reached; decision 400 key mismatch, accepted moderation decision audit absent; evidence D082.json.
- D102 — recipes/author-a-recipe / owner: prerequisite not reached; two source files imported, supported public withdrawal journey not established; evidence D102.json.
- D112 — realm/roles-and-team / owner: unconfirmed; generation advanced and stale distinct command 409 on earlier runtime; evidence D112.json.

### Deferred causes from the original run

Causes of failing tests in the run on `main` d2a2e3166 that show no persona of a
row a wrong answer, largest first (89 causes, 192 files; added by the program from
its reading of that run). When a row's implementation is briefed, the causes
whose source it changes go into the brief's `refs:`; a line leaves this list with
the change that makes its tests pass or removes them.

- D002, 24 files: Contribution activation is wrapped as reconciling without a readable terminal draft receipt; fixtures and public POST stop at 202 before the intended assertion. Source: `services/main/src/modules/contribution/create-admitted.ts`.
- D003, 19 files: Content relay cannot reach its source cut; terminal publication evidence or eligibility is unavailable and projection/read readiness remains closed. Source: `services/main/src/modules/content-publication/relay.ts`.
- D006, 10 files: Realm thread/community surface hydration exceeds its fixed graph/SQL caps at every follow, history, membership and unrelated-Work scale (30>17 graph; 24>15 graph and 11>6 SQL). Source: `services/main/src/modules/realm-reply/thread-read.ts`.
- D009, 6 files: Owner reconciliation returns 201 held/conflict where the lost-outcome fixture expects a 50x; release qualification stops before subsequent recovery cases. Source: `services/main/src/modules/owner/operations.ts`.
- D010, 6 files: Statement fixture admission is rejected or cancelled before a retained semantic/Context decision can be read. Source: `services/main/src/modules/statement/graph.ts`.
- D011, 5 files: Retained growth corpus compatibility no longer matches current storage/model; restore rejects before measuring the API. Source: `scripts/load/work-profile-corpus.ts`.
- D013, 5 files: Realm fixture grants/management generations no longer admit the requested policy/role action; setup or CAS returns 403/409. Source: `services/main/src/modules/access/realm-management.ts`.
- D014, 5 files: Exact contribution/reply authority denies a reader or retry that the API scenario expects to admit. Source: `services/main/src/modules/realm-reply/store.ts`.
- D015, 4 files: Home/follow/ranked/trending reads exceed their declared fixed graph, SQL or sent-byte budgets. Source: `services/main/src/modules/feed/`.
- D017, 4 files: Exact media/cover delivery repeats owner/disclosure hydration beyond its published graph/SQL/call contract. Source: `services/main/src/modules/media/store.ts`.
- D019, 3 files: Live disclosure batch/heads are incomplete or invalid despite the requested current owner; private name, Studio and Query reads cannot complete. Source: `services/main/src/modules/disclosure/read.ts`.
- D022, 3 files: Restore custody capture cannot read an immutable object, supplemental owner or separate relay handoff; exact source qualification stays closed. Source: `services/main/src/modules/owner/object-coverage.ts`.
- D023, 3 files: Query plans/candidate hydration violate expected indexed joins, examined-row or privacy-position behavior. Source: `services/main/src/modules/query/resources.ts`.
- D024, 3 files: The realm-ranking-commands-v3 retained backup is absent in regression checkouts; three ranking tests never reach their request. Source: `services/main/tests/realm-ranking-corpus.ts`.
- D027, 3 files: Public search/card query cannot establish its current snapshot and returns query_unavailable. Source: `services/main/src/modules/query/resources.ts`.
- D029, 3 files: Long-lived fixture requests reuse an expired Account assertion and receive 401 instead of the intended reader answer. Source: `services/main/src/modules/account/verify-assertion.ts`.
- D031, 2 files: LN/VN catalogue seed command saturates the broker budget and does not retry its Work command. Source: `scripts/dev/seed/ln-vn-zones-step.ts`.
- D032, 2 files: Comment source erasure probes classify a revision as foreign rather than erased; replay cannot prove quote suppression. Source: `services/content/src/core.ts`.
- D035, 2 files: Content eligibility resolves an owner proof that the counterexample expects to remain absent/mismatched, or cannot read its retained owner epoch. Source: `services/main/src/modules/content-publication/eligibility.ts`.
- D036, 2 files: Erasure disposition loses the configured live/WAL physical retention reason and substitutes Copy destruction requires verification. Source: `services/main/src/modules/erasure/journal.ts`.
- D038, 2 files: Statement frame preparation repeats membership scans (two instead of one; sixteen instead of eight). Source: `services/main/src/modules/statement/subject-read.ts`.
- D041, 2 files: Registry has 14 shapes rather than 12 and navigation focus-role text differs; update stale generated-profile shape assertions after authored schema changes. Source: `model/`.
- D042, 2 files: Realm Works/home hydration exceeds the declared graph cap (18>12 and 144>63). Source: `services/main/src/modules/realm-reads/`.
- D044, 2 files: Old projection assertions require deferred where current relay explicitly acknowledges ignored/superseded media or obsolete source events. Source: `services/main/src/modules/content-publication/relay.ts`.
- D045, 2 files: Restored source-credit/field seek index returns HTTP 500 from the template-index command. Source: `infra/jena/command-module/src/main/java/com/rezics/jena/TemplateIndexService.java`.
- D046, 2 files: Fixture sends a Fuseki update to a retired/not-mounted endpoint and receives HTML 404. Source: `services/main/src/infrastructure/fuseki.ts`.
- D047, 2 files: Safety queue/appeal reads execute 18 SQL statements against their shared 15-statement cap. Source: `services/main/src/modules/safety-queue/`.
- D050, 2 files: Verification lineage/invalidation work fails to settle within the declared bounded steps or test preparation deadline. Source: `services/main/src/modules/verification/store.ts`.
- D051, 2 files: Zone mounted-card/route reads repeat their batched membership and disclosure preparation. Source: `services/main/src/modules/zone-modules/`.
- D053, 1 file: Sensitive provider/session endpoint classifies an old session as unauthenticated rather than the asserted step_up_required. Source: `services/account/src/`.
- D054, 1 file: Lookalike/skeleton protection query plan does not use the expected alias registry skeleton index. Source: `services/main/src/modules/address/registry.ts`.
- D055, 1 file: Retained alias migration SQL reads a missing key_digest column. Source: `services/main/migrations/access/`.
- D056, 1 file: Realm disclosure fixture decides an unclaimed governance case and receives claim the case before deciding. Source: `services/main/src/modules/governance/store.ts`.
- D057, 1 file: Catalogue cards add/move chapterCount fields against the name-ranking expected response; reconcile the published card schema and reader. Source: `services/main/src/modules/query/`.
- D058, 1 file: Retained chapter-seek fixture header is absent; population navigation assertions do not start. Source: `scripts/load/`.
- D059, 1 file: Classification page/build work exceeds its graph-call request contract at catalogue scale. Source: `services/main/src/modules/classification/`.
- D061, 1 file: Unrelated Content writer waits behind a transaction until PostgreSQL lock_timeout; preserve independent-target concurrency. Source: `services/content/src/core.ts`.
- D062, 1 file: Context exact read performs three graph queries against the two-query contract. Source: `services/main/src/modules/context/`.
- D063, 1 file: Principal controller inventory query plan does not use its declared representation_active_lookup index. Source: `services/main/src/modules/access/`.
- D064, 1 file: Physical corpus restore omits newly declared population axes (mounted resources, shelf entries, recipe occurrences). Source: `scripts/load/corpus-backup-driver.ts`.
- D065, 1 file: Concurrent credential removals observe one waiter instead of two behind the revoked session; inspect credential transaction scheduling and fence. Source: `services/account/src/`.
- D066, 1 file: Work credits facade returns eleven cards where its retained first page should contain twenty; continuation/refill loses source tuples. Source: `services/main/src/modules/work/author-credit.ts`.
- D067, 1 file: Derived inventory omits the expected retained rated target (null instead of its current value). Source: `services/main/src/modules/projection/`.
- D068, 1 file: Recent-page history plan fails its declared local/indexed seek assertion at 20,000 Works. Source: `services/main/src/modules/discovery/`.
- D069, 1 file: One deleted/ineligible Realm base makes refresh basis-unavailable instead of skipping it beside healthy projections. Source: `services/main/src/modules/discovery/refresh.ts`.
- D070, 1 file: Erasure verifier fixture lacks current fresh evidence-source/absence probes and cannot prove completed Content deletion. Source: `services/main/src/modules/erasure/reconcile.ts`.
- D071, 1 file: Erasure fixture pool lacks connect() now required by the transactional retained relay journal. Source: `services/main/src/modules/erasure/journal.ts`.
- D074, 1 file: A newly credited followed author has no feed item yet the response says caught-up instead of projecting; credited-author invalidation is not reflected. Source: `services/main/src/modules/feed/`.
- D076, 1 file: Rights delivery cannot establish the governance owner after authorization, so the expected hold/delivery proof fails. Source: `services/main/src/modules/governance/store.ts`.
- D077, 1 file: Graph claim expansion performs six graph queries rather than its five-query contract. Source: `services/main/src/modules/graph-query/`.
- D078, 1 file: Guardian-consent withdrawal/deletion does not finish before its test deadline in the quiet-host interval; prior isolated diagnosis also failed. Source: `services/account/src/`.
- D079, 1 file: Hidden and absent Work classifications have unequal observable graph/SQL/byte costs. Source: `services/main/src/modules/work/read-classifications.ts`.
- D081, 1 file: work/history.ts wraps a caught owner error in RevisionReadBudgetExceeded without preserving cause. Source: `services/main/src/modules/work/history.ts`.
- D083, 1 file: Media reader returns a reference descriptor instead of the asserted available Use/byte URL; assess current media contract/authority result. Source: `services/main/src/modules/media/store.ts`.
- D084, 1 file: Private Realm join/count/growth read transaction hits PostgreSQL lock_timeout. Source: `services/main/src/modules/access/realm-management-joining.ts`.
- D085, 1 file: Stored membership normalization accepts the deliberately mutated PartRole instead of refusing the incompatible retained placement. Source: `services/main/src/modules/structure/`.
- D086, 1 file: Horizon lag fixture hardcodes renumbered migration 1332_review_rank_enqueue_time.sql, which is absent. Source: `services/main/migrations/access/`.
- D087, 1 file: Protected mod capture upload/admission times out during quiet-host integration; inspect request transport and capture deadline. Source: `services/main/src/modules/package/`.
- D088, 1 file: Changed model generation refuses the expected bootstrap command before it is sent; inspect model admission ordering. Source: `services/main/src/modules/work/activate.ts`.
- D090, 1 file: Native Person profile erasure never returns within 600 seconds; its 05:47 batch starts after worker load stopped and is not proven run-caused. Source: `services/main/src/modules/access/person-profile-erasure.ts`.
- D091, 1 file: Saved platform administrator grant/controller proof is rejected despite the expected current exact subject binding. Source: `services/main/src/modules/access/platform-administrator.ts`.
- D094, 1 file: Semantic readability still admits a private display name that should remain withheld. Source: `services/main/src/modules/agent/`.
- D095, 1 file: Address availability operation has no declared read class, so the web credentials guard cannot choose its public/requester policy. Source: `services/main/src/routes/addresses.ts`.
- D097, 1 file: Work rating roll-up request cannot complete dependency admission and returns 503. Source: `services/main/src/modules/rating/`.
- D098, 1 file: First-page retry retains the wrong sequence basis instead of reacquiring the current admitted frame. Source: `services/main/src/modules/work/read-session.ts`.
- D100, 1 file: Paged public Content rebuild reports a generation/counter shape inconsistent with expected unitCount=0. Source: `services/main/src/modules/content-publication/rebuild.ts`.
- D101, 1 file: Activated rebuild checkpoint and live Content projection cursor differ, preventing analyzer profile cutover. Source: `services/content/src/projection-cursor.ts`.
- D103, 1 file: Retained launch recipes corpus is absent; source-backed Recipe catalogue tests never start. Source: `scripts/load/launch-corpus.ts`.
- D104, 1 file: Grouped search asserts recovery is held although Access now reports Access is held for recovery; the denial still occurs. Source: `services/main/src/modules/access/admission.ts`.
- D106, 1 file: Work read fixture calls an operation no longer registered and receives 404 No such operation. Source: `services/main/src/routes/work-reads.ts`.
- D107, 1 file: Public case-status reminting remains partial rather than producing a completed recipient-safe access receipt. Source: `services/main/src/modules/public-report/`.
- D110, 1 file: Publishing recovery coverage races a later relay erasure epoch and refuses the captured cut. Source: `services/main/src/modules/outbox/recovery-coverage-head.ts`.
- D111, 1 file: Replayed platform-name repair sees its retained import holder changed and refuses the intent. Source: `services/main/src/modules/catalogue-intake/`.
- D113, 1 file: Cancelled safety-answer history fails to produce the expected indexed/local answer seek plan. Source: `services/main/src/modules/safety-queue/`.
- D114, 1 file: Killed Fuseki retries qualification nine times but retains text-index-uncertain and cannot prove the stored receipt/body against RDF. Source: `infra/jena/command-module/src/main/java/com/rezics/jena/`.
- D115, 1 file: Accepted semantic resource read returns 404 despite the expected current Work disclosure/admission. Source: `services/main/src/modules/semantic/`.
- D116, 1 file: Serial projection finds ambiguous selected Structure publication and cannot rebuild its current facts. Source: `services/main/src/modules/work/serial-projection.ts`.
- D117, 1 file: Slim edition command outcome reads null instead of the admitted works/created receipt. Source: `services/main/src/modules/realization/`.
- D118, 1 file: Source-only Open Library rating import reports incomplete rather than completed. Source: `services/main/src/modules/source/`.
- D119, 1 file: Public source-author title search result omits matchedText Jane Austen. Source: `services/main/src/modules/search/`.
- D120, 1 file: Optional-owner rating projection health performs four graph queries against the three-query contract. Source: `services/main/src/modules/rating/`.
- D121, 1 file: Owner Statement upgrade tries to take an unrelated recovery fence; migrate rejects instead of deferring or proceeding on its own owner. Source: `services/main/src/modules/statement/upgrade.ts`.
- D122, 1 file: Sealing an occurrence stage omits the expected current target check. Source: `services/main/src/modules/structure/stage.ts`.
- D123, 1 file: Typed semantic/facet admission exceeds its test deadline in the quiet-host interval; prior isolated diagnosis also failed. Source: `services/main/src/modules/semantic/change.ts`.
- D124, 1 file: Typeahead prefix walk examines 80 candidates against the 40-candidate native-work bound. Source: `services/main/src/modules/search/`.
- D125, 1 file: Summary pending probe scans 5,634 rows instead of a local one-row dependency seek. Source: `services/main/src/modules/verification/store.ts`.
- D126, 1 file: Wiki candidate matching performs two name-record queries instead of its one-batch contract. Source: `services/main/src/modules/wiki/`.
- D127, 1 file: Work progress summary executes eight statements instead of the six-statement owner budget. Source: `services/main/src/modules/progress-summary/`.
- D128, 1 file: Zone facet reconciliation cannot complete within its preparation page budget. Source: `services/main/src/modules/zone-browse/store.ts`.
