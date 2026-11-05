# Search API and disclosure proof audit

Evidence snapshot: 2026-10-28, 12:09 UTC. This is an evidence report, not a product decision or a claim of completion.
The public Search contract is **incomplete**: Search is absent from main; dev still exposes readable cursor positions,
uses stale facet contributions and lacks the required real default-worker proof. Committed fixes on stopped worker
branches are identified separately below. No product gate, test suite, service, build, installation or external
research was run; local audit validation is limited to report existence, formatting and whitespace.

## Authorities and revision boundaries

All source references are pinned. `S` means `services/kernel/src/search`, `T` means `services/kernel/test/search`,
and `K` means `services/kernel`. A path and line number following a revision label refer to that revision's file.

| Label | Revision / primary source                                                                                                                                | Meaning                                                                                                                                                                                                                                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M     | [main, `90ffc5216ae62d52d4534696b3e6957b9ffbe8f8`](https://github.com/rezics/rezics-next/tree/90ffc5216ae62d52d4534696b3e6957b9ffbe8f8)                  | Actual main-checkout HEAD. Its tree has no `S/`, `T/`, or `specs/search-outcomes.test.ts`; its server does not compose Search.                                                                                                                                                                                                                      |
| B     | [audit base, `34dbc5607bf58f36722fb7e252df58fc1120d541`](https://github.com/rezics/rezics-next/tree/34dbc5607bf58f36722fb7e252df58fc1120d541)            | This worktree's unchanged implementation snapshot.                                                                                                                                                                                                                                                                                                  |
| D     | [dev, `3f587a8b5494992a46d976df56d9752453a29ed4`](https://github.com/rezics/rezics-next/tree/3f587a8b5494992a46d976df56d9752453a29ed4)                   | Rechecked after dev advanced during reading. The API, cursor, query, Semantic source and production composition files discussed below are identical to B.                                                                                                                                                                                           |
| C     | [`6801ff700d0262bbbb3b02fc6702dae70042ea4e`](https://github.com/rezics/rezics-next/tree/6801ff700d0262bbbb3b02fc6702dae70042ea4e)                        | Clean, stopped count worker. Its implementation commit is `367a621dadc97b63cd565c88c576db3044caa0ff`; the last commit changes only overflow test expectations. Neither commit is in M or D.                                                                                                                                                         |
| Q     | [`58ff7a1149f219f34503603891ccba8d96e1fe99`](https://github.com/rezics/rezics-next/tree/58ff7a1149f219f34503603891ccba8d96e1fe99)                        | Clean, stopped completion-admission worker, including the final shard-counter correction. Not in M or D.                                                                                                                                                                                                                                            |
| E     | [`db7cee84736de18473dab16369ff6f7528d3584e`](https://github.com/rezics/rezics-next/tree/db7cee84736de18473dab16369ff6f7528d3584e)                        | Clean, stopped Semantic source worker. Adds native relation ports and supplies production route keys; not in M or D. Only its API boundary was inspected here.                                                                                                                                                                                      |
| A     | [discussion, `7ff5c2aa6034f8fbd9951cf477c040804b125f65`](https://github.com/rezics/rezics-next-discussion/tree/7ff5c2aa6034f8fbd9951cf477c040804b125f65) | Original [ADR-0032](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0032-opensearch-index-tier.md), lines 28–43, and [ADR-0034](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0034-partition-row-tokens-cursors.md), lines 31–40. |

Repository sources are covered by its root `LICENSE` (GNU AGPL version 3). No root licence file was found in the
discussion checkout; its documents are cited as authority, not proposed for copying. Ignored local briefs and recorded
outputs have no separate licence declaration observed. No external implementation or long passage is reproduced.

The full main-checkout `.temp/goal/managers/search.md` was read, including original done-on-main/root-gate obligations,
anonymous floor, strict JSON bodies and default worker rules. Current owning documents inspected include `AGENTS.md`,
`docs/deletion.md`, the Search/rating parts of `docs/scope.md`, `S/README.md`, `T/README.md`, and
`K/src/semantic/relation-facets-design.md`. Producer/replay/reconciliation mechanics are outside this audit; only
their generation/readiness and source-disclosure interfaces are assessed.
Scope/Zone scaffolds and composition pages have separate contracts; they neither supply public Search proof nor
add implementation obligations to this API audit.

Ignored briefs are not Git-pinned, so these SHA-256 snapshots identify the authority actually read. Paths are relative
to the read-only main checkout, not this worktree:

| Authority path                                              | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `.temp/goal/managers/search.md`                             | `e5f17936d686a5a3758c4d1d92b1c8bb83222f0da8a466053fb8faf822a0b2fa` |
| `.temp/goal/search/d4-count-service-wiring.md`              | `1fe1515254b4986e565e0d3e1e156f9a5b3a9c5ed3dda1ce5d6f2c2a97a779ac` |
| `.temp/goal/search/c5-search-encrypted-cursor-migration.md` | `4340f8486f791490a2e5a595975e9b6f4cd82c6821e8a8f8cc4312181435c2e1` |
| `.temp/goal/search/d5-native-deletion-count-proof.md`       | `82df16a3ba2aaf5f0df783d20b295aa9f231706187d8325ed256bf81cc3359ed` |
| `.temp/goal/search/rt17-native-rating-outcomes-spec.md`     | `8992d43f6ebe43e4117f9338ff41b4203696e0542921020f2dd0d85e1a72b3b6` |
| `.temp/goal/search/bounded-name-sort-decision.md`           | `826fd79cab8ce80d5f89e825f78c967611180be344189000237726d5a43bb0ad` |
| `.temp/goal/search/c11-bounded-generation-readiness.md`     | `3aad479e265f2d189d3c57088899c6ffc2531774b943b7c5ddc135e639964637` |
| `.temp/goal/search/qv4-query-completeness-wiring.md`        | `3cdbb5de2b62043a09e710bc0a1b01fa2150edcbadab7bbab1019d15646b38d7` |
| `.temp/goal/search/qg2-physical-query-generation.md`        | `67685c80af282b078ebd0af446b01dba5bdabb3ce77f52885246ba2f0e9ae74d` |
| `.temp/goal/semantic/rs3-relation-facet-source.md`          | `a49a53dac20e69767eb694085f198a301130de684c093e255add570b77a0513e` |

Interpretation decisions: the FINAL count brief supersedes ADR-0032's engine-exact-below-cap rule, older deletion
count wording and old ordinary exact-count assertions. **Every ordinary total**, restricted and zero included,
needs full-predicate completeness across every matchable home before and after the read to be exact. Without it,
the adopted response is the actual indexed observation with `indexed_estimate`, including cap 10,000. A pre-read
caught-up watermark or returned-home checks cannot supply that proof. Current facet contributions and the separately
owned genuine rating unique-disclosed `lower_bound` remain distinct. Existing owner work is pending implementation
or proof, not a proposal to redesign these contracts. Format acceptance establishes authored specifications only.

## Requirement and evidence matrix

“Proven” below is confined to the stated layer. “Indirect” means a fixture/helper cannot establish the production
claim. “Contradicted” identifies a source counterexample or recorded failure; it does not mean this audit ran it.
All public runtime rows remain missing on M.

| Scoped requirement / invariant                                                                                                        | Inspected evidence                                                                                                                                                              | Classification at D; later committed evidence                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FilterDocument admission, immutable versioned templates, no client engine DSL                                                         | `S/service.ts:232–253,280–300`; `S/query.ts:10–35,103–156`; `T/filter.test.ts`, `text.test.ts`, `query.test.ts`; frozen text/filter scenarios below                             | **Proven at compiler/query layer**, **incomplete native API proof**. Named clauses and `toJson` serialization exist; stored IDs are versioned.                                                                                                                                                                                                                                                             |
| Closed text grammar and budgets, typed 422 with pointers; positive roots                                                              | `S/service.ts:101–149,232–253`; `S/text.ts`; frozen scenarios at `specs/search-outcomes.test.ts:433,457`                                                                        | **Indirect/incomplete** through real API; parser/unit cases cannot replace original outcomes.                                                                                                                                                                                                                                                                                                              |
| Strict JSON without coercion; closed bodies; public Global `subject:read`                                                             | `K/src/http/app.ts:293` strict pre-coercion compilation; `S/http/routes.ts:20,125–221`; `T/routes.test.ts:99–260`                                                               | **Proven in source, indirect route tests** using supplied Access/service. Numeric-string acceptance must execute through actual composition.                                                                                                                                                                                                                                                               |
| Exact native keysets, stable unique ID tie, rejected-hit consumption, acceptable lookahead unconsumed                                 | `S/query.ts:110–155`; `S/service.ts:323–357`; `S/cursor.ts:28–54`; `T/query.test.ts`, `cursor.test.ts`, `contract.test.ts`                                                      | **Proven helper behavior**, **incomplete API traversal**. Native query tests cover engine ordering; no claim of snapshot traversal while keys move.                                                                                                                                                                                                                                                        |
| Confidential consumed hidden/taken-down lookahead                                                                                     | `S/service.ts:345–375`; `S/cursor.ts:3,57–68`; `K/src/tokens/seal.ts:22–33`; `T/cursor-confidentiality-outcomes.test.ts:35–78`                                                  | **Contradicted**: authenticated plaintext. Real two-mode regressions exist but their recorded attempt never reached tests.                                                                                                                                                                                                                                                                                 |
| Actual shared encrypted codec migration, all async callers, canonical request/operation/real viewer, no plaintext fallback            | `K/src/tokens/list-cursor.ts`; shared codec commit `bd050b9121c816d2029e2d15d9a63f02bb9a66f2`; actual Search import above                                                       | **Incomplete**. Shared AES-GCM implementation is in D; Search and rating wrappers still call the old synchronous codec. Migration is held, with no attempt.                                                                                                                                                                                                                                                |
| Fifteen-minute expiry including anonymous, future allowance, tamper/request/principal binding                                         | `K/src/tokens/cursor.ts`; `S/cursor.ts:12–25,71–88`; `T/cursor-confidentiality.test.ts:31–82`, `cursor.test.ts`                                                                 | **Proven at old codec layer**, **incomplete for adopted encrypted caller**. Finite numbers, null and negative zero have explicit encodings.                                                                                                                                                                                                                                                                |
| Eight keys; 2,560 bytes/key, 3,072 aggregate, 3,584 serialized, 4,864 token; full native names/null                                   | `S/README.md:281–312`; `S/rating-cursor.ts:31–48,69`; `T/cursor-confidentiality.test.ts`, `bounded-name-cursor-outcomes.test.ts`                                                | **Incomplete/contradicted caller capacity**: old unseal/rating cap is 4,096; HTTP cursor is unbounded `t.String`. Rating tuple validation already accepts name null; that is not a missing feature. `ordered-cursor-capacity.test.ts` exercises the actual shared codec with proposed Zone positions only: **indirect serialization evidence**, no adopted Zone contract or native Search traversal proof. |
| Generation switch 409, empty-result race, pin physical generation and supported bounded format before reads                           | `S/service.ts:192–220,325–333,447`; `S/query.ts:113`; `T/query-generation.test.ts`; `bounded-generation-readiness.test.ts`                                                      | **Proven physical-target helper**, **contradicted service admission**: ordinary service omits generation, empty reads use cached alias. C adds fresh pre/post alias checks but still queries alias. Six readiness cases remain red in recorded C run.                                                                                                                                                      |
| Capped native tracking; ordinary total provenance, restricted/zero/full-predicate rule                                                | `S/query.ts:13,150–153`; released search template; `S/service.ts:369,446`; C `S/service.ts:281–285,363–366,458–461`; `T/live-count-policy.test.ts` at C                         | **Contradicted D**; **incomplete C**, with mixed/relation fallback divergence detailed below. C's real unvisited-home races prove limited count classification, not default-worker health.                                                                                                                                                                                                                 |
| One request-owned pre freshness observation for `as_of`, no cached total/proof shortcut; preserve candidate/read caps                 | D `S/service.ts:223–229,378`; C `S/service.ts:219–226,281–285,382`; C policy test concurrency and pre/post race cases                                                           | **Incomplete D**, **proven focused C behavior**. C removes the false exactness certificate and observes once before discovery. No latency/postings claim follows.                                                                                                                                                                                                                                          |
| Bounded `search_as_you_type` suggest and current withholding                                                                          | `subjects-suggest-v1.json`; `S/service.ts:451–467`; `T/query.test.ts`; frozen typeahead scenario                                                                                | **Proven query/source structure**, **incomplete real personas/deletion**: 1–64 code points, limit 1–10, at most twice limit candidates.                                                                                                                                                                                                                                                                    |
| Typed index outage, source unavailable, incomplete native response never successful exhaustion                                        | `S/opensearch.ts:82–94`; `S/service.ts:176–188`; `S/query.ts:140–170,254–267`; `T/query-completeness.test.ts`, `complete-search.test.ts`                                        | Transport/missing index mapping **proven in source**; completion **contradicted D**. Q wires all three operations and fixes shard counters, but final focused proof is absent.                                                                                                                                                                                                                             |
| Anchored `matched_queries` disclosure, current full Boolean predicate including unreported negative leaves                            | `S/disclosure/check.ts:49–85,89–139,157–184`; `current-filter-plan.ts`; `current-leaf.ts`; `T/disclosure.test.ts`, `not-proven-rechecks.test.ts`, `overflow-disclosure.test.ts` | **Proven consumer logic, indirect native truth**. Partition is derived from ID; names prioritize work rather than authorize evidence. Only current `true` passes.                                                                                                                                                                                                                                          |
| Current returned facts, same-statement qualifiers/ranges/units, target IDs/labels and language choice                                 | `S/hits.ts:123–160`; `S/facets.ts:118–144`; `T/hit-facts.test.ts`, `hit-text.test.ts`, `disclosure.test.ts`                                                                     | **Indirect**: current snapshots and target batching are implemented, tests supply Source. Native source completeness remains pending.                                                                                                                                                                                                                                                                      |
| Current facet VALUE/code/type contributions, not only visible target labels                                                           | D `S/service.ts:402–446`; C `S/service.ts:408–468`; `S/live-facets.ts`; `T/live-facets.test.ts`, `deletion-count-outcomes.test.ts`                                              | **Contradicted D**: aggregation buckets bypass contributor rechecks. **Focused C implementation**, but all four real deletion modes fail startup.                                                                                                                                                                                                                                                          |
| Protected facts never public-index input; imported tuple fences immediately effective                                                 | `K/src/semantic/search-source-statements.sql:28–56`; `search-source.ts:271,332–342`; `K/src/server.ts:243`; `S/work.ts:37`; `S/document.ts`                                     | **Incomplete/contradicted composition**: SQL excludes concealed/retracted candidates, but route-key omission skips imported fences. E fixes the callers and adds source capabilities; not merged. No public-index cleanliness claim from fake documents.                                                                                                                                                   |
| Native current relation targets/witnesses, unknown under NOT, overflow, finite repair; budgets 128/33/256                             | `S/README.md:62–89`; Semantic owning design; source port at E; `T/not-proven-rechecks.test.ts:193–365`, `overflow-disclosure.test.ts:108–376`; six frozen relation cases        | **Indirect/incomplete**. D source omits relation facets/probes/overflow metadata. Missing ports are existing Semantic work, not newly invented defects. Negative nonoverflow absence still requires native completeness proof.                                                                                                                                                                             |
| Anonymous/editor/suspended outcomes, actual Auth/Access, immediate hide/takedown and independent session/cursor state                 | `specs/search-outcomes.test.ts:235,321`; `T/real-source-composition.test.ts:125–465`; actual default-worker guard at `T/support/outcome-worker.ts:106–115`                      | **Contradicted recorded runtime**: missing default Semantic services. Synthetic Actor/Access tests do not prove floor or named suspension denial.                                                                                                                                                                                                                                                          |
| Real Search-only pause/resume, one default registration/SDK launch, drain/restart/rebuild/node outage/convergence                     | `T/README.md`; `T/support/outcome-worker.ts`, `driver-client.ts`, `outcome-supervisor.ts`; `real-source-composition.test.ts`; wrappers                                          | **Incomplete**. Executable harness preserves imported registrations and refuses absent services. Documentation still describes some superseded driver wiring; actual code controls the evidence.                                                                                                                                                                                                           |
| Genuine Global rating unique currently disclosed lower bound; public eligibility, epoch/generation 409, score zero/null, native order | `S/README.md:219–279`; `rating-query.ts`, `rating-subject-source.ts`, `rating-cursor.ts`; `T/rating-phases.test.ts`, `rating-api-outcomes.test.ts`                              | **Indirect/incomplete**. Query/source helpers are not public service wiring; HTTP sort excludes rating. Four authored API cases mainly cover null figures. Positive native vote outcome file is absent and held; no fabricated positive figure proves delivery.                                                                                                                                            |
| All accepted API proof merged on main and root gate green                                                                             | M tree; read-only promotion record; recorded command ledger below                                                                                                               | **Missing/contradicted**. A passing narrow worker check or authored test is not main completion.                                                                                                                                                                                                                                                                                                           |

## Recorded commands and what they actually establish

These are inspected historical outputs, not commands launched by this audit. SHA-256 identifies the complete output
or log even where its checkout name is temporary. Transcripts are under the main checkout's `.temp/goal/runs/`;
identify the worker by the pinned source revision and acceptance command rather than treating its state as a merge.

| Evidence                                                                                                                                                        | Actual result and limitation                                                                                                                                                                                                                                                                                                           | Output identity                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Physical-target implementation, command `bun run --cwd services/kernel check test/search/query-generation.test.ts test/search/query.test.ts`                    | Exit 0, 6 + 7 tests, zero failures. Implementation `c441ba446a5e9e6b206979bb46000a18d2a089f3` (integrated through `5367ede67573a90d29b225f2d2d9bef14347c578`, present in B/D). Proves helper targeting including zero hits, not service admission.                                                                                     | Transcript attempt 1, event 67; SHA `13e3556b52276ec112364686a3b33918ec9ad3812e66b7e2e430c3f7ce7b1452` |
| Completion specification's `.temp/query-completeness-check.log`                                                                                                 | Exit 1; 3 pass, 3 fail, 870 assertions. Search, suggest and facets admitted incomplete completion metadata; real native business payload was retained during metadata injection.                                                                                                                                                       | SHA `433db1e120da2a6c215909c38b12294d42827136ba86b222fccbacc1969d7d0e`                                 |
| Q predecessor, focused `query-completeness.test.ts query-generation.test.ts query.test.ts`                                                                      | Exit 0, 6 + 6 + 7 pass. Later shard equality/skipped correction and new frozen shard tests came afterward. This pass cannot certify Q's final helper or the complete final five-file acceptance.                                                                                                                                       | Attempt 2, event 44; SHA `f26ac740a381510b1f4dc55269d4fba7d1f08802f6774641eec6cd0f4a1c3178`            |
| Q `bun scripts/typecheck.ts`                                                                                                                                    | Exit 0, all workspaces, before final shard helper edit. No subsequent complete focused test output found in attempt 3.                                                                                                                                                                                                                 | Attempt 3, event 21; SHA `cf491d84f695c1febc959981cdd3435c43d82e2696e170edf4a3e73154a5b91f`            |
| C `bun run --cwd services/kernel check test/search/live-count-policy.test.ts test/search/live-facets.test.ts test/search/service.test.ts src/search/service.ts` | Exit 0 after implementation commit; 27 + 12 + 10 pass, zero failures. Native races use real commands, returned IDs, Access, source and production indexer steps; the other cases also use controlled Source fixtures. They do not run the default worker/real Auth harness.                                                            | Attempt 6, event 665; SHA `9e7a76198e1ec5fd5fddc0821958194ccfe5783a7ec64fe139f010bd7a510d71`           |
| C `bun scripts/typecheck.ts`                                                                                                                                    | Exit 0, all 13 workspaces, before implementation commit; later overflow expectation-only edit was not typechecked again in the inspected transcript. Does not establish main health.                                                                                                                                                   | Attempt 6, event 567; SHA `1bad022ada0f3f4fb858f9cdfdff97d7fcbcb30273264d1c459169a03b04cf03`           |
| C native `deletion-count-outcomes.test.ts`                                                                                                                      | Exit 1; 0 pass, 4 fail. Every mode fails at the default-worker guard before substantive count/disclosure assertions: `Integrated default worker must start exactly one search service and real default semantic services`.                                                                                                             | Attempt 6, event 722; SHA `91b517742378c4dda2fde850f295885ab1045d1303bdb82089c610a697404e00`           |
| C six-file affected-test check                                                                                                                                  | Exit 1: code facets 3/1, facet counts 6/0, type facet 3/1, growth facets 0/4, overflow service 5/3, bounded readiness 0/6 (pass/fail). No broad success inference from focused acceptance.                                                                                                                                             | Attempt 6, event 774; SHA `67d961befbd9e4324b3bbef099d919642806a20e8ca1f19f19273288f06d99c9`           |
| C final `overflow-service.test.ts`                                                                                                                              | Exit 1; 6 pass, 2 fail. Remaining failures expect zero probes at line 322 and zero source reads at line 476; actual current contributor checking performs work. Final commit retains these failed assertions. Whether an authorized cost-contract correction is needed belongs to the owner; this is not evidence of unbounded growth. | Attempt 6, event 876; SHA `62c6625ac3bb58310297c00e5fac08b2e3e8684154ad1d73602103c431efe88e`           |
| Harness `.temp/search-runtime-isolated.log`                                                                                                                     | Exit 1: original 13 cases all fail startup; relation wrapper and real composition file also fail. The six relation cases report 0 pass / 6 fail; native behavior was not reached. Harness specification integration was format acceptance, not a later runtime pass.                                                                   | SHA `037d3aca8e3a3cb762ba4aed78a0659075e51f46e2e57cbfb2867c2c6fc1535e`                                 |
| Confidentiality `.temp/cursor-confidentiality-check.log`                                                                                                        | Slot waited 1,037.439 seconds, then SSH timeout and rsync failure before a test result. This is neither a confidentiality pass nor an observed assertion failure. Codec plaintext contradiction is independently visible in source.                                                                                                    | SHA `9341fbcafb6397c5cc997c47f74fad20289a94ef3141c3be939b299f2d2df139`                                 |
| Root promotion record                                                                                                                                           | `.temp/goal/goal.sqlite`, read-only `worker_promotions`: `stabilize-blocked`; cut `bc2d98c0652a0b68587552e2ed94bb68b86b48db`, `bun scripts/gate.ts`, `passed:false`, `timedOut:false`. Stored failure excerpt is partial and includes failures outside Search. No full current-M/D gate pass is available here.                        | Excerpt SHA `fdcf5bd4e02d153092e738e4147c2f63c6b50c05be4bfbc4968be72088b8e6b8`                         |

Some C `.temp/acceptance-final.log` files end at slot waits/exit 143, and a typecheck log contains only a wait.
The successful rows above come from completed transcript events, not those filenames or a worker's final summary.
Control-plane “stopped” describes worker attempts; it says nothing about current service availability. Held cursor,
default Semantic composition, final real-source outcomes and native deletion proof have no successful runtime evidence.
No live node or process state was probed.

## Concrete findings, ordered by disclosure impact

1. **A hidden consumed key is readable in the public cursor.** B/D
   [service.ts:345](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/search/service.ts#L345)
   advances through rejected lookahead; `S/cursor.ts:63–66` serializes its complete tuple and
   [seal.ts:31](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/tokens/seal.ts#L31)
   merely base64-encodes JSON before signing. Minimal case: indexed ordered A/B/C, pause Search, hide or take down B,
   request limit 1; A is returned, B is consumed, C is acceptable lookahead. Decoding the first token segment exposes
   B's old name and ID without the signing key. Smallest native acceptance already exists:
   `T/cursor-confidentiality-outcomes.test.ts:35` runs both modes and then requires C without duplication. The shared
   encrypted codec being present is not this caller migration; the existing held migration owns the fix and async calls.

2. **Production current-source reads skip imported fences.** B/D
   [server.ts:243](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/server.ts#L243)
   passes no route key; the same omission is at `S/work.ts:37`.
   [search-source.ts:271](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/semantic/search-source.ts#L271)
   then chooses entries without `withoutFencedEntries`. Minimal case: a visible subject has one adopted imported code
   supported only by tuple X; fence X while Search is paused without hiding the subject. Its stale matched code is
   still present in the current source snapshot, so the API can disclose a hit/requested fact supported only by X.
   Smallest independent proof: real import/adopt/fence commands, actual server composition, paused index, query the
   code and request its facts; require immediate withholding and verify no fence-only contribution. E already supplies
   `config.routeKey` at server line 243 and worker line 41 and adds native source checks. This is an existing source
   owner's unmerged correction; helper tests with a supplied key cannot prove deployed caller safety.

3. **Visible facet targets do not prove current contributors.** B/D
   [service.ts:402](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/search/service.ts#L402)
   derives buckets from the index; line 440 returns code buckets without any current source check. Item buckets only
   check the value subject, not the statement contributor. Minimal case: one public book contributes code X / author Y;
   pause Search and hide the book or retract its statement while Y remains public. A facets read still returns X/Y.
   Smallest acceptance is the relevant hidden-only native case in `T/deletion-count-outcomes.test.ts`, retaining actual
   code/item/type values and labels as well as totals. C wires `readLiveFacets` at lines 438–448, addressing the missing
   contribution check; four native cases remain unproved because default composition fails before assertions.

4. **Ordinary total policy is not fully carried through, even on C.** D `S/service.ts:369,446` reports engine exact
   totals with no full-predicate proof. C fixes unrestricted/static/zero classification but
   [service.ts:363](https://github.com/rezics/rezics-next/blob/6801ff700d0262bbbb3b02fc6702dae70042ea4e/services/kernel/src/search/service.ts#L363)
   substitutes page contributor `lower_bound` whenever a current candidate is dropped or a relation predicate is used;
   facets do the same at lines 458–461. Minimal case: engine observes two matches, one is now hidden, one is disclosed;
   C returns `{value:1,relation:'lower_bound'}` instead of the FINAL ordinary observed estimate of 2. The lower bound
   can be mathematically valid; it is a different public observation from the latest every-ordinary-total instruction.
   C `T/live-count-policy.test.ts:500–513,559–566` explicitly expects that fallback, so its green run cannot settle the
   policy mismatch. Smallest acceptance: known native two-document index, pause/hide one, independently establish
   observed count 2, require estimate 2 for search and facets while only the survivor/its values are returned. Repeat
   zero/restricted and cap cases without replacing known values with response-derived expectations. Preserve genuine
   rating unique-disclosed lower bounds and bounded facet bucket contributions. Both authorities must be visible to
   the adopting manager: FINAL count brief's “every ordinary total” rule and `S/README.md:273–275` rating exception.

5. **Ordinary engine responses lack completion admission on D.** B/D
   [query.ts:140](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/search/query.ts#L140)
   maps HTTP-success payloads without checking timeout/shard/termination metadata; suggest and facets do likewise.
   Minimal counterexample is an otherwise valid native empty response with `timed_out:true` or a failed shard: it
   becomes successful zero/exhaustion. Missing `hits.total` instead causes an untyped property access failure.
   `T/query-completeness.test.ts:124–314` already exposes incomplete metadata for all three native operations; the
   smallest additional boundary assertion for malformed payload is typed 503, never empty success or generic 500.
   Q's query wiring and `complete-search.ts:11–40` address metadata, including `successful === total` and skipped
   bounds; final five-file acceptance after that correction remains required. Do not commission a duplicate validator.

6. **Service generation/readiness proof is weaker than the implemented query port.** B/D
   [service.ts:192](https://github.com/rezics/rezics-next/blob/34dbc5607bf58f36722fb7e252df58fc1120d541/services/kernel/src/search/service.ts#L192)
   caches alias identity for one second; lines 208–209 infer empty-result generation from that cache, and line 326
   never passes the available physical generation. Minimal case: warm alias cache at G1, switch to G2, immediately
   continue a valid G1 cursor whose engine result is empty; cached G1 can avoid required restart. Smallest independent
   acceptance: actual alias switch between requests with no sleep, empty result and old valid token, require 409.
   `T/bounded-generation-readiness.test.ts` additionally requires unsupported old-format rejection before any cursor
   is emitted, including empty generations and alias races. Its existing six native cases are the pending owner's
   acceptance; producer implementation is outside this audit. C's uncached pre/post observation improves race checks
   but does not yet use the physical target or prove supported format.

The missing default Semantic registration is the shared reason native outcomes cannot yet reach those assertions:
B/D `K/src/work/modules.ts:69–78` contains no Semantic module, whereas `T/support/outcome-worker.ts:110–114` requires
its actual started services. This is an explicitly held composition obligation, not grounds to replace the default
list, invoke dormant factories manually, accept absent starters, or call the already staged tests new defects.

## Exact remaining proof obligations

1. Execute all **13 original API scenarios** against the adopted real harness after composition and count-only
   correction. `specs/search-outcomes.test.ts` cases start at B lines 199, 208, 218, 235, 253, 275, 321, 357, 392,
   410, 433, 457 and 486: CJK; Kana; names/aliases/descriptions versus statement text; real personas; bounded index
   freshness/as_of; adopted Global statement/positive-NOT behavior; paused hide/takedown/refill; keysets/binding;
   rebuild restart; typeahead; text syntax; filter/strict-body budgets; genuine node outage with subject reads intact.
   `T/outcomes.test.ts` checks actual execution count and zero skips/todos; a narrowed unit selection is insufficient.

2. Execute all **six original relation scenarios**, `specs/search-relation-facets.test.ts:173,232,270,314,351,396`:
   positive and negative matches beyond 128 values; overflow counts; paused source deletion; native relation update;
   target hide before rebuild; qualified refusal. `T/relation-facet-outcomes.test.ts` enforces the complete suite.
   Native source proof must also demonstrate nonoverflow negative completeness, true/false/unknown under NOT, current
   target/fence/witness checks and finite restoration convergence. Controlled snapshots/probe arrays establish only
   Search's consumer truth table and bounds; they cannot establish the source's truth or absence certificate.

3. Keep all **four** `T/deletion-count-outcomes.test.ts` modes (hidden/taken_down × hidden-only/mixed), real Auth/Access,
   actual default-worker pause, sessions, current hit/value/label/code suppression, real errors and later convergence.
   The final count brief permits count metadata corrections only. C changes the frozen Search suite's count union and
   helper, name totals 5 and rebuilt totals 2 to estimates, and introduces explicit lower-bound expectations for adopted
   relation queries and paused deletions. The 13 scenarios and noncount assertions remain; the latter fallback still
   needs alignment with the FINAL rule, not a blanket permissive count matcher. No old exact-count assertion is treated
   here as the current requirement. The relation frozen file has no corresponding authorized rewrite in this brief.

4. Finish actual encrypted Search/rating caller migration, then execute the named contract/rating cursor suites and
   both real confidentiality modes. Retain native numbers/null/negative-zero, request/principal/operation binding,
   anonymous/account expiry, future allowance, malformed token handling and complete long ICU-expanded keys within
   the adopted profile. `T/bounded-name-cursor-outcomes.test.ts` and the six bounded readiness cases must reach
   substantive API assertions; a mapping marker or shared crypto unit pass is insufficient. The separate proposed
   Zone serialization vectors in `ordered-cursor-capacity.test.ts` are not an additional Search runtime gate.

5. Preserve the native count races already observed on C: empty and A-only engine results while a real matching B is
   created in an unvisited home between caught-up pre-observation and the actual engine query, plus facets totals.
   Inspect C `T/live-count-policy.test.ts:79–308,774–949`: real returned IDs and route assertions are used, relay work
   establishes catch-up and a transparent request gate schedules the race. Keep suffix/hide-and-new-source, source
   mutation, nonmatching-home, failure and concurrent-request coverage and one freshness read/request. These are
   useful boundary proofs; they are not default-worker or full-predicate completeness proofs. Resolve the still-red
   affected facet/overflow/readiness checks under their existing contracts; do not discard measured work assertions.

6. Obtain final completion-admission acceptance for `query-completeness.test.ts`, `query-generation.test.ts`,
   `query.test.ts`, `complete-search-shards.test.ts`, `complete-search.test.ts` on Q's corrected helper plus root
   typecheck. Preserve raw metadata, actual engine counts, zero-hit targeting and no alias fallback. Native malformed
   payload/error propagation proof must remain typed; the historical metadata pass does not prove this entire layer.

7. Obtain real harness lifecycle proof: the complete imported module order and one registration each, post-launch
   starters, one SDK launch per owning process, Search-only pause with Semantic progress, replacement runner stop,
   actual completed drains/IPC, restart/rebuild/outage recovery, and sequential/concurrent fixture isolation. Inspect
   every case of `T/real-source-composition.test.ts:125–465` plus `worker-outcome-adapter.test.ts`,
   `supervisor-lifecycle.test.ts`, `relation-facet-events.test.ts`, `rebuild-source-fences.test.ts` and Semantic lifecycle
   acceptance named by `.temp/goal/search/r24-final-real-source-outcomes.md`. Source and tuple-fence composition remain
   the existing owners' work. Send acknowledgments, signals and format acceptance are not completed operations.

8. Keep the **separate genuine rating contract**: real votes crossing population 50 / subject 5, published current
   Global figure, score 0 versus null, fixed-state native A/B order/ties and raw tuples, unique disclosed lower-bound
   totals, threshold loss withheld while lagging, epoch/generation restart and private/Realm exclusion. The staged
   `T/rating-api-outcomes.test.ts` and supplied-document `rating-phases.test.ts` do not supply this proof.
   `.temp/goal/search/rt17-native-rating-outcomes-spec.md` explicitly makes native positive outcome authoring contingent
   on genuine private fixture controls; its future `T/native-rating-outcomes.test.ts` is absent at D. Retain the
   separately approved native query/relay/production-composition acceptances; never expose summed A/B observations as
   a public lower bound or relabel ordinary estimates to satisfy rating assertions.

9. Completion still requires accepted changes actually merged on **main**, the final original 13 + 6, native deletion,
   rating and canonical producer proof supplied by their respective owners, and a passing `bun scripts/gate.ts` on the
   final promotion revision, with required root typecheck. This audit does not certify producer/generation mechanics
   or request another broad check. The current failed promotion record and stopped/held workers are pre-existing
   evidence gaps, not blockers to producing this report. Retain command, revision, actual coverage and zero-skip output
   for each final proof; never redefine completion around whichever narrow tests presently pass.

The sources consistently separate candidate discovery from current anchored disclosure, and helper contracts from
composed runtime evidence. The recommendation is to adopt that same distinction in the merge decision: retain the
approved contracts, finish the existing owners' integration and exact proofs, and resolve the ordinary count fallback
explicitly against the FINAL authority. No new architecture, external standard or broader runtime claim is proposed.
