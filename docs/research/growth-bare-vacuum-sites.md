# Bare VACUUM sites before growth measurements

Audit date: 2026-10-29. This report is evidence for adoption, not a change to fixture or harness contracts.
All source paths and line numbers refer to base
[`22ec9cb1cba1989612a0fa1026244930e49a4183`](https://github.com/rezics/rezics-next/tree/22ec9cb1cba1989612a0fa1026244930e49a4183).
Repository sources are primary evidence under [AGPL-3.0-only](../../LICENSE).

Inventory: `git grep -n -i -w VACUUM -- 'services/*/test/**'`, followed through helpers, callbacks and assertions.
There are **83 executable SQL source sites**, plus one expected-SQL literal included for completeness (84 table rows).
Loops count once per source statement, not once per table, scale or execution. The SQL constructed by `settle` at
`services/kernel/test/support/growth-capture.ts:825` is excluded. Comments, names, diagnostic messages and references
to the expected SQL variable are not additional statements. Search has no executable VACUUM; its match at
`services/kernel/test/search/growth-rating-query.test.ts:279` is a comment. No other service test directory adds a site.

R means the same database is settled after its grow callback and before its measured operation. U takes precedence
when a callback captures its own cost before returning, a shared helper serves an uncovered measurement, or a second
database is not fully settled. F means functional/planner setup whose vacuum has no independent measured-work
consumer, or the expected maintenance SQL literal. Five accounts setup statements and one performance setup
statement sit outside grow but precede its guaranteed settle; they are F rather than pretending they are callbacks.
Fixture population floors (`SELECT count(*)` to validate seed size) and API output lengths are logical correctness
checks, not examined-row cost measurements; actual EXPLAIN rows, captured statements and buffer counts are costs.
The intentional dirty-index regression remains U because its block assertion explicitly depends on bare vacuum.

`schema.{a,b}` abbreviates concrete relations `schema.a` and `schema.b`, not an API argument. For U rows, Relations
names the written fixture relations, including writes outside the original vacuum target; native command side effects
are identified where relevant. Unqualified Auth relations belong to public. A whole-database settle is the conservative
existing API choice when native preparation writes additional bookkeeping relations.

## Inventory

| File:line | Owner | Class | Callback or measurement | Relations |
| --- | --- | --- | --- | --- |
| `services/auth/test/growth-auth-rate.test.ts:204` | accounts | U | `grow:117` → `attempts(true):208`; direct `capture` of denied origin (`attempts:307`) and handlers (`attempts:328`), reduced by `indexVisits:223`; sets block slack at :210 and asserts per-relation blocks at :421. Runs before harness settle. | public.{user,account,auth_client,auth_client_coverage,auth_client_reduction,session,auth_recovery,verification,auth_attempt_counter}; recovery/verification indexes rebuilt too |
| `services/auth/test/growth-auth-schedules.test.ts:126` | accounts | R | `runGrowth` → `checkGrowth.grow:101` → native tick `operation:128` | public.{session,verification,auth_signing_key_archive,user} |
| `services/auth/test/growth-barrier-proofs.test.ts:124` | accounts | R | helper `grow:18`, called only by `checkGrowth.grow:282`; consent/recovery/sweep `operation:314` | public.{user,test_access,account,auth_client,auth_client_coverage,auth_client_reduction,session,auth_consent,auth_recovery,verification,auth_barrier_proof,auth_effect_receipt,auth_recovery_establishment} |
| `services/auth/test/growth-barrier-proofs.test.ts:360` | accounts | R | batch cleanup `checkGrowth.grow:358` → `operation:362` | public.auth_barrier_proof |
| `services/auth/test/growth-bounded-sessions.test.ts:44` | accounts | R | insertion/revocation `checkGrowth.grow:31` → `operation:47` | public.session (also user fixture/ANALYZE) |
| `services/auth/test/growth-bounded-sessions.test.ts:112` | accounts | R | legacy pages `checkGrowth.grow:90` → `operation:114` | public.session (also user fixture/ANALYZE) |
| `services/auth/test/growth-bounded-sessions.test.ts:142` | accounts | R | expiry batch `checkGrowth.grow:131` → `operation:144` | public.session (also user fixture/ANALYZE) |
| `services/auth/test/growth-consent-issuance.test.ts:490` | accounts | R | helper `grow:440`, called by `checkGrowth.grow:548` for each axis; full consent/issuance operation | public.{user,auth_consent,auth_client,auth_client_coverage,auth_barrier_proof,auth_effect_receipt} |
| `services/auth/test/growth-credential-effects.test.ts:71` | accounts | R | `checkGrowth.grow:33` → `apply` in `operation:73` | public.{auth_effect_receipt,auth_public_key,user,account,session}; test_authority fixture too |
| `services/auth/test/growth-current-consent.test.ts:50` | accounts | U | `checkGrowth.grow:25` → direct `capture:51` of `readCurrentConsent`; asserts one statement and retains raw plans before harness settle. | public.{auth_client,auth_client_coverage,auth_consent,auth_client_reduction_progress,auth_client_reduction} |
| `services/auth/test/growth-current-consent.test.ts:283` | accounts | U | `checkGrowth.grow:252` → direct `capture:284` of pending consent `read`; asserts one plan/statement and retains raw evidence before harness settle. | public.{auth_client,auth_client_coverage,auth_consent,auth_client_reduction_progress,auth_client_reduction}; public.auth_barrier_proof |
| `services/auth/test/growth-pages-reads.test.ts:130` | accounts | F | Planner baseline setup before either `checkGrowth:136`; each route grows at :139 then settles before `operation:180`. No standalone cost depends on this vacuum. | public.{user,session,auth_client,auth_client_coverage,auth_client_reduction,auth_consent} |
| `services/auth/test/growth-pages-reads.test.ts:178` | accounts | R | route `checkGrowth.grow:139` → HTTP `operation:180` | All user relations; axis writes public.{user,session,auth_client,auth_client_coverage,auth_client_reduction,auth_consent} |
| `services/auth/test/growth-provisioning-evidence.test.ts:105` | accounts | R | helper `grow:77`: `checkGrowth` uses it at :119, :182 and :224; evidence resolution/provisioning/erasure costs are measured after settle. | All user relations; decoys in public.{user,auth_provisioning_receipt,auth_registration_stage} |
| `services/auth/test/growth-provisioning-evidence.test.ts:183` | accounts | R | fallback in idempotent provisioning `checkGrowth.grow:168` → `operation:185` | All user relations; public.{user,auth_registration_stage} trimmed |
| `services/auth/test/growth-provisioning-evidence.test.ts:225` | accounts | R | erasure `checkGrowth.grow:211` → `operation:227` | All user relations; public.{user,auth_registration_stage,auth_provisioning_receipt} |
| `services/auth/test/growth-recovery-delivery.test.ts:197` | accounts | R | failed delivery `checkGrowth.grow:157` → `operation` supplied at :199 | public.{user,account,auth_recovery,verification,auth_attempt_counter,test_access} |
| `services/auth/test/growth-recovery-establishment.test.ts:71` | accounts | R | helper `grow:15` called by `checkGrowth.grow:220`; complete/resolve/cleanup operation | public.{user,account,test_access,auth_recovery,auth_barrier_proof,auth_effect_receipt,auth_recovery_establishment,verification} |
| `services/auth/test/growth-recovery-establishment.test.ts:247` | accounts | R | `checkGrowth.grow:220`, after session preparation; operation at :250 | public.session |
| `services/auth/test/growth-session-proof-capability.test.ts:122` | accounts | R | `checkGrowth.grow:104` → proof signing `operation:126` | public.session; public.user and access.account also analyzed |
| `services/auth/test/growth-sessions.test.ts:122` | accounts | F | `setup:60` planner baseline; callers use returned `check:466` → `checkGrowth:467` and its `grow:470`. No intervening standalone measured cost. | public.{auth_client,auth_client_coverage,auth_client_reduction} |
| `services/auth/test/growth-verification.test.ts:77` | accounts | R | helper `grow:56`, passed to latest-query `checkGrowth:88` and expiry `checkGrowth:113`; direct inspections :103/:128 occur after these settled checks. | public.verification |
| `services/auth/test/growth-website-refresh.test.ts:195` | accounts | R | helper `seed:160`, called by rotation `grow:202` and replay `grow:229` only | public.{oauthRefreshToken,oauthRefreshFamily,user} |
| `services/auth/test/website-protocol-retention.test.ts:131` | accounts | R | retention `checkGrowth.grow:127` → `operation:133`; direct plan inspection :139 follows settled check | public.{oauthAccessToken,oauthRefreshToken,oauthRefreshFamily,oauthClientAssertion,auth_recent_oidc_session} |
| `services/kernel/test/access/growth-account-handle-read.test.ts:89` | accounts | R | profile `checkGrowth.grow:27` → HTTP `operation:92` | access.account |
| `services/kernel/test/access/growth-account-handle-read.test.ts:90` | accounts | R | profile `checkGrowth.grow:27` → HTTP `operation:92` | access.handle_claim |
| `services/kernel/test/access/growth-anonymous-resource-authorization.test.ts:114` | accounts | R | `checkGrowth.grow:72` → authorization/report `operation:116` | All user relations; access ACLs; public.{anonymous_growth_authority,anonymous_growth_report}; core.receipt |
| `services/kernel/test/access/growth-auth-barriers.test.ts:141` | accounts | R | native barriers `checkGrowth.grow:126` → `operation:143` | access.{account,lifecycle_fence_receipt}; core.receipt |
| `services/kernel/test/access/growth-auth-credential-capability.test.ts:393` | accounts | R | `checkGrowth.grow:355` → credential `operation:395` | core.receipt; access.{account,resource_grant,operator_opening_receipt,workflow_approval,credential_floor_receipt}; public.auth_effect_receipt |
| `services/kernel/test/access/growth-auth-session-capability.test.ts:245` | accounts | R | `checkGrowth.grow:212` → session `operation:247` | core.receipt; access.{operator_opening_receipt,account,resource_grant}; public.{auth_effect_receipt,auth_session_opening,session} |
| `services/kernel/test/access/growth-bootstrap-governance.test.ts:192` | accounts | R | `checkGrowth.grow:111` → native command and CLI `operation:194` | access.{account,resource_role_grant,resource_grant}; core.{receipt,outbox}; semantic.context |
| `services/kernel/test/access/growth-creation-manifest.test.ts:136` | accounts | R | helper `grow:106`, called by `checkGrowth.grow:143` and :162; `createAndReplay` operation | All user relations; public.standing_resource; access ACLs; core.receipt |
| `services/kernel/test/access/growth-creation-manifest.test.ts:163` | accounts | R | changed resources `checkGrowth.grow:161` → `operation:165` | All user relations; same manifest population as :136 |
| `services/kernel/test/access/growth-durable-initiator-capture.test.ts:42` | accounts | R | `checkGrowth.grow:26` → durable initiator `operation:44` | All user relations; access.{account,principal_assignment} |
| `services/kernel/test/access/growth-durable-initiator.test.ts:131` | accounts | R | `checkGrowth.grow:71` → native `operation:53`; later direct capture :136 follows harness settle | durable_test.{operation,source}; core.receipt; access.{principal_assignment,account,resource_grant,organization_member,membership_inverse}; public.{auth_client,auth_client_coverage,auth_consent} |
| `services/kernel/test/access/growth-evaluator.test.ts:137` | accounts | R | helper `population:21` called only by `checkGrowth.grow:199` and :210 → evaluator operation | access.{account,resource_grant,resource_denial,resource_role_grant,membership_inverse,organization_member} |
| `services/kernel/test/access/growth-grant-routes.test.ts:132` | accounts | R | `checkGrowth.grow:107` → `exercise`; direct capture :136 follows harness settle | access.{resource_grant,resource_role_grant}; core.receipt |
| `services/kernel/test/access/growth-membership-inverse-bootstrap.test.ts:173` | accounts | R | bootstrap `checkGrowth.grow:159` → `operation:182` after warmup | access.{account,organization_member,membership_inverse,lifecycle_membership_slot,lifecycle_coordination}; core.receipt |
| `services/kernel/test/access/growth-native-membership-work.test.ts:174` | accounts | R | membership workflow `checkGrowth.grow:119` → `operation:176` | access.{account,resource_grant,workflow_approval,organization_member}; core.receipt |
| `services/kernel/test/access/growth-open-interval-history.test.ts:115` | accounts | F | `checkDenialHistory` planner baseline before `checkGrowth:130`; the subsequent grow/settle protects `operation:151`. No standalone cost before that settle. | access.resource_denial |
| `services/kernel/test/access/growth-open-interval-history.test.ts:149` | accounts | R | `checkDenialHistory` conditional `checkGrowth.grow:135` → `operation:151` | access.resource_denial |
| `services/kernel/test/access/growth-open-interval-history.test.ts:168` | accounts | F | `checkDenialUnrelated` planner baseline before `checkGrowth:179`; the subsequent grow/settle protects `operation:188`. No standalone cost before that settle. | access.resource_denial |
| `services/kernel/test/access/growth-open-interval-history.test.ts:186` | accounts | R | `checkDenialUnrelated` conditional `checkGrowth.grow:184` → `operation:188` | access.resource_denial |
| `services/kernel/test/access/growth-open-interval-history.test.ts:204` | accounts | F | `checkGroupUnrelated` planner baseline before `checkGrowth:211`; the subsequent grow/settle protects `operation:220`. No standalone cost before that settle. | access.resource_role_grant |
| `services/kernel/test/access/growth-open-interval-history.test.ts:218` | accounts | R | `checkGroupUnrelated` conditional `checkGrowth.grow:216` → `operation:220` | access.resource_role_grant |
| `services/kernel/test/access/growth-operator-cursor.test.ts:58` | accounts | R | `checkGrowth.grow:35` → responsibility keyset `operation:60` | access.lifecycle_coordination |
| `services/kernel/test/access/growth-operator-transfer.test.ts:201` | accounts | R | `checkGrowth.grow:183` → native `transfer` operation | access.{account,resource_grant,lifecycle_coordination,operator_relation_slot,workflow_approval}; core.{receipt,outbox}; editorial.write_basis |
| `services/kernel/test/access/growth-organization-creation.test.ts:112` | accounts | R | `checkGrowth.grow:26` → organization creation `operation:118` | access.{account,resource_grant,resource_role_grant,membership_inverse,organization_member,lifecycle_membership_slot,lifecycle_coordination,workflow_approval,handle_claim,lifecycle_handle_operation,lifecycle_handle_effect}; core.{receipt,outbox}; editorial.write_basis |
| `services/kernel/test/access/growth-public-identity-read.test.ts:42` | accounts | R | public identity `checkGrowth.grow:32` → public read `operation:44` | access.account |
| `services/kernel/test/access/growth-rate-tier.test.ts:134` | accounts | R | rate tier `checkGrowth.grow:114` → `setService` operation :138 | access.account |
| `services/kernel/test/access/growth-rate-tier.test.ts:135` | accounts | R | rate tier `checkGrowth.grow:114` → `setService` operation :138 | access.operator_relation_slot |
| `services/kernel/test/access/growth-registration-proof.test.ts:80` | accounts | R | registration proof `checkGrowth.grow:60` → proof lookup operation | core.receipt |
| `services/kernel/test/access/growth-registration-proof.test.ts:81` | accounts | R | registration proof `checkGrowth.grow:60` → proof lookup operation | access.account |
| `services/kernel/test/access/growth-reinstatement.test.ts:254` | accounts | R | reinstatement `checkGrowth.grow:215` → reinstate `operation:261` | access.{account,lifecycle_fence_receipt}; core.receipt |
| `services/kernel/test/access/growth-resource-authorization.test.ts:159` | accounts | R | `checkGrowth.grow:89` → `operation:161` authorization/parent creation | All user relations; access.{resource_grant,resource_role_grant,resource_denial,organization_member}; public.{authorization_growth_resource,authorization_growth_tuple} |
| `services/kernel/test/access/growth-suspension.test.ts:374` | accounts | R | suspension `checkGrowth.grow:266` → suspend `operation:390`; subsequent preparation is also inside grow | access.{account,handle_claim,resource_grant,resource_role_grant,resource_denial,lifecycle_coordination,lifecycle_fence_receipt,write_rate_counter}; semantic.context; core.{receipt,outbox}; editorial.write_basis |
| `services/kernel/test/access/growth-workflow-approvals.test.ts:196` | accounts | R | approval `checkGrowth.grow:162` → `operation:145`; later denied capture :205 follows settled check | access.{workflow_approval,account,resource_grant}; core.receipt |
| `services/kernel/test/access/membership-history-cost.test.ts:149` | accounts | U | helper `seed:131`; functional callers :181, :207, :221, :237, :243, :266 and growth caller :399. In `checkGrowth.grow:398`, `exercise:400` warms then direct `capture:403` → `mutationCostOf:363`, exact rows and `assertGrowth:413`, before harness settle. | access.organization_member; exercise additionally changes access coordination/inverse state and core command receipts/effects |
| `services/kernel/test/access/public-floor-boundary.test.ts:166` | accounts | R | `checkGrowth.grow:151` → publication/container `operation:168` | public.public_boundary_fixture |
| `services/kernel/test/access/write-rate-expiry-work.test.ts:80` | accounts | U | direct `measure:88` → `expireWriteRateCounters`; asserts examined/skipped rows and deletion work under 0/1/1000 locked candidates. No checkGrowth. | access.write_rate_counter (TRUNCATE + INSERT); row-lock transaction starts after vacuum |
| `services/kernel/test/access/write-rate-expiry.test.ts:169` | accounts | R | `checkGrowth.grow:160` → expiry `operation:174` | access.write_rate_counter |
| `services/kernel/test/library/entry-due-store-growth.test.ts:222` | commerce | U | `checkGrowth.grow:220` → direct `capture:223` of `operation:174`; catalog count :225, statement/block costs :227–229, indexed actual rows/loops :231 onward, before harness settle. | library.{entry_deleted,entry}; `grow:73` inserts both and `fixed:57` restores fixed archives/live rows; operation rolls back |
| `services/kernel/test/library/sitemap-discovery.test.ts:202` | commerce | U | local `explain:210`, SQL `EXPLAIN (ANALYZE, FORMAT JSON):212`; loop :217 onward asserts actual rows, removed rows, index/range plan. No checkGrowth. | library.collection (generate:182 inserts target and neighboring routes) |
| `services/kernel/test/content/author-post-delete.test.ts:533` | content | U | `checkGrowth.grow:527` → direct `capture:534` of `cleanup:227`; page cost appended :536, bounded by `assertGrowth:550`, before harness settle. | content.{thread,post,revision}; access.{account,membership_inverse,organization_member,resource_grant,resource_role_grant,resource_denial,write_rate_counter}; core.{partition,receipt,outbox}; editorial.write_basis (vacuum currently names only post/revision) |
| `services/kernel/test/content/board-projection.test.ts:319` | content | R | helper `grow:304` passed to `checkGrowth:321` → candidate upsert/page `operation:326` | content.board_thread |
| `services/kernel/test/content/boards-http.test.ts:445` | content | R | `checkGrowth.grow:367` → board HTTP `operation:448` | content.{board,board_thread,thread,post,revision}; access.{resource_grant,resource_role_grant,resource_denial} |
| `services/kernel/test/content/collection-job.test.ts:557` | content | R | helper `grow` passed to `checkGrowth:572` → collection `operation:581`; :566 counts only fixture population; captured physical work follows settle. | content.media; population also content.media_variant, core.{partition,receipt,outbox}, editorial.write_basis |
| `services/kernel/test/content/http.test.ts:394` | content | R | HTTP `checkGrowth.grow:329` → native content `operation:397` | content.{board,thread,post,revision}; access.{resource_grant,resource_role_grant,resource_denial} |
| `services/kernel/test/content/moderation-http.test.ts:500` | content | R | moderation `checkGrowth.grow:464` → moderation HTTP `operation:502` | content.{post,revision}; access.resource_grant |
| `services/kernel/test/content/relays.test.ts:559` | content | R | relay `checkGrowth.grow:545` → enqueue `operation:561` | core.{outbox,consumer_checkpoint}; content.media; dbos.{workflow_status,workflow_input} |
| `services/kernel/test/content/revision-pages.test.ts:128` | content | U | direct `capture:132` → `pageRevisionCandidates:133` and `finishPlan:134`; asserts examined rows, statement/control counts and indexed plan :138–145. Before `anchored:129`; no checkGrowth in this test. | content.{thread,post,revision}; three parents via `parent:56`, revisions via `append:27` (vacuum currently revision only) |
| `services/kernel/test/content/revision-pages.test.ts:271` | content | R | revision `checkGrowth.grow:257` → anchored `operation:275` after harness settle | content.revision; parent thread/post fixtures too |
| `services/kernel/test/content/support/media-fixtures.ts:310` | content | R | `mediaGrowthFixture.grow:287`, changed-set branch; only caller is `media-outcomes.test.ts` checkGrowth grow :85 (spare/fixture :86–87) → collectChanged operations | All user relations; branch writes content.media |
| `services/kernel/test/content/support/media-fixtures.ts:453` | content | R | `mediaGrowthFixture.grow:287`; only callers in `media-outcomes.test.ts` grow :44 (:45/:59) and :85 (:86/:87); then harness settle → fixture.operation / collectChanged | All user relations; content.{thread,post,revision,media}; core.{partition,receipt,outbox}; editorial.write_basis |
| `services/kernel/test/imports/identity-growth.test.ts:37` | imports | R | application DB in `checkGrowth.grow:26` → grant/Access operation :76; application DB receives post-grow settle | access.{account,resource_grant,workflow_approval,operator_opening_receipt}; core.{receipt,outbox} |
| `services/kernel/test/imports/identity-growth.test.ts:47` | imports | U | separate Auth DB in `grow:26` → direct Auth `capture:77` inside operation → `costOf:100` / `assertGrowth:114`. Post-grow settle at growth.ts:362 covers only f.database; Auth warmup writes settle only their touched relations, not all seeded Auth history. | public.{user,account,session,auth_consent,auth_registration_stage,auth_provisioning_receipt,auth_effect_receipt,auth_public_key,auth_key_assertion}; native.grow / seedBaseline in identity-fixture.ts (current vacuum omits provisioning receipts/assertions) |
| `services/kernel/test/support/growth-dbos-vacuum.test.ts:7` | performance | F | Expected SQL string, never submitted by this test; observeAdminQueries :9 compares actual harness maintenance at :52/:74. Functional coverage of absent/late DBOS schema, not fixture preparation. | dbos.workflow_status (comparison literal only) |
| `services/kernel/test/support/growth-determinism.test.ts:48` | performance | U | beforeAll → `runWorkload:120` direct `capture:122`, invoked alone :144 and under load :149; exact row/block equality :167. Workload priming :143 is not settle. | growth_determinism_test.{parallel_rows,hash_rows,blocker_rows} |
| `services/kernel/test/support/growth-load.test.ts:24` | performance | F | beforeAll creates 16-row delayed-notice fixture; only verdict is `checkGrowth:68`, empty `grow:74`, then harness settle before warmup/operation. No standalone measured cost depends on vacuum. | growth_load_test.rows |
| `services/kernel/test/support/growth-settle.test.ts:54` | performance | U | intentional unsettled control in `dirtyWithSnapshot:47`, called :67/:75; `probe:56` EXPLAIN at :61, first/next block inequality :72. Second invocation tests settle before block equality :88. U by measurement criterion, not a repairable fixture defect. | growth_settle_test.rows (TRUNCATE + INSERT 3000 + DELETE 2800, with an older REPEATABLE READ snapshot) |
| `services/kernel/test/semantic/graph-summaries.test.ts:357` | semantic | U | direct `capture:359` → `get(graphPath(anchor))`; statement counts :380/:381 and reported cost via `costOf:383`; preceded only by one unmeasured GET :358. | Native `subject:83` writes semantic.{subject,revision,fact,partition_subjects} and core.{partition,receipt,outbox}; `catchUp:155` writes semantic.{inbound_link,outbound_link,inbound_link_count,outbound_link_count,inbound_link_context_count,outbound_link_context_count} and core.consumer_checkpoint. Bare vacuum targets whole DB. |
| `services/kernel/test/semantic/growth-inverse-pages.test.ts:192` | semantic | U | manual changed-links branch: warmup `check.operation:193`, then `measure:194` of same operation; bounds on rows/blocks/statements :197–199. The other branch uses checkGrowth, but this vacuum is only in the manual branch. | semantic.{inbound_link,inbound_link_count}; core.{outbox,consumer_checkpoint}; native operation also writes core.partition and semantic.{outbound_link,outbound_link_count,inbound_link_context_count,outbound_link_context_count} |
| `services/kernel/test/semantic/growth-relation-facet-rebuilds.test.ts:287` | semantic | U | manual scale loop: `prepare:290` writes fresh continuation; `step:291` → worker.run:292; direct `capture:298`, median :303 and `assertGrowth:305`. Warmup is a different consumable page; prepare runs again before each measurement. | Native imports/proposals/retractions and redirect seeds target semantic.{subject,partition_subjects,revision,fact,candidate,retraction,external_claim,source_candidate,redirect}; setup also writes access.{account,resource_grant,write_rate_counter}, editorial.write_basis and core.{partition,receipt,outbox}. prepare targets content.source_fences and core.consumer_checkpoint; relay writes are not implemented on this base (see caveat below). Whole DB vacuum occurs before per-run prepare. |
| `services/kernel/test/semantic/growth-source-record-attribution.test.ts:57` | semantic | U | helper `series:47`: direct `capture:61` → inspect:63, median :72 and `assertGrowth:75` / byte bounds :76. Callers :299 (subject attribution/disclosure axes) and :340 (metadata fill/replay/duplicate/correction/denial); warmup :58 can write. | Population: core.receipt; semantic.{source_record,subject,fact,external_claim,revision,candidate,retraction}. Native operations also write command/provenance state; seed has no harness-managed grow here. |

The facet-rebuild test asserts that `src/semantic/relation-facet-rebuilds.ts` exists at :173–176; that module is
absent on this base. Its U classification follows the explicit intended prepare/capture path, not an observed
successful run. The table names existing native writes; it does not invent the missing relay's bookkeeping writes.
The future repair should settle the whole database after prepare so it also covers those writes when implemented.

## Counts by owner and class

Counts include the expected-SQL literal; executable-only performance F is one, and executable-only total F is six.

- accounts: R 51, U 5, F 5; total 61.
- commerce: R 0, U 2, F 0; total 2.
- content: R 9, U 2, F 0; total 11.
- imports: R 1, U 1, F 0; total 2.
- performance: R 0, U 2, F 2; total 4.
- search: R 0, U 0, F 0; total 0.
- semantic: R 0, U 4, F 0; total 4.
- All owners: R 61, U 16, F 7; total 84.

## Shared patterns and primary-source basis

The uncovered cases share a lifecycle error: preparation and a direct capture live inside grow, so the harness's
post-grow settle happens too late. Other cases hand-roll a scale/repetition loop or use a separate Auth database.
An unmeasured warmup can consume or modify rows; it cannot establish a verified clean horizon for later captures.
A later checkGrowth result does not retroactively settle an earlier capture.

The source ordering is explicit in [growth.ts](../../services/kernel/test/support/growth.ts): grow at :360,
settle at :362, warmups at :367, pending-write settles at :398, prepare at :401, measured capture at :402.
[settle](../../services/kernel/test/support/growth-capture.ts) captures the horizon at :799–800, waits for xid/xmin
holders, forces index cleanup at :825, and checks visibility before returning (:839 onward).
The APIs are re-exported by growth.ts:51–53; settleAdmin resolves only registered admin pools (:875–878). This is stronger evidence than the presence of ANALYZE in fixture SQL.

PostgreSQL documents that old row versions remain while potentially visible to transactions, and that visibility-map
bits describe pages visible to every transaction. This supports the distinction between garbage collection and a
settled measurement baseline. See [PostgreSQL 18 routine vacuuming](https://www.postgresql.org/docs/18/routine-vacuuming.html)
(§24.1.2, §24.1.4). The [VACUUM reference](https://www.postgresql.org/docs/18/sql-vacuum.html) documents both
ANALYZE statistics and INDEX_CLEANUP ON; neither is a promise that an older snapshot has ended.
PostgreSQL documentation is under the [PostgreSQL License](https://www.postgresql.org/about/licence/).
These official documents and the audited repository suffice; no external source clone or reference-index change was needed.

## Fix shape

Recommendations below cover U rows only. Use exports from `services/kernel/test/support/growth.ts`.
Always finish/commit fixture transactions before settling, and settle after any warmup or per-run preparation that
writes, immediately before the capture. Preserve analyze=true at scale preparation when replacing VACUUM ANALYZE;
repeat settles between samples may omit analyze. Do not place maintenance inside the measured capture.

- **Accounts — growth-auth-rate:204:** replace the loop with `settle(database, { analyze: true })` before
  `attempts(true)`. Its separate handler captures can change recovery/counter/session history; settle after each
  branch's setup and before its direct capture when retaining the independent inspections. No harness API change.
- **Accounts — growth-current-consent:50/:283:** smallest change is `settle(db, { analyze: true })` at each
  replacement site, immediately before :51/:284. Alternatively collect the raw plans from the already existing
  three-scale checkGrowth measurement instead of capturing them inside grow.
- **Accounts — membership-history-cost:149:** leave functional seed callers unchanged; in the measured caller
  `grow:398`, settle after the unmeasured exercise and before each of the five `capture:403` calls. Whole-database
  settle covers command side effects as well as `access.organization_member`. The shared helper remains U until
  those callers are protected; replacing only its vacuum misses writes in exercise.
- **Accounts — write-rate-expiry-work:80:** use
  `settle(db, { relations: ['access.write_rate_counter'], analyze: true })` before opening the locking transaction.
  Keep the intended locked-candidate state during the measurement; do not wait on the deliberate locker.
- **Commerce — entry-due-store-growth:222:** replace with
  `settle(db, { relations: ['library.entry_deleted', 'library.entry'], analyze: true })` before the direct probe.
  Its operation rolls back, so keep settling outside that transaction.
- **Commerce — sitemap-discovery:202:** replace with
  `settle(db, { relations: ['library.collection'], analyze: true })` before the explain loop, obtaining db with
  `openGrowthDatabase(databaseUrl)` and closing it in the test's finally. The current `pool` is an ordinary pg.Pool:
  `settleAdmin` requires a registered **admin** pool and throws for this pool (growth-capture.ts:875–878). Alternatively
  use db.admin for the fixture and pass that registered pool to settleAdmin. No three-scale conversion is necessary.
- **Content — author-post-delete:533:** replace with `settle(db, { analyze: true })` immediately before the
  cleanup capture. The full set includes fresh author-delete command effects, not just post/revision. A separate
  cleanup checkGrowth at the existing 256/1024/4096 scales is also possible, but replacing this preparation is smaller.
- **Content — revision-pages:128:** use
  `settle(db, { relations: ['content.thread', 'content.post', 'content.revision'], analyze: true })` **before**
  `anchored:129` opens its long transaction. The repeated selector captures are read-only; do not settle while the
  deliberate anchor transaction holds an old snapshot.
- **Imports — identity-growth:47:** settle `native.authDatabase` explicitly with `{ analyze: true }` after
  native growth, including all seeded Auth relations. This must occur before Auth captures; settling f.database
  cannot do it. Keep application and Auth preparation on their respective database handles. Between operation
  repetitions the existing harness tracks Auth writes; check that any setup added inside the operation is settled
  before its nested Auth capture as well.
- **Semantic — graph-summaries:357:** replace the full-database vacuum with `settle(db, { analyze: true })`;
  if the unmeasured GET changes projection/bookkeeping state, settle again before :359. Retain the statement-count
  assertions for the 501-node graph; no new scale loop is necessary for this fixed functional bound.
- **Semantic — growth-inverse-pages:192:** move settle to **after** `check.operation` warmup :193 and before
  `measure:194`, using `settle(db, { analyze: true })` to cover native command and projection effects. This preserves
  the existing 10/100/500 scale points without requiring a change to the growth contract.
- **Semantic — growth-relation-facet-rebuilds:287:** use a whole-database settle with analyze after scale seeding,
  then settle again **after prepare:290 and before capture:298** on every measured consumable page. The warmup and
  verify/drain also write, so a single replacement before the loop is insufficient. Retain fresh per-run work.
- **Semantic — growth-source-record-attribution:57:** in shared `series`, replace the vacuum with
  `settle(db, { analyze: true })`, and settle after the warmup and between direct captures. This protects both
  callers (:299/:340), including writing metadata operations. Recasting this existing three-scale series
  (64/512/4096) as checkGrowth is an alternative that supplies the same preparation lifecycle.
- **Performance — growth-determinism:48:** replace beforeAll vacuum with whole-database
  `settle(db, { analyze: true })` (or its three explicit fixture relations). Finish settling before launching the
  intentional concurrent parallel workloads; those workloads are the experiment, not fixture cleanup to await.
- **Performance — growth-settle:54:** retain the bare-vacuum **negative control**. Settling before dirtyFirst would
  erase the behavior this test proves and waiting before ending holder's snapshot would defeat its waiting assertion.
  The settled positive comparison already uses `settle(db, { relations: [table], ... })` at :77, waits for holder's
  COMMIT, and only then calls probe :86/:87. No repair is recommended here; route this U row as intentional coverage,
  with the existing settled arm as the model for production-fixture fixes.

The recommendation is to repair the uncovered fixture/measurement boundaries above, keep the intentional dirty
control, and leave adoption and fixture edits to their owning follow-up work. No harness API change is proposed.
