# Local consistency: persistence, convergence and opening

**defer: the additional durable dual-read cost is 0 demonstrated formats if
immutable evidence stays readable; public search tokens need at most five
minutes of compatibility, or an explicit restart.** Fix the eight scoped-position
defects below separately. Opening increases replay/rebuild volume, but the code
does not establish that it forces a user-data rewrite or a new receipt reader.

Read-only analysis at `c01efcdf0ed7146c58e572444c6264706148cb9c`, 2026-10-11.
Only this report changes. No test, server, image build or product mutation was
run. Findings are source evidence and proposed acceptance scenarios, not claims
of reproduced failures or passing qualification. Parallel native, Main and
operations inventories were reconciled with a repository-wide reference census.

## Decision and limits

Program's decision supplied by the brief is **architecture convergence after
opening**, except where this inventory changes that decision. Program's
`docs/goals/program/state.md:11` records the already-landed C3 first path: Work
and Context dependencies, Main stream positions, relay migration 020 and the
local-read-basis fixtures. Do not commission that foundation again.

`docs/goals/kernel/GOAL.md:62-65` names the targets: local revisions, dependency
tokens and stream-scoped positions. The referenced record would be
`.temp/arch-review-2/target-architecture.md` after translating the cited main
checkout path. It is absent here. I could not verify its §10, especially the
intended public browse chronology or full selected-model dependency protocol.
Supplying that record inside this worktree would settle those design questions.
The report does not invent its contents.

C3 concerns **correctness depending on site-wide order**, not the presence of a
number in immutable evidence. These are different changes:

1. Replace stale/current/coverage/order decisions with the responsible owner's
   revision, selected dependency or scoped stream position. Preserve exact old
   receipt, object, model and backup bytes. This is the recommended convergence.
2. Delete or reinterpret every serialized `sequence`/`modelGeneration` field.
   That additionally changes signed evidence and old manifests. It would need
   versioned readers or authorized conversion; neither the brief nor the
   observed code establishes a reason to do it.

An exact receipt/revision equality establishes that two records belong to the
same operation. Comparing either to the current dataset counter establishes a
site-wide freshness requirement. A revision's historical validated-under model
pin is custody; rejecting a prepared operation because an unrelated profile
changed is a global admission guard. Keep the former, converge the latter.

Classification: **A** is a wrong/incomplete existing function, **B** can follow
opening, **C** is architecture work to defer. A below is supported by static
counterexamples; it still needs the named focused test before claiming a red
acceptance case reproduced. IDs indicate contributions, not whole-ID green
qualification. The brief supplies no acceptance case IDs; C3 is a contract ID.

## Inventory by persisted kind

Paths in the following tables are repository-relative. Abbreviated `modules/`
means `services/main/src/modules/`; Java names mean
`infra/jena/command-module/src/main/java/com/rezics/jena/`. The final census gives
every candidate file and matching line, including indirect consumers, models
and schemas. A lexical match is not classified as a global dependency merely
because it contains `sequence`.

| Kind | Writes and storage | Dependence / reader | After opening; converged form; classification |
| --- | --- | --- | --- |
| Dataset counter and ordinary terminal/revision/outbox coordinates | `modules/work/edit.ts:151-218`, `agent/graph.ts:65-90`, `rating/observation.ts:320-340`, `structure/change.ts:391-446`; graph control, revisions, receipts, outbox. Writer census below identifies 79 raw-template files. | `CommandInvariant.java:177-183,243,268-275,301-318,459-483` requires global guard/next value. Main receipt readers also require numeric coordinates. | **Yes**, ordinary writes. Relevant local heads/dependency checks decide correctness; existing Main stream allocates transport order. Preserve historical coordinates as evidence. **C**, no independently reproduced ordinary-write bug. |
| Main outbox/relay transport | `CommandInvariant.java:38-104`; native Main head, batch `streamScope`/`streamSequence`; `modules/outbox/relay.ts:433-515`; SQL checkpoint/delivered batches/events. | `relay-position.ts:10-18` refuses cross-stream or cross-epoch comparison. `relay.ts:450-454` reads an explicit `legacyThroughSequence` prefix. | **Yes**, already scoped. Keep existing allocator and bridge. Migration `services/main/migrations/relay/020_main_stream_scope.sql:3-18` preserves envelope bytes. Opening does not create another bridge. **C: no replacement work**. |
| Exact owner custody / compact graph proof | `modules/outbox/receipt-custody.ts:28-39,157,180,406-416,427-435,469`; durable receipt JSON and exact payload objects. `CommandInvariant.java:112-140` writes compact proof containing both diagnostics and stream sequence. | Custody `:656-709` checks exact terminal/compact proof and signed positions; `CommandService.java:466-520` validates retirement proof. | **Yes**, indefinitely retained. Operation/receipt/revision identity plus existing stream order suffice; keep signed bytes. New reader required **only if evidence format is changed**. **C**, no mandatory rewrite. |
| Model generation head and validated-under pins | `modules/semantic/command.ts:306`, `semantic/change.ts:516-536`, `semantic/staging.ts:273,300-332,449-451,636-642`; graph generation revision/receipt/head, Content staged manifests/outcomes. | `semantic/generation-guard.ts:76-96`, `context/rule.ts:261,325,361,386`; model-dependent writers compare current global head. | **Yes**, semantic edits, rules and stages. Current admission must depend on selected shape/profile/source revisions; immutable generation pin stays custody. **C**. Exact selected dependency protocol remains a design gap; do not simply remove guard. |
| Revision SHACL sequence properties | 56 authored definitions, e.g. `model/definitions/work-metadata-details-v2.ttl:34`, `context-v1.ttl:46,76`, `statement-v1.ttl:92`, `structure-composition-v1.ttl:124,156`. Seven definitions require `modelGeneration`. | These impose cardinality/type/range or exact historical pin, not current-head order. | **Yes**, validation of new records. **C: no mechanical shape migration needed** while diagnostics remain. A new meaning needs a new term; never silently reinterpret old sequence as a local revision. |
| Process-key encrypted cursors | `modules/work/read-session.ts:61-105`; client-held version-1 body. 64 helper-caller files are an audit set, many already local. | `:100-105` prefers dependency token; otherwise sequence fence. `:392-403` refences local reads or globally checks before/after. | **Yes**, transient, already invalid after process restart. No durable migration/dual reader. Use existing dependency capture and epoch fence per family. **C**. |
| Public JSON continuations | `modules/work/search-continuation.ts:4-16,95-127`; `content-publication/search-continuation.ts:12,44-88`; `graph-query/schema.ts:90-125,162,203`, `query.ts:380,424-449`; API schema `services/main/src/api-contract.ts:165-181`. | Public and Content search compare graph sequence; graph-query continuation also compares it. | **Yes**, client tokens. Search fixes first-page expiry to five minutes. Use selected relation/presentation dependency and index/owner position. Explicit restart or bounded token compatibility, **no DB rewrite**. Graph-query token lifetime must be established separately; do not assign it search's TTL. **C**. |
| Private continuation disclosure fence | `modules/search-disclosure/private-continuation.ts:4-13,62-69`; graph sequence, source/result digests and erasure frontier. | Private producers use the fence to detect moving disclosed inputs. | **Yes**, client-held. Keep digests, admission and live erasure/revocation; substitute exact selected dependencies only after equivalence proof. **C**, SEARCH16. |
| Feed / target / Home positions | `modules/feed/store.ts:101-102,157-183`; `target-index.ts:23-24,63-64`; SQL feed/target checkpoints and Home watermark. | `refresh.ts:24`, `store.ts:83-86`, `read.ts:790,810`, `new-since.ts:65-67` compare relay-derived coverage to graph sequence. | **Yes**, derived SQL. Wrong mixed-coordinate decisions are **A** (A2); reuse Main stream coverage and Access membership revision. Derived caches can cut/rebuild; user actions and Home watermark need their stream identity preserved. |
| Discover generations and coverage | `modules/discovery/store.ts:350-368,499-565`, `refresh-store.ts:80,400-427,458-461`; SQL immutable generations/coverage/refresh positions. | `refresh.ts:73-79` equates graph and relay; `source.ts:58-80` consumes scoped SQL relay batches; `changes.ts:51-59` separately walks graph-sequence batches. | **Yes**, derived generations. Wrong caught-up gate is **A** (A3); broader coverage representation is **C**. Keep graph diagnostic and stream coverage distinct during cutover. Rebuild derivatives, preserve original immutable generation evidence. |
| Realm directory, threads, recommendations | `modules/realm-directory/index.ts:197-200`; `realm-reply/thread-store.ts:77-85`; `also-enjoyed/store.ts:134-141`; `recommendation/derived-generation.ts:206`; graph cuts/checkpoints/input-position JSON in Access. | Directory `:64-85,121,225,240,266-268`; Also-enjoyed `:404,421-446` checks graph position; thread/ranking continuations have owner retention exceptions. | **Yes**, derived SQL and retained input cuts. Local membership/revision plus explicitly scoped source coverage. Regenerate caches rather than rewrite user facts. Existing sealed input evidence stays readable. **C**. |
| Source proposal/adoption/application coordinates | `modules/source/native-work-proposal.ts:94`; `native-work-adoption.ts:357-362,651-658`; `author-credit.ts:252-254`, `child-native-support.ts:272`, `field-application.ts:148`, `support-attach.ts:246`; immutable Content rows. | Exact receipt equality is harmless; `native-work-adoption.ts:600-602`, `author-credit.ts:129-130`, `child-native-support.ts:130-131` use graph sequence to establish later proposals. | **Yes**, user source workflows. Same-source observation/conversion lineage decides chronology, plus exact local application head. A Work-local revision alone cannot prove source chronology. Preserve exact old proof coordinates. **C**; no focused failing case reproduced. |
| Serial statistics checkpoint | `modules/work/serial-projection.ts:368-370,441-442`; Access `476_serial_statistics.sql:5`, derived statistics/cursor. | `serial-projection.ts:474-499` compares relay-derived checkpoint with optional caller graphSequence; Main batch/event queries omit stream scope. | **Yes**, derived owner state. **A6**, typed Main coverage plus graph disclosure dependencies; do not rewrite Content publication-time receipt pins. |
| Zone browse projection/order | `modules/zone-browse/store.ts:106,140-143,193-208`; Access browse entries plus process-local observed/cursor. | `:218-220` compares graph position to observed value advanced with relay numbers; source SQL omits scope. Adoption chronology also uses global graph sequence. | **Yes**, derived entries/order. **A5** for mixed coordinates; **C25c** for owner chronology. Rebuild derivatives without rewriting original selections. |
| Ranking generation/Realm rank coverage | `modules/recommendation/ranking.ts:178-217,459`; Access generation inputs/checkpoints; `rankings/realm-threads.ts:197-204,351-354` persists rank checkpoint. | Recommendation head/batches `:131-134,373-393`, Realm events `:336-339` omit scope; Realm read cut `:138,168` compares a relay-derived position to graph diagnostic. | **Yes**, derived generations and retained rank/history admission. **A7/A8**, keep immutable input evidence and explicit fixed Main/Content domains. Permanent history chronology remains C25b. |
| Admission, provisioning, membership-history boundary | Access graph seal columns/functions; `services/main/migrations/access/002_claim_and_seal.sql:14-20`, `1041_catalogue_import_batches.sql:97-123`, `1201_scope_gate_admission.sql:116-142`, `200_agent_provision.sql:15-21`, `1000_space_visibility.sql:17-26`. | Seal compares the exact submitted proof; Realm history uses an immutable admission cut. | **Yes**, admitted writes and visibility transitions. Receipt identity may stay unchanged; history's chronological boundary must become an explicit stream/owner boundary. **C**. History admission is not an expiring cursor and must not be reset as a cache. |
| Structure and Theme proof copies | `modules/structure/stage.ts:270,317,339`; `theme/store.ts:145-153`; Content stage/activation rows. | `theme/store.ts:100,126` reads exact activation proof; `structure/read.ts:382-387` also has graph-bound paging. | **Yes**, owner proof records. Existing exact Structure/activation revision/receipt identifies proof; preserve diagnostics. Paging uses local membership basis. **C**, no automatic proof-format migration. |
| Content publication/eligibility/erasure proof copies | Content `services/content/src/core.ts:948-951,1211`; Main `modules/erasure/content.ts:208`, `replay-supersessions.ts:21,29`; Content preparation/outbox/supersession rows. | Content `core.ts:357,502-514,1185,1276` verifies copied proof; native `CommandService.java:1388-1394,1465-1467,1572-1574` requires poststate sequence equal CONTROL. | **Yes**, new publications and erasures. Exact receipt/revision/operation and relevant local head bind poststate. Keep source coordinates in evidence. Content delivery is already scoped. **C**, preserve WORK09/WORK10/SEARCH03/SEARCH19. |
| Export exact snapshots | `modules/export/store.ts:151-158`; sealed manifests and exact member pins. | `export/readers.ts:92,323,356,404,459-481` checks exact positions. | **Yes**, retained user exports. Exact revision/receipt pins can remain diagnostic; live disclosure must be refenced by owner dependencies. Do not modify sealed manifest bytes merely to rename coordinates. **C**. |
| Backup manifest and restore lineage/cursors | `scripts/ops/backup.ts:438-446,464-465`, `recovery-set.ts:104`; HMAC-sealed recovery set. `modules/work/restore-lineage.ts:160-170,489-534` writes retained prior graph/Main positions and restored lineage. | `scripts/ops/restore.ts:218-224,397,420-422`; `MetadataRestorePolicy.java:122-135`, `CommandInvariant.java:257-262`, `StatementRestorePolicy.java:89-94,210` still order diagnostic values. | **Yes**, backups of future writes. Keep original manifests/evidence; paired Main stream continuity replaces diagnostic monotonicity where available. Legacy unpaired restore needs a documented interpretation, not invented stream coordinates. **C**. |
| Before/after ordinary composite reads | `modules/work/read-session.ts:297-331,392-403`, `search/snapshot.ts:22-29`, `search/fields.ts:172-176`, `search-disclosure/public-fields.ts:115,245`; transient positions. | Requires unchanged global graph during separate HTTP reads; localBasis already refences captured Work/summary/owner dependencies. | **No separate durable before/after record found here**. Local dependency/refence work, not data conversion. Search must also pair its Lucene relation with graph/disclosure inputs. **C**. |
| Native read/index readiness | `CommandService.java:50-54,89-100`; `SearchDeltaJournal.java:801,838-850,904-947,1005-1014`; search journal ordinal, generation and write epoch. | Relevant public-index overlapping writers refuse a proof; journal ordering uses its own ordinal. TDB read snapshot does not pin production Lucene reader. | **Yes**, index journal effects. Already search-owned order, broader than one entity but not every graph write. Keep safety until paired/local dependency proof exists. **C**. |
| Controlled physical preparation and backup quiescence | `TemplateIndexService.java:450,485-497,579-585,648-650`; `SemanticSourceBasis.java:347,358,404-411,525-570`; persisted store incarnation/TDB-version checkpoints. Backup `scripts/ops/backup.ts:151-156,288,329-331,387-389`; lineage read `modules/work/restore-lineage.ts:298-405`. | Requires stopped/held writers and restarts an interrupted physical scan after store/version change; backup capture rechecks cuts behind a closed recovery fence. | **No ordinary-user requirement to quiesce the graph** in these paths. Retain offline cut identity and physical safety. **C: keep**, not a universal retained-read implementation. |

### Content and Access storage ledger

All graph-proof copies below continue with user writes after opening; all can
retain original coordinates as historical evidence. New optional local-basis
columns would require migrations, but preserving evidence does not. SQL filenames
in this table abbreviate `services/content/migrations/` unless prefixed Access.

| Schema file:line | Stored kind / runtime writer |
| --- | --- |
| `001_core.sql:71-72` | Publication preparation proof; `services/content/src/core.ts:948-951`. |
| `008_source_native_work_proposal.sql:12-13` | Proposal graph receipt; `modules/source/native-work-proposal.ts:94`. |
| `009_source_native_work_adoption.sql:30-31` | Native binding proof; `native-work-adoption.ts:357-362`. |
| `010_source_native_work_title_application.sql:31-32` | Title application proof; same file `:651-658`. |
| `019_source_author_credit.sql:37-38` | Author-credit application; `source/author-credit.ts:252-254`. |
| `030_structure_stage.sql:39-40,58` | Staged Structure proof; `structure/stage.ts:270,317,339`. |
| `043_source_field_support.sql:65-78` | Field-support outcome; `source/field-application.ts:148`, `support-attach.ts:246`. |
| `110_semantic_change_stage.sql:20,57,75,77-83`; `220_semantic_stage_generation_iri.sql:6,12,18` | Stage generation pins and terminal position; `semantic/staging.ts:273,324,330,527-558`. |
| `122_publication_erasure_supersession.sql:10-11` | Exact erasure proof; `erasure/content.ts:208`, replay `replay-supersessions.ts:21,29`. |
| `174_source_native_child_support.sql:40-41` | Child application proof; `source/child-native-support.ts:272`, recovery `child-recovery.ts:143`. |
| `200_theme_activation.sql:21-22` | Theme activation receipt; `theme/store.ts:148`. |
| `2121_content_eligibility_delivery.sql:9-26,41` | Scoped delivery cursor/batches plus graph source proof; Content `core.ts:1211`. |
| Access `110_derived_generation.sql:59-64,89-90` | Pinned/checkpoint coordinates and immutable activation `input_positions`; `recommendation/derived-generation.ts:206`. |
| Access `315_discovery_projection.sql:47,97-100`, `1043_discovery_versions.sql:65` | Immutable generation source cut and coverage; Discover store/refresh writers above. |
| Access `785_also_enjoyed_generation.sql:33,49-51` | Immutable generation graph cut; `also-enjoyed/store.ts:134-141`. |
| Access `396_realm_directory.sql:3-4`, `1161_realm_directory_refresh.sql:22` | Directory checkpoint/rebuild target; directory index `:197-200`. |
| Access `405_home_feed.sql:33,42`, `520_home_personal.sql:12`, `1030_feed_target_timeline.sql:24`, `1038_realm_thread_ranking.sql:10` | Feed, Home watermark, target/thread projection cuts; Feed/Realm owners above. |
| Access `1761_template_seek.sql:7,22`, `1763_template_seek_pending.sql:4`, `1764_template_seek_pending_anchor.sql:4-6` | Seek coverage/pending basis. Native per-key basis is already local invalidation; existing pending owner must remain the decision maker. |
| Access `1769_event_temporal_projection.sql:7,18`, `1771_event_temporal_scoped_coverage.sql:2-12`, `1772_event_temporal_publication.sql:9` | Temporal projection source/published proof cuts; `modules/event/projection.ts:149-182,198-218,260-290`. Its collection reads already scope the Main relay. |
| Access `1766_receipt_custody_delivery.sql:5-11` | Custody delivery already stores stream sequence. |
| Relay `012_owner_relocation.sql:17,32`, `013_owner_reconciliation.sql:70,79`, `016_notification_producer_cursor.sql:5` | Retained relocation/reconciliation positions and notification consumer cursor; relocation/custody owners, notification producer `:514-578`. |

Owner-scoped exclusions: Content `791_content_event_sequencer.sql:63-82` and
`services/content/src/event-sequencer.ts:25-75` sequence **Content** events after
commit. `projection-cursor.ts:43-86` is also Content-scoped. Provider feed cursor
041, package journal 053, reading-position signals 810/840 and verification
freshness 1521 are separate owner mechanisms. Migration 1520's singleton was
retired by 1521; do not count both as live. Verification summary 093 stores
`owner_positions` and exact-head dependencies: its full JSON consumer semantics
were not established; acceptance must inspect that owner before changing it.

### Native file classification

The 12 sequence-bearing production Java files are all accounted for:

| File:lines | Classification |
| --- | --- |
| `CommandInvariant.java:177-183,243,268-318,459-483` | C: ordinary global-order invariant; `:38-140` already owns scoped stream/proof. |
| `CommandPolicy.java:285-289` | C: supporting footprint/parser if command basis changes. |
| `CommandService.java:841,884-886,901-904,1388-1394,1465-1467,1572-1574,1663-1669` | C: poststate head comparisons need convergence; exact same-operation evidence equality can remain. |
| `BindingPolicy.java:396-397` | C/keep: receipt/revision equality, no unrelated-head dependence shown. |
| `TemplateIndexService.java:229-244,337-342,351-381,822-835` | C: per-key token already local; global position in payload is evidence; maintenance writer joins strict counter retirement only. |
| `PublicNameProjection.java:1033-1046` | C: created/updated browse ranks derive from sequence; intended replacement chronology unavailable without record §10. |
| `SearchDeltaJournal.java:801,838-850,904-947,1005-1014` | C/keep: own ordinal orders replay; sequence is source diagnostic. |
| `SemanticSourceBasis.java:198-248,347-358,404-411,525-570` | C/keep: pinned identity plus resource-local effect; `modelGeneration` is historical pin, not compared to current global head here. Held physical checkpoints are maintenance only. |
| `MetadataRestorePolicy.java:39-40,104,117-135,166` | C: calls sequence diagnostic but still requires diagnostic monotonicity. |
| `StatementRestorePolicy.java:89-94,150,162,184,210` | C: retained restore ordering and reconciled prior sequence; legacy evidence needs explicit interpretation. |
| `StatementUpgradePolicy.java:61-70,130,211-272,337-344,373-377` | C/keep held-cut protection; preserve retained provenance rather than rewrite it. |
| `ErasureRestorePolicy.java:119,136,147,153` | C/keep: reconstructs exact old receipt/zero-control maintenance evidence. |

`WorkNameScopeBasisTest.java:370-382` already proves an unrelated ordinary write
does not stamp singleton correctness state and `scopeVersion` is absent.
`SemanticSourceBasisTest.java:319` covers stable unrelated-write dependencies.
Do not rebuild these mechanisms. `ReadSnapshotTest.java:36-94` establishes why
turning off global fences without paired graph/Lucene/disclosure protection is
not an implementation.

## Single-session implementation specifications

Each row is one Luna/max session, not an instruction to dispatch the entire
backlog. S/M is estimated task size, not a measured duration. **Mechanisms for
every row: none new**; extend the existing owner named in the change. A shared
test matrix for every local-basis row is: unrelated write survives; relevant
insert/update/delete invalidates; stale same-owner write and concurrent CAS
refuse; epoch restore/revocation/expiry/erasure still refuse; uncertain response
replay is exact; partial progress and restart never skip work. Do not remove a
check until its replacement proves these outcomes.

### A: existing scoped-position functions

| Item / size | Files and change | Proof, IDs, native image |
| --- | --- | --- |
| A1 / S | `scripts/load/practical.ts:251-280`: read Main **stream** high water and matching checkpoint scope/epoch; never subtract graph diagnostic from scoped relay. Reuse the relay position owner. | New `tests/qa/unit/relay-stream-lag.test.ts`: graph 100/Main 3/checkpoint 3 gives zero; actual stream lag remains; missing/foreign scope/epoch refuse. Existing `tests/qa/unit/load-profile.test.ts`. C3 contribution, no reproduced ID failure. Native **no**, migration **none**. |
| A2 / M | `modules/feed/refresh.ts:21-44`, `store.ts:69-91`, `read.ts:790,810`, `new-since.ts:65-67`, `frame.ts:110-112`: distinguish graph disclosure position, Main stream coverage and Access membership revision. Also scope delivered-event timestamp SQL in refresh `:43-46`. Preserve reader watermark's stream meaning. | New `services/main/tests/feed-stream-position.test.ts`; existing `services/main/tests/feed-read-basis.test.ts`, `tests/qa/integration/feed-read-stability.test.ts`, `g-1043-feed-readiness.test.ts`. Divergent diagnostics must still become ready; foreign stream/epoch and actual lag refuse. C3. Native **no**; no schema change required if these fixed Main-owned tables retain explicit owner binding. |
| A3 / M | `modules/discovery/refresh.ts:73-79,88,165`, `source.ts:58-80`, `refresh-store.ts:400-427`: capture graph and Main stream cuts separately; caught-up checks compare stream high water, not graph counter; pass scoped coverage into relay inputs. Do not relabel existing graph source cuts as stream cuts. | New `services/main/tests/discovery-stream-position.test.ts`; existing `services/main/tests/discovery-refresh.test.ts`, `tests/qa/integration/discovery-refresh.test.ts`, `discovery-continuous-writes.test.ts`. Graph-only diagnostic advance neither blocks enrollment nor overstates delivery; partial relay/epoch/hidden effects remain refused. C3. Native **no**. If durable coverage needs separate columns, additive migration belongs to C17 before switching that path. |
| A4 / M | `modules/notification-producers/producer.ts:514-578`: select/check upstream stream; filter batches/events by that same scope; bind producer cursor to the existing fixed Main owner. SQL currently selects only epoch/numeric sequence although delivered tables have scoped keys. The cursor table is explicitly graph-relay-only (`016_notification_producer_cursor.sql:1`); preserve that fixed-owner contract and validate upstream scope. Add a scope column only if this existing owner is intentionally generalized, not for a second source-selection mechanism. | New `services/main/tests/notification-stream-position.test.ts`; existing `services/main/tests/notification-producer.test.ts`, `tests/qa/integration/notification-producer-log.test.ts`, `notification-producers.test.ts`. Equal numbers in two streams produce only Main notices; wrong scope denies; partial/lost-ack/retry retains exact cursor. C3/SYS04 contribution. Native **no**, migration **none** for the existing fixed Main owner. |


| A5 / M | `modules/zone-browse/store.ts:125-143,158-208,218-220`, `zone-modules/browse.ts:247-291`: `observed` starts as a graph cut then advances with scoped relay numbers. Keep those cuts separate; filter every batch/event by Main scope and use stream coverage for ready/current. Preserve adoption-order keys as historical evidence pending B1/order decision. | New `services/main/tests/zone-browse-stream-position.test.ts`; existing `services/main/tests/zone-browse.test.ts`, `tests/qa/integration/g-828-zone-browse.test.ts`. Divergent diagnostics do not leave ready stuck; relevant missing batch still prevents readiness; foreign same-number rows never advance. C3; native **no**, migration **none** for process-local cuts. |
| A6 / M | `modules/work/serial-projection.ts:248-281,474-499`; callers `work/summary-serial.ts:28-29`, `search/result-cards.ts:52-53`, `library/stats.ts:82`, `zone-modules/browse.ts:213`, `work/read-header.ts:64-65`: all SQL source positions must be scoped; never compare materialized relay sequence with graphSequence. Preserve already-local header behavior and graph disclosure fences. | New `services/main/tests/serial-stream-position.test.ts`; existing `services/main/tests/serial-projection.test.ts`, `tests/qa/integration/work-serial-projection.test.ts`. Completed projection returns statistics after graph-only diagnostic advance; actual stream gap yields unknown; a foreign batch neither contaminates nor stalls it. C3; native **no**, fixed Main-owned checkpoint needs no migration. |
| A7 / M | `modules/recommendation/ranking.ts:131-134,373-393`: filter head/batches/events by the declared Main stream; carry that domain in typed input/coverage comparisons. Keep immutable old input manifests readable as the explicitly fixed legacy Main owner, rather than rewriting their JSON. | New `services/main/tests/ranking-stream-position.test.ts`; existing `tests/qa/integration/ranking-progress.test.ts`, `public-ranking-target-receipts.test.ts`. Foreign batch with same epoch/sequence cannot inflate counts, poison generation or create apparent gap; local contiguous replay/recovery unchanged. C3; native **no**. Scope metadata can use existing input manifest; no demonstrated mandatory SQL migration. |
| A8 / M | `modules/rankings/realm-threads.ts:138,159-168,197-204,322-354` and Feed caller `store.ts`/`refresh.ts`: keep Main and Content stream checkpoints distinct; filter relay event SQL by Main scope; stop comparing relay-derived checkpoint with graph diagnostic at read admission. Permanent history boundary is C25b and must remain intact. | New `services/main/tests/realm-ranking-stream-position.test.ts`; existing `services/main/tests/realm-thread-continuation.test.ts`, `tests/qa/integration/realm-thread-continuation.test.ts`, `feed-read-stability.test.ts`. Same-number foreign streams never enter rank population; unrelated graph diagnostics preserve completed current population; relevant pending effects and Content/graph recovery still refuse. C3; native **no**. Fixed-owner cursor can retain old column; add scope only if its owner contract permits other streams. |

The A class is **positions must carry their comparison domain**. Its API jobs
are relay delivery, Feed ready status, Discover enrollment and notification
production; the UI consequences are Home/Discover/Zone browse remaining indexing, unknown
serial statistics, stalled rankings and wrong or stalled notices. This is static inference, not an observed UI journey.
Use `compareRelayPositions` and typed stream positions in the changed interfaces
as the prevention guard. The audit also inspected Event's scoped SQL source, erasure custody's scoped joins
(`modules/erasure/custody.ts:75-86`), owner-gap recovery and notification consumers; a naked numeric field is not
itself grounds for changing a correctly fixed owner stream.

### C: convergence after opening

All paths below with `modules/` retain the abbreviation above. “Native yes”
means the change must be qualified in a built native image; related slices may
share one image activation. It is not a request to build one image per row.

| Item / size | Files:lines and concrete change | Existing/new proof; acceptance; native |
| --- | --- | --- |
| C01 / M | `CommandInvariant.java:243,268-275,459-483`, `CommandPolicy.java:285-289`; command compiler/builders identified in writer waves below. Replace global caller correctness basis with existing affected local heads/dependencies; preserve lineage, operation identity and existing Main allocator. Foundation must support old callers during bounded cutover; do not introduce a second command authority. | Existing `CommandInvariantRelayStreamTest.java:44,65,79,111`, `SlimCommandTest.java:124,178,228`; new `LocalCommandConsistencyTest.java`. C3, no named red case established. Native **yes**. |
| C02 / M | `CommandService.java:1388-1394,1465-1467,1572-1574`; `modules/content-publication/publish.ts`, `eligibility.ts`, `projection/command.ts`: validate exact operation/receipt/revision/local head instead of CONTROL sequence. Keep signature evidence. | Existing `SearchDeltaJournalTest.java:755,808,840,896`, `tests/qa/integration/content-publication-native.test.ts`; new `ContentLocalPoststateTest.java`. C3; preserve WORK09/WORK10/SEARCH03/SEARCH19. Native **yes**. |
| C03 / M | `CommandInvariant.java:257-262`, `MetadataRestorePolicy.java:122-135`; `modules/work/reconcile-slim-metadata.ts` paired cursor. Remove diagnostic monotonicity **only for stream-qualified recovery**; preserve exact source evidence and half-pair denial. | Existing `MetadataRestoreTest.java:293,325,351`, `SlimCommandTest.java:178`; add equal/regressing diagnostics in distinct local scopes. C3/OPS03 contribution. Native **yes**. |
| C04 / M | `StatementRestorePolicy.java:89-94,184,210`, `StatementUpgradePolicy.java:337-344`; `modules/statement/populated-conversion.ts:166-264`, `work/reconcile-restored.ts` Statement path: explicit retained-stream continuity where evidence exists; retain old anchors/provenance. Do not assign missing legacy scope from numeric coincidence. | Existing `StatementUpgradeTest.java:253,269,288,319,342`, `ErasureRestorePolicyTest.java:174,270,309,322`, `tests/qa/integration/classification-restore.test.ts`; new `services/main/tests/statement-restore-stream-basis.test.ts`. C3/OPS03; native **yes**. Legacy interpretation unresolved. |
| C05 / S | `modules/work/read-session.ts:61-133,297-331,392-403`: make cursor basis alternatives explicit in types; keep local capture/refence and epoch semantics. Convert no family by blanket sequence relaxation. | Existing `services/main/tests/read-basis.test.ts`, `local-read-basis.test.ts`; new `local-cursor-basis.test.ts`. C3; native **no**, migration **none**. |
| C06 / S | `modules/work/search-continuation.ts:95-127`, `search-public.ts`, `search-presentation.ts`; schema `api-contract.ts:165-174`: selected complete relation/presentation digest instead of graph diagnostic equality, retaining index instance/generation/epoch and fixed TTL. | New `services/main/tests/search-local-continuation.test.ts`; existing `services/main/tests/search-card-reads.test.ts`. C3/SEARCH08 paging contribution; native **no** if bounded complete relation provides all dependencies. |
| C07 / M | `modules/search-disclosure/private-continuation.ts:4-13,62-69`, `contribution/search-private.ts`, `content-publication/search-private.ts`: selected source/result dependencies; retain live disclosure/erasure frontier and authority checks. | Existing `services/main/tests/search-private-continuation.test.ts`; new `private-search-local-basis.test.ts`. C3/SEARCH16; native **conditional** on missing selected-dependency production, not on token encoding. |
| C08 / S | `modules/content-publication/search-continuation.ts:44-88`, `search.ts:285-292`; `api-contract.ts:175-181`: distinguish Content stream/index basis from graph dependencies, keep first-page expiry. | New `services/main/tests/content-search-local-continuation.test.ts`; existing `services/content/tests/content-eligibility-ingestion.test.ts`, `tests/qa/integration/content-publication-native.test.ts`. C3/SEARCH19 contribution; native **no** after C02. |
| C09 / M | `modules/graph-query/query.ts:233,380,424-449`, `statements.ts:50`, `schema.ts:90-125,162,203`: owner relation-membership and selected revision basis, not global query head; explicit old-token restart. | Existing `tests/qa/integration/graph-query-cases.test.ts`; new `services/main/tests/graph-query-local-continuation.test.ts`. C3; native **conditional** on needed bounded membership support. |
| C10 / M | `modules/semantic/generation-guard.ts:76-96`, native validation/profile registry: define selected immutable profile/shape/source dependency verification through **existing model owner**, preserving historical generation. Exact dependency list must come from validation, not another generation singleton. | New `services/main/tests/selected-model-dependency.test.ts`; existing `model-generation-refusal.test.ts`, `model/tests/native-equivalence.test.ts`. C3; retain MODEL constraints. Native **yes**. Design input §10 unavailable; not dispatch-ready until exact selected-dependency contract is settled. |
| C11 / M | `modules/semantic/staging.ts:300-332,449-451,527-558,636-642`, `admitted.ts:115`, `change.ts:516-536`; persist selected dependency manifest in existing Content stage; validate same dependencies at commit. Preserve old generation evidence. | Existing `tests/qa/fault-recovery/semantic-stage.test.ts`, `tests/qa/integration/semantic-generation.test.ts`, `services/main/tests/model-generation-refusal.test.ts`; new `semantic-stage-local-basis.test.ts`. C3/MODEL21/MODEL22; native **yes** via C10. One additive Content migration if current manifest cannot hold dependency evidence. |
| C12 / M | `modules/context/rule.ts:111-144,261,325,361,386`: bind selected Context/semantic/rule dependencies from C10, rather than all-model head; preserve exact rule-generation hashing inputs for legacy identity. | New `services/main/tests/context-rule-local-model-basis.test.ts`; existing `services/main/tests/local-read-basis.test.ts`, `tests/qa/integration/semantic-generation.test.ts`. C3; native **no** after C10. |
| C13 / S | `modules/lexicon/change.ts:293-318`, `catalog.ts`, `render.ts`: selected definition/presentation basis; retain exact old pins. | New `services/main/tests/lexicon-local-model-basis.test.ts`; existing model refusal file. C3; native **no** after C10. |
| C14 / M | `modules/rating/question-presentation.ts:347,388-428`: selected question/context/presentation basis at preparation and native apply; unrelated profile change must not refuse. | New `services/main/tests/rating-presentation-local-model-basis.test.ts`; existing `model/tests/rating-release-turtle.test.ts`, Main model refusal file. C3; native **no** after C10. |
| C15 / S | `modules/relation/change.ts:454`, semantic guard sites; `schema.ts:60`: selected relation/profile dependency, retaining historical model pin. | New `services/main/tests/relation-local-model-basis.test.ts`; existing model refusal file. C3; native **no** after C10. |
| C16 / M | `modules/realm-directory/index.ts:64-85,121,197-200,225-268`, `source.ts`: separate scoped coverage from local membership revision; bounded rebuild and partial activation. | Existing `services/main/tests/realm-directory.test.ts`, `tests/qa/integration/realm-directory.test.ts`; new `realm-directory-local-position.test.ts`. C3; native **no**. One additive Access migration if two basis fields required. |
| C17 / M | `modules/discovery/store.ts:350-368,499-565`, `refresh-store.ts:400-461`, `changes.ts:51-59`; after A3, separate original graph-cut evidence, stream delta coverage and relevant dependency/membership revision. Keep old immutable generation rows readable and invalidate/rebuild derivatives under the owner. | Existing `services/main/tests/read-basis-discovery.test.ts`, `tests/qa/integration/discovery-read-isolation.test.ts`, `discovery-continuous-writes.test.ts`; new `discovery-local-coverage.test.ts`. C3; native **no**. One additive Access migration for explicit coverage basis if current fields conflate it. |
| C18 / M | `modules/also-enjoyed/store.ts:134-141,205,404,421-446`, `read.ts:149-245`, `recommendation/derived-generation.ts:206`: exact owner input vector plus local recommendation membership, preserve original activation input-position JSON. | Existing `services/main/tests/also-enjoyed-contract.test.ts`, `tests/qa/integration/recommendation-generation.test.ts`, `also-enjoyed-continuous-writes.test.ts`; new `also-enjoyed-local-basis.test.ts`. C3; native **no**. One additive generation-basis migration if needed. |
| C19 / M | `modules/source/native-work-adoption.ts:357-362,600-602,651-658`, `native-work-proposal.ts:35-53,94`: replace global “later” with the source owner's observation/conversion lineage and exact applied head. Use existing retained observation identity; do not add another title-decision owner. | Existing `tests/qa/integration/source-adoption-language.test.ts`, `services/main/tests/g-1035-native-work.test.ts`; new `source-title-local-chronology.test.ts`. C3; native **conditional** on owner command guard changes. Missing source-lineage proof must refuse, not use sequence fallback. |
| C20 / M | `modules/source/author-credit.ts:129-130,239-277`, `reconcile-author-credit.ts:79`: same-source observation lineage, exact credit application identity and idempotent recovery. | Existing `tests/qa/integration/source-author-credit.test.ts`, `tests/qa/fault-recovery/source-author-credit.test.ts`; new `source-credit-local-chronology.test.ts`. C3; preserve LIVE04/MODEL05/MODEL06. Native **conditional** on changed guard. |
| C21 / M | `modules/source/child-native-support.ts:130-131,258-294`, `child-recovery.ts:143`: local child application head plus source lineage; preserve old immutable child proof. | Existing `tests/qa/integration/source-support-child-attach.test.ts`; new `source-child-local-chronology.test.ts`. C3; native **conditional** on changed guard. |
| C22 / S | `modules/source/field-application.ts:148`, `support-attach.ts:246`, Content field-support proof reader: remove any current-global-position check, retain exact historical receipt equality and selected source observation. | Existing `tests/qa/integration/source-field.test.ts`, `source-field-child.test.ts`; new `source-field-local-basis.test.ts`. C3; native **no** unless a native guard is changed. Do not invent a new proof format if identity suffices. |
| C23 / M | `modules/structure/read.ts:382-387`, `seal-read.ts:79`, `release`/`realization` paging callers in census: exact local generation/revision plus membership/order token; keep stage receipt proof. | Existing `services/main/tests/structure-group-seek.test.ts`, `tests/qa/integration/structure-stage.test.ts`; new `structure-local-continuation.test.ts`. C3; preserve COMP03/COMP04. Native **conditional** on selected membership token support. |
| C24 / two M sessions | `modules/library/read.ts:108-150` and `wiki/history-read.ts:87`: Library ordering/membership and Wiki composite summary dependencies need separate capability fences. Profiles library/credits and Contribution history preserve exact receipt evidence; no independent global-order decision established there, so do not automatically convert them. | New `services/main/tests/library-local-continuation.test.ts`, `wiki-history-local-basis.test.ts`; existing `services/main/tests/content-revision-read.integration.test.ts`, `revision-read.test.ts`. C3; native **no** if exact immutable history membership suffices. Dispatch the two subitems below separately. |
| C25 / four M sessions | `modules/realm-reply/thread-read.ts`, `realm-admin/history.ts`, `zone-modules/browse.ts`, `zone-browse/store.ts`: distinguish retained Access membership from graph hydration and permanent admission boundary. Preserve already-retained Home/Realm semantics. | Existing `services/main/tests/realm-thread-continuation.test.ts`, `tests/qa/integration/feed-read-stability.test.ts`; new `realm-zone-local-basis.test.ts`, `realm-history-stream-boundary.test.ts`. C3; native **no**. Permanent admission cut may need one additive Access migration; this owner decision must be established before dispatch. |
| C26 / M | `modules/export/store.ts:151-158`, `readers.ts:92,323,356,404,459-481`, `scoped.ts:104-134,188-234`: preserve exact retained revision/receipt manifest; separate live delivery dependency fence from historical pins. | Existing `services/main/tests/export-scoped.test.ts`, `tests/qa/integration/export-scoped-dependencies.test.ts`; new `export-local-read-basis.test.ts`. C3; native **no** unless native retained-read support changes. |
| C27 / M | `modules/work/restore-lineage.ts:298-405,489-534`, `scripts/ops/restore.ts:218-224,397,420-422`, `recovery-set.ts:104`: retain original signed backup format; use existing paired Main stream cut for future ordering, preserve graph diagnostic and physical held-cut safety. | Existing `scripts/ops/tests/g-727-recovery-set.test.ts`, `tests/qa/fault-recovery/g-727-recovery-set.test.ts`; new `restore-local-stream-cut.test.ts`. C3/OPS03/OPS10 contribution; native **yes** only if native cutover contract changes. No mandatory manifest-version migration. |
| C28 / S | `scripts/datasets/model-bootstrap.ts:120,147,158-175,211-213,316`; translate local fixture bootstrap to C10's model basis and existing stream owner. Align diagnostic expectations without resetting retained user data. | Existing `tests/qa/unit/dataset-model-bootstrap.test.ts:52,68-80`; new assertions for unchanged unrelated dependencies. C3; native **no** after foundations. |

**C24/C25 are parent slots, split before dispatch.** Each subitem is one M
session, with the corresponding parent proof matrix, C3 contribution,
Mechanisms none new, and native no unless its bounded owner basis is unavailable.
The census supplies all matching sites; these are the decision/writer anchors:

| Subitem | Files:lines, change and exact new test |
| --- | --- |
| C24a Library | `modules/library/read.ts:108-150`, local membership/changed-order basis; new `services/main/tests/library-local-continuation.test.ts`; existing `services/main/tests/revision-read.test.ts`. |
| C24b Wiki history | `modules/wiki/history-read.ts:87` and its existing reading boundary: capture/refence selected summary/disclosure dependencies instead of global summary generation; new `services/main/tests/wiki-history-local-basis.test.ts`; existing `services/main/tests/g-920-wiki-readers.test.ts`. |
| C25a Realm thread hydration | `modules/realm-reply/thread-read.ts:206,309-314,340-343,490-497,570-598`: keep retained Access membership and replace global hydration fence with selected rows/current disclosure; new `services/main/tests/realm-thread-local-hydration.test.ts`; existing `services/main/tests/realm-thread-continuation.test.ts`. |
| C25b Realm history admission | `modules/realm-admin/history.ts:26-36,64-67,132-133`, `services/main/migrations/access/1000_space_visibility.sql:17-26`: preserve permanent old admission boundary; define explicit same-owner history stream cut before new writer switches. New `services/main/tests/realm-history-stream-boundary.test.ts`; existing `tests/qa/integration/feed-read-stability.test.ts`. Owner mapping and migration necessity remain unresolved; not dispatch-ready. |
| C25c Zone browse ordering | `modules/zone-browse/store.ts:73-106`: selection order currently derives from sequence plus restore-epoch rank; choose documented owner chronology after §10/B1, retain existing order evidence or rebuild derivative. New `services/main/tests/zone-browse-local-order.test.ts`; existing `services/main/tests/zone-browse.test.ts`. Native no. Product ordering decision unavailable; not dispatch-ready. |
| C25d Zone module paging | `modules/zone-modules/browse.ts:247-330`: after A5/A6, local membership/order basis and current disclosure; new `services/main/tests/zone-module-local-continuation.test.ts`; existing `tests/qa/integration/g-828-zone-browse.test.ts`. |

This adds four sessions over C24/C25's two table slots. No new profile or
Contribution history format is justified merely by its historical proof fields.

**B1: public-name browse chronology needs a product decision**, not a guessed
implementation. `PublicNameProjection.java:1033-1046` computes created/updated
directory order from global sequence. Existing names/seek metadata is rebuildable;
user facts need not be rewritten. Establish from §10 whether creation order is
an immutable event time/identity, an owner stream key, or merely a presentation
order. Test equal positions from different scopes, deterministic ties, insertion
and paging. Existing `PublicNameProjectionTest.java` and
`WorkNameScopeBasisTest.java`; proposed `PublicNameLocalOrderTest.java`; C3,
native **yes** if native projection changes. This is not dispatch-ready and is
excluded from the definite session count.

## What deferring actually costs

| Kind | Added cost of opening first |
| --- | --- |
| Signed graph/owner receipts, exact payload objects, generation custody | **No demonstrated new durable dual-reader**, provided old fields retain their historical meaning. They already contain exact operation/revision/profile references. If the maintainer instead deletes evidence fields, that is a separate versioned-format project. |
| Scoped Main relay | One existing legacy-prefix reader; not a new opening-dependent reader. Removing it requires proof all retained unscoped batches are covered or retired, including independent backups, not a guess based on latest head. |
| Encrypted cursors | Restart-only compatibility; no persisted migration. |
| Public search tokens | Explicit restart, or old decoder for remaining fixed expiry, at most five minutes. Graph-query expiry is not established; explicitly restart those tokens unless its owner defines a retention promise. |
| Derived SQL projections/index directories | More data to rebuild/replay after opening. One cutover per changed owner/generation, with readiness held until scoped coverage is complete. The amount is population-dependent; no workload measurement was performed, so hours/bytes are unknown. |
| Source chronology / permanent Realm history boundary | New user records enlarge retained evidence that must still be interpreted correctly. Existing source observation and admission identity may avoid format change; complete lineage coverage was not established. A future new format would require legacy interpretation, not a blind sequence rewrite. |
| Independently retained backups | Old manifest reader/diagnostics must remain until retention ends. Opening is not the trigger: pre-opening recovery sets already create that obligation. |

**Smallest supported pre-opening slice that avoids deferral cost:** preserve
existing exact evidence formats and finish scoped-position consumers A1–A8,
in order **A1 → A2/A3 → A4 → A5/A6 → A7/A8** (separate consumers can run
independently once the typed stream comparison contract is explicit). Eight sessions, **1 S + 7 M**, no native image,
no mandatory migration for fixed-owner scope binding; A3 may depend on a
coverage-column migration.
This fixes demonstrated class-level mistakes without creating a speculative
durable compatibility mechanism. It does **not** finish C3. There is no established
need to pre-open a new receipt format to avoid mandatory dual reads later.

If the maintainer chooses strict removal of the global counter as well, run
consumer/dependency foundations first, then the writer waves below, then retire
the native global guard only when all producers have moved. Keep one command
executor and one existing stream allocator throughout. Recovery/custody readers
must accept the old immutable evidence before any producer switches. A native
image activation joins the shared foundation and changed callers; do not activate
a native-only cut that strands unchanged raw builders.

## Size and evidence needed before committing to a full pre-opening convergence

The reference census is a reproducible **inventory**, not a touched-file estimate.
It covers direct RDF references, indirect graph-position fields, model pins,
scoped stream fields and ordinary/maintenance fences. The writer waves are a
bounded candidate plan for **strict counter retirement**, additional to semantic
consumer convergence. Per-wave changes/tests/Mechanisms/native requirements
follow below. None is an authorization to rewrite historical evidence.

Numbers and exclusions are calculated after the census below. Estimates are
session planning, not measured delivery time. A precise complete-C3 file count,
migration count or one scalar completion time cannot be established from the
present evidence: §10 is absent, selected-profile dependency capture is unsettled,
public browse order is undecided, and the remaining cursor/history owners need
their capability-specific split. The report gives a concrete backlog and its
count rather than multiplying “200 references” by an invented editing rate.

Before accepting a complete-convergence estimate, obtain §10, settle C10/B1,
decide the permanent Realm history boundary, audit the already-local cursor
exceptions, and prove mixed diagnostic/stream counterexamples in A1–A8. These
facts can remove candidate waves or require extra owner-local work. Preserve
pre-opening data unless the maintainer separately authorizes its disposal.

## Strict-counter writer waves (C; optional after consumer convergence)

Each wave is one M planning session, with at most four raw builders; the large
Work restore file is its own session. These are necessary candidate edits only
if retiring the global allocator/guard, not merely preserving historical diagnostics.
The matched line starts the DELETE/INSERT template; following clauses write
control, revision, receipt and batch coordinates. Retain original proof fields
and operation IDs; replace correctness guards with existing local head CAS
and the C01 contract, and allocate delivery through the existing Main stream.
Cancel/replay/rollback/refusal branches must share the same basis. No bulk rewrite.

Every wave needs **Mechanisms: none new; existing command executor, native local
CAS and Main stream**. **Native image: yes for the shared C01 activation**; no
independent native feature per builder. **Acceptance: C3**, plus preserve its
domain contracts. **Migrations: none for template conversion alone**. Proof uses
`services/main/tests/local-read-basis.test.ts` and
`services/main/tests/outbox.integration.test.ts` as shared contract anchors, plus
one new capability-specific file named below; implementation must add the
wave's cases there, not run unrelated whole tiers. Cover denied/stale/concurrent
same-head edits, unrelated-head progress, zero-event/cancel batches, uncertain
response replay, and no skipped stream position. Held reconciliation additionally
uses the metadata/Statement restore fixtures named in C03/C04.

| Wave / session | Exact builder files:template lines | New proof file |
| --- | --- | --- |
| W01 / M | `services/main/src/infrastructure/invalid-receipt.ts:27`; `services/main/src/modules/address/migrate.ts:502`; `services/main/src/modules/agent/graph.ts:65,125`; `services/main/src/modules/agent/profile.ts:214` | `services/main/tests/command-invalid-receipt-local-command.test.ts` |
| W02 / M | `services/main/src/modules/catalogue-intake/verification.ts:46`; `services/main/src/modules/classification/context.ts:144,237`; `services/main/src/modules/classification/decision.ts:171`; `services/main/src/modules/classification/global.ts:53` | `services/main/tests/catalogue-intake-verification-local-command.test.ts` |
| W03 / M | `services/main/src/modules/classification/proposition.ts:140,229`; `services/main/src/modules/classification/vocabulary.ts:275`; `services/main/src/modules/collection/dynamic.ts:162`; `services/main/src/modules/collection/names.ts:104` | `services/main/tests/classification-proposition-local-command.test.ts` |
| W04 / M | `services/main/src/modules/content-publication/eligibility.ts:320,371`; `services/main/src/modules/content-publication/publish.ts:190,263`; `services/main/src/modules/content-publication/rebuild.ts:232`; `services/main/src/modules/content-publication/relay.ts:192` | `services/main/tests/content-publication-eligibility-local-command.test.ts` |
| W05 / M | `services/main/src/modules/content-publication/search-private-projection.ts:74`; `services/main/src/modules/context/command.ts:160,208`; `services/main/src/modules/contribution/draft.ts:223,303`; `services/main/src/modules/contribution/edit.ts:133,180,263` | `services/main/tests/content-publication-search-private-projection-local-command.test.ts` |
| W06 / M | `services/main/src/modules/contribution/publish.ts:166,216,328`; `services/main/src/modules/erasure/graph.ts:164`; `services/main/src/modules/event/observation.ts:148,276`; `services/main/src/modules/governance/effects.ts:255` | `services/main/tests/contribution-publish-local-command.test.ts` |
| W07 / M | `services/main/src/modules/package/release-recommendation.ts:161,241`; `services/main/src/modules/post/backfill.ts:102`; `services/main/src/modules/profiles/credits.ts:75`; `services/main/src/modules/proposal/graph.ts:119` | `services/main/tests/package-release-recommendation-local-command.test.ts` |
| W08 / M | `services/main/src/modules/protection/work.ts:171,232,304,433`; `services/main/src/modules/rating/context.ts:161,242`; `services/main/src/modules/rating/global.ts:109,264,350`; `services/main/src/modules/rating/observation.ts:320,443` | `services/main/tests/protection-work-local-command.test.ts` |
| W09 / M | `services/main/src/modules/rating/policy.ts:242,314`; `services/main/src/modules/rating/release.ts:129,520`; `services/main/src/modules/rating/target.ts:315,435`; `services/main/src/modules/realization/command.ts:105` | `services/main/tests/rating-policy-local-command.test.ts` |
| W10 / M | `services/main/src/modules/realm-profile/commands.ts:97,253,348`; `services/main/src/modules/realm-reply/graph.ts:92,126,275`; `services/main/src/modules/realm-submission/graph.ts:78`; `services/main/src/modules/release/command.ts:147` | `services/main/tests/realm-profile-commands-local-command.test.ts` |
| W11 / M | `services/main/src/modules/rights/offering.ts:179,243,313`; `services/main/src/modules/search/name-preferences.ts:66`; `services/main/src/modules/search/names.ts:77,129,195`; `services/main/src/modules/semantic/command.ts:150,176,217,324` | `services/main/tests/rights-offering-local-command.test.ts` |
| W12 / M | `services/main/src/modules/semantic/staging.ts:490`; `services/main/src/modules/source/child-native.ts:117`; `services/main/src/modules/source/child-retirement.ts:98`; `services/main/src/modules/source/field-control-native.ts:157` | `services/main/tests/semantic-staging-local-command.test.ts` |
| W13 / M | `services/main/src/modules/source/graph-projection.ts:85`; `services/main/src/modules/space/create-zone.ts:127`; `services/main/src/modules/space/create.ts:223,306`; `services/main/src/modules/space/policy.ts:113,198` | `services/main/tests/source-graph-projection-local-command.test.ts` |
| W14 / M | `services/main/src/modules/structure/change.ts:391,467,613,724,1596,1723,1842,1884,2285`; `services/main/src/modules/structure/label-index-backfill.ts:80`; `services/main/src/modules/theme/activation.ts:232,277`; `services/main/src/modules/theme/first-party-lifecycle.ts:364` | `services/main/tests/structure-change-local-command.test.ts` |
| W15 / M | `services/main/src/modules/verification/graph.ts:137,190`; `services/main/src/modules/vote/graph.ts:129,176`; `services/main/src/modules/web-publication/command.ts:120,365`; `services/main/src/modules/work/activate.ts:298` | `services/main/tests/verification-graph-local-command.test.ts` |
| W16 / M | `services/main/src/modules/work/author-credit-retirement.ts:115`; `services/main/src/modules/work/author-credit.ts:175`; `services/main/src/modules/work/catalogue-import.ts:201,228`; `services/main/src/modules/work/command-envelope.ts:73` | `services/main/tests/work-author-credit-retirement-local-command.test.ts` |
| W17 / M | `services/main/src/modules/work/derivations.ts:147,389`; `services/main/src/modules/work/edit.ts:151,203,354`; `services/main/src/modules/work/fixed-release.ts:194,318`; `services/main/src/modules/work/merge-command.ts:35` | `services/main/tests/work-derivations-local-command.test.ts` |
| W18 / M | `services/main/src/modules/work/metadata-command.ts:140,313`; `services/main/src/modules/work/reject-realm.ts:169,288`; `services/main/src/modules/work/seal.ts:37`; `services/main/src/modules/work/select-main.ts:164,319` | `services/main/tests/work-metadata-command-local-command.test.ts` |
| W19 / M | `services/main/src/modules/work/select-realm.ts:195,368`; `services/main/src/modules/work/title-control.ts:636,711`; `services/main/src/modules/work/translation-links.ts:227`; `services/main/src/modules/zone/configuration.ts:645` | `services/main/tests/work-select-realm-local-command.test.ts` |
| W20 / M | `services/main/src/modules/zone/owner-create.ts:131`; `services/main/src/modules/zone/realm-attachment-withdrawal.ts:62,116` | `services/main/tests/zone-owner-create-local-command.test.ts` |
| W21 / M | `services/main/src/modules/work/reconcile-restored.ts:649` | `services/main/tests/work-reconcile-restored-local-command.test.ts` |

## File-and-line reference census

Keys: **Q** RDF/native sequence reference; **G** generation pin/head/guard;
**P** graph/source position, SQL proof/input position or sequence consumer;
**S** explicitly scoped stream or relay position; **F** quiescence/physical-version
reference; **D** broad SQL sequence/position declaration or function (includes
already-local owner counters). **W** marks a raw-template mutation candidate.
Model definitions are evidence constraints; SQL declarations show where values
can persist; TS/Java may write or consume them. Read the per-kind classification
above before treating any reference as a change. This appendix intentionally
keeps false-positive candidates visible, rather than dropping indirect consumers.
It does not assert every D/P occurrence is global. Tests/generated artifacts,
docs and temporary files are excluded. Native string literals are included because
they do not spell `rv:sequence`. No match line is sampled or elided.

Coverage limits: dynamically constructed predicates, JSON positions stored under
other names, generated templates and lifecycle wiring may lack these spellings.
No runtime data/backup inventory or population scan was performed. Thus “every
persisted row” or a proof of complete dependency coverage is not claimed. The
listed static paths plus named owner acceptance are the reproducible evidence.
Full closure needs compiler/native writer coverage and the §10 contract, not a
larger lexical count.

Reproduction selectors (all tracked TS/TSX/Java/Turtle/SQL under services,
packages, infra, model, scripts and apps; exclude test/tests/generated path
components, `*.test.*` and `*.stories.*`):

```text
Q = rv:sequence (plus native Java literal "sequence")
G = modelGeneration|model_generation|modelGenerationHeadGuard|assertModelGenerationCurrent|generationHead
P = graph_sequence|graphSequence|graphPosition|sourcePosition|position\.sequence|source_sequence|sourceSequence|graph_data_epoch|beforePosition|afterPosition|pinned_sequence|checkpoint_sequence|input_positions|owner_positions
S = streamSequence|stream_scope|streamScope|relayPosition|MAIN_RELAY_STREAM_SCOPE|relay_sequence
F = quiescen|\bdataVersion\b|\bgetDataVersion\b|\bscopeVersion\b (case insensitive)
D = \b\w*sequence\b|\b\w*position\w*\b (SQL, case insensitive)
W = DELETE\s*\{[^;]{0,500}rv:sequence (Main source, multiline search)
```

Census: **693 unique source/schema files**, roots apps 36, infra 12, model 56, packages 1, scripts 13, services 575.
Overlapping kind counts: Q 274, G 34, P 419, S 31, F 5, D 135.
Of these: **12 production native files**, **136 SQL files**, **56 authored Turtle definitions**.
Raw template mutation candidates: **79 files**; split into **21 M waves**.

| File | Matching lines by kind | Role boundary |
| --- | --- | --- |
| `apps/web/features/author/fixtures.ts` | P: 35,120 | writer/reader reference; classified by kind above |
| `apps/web/features/catalogue/reader-store.ts` | P: 19,35,212,332 | writer/reader reference; classified by kind above |
| `apps/web/features/concept/concept-works.tsx` | P: 102 | writer/reader reference; classified by kind above |
| `apps/web/features/concept/fixtures.ts` | P: 46,82 | writer/reader reference; classified by kind above |
| `apps/web/features/discover/api.ts` | P: 46 | writer/reader reference; classified by kind above |
| `apps/web/features/discover/fixtures.ts` | P: 55 | writer/reader reference; classified by kind above |
| `apps/web/features/discover/query-read.ts` | P: 41 | writer/reader reference; classified by kind above |
| `apps/web/features/discover/query.ts` | P: 36 | writer/reader reference; classified by kind above |
| `apps/web/features/entity-page/fixtures.ts` | P: 14,55,60,83,117 | writer/reader reference; classified by kind above |
| `apps/web/features/entity-page/identity-fixtures.ts` | P: 123 | writer/reader reference; classified by kind above |
| `apps/web/features/feed/feed-list.tsx` | P: 142,168,169,174,175,187,194 | writer/reader reference; classified by kind above |
| `apps/web/features/feed/fixtures.ts` | P: 191 | writer/reader reference; classified by kind above |
| `apps/web/features/feed/projection.ts` | P: 11,53 | writer/reader reference; classified by kind above |
| `apps/web/features/feed/thread-fixtures.ts` | P: 77 | writer/reader reference; classified by kind above |
| `apps/web/features/library/fixtures.ts` | P: 169 | writer/reader reference; classified by kind above |
| `apps/web/features/manage/fixtures.ts` | P: 115,166,198,259,262 | writer/reader reference; classified by kind above |
| `apps/web/features/manage/settings-fixtures.ts` | P: 30 | writer/reader reference; classified by kind above |
| `apps/web/features/onboarding/welcome-fixtures.ts` | P: 19 | writer/reader reference; classified by kind above |
| `apps/web/features/profile/fixtures.ts` | P: 26,57,65,68 | writer/reader reference; classified by kind above |
| `apps/web/features/saved-filter/fixtures.ts` | P: 140 | writer/reader reference; classified by kind above |
| `apps/web/features/scoped-rating/fixtures.ts` | P: 15,112,200 | writer/reader reference; classified by kind above |
| `apps/web/features/search/read.ts` | P: 103 | writer/reader reference; classified by kind above |
| `apps/web/features/studio/content-api.ts` | P: 106,442 | writer/reader reference; classified by kind above |
| `apps/web/features/studio/fixtures.ts` | P: 50,60,99,109,115,128,139,234,242,275,283,301,317,322,355,367,389,404,426,430,439 | writer/reader reference; classified by kind above |
| `apps/web/features/studio/read.ts` | P: 724,747 | writer/reader reference; classified by kind above |
| `apps/web/features/tracking/fixtures.ts` | P: 84 | writer/reader reference; classified by kind above |
| `apps/web/features/work-levels/fixtures.ts` | P: 38,44,77,89,112 | writer/reader reference; classified by kind above |
| `apps/web/features/work-page/fixtures.ts` | P: 13,15,46,129,171,175,178,217,237,238,241,243,250,305 | writer/reader reference; classified by kind above |
| `apps/web/features/work-page/hub-fixtures.ts` | P: 29 | writer/reader reference; classified by kind above |
| `apps/web/features/work-page/reader-client.tsx` | P: 10,333 | writer/reader reference; classified by kind above |
| `apps/web/features/work-page/reader-settings.ts` | P: 58 | writer/reader reference; classified by kind above |
| `apps/web/features/work-page/record.tsx` | P: 69 | writer/reader reference; classified by kind above |
| `apps/web/features/work-page/types.ts` | P: 16 | writer/reader reference; classified by kind above |
| `apps/web/features/work/work-detail.tsx` | P: 19,71 | writer/reader reference; classified by kind above |
| `apps/web/features/zone-editor/api.ts` | P: 102 | writer/reader reference; classified by kind above |
| `apps/web/features/zone-editor/model.ts` | P: 323 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/BindingPolicy.java` | Q: 397 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/CommandInvariant.java` | Q: 83,120,138,177,197,304,318,341,354,356,366,375,385,394,464,482; P: 284,290; S: 44,61,75,76,87,100,101,103,104,112,121,126,129,139,402,416 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/CommandPolicy.java` | Q: 289; S: 89 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java` | Q: 212,884,885,1389,1391,1404,1466,1476,1573,1582,1667,1669; P: 1389,1392,1393; S: 212,371,470,491,520,892,893,894,895,904 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/ErasureRestorePolicy.java` | Q: 136,147,153 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/MetadataRestorePolicy.java` | Q: 39,138,166; P: 40,104 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/PublicNameProjection.java` | Q: 1034 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SearchDeltaJournal.java` | Q: 58,597,1006,1012; P: 391,846,1012 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/SemanticSourceBasis.java` | Q: 44,221,404,432,480,494,503,569; G: 43,198,218; P: 199; F: 545,564 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/StatementRestorePolicy.java` | Q: 30,38,61,62,89,150,162,184 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/StatementUpgradePolicy.java` | Q: 40,44,69,107,130,152,211,259,377 | writer/reader reference; classified by kind above |
| `infra/jena/command-module/src/main/java/com/rezics/jena/TemplateIndexService.java` | Q: 230,356,365,369,370,376,381,397,825,826,829,832; F: 497,648 | writer/reader reference; classified by kind above |
| `model/definitions/agent-profile-address-v1.ttl` | Q: 49,62 | historical evidence constraint; keep |
| `model/definitions/agent-profile-v2.ttl` | Q: 33,45 | historical evidence constraint; keep |
| `model/definitions/assessment-v1.ttl` | Q: 44,73 | historical evidence constraint; keep |
| `model/definitions/claim-v1.ttl` | Q: 39 | historical evidence constraint; keep |
| `model/definitions/collection-curation-v1.ttl` | Q: 49,73 | historical evidence constraint; keep |
| `model/definitions/collection-public-name-v1.ttl` | Q: 18 | historical evidence constraint; keep |
| `model/definitions/content-match-unit-v1.ttl` | Q: 23 | historical evidence constraint; keep |
| `model/definitions/content-publication-v1.ttl` | Q: 36 | historical evidence constraint; keep |
| `model/definitions/content-search-eligibility-v1.ttl` | Q: 25 | historical evidence constraint; keep |
| `model/definitions/content-search-eligibility-v2.ttl` | Q: 26 | historical evidence constraint; keep |
| `model/definitions/context-definition-equivalence-v1.ttl` | Q: 32 | historical evidence constraint; keep |
| `model/definitions/context-definition-state-v1.ttl` | Q: 28 | historical evidence constraint; keep |
| `model/definitions/context-selection-v1.ttl` | Q: 48 | historical evidence constraint; keep |
| `model/definitions/context-v1.ttl` | Q: 46,76 | historical evidence constraint; keep |
| `model/definitions/correction-decision-v1.ttl` | Q: 26,49 | historical evidence constraint; keep |
| `model/definitions/correction-proposal-v1.ttl` | Q: 47 | historical evidence constraint; keep |
| `model/definitions/definition-presentation-v1.ttl` | Q: 45; G: 40 | historical evidence constraint; keep |
| `model/definitions/fixed-native-text-release-v1.ttl` | Q: 28 | historical evidence constraint; keep |
| `model/definitions/main-package-release-recommendation-v1.ttl` | Q: 20 | historical evidence constraint; keep |
| `model/definitions/projection-v1.ttl` | Q: 31 | historical evidence constraint; keep |
| `model/definitions/protection-revision-v1.ttl` | Q: 35 | historical evidence constraint; keep |
| `model/definitions/rating-question-presentation-v1.ttl` | Q: 36; G: 31 | historical evidence constraint; keep |
| `model/definitions/rating-question-presentation-v2.ttl` | Q: 37; G: 32 | historical evidence constraint; keep |
| `model/definitions/realization-v1.ttl` | Q: 35 | historical evidence constraint; keep |
| `model/definitions/realm-public-profile-v1.ttl` | Q: 26,39 | historical evidence constraint; keep |
| `model/definitions/realm-public-profile-v2.ttl` | Q: 19 | historical evidence constraint; keep |
| `model/definitions/realm-reply-placement-v1.ttl` | Q: 41 | historical evidence constraint; keep |
| `model/definitions/realm-submission-selection-v1.ttl` | Q: 22 | historical evidence constraint; keep |
| `model/definitions/relation-occurrence-v1.ttl` | Q: 48; G: 43 | historical evidence constraint; keep |
| `model/definitions/release-v1.ttl` | Q: 37 | historical evidence constraint; keep |
| `model/definitions/release-v2.ttl` | Q: 47 | historical evidence constraint; keep |
| `model/definitions/release-v3.ttl` | Q: 55 | historical evidence constraint; keep |
| `model/definitions/rights-offering-v1.ttl` | Q: 23,56,75 | historical evidence constraint; keep |
| `model/definitions/semantic-definition-v1.ttl` | Q: 36; G: 31 | historical evidence constraint; keep |
| `model/definitions/semantic-model-generation-v1.ttl` | Q: 26; G: 32 | historical evidence constraint; keep |
| `model/definitions/semantic-resource-v1.ttl` | Q: 34; G: 29 | historical evidence constraint; keep |
| `model/definitions/semantic-rule-v1.ttl` | Q: 34,53; G: 27 | historical evidence constraint; keep |
| `model/definitions/statement-decision-v1.ttl` | Q: 40 | historical evidence constraint; keep |
| `model/definitions/statement-v1.ttl` | Q: 92 | historical evidence constraint; keep |
| `model/definitions/structure-composition-v1.ttl` | Q: 124,156 | historical evidence constraint; keep |
| `model/definitions/theme-activation-v1.ttl` | Q: 34 | historical evidence constraint; keep |
| `model/definitions/translation-link-v1.ttl` | Q: 33 | historical evidence constraint; keep |
| `model/definitions/work-author-credit-v1.ttl` | Q: 36 | historical evidence constraint; keep |
| `model/definitions/work-derivation-unresolved-v1.ttl` | Q: 28 | historical evidence constraint; keep |
| `model/definitions/work-derivation-v1.ttl` | Q: 26 | historical evidence constraint; keep |
| `model/definitions/work-derivation-v2.ttl` | Q: 27 | historical evidence constraint; keep |
| `model/definitions/work-editorial-field-v1.ttl` | Q: 29,44 | historical evidence constraint; keep |
| `model/definitions/work-metadata-details-v1.ttl` | Q: 34 | historical evidence constraint; keep |
| `model/definitions/work-metadata-details-v2.ttl` | Q: 34 | historical evidence constraint; keep |
| `model/definitions/work-native-child-v1.ttl` | Q: 31 | historical evidence constraint; keep |
| `model/definitions/work-title-control-v1.ttl` | Q: 23 | historical evidence constraint; keep |
| `model/definitions/work-title-control-v2.ttl` | Q: 24 | historical evidence constraint; keep |
| `model/definitions/work-type-v1.ttl` | Q: 25 | historical evidence constraint; keep |
| `model/definitions/work-type-v2.ttl` | Q: 25 | historical evidence constraint; keep |
| `model/definitions/work-type-v3.ttl` | Q: 25 | historical evidence constraint; keep |
| `model/definitions/zone-capability-v1.ttl` | Q: 48 | historical evidence constraint; keep |
| `packages/observability/src/log.ts` | P: 22 | writer/reader reference; classified by kind above |
| `scripts/datasets/auth.ts` | P: 312 | writer/reader reference; classified by kind above |
| `scripts/datasets/bootstrap.ts` | P: 363,365,383,394 | writer/reader reference; classified by kind above |
| `scripts/datasets/import.ts` | P: 434,572 | writer/reader reference; classified by kind above |
| `scripts/datasets/model-bootstrap.ts` | Q: 120,131,147,158,162,169,171,175,211,213,316; G: 125,137,159,163,177,178,233 | writer/reader reference; classified by kind above |
| `scripts/dev/seed/classics-text-step.ts` | P: 77,84 | writer/reader reference; classified by kind above |
| `scripts/dev/seed/home-v2.ts` | P: 46,54,149,152 | writer/reader reference; classified by kind above |
| `scripts/dev/seed/official-zones-step.ts` | P: 272,281 | writer/reader reference; classified by kind above |
| `scripts/dev/web-auth-bootstrap.ts` | P: 183 | writer/reader reference; classified by kind above |
| `scripts/fixture/smoke.ts` | P: 58,63 | writer/reader reference; classified by kind above |
| `scripts/load/baseline.ts` | P: 10,29 | writer/reader reference; classified by kind above |
| `scripts/load/clone-probe.ts` | Q: 184; P: 185 | writer/reader reference; classified by kind above |
| `scripts/load/practical.ts` | Q: 253; P: 180,251,260,345,718,721,730,746,774,786,825,829,953,967,983,1007 | writer/reader reference; classified by kind above |
| `scripts/research/access_policy_probe.sql` | D: 31,35,91,175,177 | schema/storage candidate |
| `services/account/migrations/045_admin_panel.sql` | D: 50,56,58 | schema/storage candidate |
| `services/content/migrations/001_core.sql` | P: 71,72; D: 6,59,61,72,86,93,94,96 | schema/storage candidate |
| `services/content/migrations/002_projection_checkpoint.sql` | D: 4 | schema/storage candidate |
| `services/content/migrations/003_comments.sql` | D: 18,20,21 | schema/storage candidate |
| `services/content/migrations/004_comment_order.sql` | D: 1,4 | schema/storage candidate |
| `services/content/migrations/008_source_native_work_proposal.sql` | P: 12,13; D: 13 | schema/storage candidate |
| `services/content/migrations/009_source_native_work_adoption.sql` | D: 31 | schema/storage candidate |
| `services/content/migrations/010_source_native_work_title_application.sql` | D: 32 | schema/storage candidate |
| `services/content/migrations/019_source_author_credit.sql` | D: 38 | schema/storage candidate |
| `services/content/migrations/030_structure_stage.sql` | P: 39,40,57,58; D: 40,58 | schema/storage candidate |
| `services/content/migrations/031_structure_progress.sql` | D: 11,12,30,36,37 | schema/storage candidate |
| `services/content/migrations/041_source_feed_cursor.sql` | D: 10,18,19,29,30,37,53,54,103,109,110,112,128,136,140 | schema/storage candidate |
| `services/content/migrations/042_source_field_disposition.sql` | D: 1,18,22,30,31,32,34,36,41,43,51,56,63,64,68,79,82 | schema/storage candidate |
| `services/content/migrations/043_source_field_support.sql` | D: 53,72,78,136,142,146 | schema/storage candidate |
| `services/content/migrations/045_source_open_library_run_map.sql` | D: 1,5,7,61 | schema/storage candidate |
| `services/content/migrations/046_source_vndb_concept_map.sql` | D: 5,7,32,36,40 | schema/storage candidate |
| `services/content/migrations/053_package_installation.sql` | D: 209,217,224,231,239,241,242,243,250,354 | schema/storage candidate |
| `services/content/migrations/070_media_owner.sql` | D: 44,47,48,196,199,200 | schema/storage candidate |
| `services/content/migrations/093_verification_summary.sql` | P: 27,28; D: 24,27,28,47,163,167,178,193,195 | schema/storage candidate |
| `services/content/migrations/095_verification_source_disposition.sql` | D: 7,15,18,26,28,29,31,34,36,38,39,42,43,44 | schema/storage candidate |
| `services/content/migrations/096_verification_correction_delivery.sql` | D: 3,7 | schema/storage candidate |
| `services/content/migrations/110_semantic_change_stage.sql` | G: 20,57,61,75,136; D: 69,78,83 | schema/storage candidate |
| `services/content/migrations/121_export.sql` | D: 2,55,56 | schema/storage candidate |
| `services/content/migrations/122_publication_erasure_supersession.sql` | P: 10,11; D: 11 | schema/storage candidate |
| `services/content/migrations/140_graph_layout.sql` | D: 2,4 | schema/storage candidate |
| `services/content/migrations/1493_progress_member_anchors.sql` | D: 3,11 | schema/storage candidate |
| `services/content/migrations/1520_verification_walk.sql` | D: 10,16,19,20,37,44,77,81,87,95,102,103,106,112,117 | schema/storage candidate |
| `services/content/migrations/1521_verification_stream_freshness.sql` | D: 8,18,20,30,31,37,38,50,65,78,87,88,98 | schema/storage candidate |
| `services/content/migrations/1704_verification_assessment_producer.sql` | D: 13 | schema/storage candidate |
| `services/content/migrations/1707_wiki_evidence_claim_generation.sql` | D: 7,12,14 | schema/storage candidate |
| `services/content/migrations/1709_evidence_source_erasure.sql` | D: 296 | schema/storage candidate |
| `services/content/migrations/173_source_synopsis_field_mapping.sql` | D: 17 | schema/storage candidate |
| `services/content/migrations/174_source_native_child_support.sql` | D: 41 | schema/storage candidate |
| `services/content/migrations/180_export_terminal.sql` | D: 2,7,9,10,12,16 | schema/storage candidate |
| `services/content/migrations/200_theme_activation.sql` | P: 21,22; D: 22 | schema/storage candidate |
| `services/content/migrations/2121_content_eligibility_delivery.sql` | P: 9,12,19,26,27,28,29,38,41,57,58,76,77,81; S: 8,12,18,26,27,28,29,37,57,58,76,77,80; D: 3,11,21,26,41,43,57,58,70,78,83,84 | schema/storage candidate |
| `services/content/migrations/220_semantic_stage_generation_iri.sql` | G: 4,5,6,10,12,16,18,24,35,40 | schema/storage candidate |
| `services/content/migrations/370_reader_library.sql` | D: 2 | schema/storage candidate |
| `services/content/migrations/375_structure_progress_outbox.sql` | D: 1 | schema/storage candidate |
| `services/content/migrations/727_reading_position.sql` | D: 1,3,12,15,19,20,22,26,27 | schema/storage candidate |
| `services/content/migrations/728_wiki_evidence.sql` | D: 22,52 | schema/storage candidate |
| `services/content/migrations/771_pending_revelation.sql` | D: 2,5,10 | schema/storage candidate |
| `services/content/migrations/791_content_event_sequencer.sql` | D: 1,4,9,13,14,15,16,19,20,21,24,25,29,31,33,36,37,39,40,42,43,49,51,54,62,63,70,73,75,77,82,87,89,92,97,98 | schema/storage candidate |
| `services/content/migrations/810_reading_position_change_signal.sql` | D: 3,8,9,12,16,21,24,27 | schema/storage candidate |
| `services/content/migrations/811_ranking_progress_event_index.sql` | D: 3,4,6 | schema/storage candidate |
| `services/content/migrations/840_reading_position_fence.sql` | D: 5,6,7,9,12,14,19,20,26,29,32,35,44,48,50,54,55 | schema/storage candidate |
| `services/content/migrations/860_projection_checkpoint.sql` | D: 2,3,4,5,6,10,13,15,21,24,25,27 | schema/storage candidate |
| `services/content/src/comments.ts` | P: 37,48,234,301,483 | writer/reader reference; classified by kind above |
| `services/content/src/core.ts` | P: 137,295,296,297,324,354,357,497,501,502,504,514,948,1047,1068,1073,1082,1109,1158,1165,1184,1185,1210,1211,1216,1226,1255,1263,1275,1276; S: 128,264,318,339,353,1039,1040,1047,1048,1049,1068,1070,1073,1074,1082,1083,1109,1112,1210,1215,1226,1227 | writer/reader reference; classified by kind above |
| `services/content/src/projection-cursor.ts` | P: 73,134,145 | writer/reader reference; classified by kind above |
| `services/main/migrations/access/002_claim_and_seal.sql` | P: 13,14,20; D: 14,20 | schema/storage candidate |
| `services/main/migrations/access/040_access_policy.sql` | D: 64,69,71,74,78,206,208 | schema/storage candidate |
| `services/main/migrations/access/041_access_interaction.sql` | D: 32 | schema/storage candidate |
| `services/main/migrations/access/042_access_decision_snapshot.sql` | D: 30,42,43,61,62,107,133,134,136,137 | schema/storage candidate |
| `services/main/migrations/access/050_representation_topology.sql` | D: 184,190,220,223 | schema/storage candidate |
| `services/main/migrations/access/051_protected_change.sql` | D: 201 | schema/storage candidate |
| `services/main/migrations/access/052_representative_policy.sql` | D: 31 | schema/storage candidate |
| `services/main/migrations/access/056_protected_rebind_and_enrollment.sql` | D: 29 | schema/storage candidate |
| `services/main/migrations/access/060_governance_case.sql` | D: 25 | schema/storage candidate |
| `services/main/migrations/access/061_moderation_decision.sql` | D: 10,16,36,39,44,57,86,95,101,103,108 | schema/storage candidate |
| `services/main/migrations/access/062_notification_intent.sql` | D: 115,127,133,135,150,163,180,188,191,228 | schema/storage candidate |
| `services/main/migrations/access/090_commerce.sql` | D: 230,235,236,239 | schema/storage candidate |
| `services/main/migrations/access/1000_space_visibility.sql` | D: 21 | schema/storage candidate |
| `services/main/migrations/access/1010_name_registry.sql` | D: 14,17,18,29,32,33,34 | schema/storage candidate |
| `services/main/migrations/access/1013_terminal_legacy_address_admissions.sql` | P: 7,8; D: 3,8 | schema/storage candidate |
| `services/main/migrations/access/1014_relationship_follows.sql` | D: 7,15,69,111 | schema/storage candidate |
| `services/main/migrations/access/1028_preserve_follow_provenance.sql` | D: 51 | schema/storage candidate |
| `services/main/migrations/access/1030_feed_target_timeline.sql` | D: 24 | schema/storage candidate |
| `services/main/migrations/access/1038_realm_thread_ranking.sql` | D: 10,13 | schema/storage candidate |
| `services/main/migrations/access/1039_realm_thread_history_population.sql` | D: 8 | schema/storage candidate |
| `services/main/migrations/access/1041_catalogue_import_batches.sql` | P: 101,123; D: 97,101,123 | schema/storage candidate |
| `services/main/migrations/access/1042_realm_thread_retirement.sql` | D: 5 | schema/storage candidate |
| `services/main/migrations/access/1043_discovery_versions.sql` | P: 67,86,87,91; D: 65,67,86,87,91 | schema/storage candidate |
| `services/main/migrations/access/1050_projection_identity.sql` | D: 11 | schema/storage candidate |
| `services/main/migrations/access/1055_target_rating_components.sql` | D: 28,61 | schema/storage candidate |
| `services/main/migrations/access/110_derived_generation.sql` | P: 59,60,63,64,89,90,195,196,197; D: 4,5,7,52,59,60,63,64,89,90,195,196,197,199 | schema/storage candidate |
| `services/main/migrations/access/1130_notification_producer_insert_log.sql` | D: 1,3,13,17,18,24 | schema/storage candidate |
| `services/main/migrations/access/113_ranking_signal_slot.sql` | P: 11; D: 4,11 | schema/storage candidate |
| `services/main/migrations/access/1161_realm_directory_refresh.sql` | D: 14,18,21,22 | schema/storage candidate |
| `services/main/migrations/access/1170_review_rank_sequencer.sql` | D: 1,2,4,10,11,23,24,32,36,38 | schema/storage candidate |
| `services/main/migrations/access/1171_editorial_event_sequencer.sql` | D: 1,4,14,15,17,20,25,26,35,36,40,44,46 | schema/storage candidate |
| `services/main/migrations/access/1172_ordered_read_change_signals.sql` | D: 33,59,85,88 | schema/storage candidate |
| `services/main/migrations/access/1201_scope_gate_admission.sql` | P: 120,142; D: 116,120,142 | schema/storage candidate |
| `services/main/migrations/access/1240_ordered_read_fences.sql` | D: 20,51,82 | schema/storage candidate |
| `services/main/migrations/access/1241_realm_directory_incremental_copy.sql` | D: 3,4,5,7 | schema/storage candidate |
| `services/main/migrations/access/1290_platform_grants.sql` | D: 191 | schema/storage candidate |
| `services/main/migrations/access/1330_recipient_source_frontier.sql` | D: 17 | schema/storage candidate |
| `services/main/migrations/access/1399_read_rankings.sql` | D: 1,2,3,4,5,6,7,8,9,10,14,17,19,24,27,28,30 | schema/storage candidate |
| `services/main/migrations/access/1422_safety_notice_continuation.sql` | D: 31 | schema/storage candidate |
| `services/main/migrations/access/1441_platform_grant_seed_ceiling.sql` | D: 1,70 | schema/storage candidate |
| `services/main/migrations/access/1499_statement_seek.sql` | D: 4 | schema/storage candidate |
| `services/main/migrations/access/160_search_send_settlement.sql` | D: 10 | schema/storage candidate |
| `services/main/migrations/access/1751_current_safety_answer.sql` | D: 5 | schema/storage candidate |
| `services/main/migrations/access/1761_template_seek.sql` | D: 7,22 | schema/storage candidate |
| `services/main/migrations/access/1763_template_seek_pending.sql` | D: 4,5 | schema/storage candidate |
| `services/main/migrations/access/1764_template_seek_pending_anchor.sql` | D: 4,5,6 | schema/storage candidate |
| `services/main/migrations/access/1766_receipt_custody_delivery.sql` | D: 1,2,5,6,7,8,10,11 | schema/storage candidate |
| `services/main/migrations/access/1769_event_temporal_projection.sql` | P: 18; S: 7; D: 7,18 | schema/storage candidate |
| `services/main/migrations/access/1770_event_temporal_relay_backfill.sql` | S: 4; D: 4 | schema/storage candidate |
| `services/main/migrations/access/1771_event_temporal_scoped_coverage.sql` | P: 5,8; S: 15; D: 2,3,5,8,11,12,15 | schema/storage candidate |
| `services/main/migrations/access/1772_event_temporal_publication.sql` | D: 9,15,17,24 | schema/storage candidate |
| `services/main/migrations/access/1777_realm_sanction_appeal.sql` | D: 83,90 | schema/storage candidate |
| `services/main/migrations/access/200_agent_provision.sql` | P: 14,15,20,21; D: 15,20,21 | schema/storage candidate |
| `services/main/migrations/access/211_owner_consumer_rebuild.sql` | D: 6,13,19,21,22 | schema/storage candidate |
| `services/main/migrations/access/315_discovery_projection.sql` | P: 47,98,100; D: 6,47,98,100 | schema/storage candidate |
| `services/main/migrations/access/340_realm_management_read.sql` | D: 1 | schema/storage candidate |
| `services/main/migrations/access/395_realm_member_publication.sql` | D: 10,14,33 | schema/storage candidate |
| `services/main/migrations/access/396_realm_directory.sql` | D: 1,3,4,7 | schema/storage candidate |
| `services/main/migrations/access/405_home_feed.sql` | D: 29,33,42 | schema/storage candidate |
| `services/main/migrations/access/475_read_rankings.sql` | D: 5 | schema/storage candidate |
| `services/main/migrations/access/476_serial_statistics.sql` | D: 5 | schema/storage candidate |
| `services/main/migrations/access/495_notification_producer_log.sql` | D: 6,11,20,60,62,63,64,65 | schema/storage candidate |
| `services/main/migrations/access/520_home_personal.sql` | D: 12 | schema/storage candidate |
| `services/main/migrations/access/535_studio_work_page.sql` | D: 1 | schema/storage candidate |
| `services/main/migrations/access/620_reader_review.sql` | D: 58,61,68 | schema/storage candidate |
| `services/main/migrations/access/623_review_rankings.sql` | D: 3,4,11,15,22,24,25,26,27,31,34 | schema/storage candidate |
| `services/main/migrations/access/665_feed_reviews.sql` | D: 1,5 | schema/storage candidate |
| `services/main/migrations/access/785_also_enjoyed_generation.sql` | P: 33,49,51; D: 33,49,51 | schema/storage candidate |
| `services/main/migrations/access/840_saved_filter.sql` | D: 28,29,35,38,72,74,83,86,87,104 | schema/storage candidate |
| `services/main/migrations/access/860_realm_growth_day.sql` | D: 13,17,50,80 | schema/storage candidate |
| `services/main/migrations/access/873_agent_access_invitations.sql` | D: 59,440,443 | schema/storage candidate |
| `services/main/migrations/access/875_reading_languages.sql` | D: 57,58,60 | schema/storage candidate |
| `services/main/migrations/access/880_editorial_proposals.sql` | D: 41,45,47,49,51 | schema/storage candidate |
| `services/main/migrations/access/882_editorial_events.sql` | D: 1,3,6,15,16,18,21,22 | schema/storage candidate |
| `services/main/migrations/access/932_safety_queue.sql` | D: 3,6,7,10,14,15,16,17 | schema/storage candidate |
| `services/main/migrations/access/973_catalogue_intake.sql` | D: 7 | schema/storage candidate |
| `services/main/migrations/access/982_editorial_ordered_commands.sql` | D: 4,7,12,16,17,21,23,24,28,30,31 | schema/storage candidate |
| `services/main/migrations/relay/001_delivery.sql` | D: 8,16,21 | schema/storage candidate |
| `services/main/migrations/relay/002_coverage_scan.sql` | P: 4; D: 1,2,3,5,7 | schema/storage candidate |
| `services/main/migrations/relay/003_retained_batches.sql` | D: 1,6,11 | schema/storage candidate |
| `services/main/migrations/relay/011_erasure_retention.sql` | D: 3,26,43,47,50,56,60,61 | schema/storage candidate |
| `services/main/migrations/relay/012_owner_relocation.sql` | P: 17,32,62,64; D: 5,17,32,62,64 | schema/storage candidate |
| `services/main/migrations/relay/013_owner_reconciliation.sql` | D: 4,70,79,97,104,108 | schema/storage candidate |
| `services/main/migrations/relay/015_erasure_copy_class.sql` | D: 10,11,14 | schema/storage candidate |
| `services/main/migrations/relay/016_notification_producer_cursor.sql` | D: 5 | schema/storage candidate |
| `services/main/migrations/relay/020_main_stream_scope.sql` | S: 3,4,5,6,7,8,11,13,15; D: 2,11,14,15,18 | schema/storage candidate |
| `services/main/migrations/relay/021_event_temporal_seek.sql` | S: 3,4,7; D: 3,4,7 | schema/storage candidate |
| `services/main/migrations/relay/022_erasure_revision_kinds.sql` | D: 34 | schema/storage candidate |
| `services/main/src/api-contract.ts` | P: 9,18,23,54,60,67,79,170,177,231,240,249,272,276,302,307 | writer/reader reference; classified by kind above |
| `services/main/src/api-responses.ts` | P: 2,7,122,129,147,240,309,318,325,331 | writer/reader reference; classified by kind above |
| `services/main/src/composition.ts` | S: 599,629,635 | writer/reader reference; classified by kind above |
| `services/main/src/infrastructure/fuseki.ts` | Q: 714; P: 586 | writer/reader reference; classified by kind above |
| `services/main/src/infrastructure/invalid-receipt.ts` | Q: 27,29,35,37,41 | W: raw writer plus consumers |
| `services/main/src/modules/access/admission.ts` | P: 474,476,487,488,1952,1956,1972,1993 | writer/reader reference; classified by kind above |
| `services/main/src/modules/access/assessment-history.ts` | P: 19,33,34,62,130,132,137,138,143,144,164,165; F: 80,84 | writer/reader reference; classified by kind above |
| `services/main/src/modules/access/organization-moderation.ts` | P: 223 | writer/reader reference; classified by kind above |
| `services/main/src/modules/access/semantic-disclosure.ts` | Q: 101 | writer/reader reference; classified by kind above |
| `services/main/src/modules/address/migrate-zone.ts` | Q: 86 | writer/reader reference; classified by kind above |
| `services/main/src/modules/address/migrate.ts` | Q: 373,505,513,515,518,522 | W: raw writer plus consumers |
| `services/main/src/modules/address/outbox-event.ts` | P: 46 | writer/reader reference; classified by kind above |
| `services/main/src/modules/agent/graph.ts` | Q: 29,65,66,77,82,84,90,126,129,135,137,142 | W: raw writer plus consumers |
| `services/main/src/modules/agent/outbox-event.ts` | Q: 28,35,78,81; P: 48,91 | writer/reader reference; classified by kind above |
| `services/main/src/modules/agent/profile.ts` | Q: 96,214,222,237,242,244,250; P: 59,171,299 | W: raw writer plus consumers |
| `services/main/src/modules/agent/provision.ts` | P: 18,23,24,39,40,130,132,133,137 | writer/reader reference; classified by kind above |
| `services/main/src/modules/also-enjoyed/contract.ts` | P: 14 | writer/reader reference; classified by kind above |
| `services/main/src/modules/also-enjoyed/read.ts` | P: 151,152,243 | writer/reader reference; classified by kind above |
| `services/main/src/modules/also-enjoyed/store.ts` | P: 22,134,136,138,141,205,404,421,424,428,434,446,452,456 | writer/reader reference; classified by kind above |
| `services/main/src/modules/author-page/contract.ts` | P: 66 | writer/reader reference; classified by kind above |
| `services/main/src/modules/author-page/read.ts` | P: 196 | writer/reader reference; classified by kind above |
| `services/main/src/modules/catalogue-intake/outbox-event.ts` | P: 18 | writer/reader reference; classified by kind above |
| `services/main/src/modules/catalogue-intake/search.ts` | P: 177 | writer/reader reference; classified by kind above |
| `services/main/src/modules/catalogue-intake/store.ts` | P: 42 | writer/reader reference; classified by kind above |
| `services/main/src/modules/catalogue-intake/verification.ts` | Q: 25,46,48,55,58,63; P: 122 | W: raw writer plus consumers |
| `services/main/src/modules/classification/context.ts` | Q: 58,144,146,160,169,173,181,237,239,245,249,257 | W: raw writer plus consumers |
| `services/main/src/modules/classification/decision.ts` | Q: 83,171,173,180,184,191 | W: raw writer plus consumers |
| `services/main/src/modules/classification/global.ts` | Q: 25,53,55,63,67,69 | W: raw writer plus consumers |
| `services/main/src/modules/classification/outbox-event.ts` | Q: 25; P: 35 | writer/reader reference; classified by kind above |
| `services/main/src/modules/classification/proposition.ts` | Q: 58,140,142,162,172,176,184,229,231,236,240,248 | W: raw writer plus consumers |
| `services/main/src/modules/classification/resolve.ts` | Q: 98,220; P: 158,285 | writer/reader reference; classified by kind above |
| `services/main/src/modules/classification/tag-proposal.ts` | Q: 82; P: 29 | writer/reader reference; classified by kind above |
| `services/main/src/modules/classification/vocabulary.ts` | Q: 262,275,278,313,317,325 | W: raw writer plus consumers |
| `services/main/src/modules/collection/dynamic.ts` | Q: 162,165,176,182,184,190; P: 87,105,110,115,221 | W: raw writer plus consumers |
| `services/main/src/modules/collection/grain.ts` | P: 119 | writer/reader reference; classified by kind above |
| `services/main/src/modules/collection/names.ts` | Q: 104,107,115,121,123,129; P: 161 | W: raw writer plus consumers |
| `services/main/src/modules/collection/outbox-event.ts` | Q: 24,27; P: 38 | writer/reader reference; classified by kind above |
| `services/main/src/modules/composition/read.ts` | P: 58,113 | writer/reader reference; classified by kind above |
| `services/main/src/modules/concept-page/contract.ts` | P: 74 | writer/reader reference; classified by kind above |
| `services/main/src/modules/concept-page/read.ts` | P: 111,227,378 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/comment.ts` | P: 29,86 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/draft.ts` | P: 49 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/eligibility-admitted.ts` | P: 36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/eligibility.ts` | Q: 222,307,321,324,335,338,345,372,374,378,385; P: 56,184,245,270 | W: raw writer plus consumers |
| `services/main/src/modules/content-publication/outbox-event.ts` | Q: 29,77; P: 46,83 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/publish-admitted.ts` | P: 53,60 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/publish.ts` | Q: 170,191,196,215,223,232,263,265,272,280,306; P: 48,68,168,211,298,306,324,336,357,365,368,394 | W: raw writer plus consumers |
| `services/main/src/modules/content-publication/rebuild.ts` | Q: 233,236,241,243,249,276,395,553,597,770,774,781,787,886; P: 274,277,284,288,304,307,313,325,710,1023 | W: raw writer plus consumers |
| `services/main/src/modules/content-publication/relay.ts` | Q: 80,84,152,174,193,196,206,224,226,234; P: 29,34,203,218,288,382,399,411 | W: raw writer plus consumers |
| `services/main/src/modules/content-publication/reply-draft.ts` | P: 38,160,166 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/search-continuation.ts` | P: 12,44,47,61,64,70,71,83,88 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/search-private-projection.ts` | Q: 75,79,104,106,113; P: 90,102 | W: raw writer plus consumers |
| `services/main/src/modules/content-publication/search-private.ts` | Q: 49; P: 35,60,117 | writer/reader reference; classified by kind above |
| `services/main/src/modules/content-publication/search.ts` | Q: 72,198; P: 285,292 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/command.ts` | Q: 95,139,147,160,162,166,209,213,220 | W: raw writer plus consumers |
| `services/main/src/modules/context/definition-state.ts` | Q: 112 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/equivalence.ts` | Q: 78,100; P: 131 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/graph.ts` | Q: 169,354 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/interpretation.ts` | Q: 149; P: 28,144 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/outbox-event.ts` | Q: 49; P: 55 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/preferences.ts` | Q: 106,121; P: 139 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/read.ts` | Q: 67; P: 49,110 | writer/reader reference; classified by kind above |
| `services/main/src/modules/context/rule.ts` | Q: 143,360; G: 7,38,49,51,55,111,114,117,139,144,176,180,186,194,198,204,261,325,361,386 | writer/reader reference; classified by kind above |
| `services/main/src/modules/continue/contract.ts` | P: 16,31 | writer/reader reference; classified by kind above |
| `services/main/src/modules/continue/read.ts` | P: 66,103 | writer/reader reference; classified by kind above |
| `services/main/src/modules/contribution/draft.ts` | Q: 128,223,225,236,249,253,262,303,305,310,313,320 | W: raw writer plus consumers |
| `services/main/src/modules/contribution/edit.ts` | Q: 68,133,135,141,145,152,180,182,188,192,199,264,269,277,290,294,303 | W: raw writer plus consumers |
| `services/main/src/modules/contribution/history.ts` | Q: 134; P: 22,178,399,673 | writer/reader reference; classified by kind above |
| `services/main/src/modules/contribution/publish.ts` | Q: 92,166,168,174,178,185,216,218,224,228,235,329,333,346,357,361,370 | W: raw writer plus consumers |
| `services/main/src/modules/contribution/search-private.ts` | Q: 76; P: 159 | writer/reader reference; classified by kind above |
| `services/main/src/modules/disclosure/sitemap.ts` | Q: 52,109 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/changes.ts` | Q: 59; P: 51 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/concepts.ts` | P: 43,97,373 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/contract.ts` | P: 160 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/management.ts` | P: 180,186,195 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/public-ranking.ts` | P: 26,48,51 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/read.ts` | P: 63,162,164 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/refresh-store.ts` | P: 71,80,293,400,402,403,461 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/refresh.ts` | P: 78,188,194,195,197,215,221,272,287,318; S: 74 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/sections.ts` | P: 52,312 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/source.ts` | Q: 211,304,316; P: 58,81,141,142,152,301,445,446; S: 28,72,73,74,141,142,153 | writer/reader reference; classified by kind above |
| `services/main/src/modules/discovery/store.ts` | P: 57,350,367,368,499,521,531,543,552,559,563,565,662,738,745,811,885 | writer/reader reference; classified by kind above |
| `services/main/src/modules/entity-page/contract.ts` | P: 75,153,170 | writer/reader reference; classified by kind above |
| `services/main/src/modules/entity-page/read.ts` | P: 190,209,265 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/authority.ts` | P: 68; S: 71 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/content.ts` | P: 208 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/custody.ts` | G: 146,166,170; P: 93,96,191,192,195,203; S: 7,18,66,69,73,76,81,85,86,93,96,98,107,108,117,125,199,201 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/graph.ts` | Q: 165,169,177,179,186,283,290,355,361,870; P: 322,972 | W: raw writer plus consumers |
| `services/main/src/modules/erasure/outbox-event.ts` | P: 36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/reconcile.ts` | P: 235,738,740,743,763,764,1000; S: 1001 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/replay-graph.ts` | Q: 32 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/replay-supersessions.ts` | P: 20,21,28,29 | writer/reader reference; classified by kind above |
| `services/main/src/modules/erasure/schema.ts` | P: 142,143,182 | writer/reader reference; classified by kind above |
| `services/main/src/modules/event/observation.ts` | Q: 74,148,150,155,157,162,276,279,294,306,310,318 | W: raw writer plus consumers |
| `services/main/src/modules/event/outbox-event.ts` | Q: 32; P: 66 | writer/reader reference; classified by kind above |
| `services/main/src/modules/event/projection.ts` | P: 20,21,151,152,162,163,208,214,217,220,278,280,284,286,298,299,344,345; S: 18,149,158,160,176,182,262,269,271,278,280 | writer/reader reference; classified by kind above |
| `services/main/src/modules/event/queries.ts` | P: 347; S: 139,208 | writer/reader reference; classified by kind above |
| `services/main/src/modules/event/source.ts` | Q: 18,203; P: 277,283; S: 5,19,38,41,50,69,100,104,111 | writer/reader reference; classified by kind above |
| `services/main/src/modules/export/planner.ts` | P: 27,175 | writer/reader reference; classified by kind above |
| `services/main/src/modules/export/readers.ts` | P: 180,215,230,265,266,323,329,330,356,363,368,404,424,425,429,430,459,467,468,480,481,508,517 | writer/reader reference; classified by kind above |
| `services/main/src/modules/export/scoped.ts` | Q: 107,190; P: 234,262,299 | writer/reader reference; classified by kind above |
| `services/main/src/modules/export/store.ts` | P: 36,157 | writer/reader reference; classified by kind above |
| `services/main/src/modules/export/vndb-source.ts` | P: 29,47 | writer/reader reference; classified by kind above |
| `services/main/src/modules/export/wiki.ts` | P: 62,63,76,77 | writer/reader reference; classified by kind above |
| `services/main/src/modules/facets/release-read.ts` | Q: 40 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/new-since.ts` | P: 67 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/read.ts` | P: 790,810 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/refresh.ts` | P: 24; S: 22 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/source.ts` | Q: 83,127,147,168,180,188,220,237 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/store.ts` | P: 83,85,86,88 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/target-index.ts` | P: 42,50; S: 12,47 | writer/reader reference; classified by kind above |
| `services/main/src/modules/feed/trending.ts` | P: 29,182 | writer/reader reference; classified by kind above |
| `services/main/src/modules/governance/effects.ts` | Q: 255,257,268,271,277 | W: raw writer plus consumers |
| `services/main/src/modules/governance/outbox-event.ts` | P: 28 | writer/reader reference; classified by kind above |
| `services/main/src/modules/graph-query/query.ts` | Q: 233; P: 312,380,424,446 | writer/reader reference; classified by kind above |
| `services/main/src/modules/graph-query/schema.ts` | P: 92,113,158,159,160,161,162,199,200,201,202,203 | writer/reader reference; classified by kind above |
| `services/main/src/modules/graph-query/statements.ts` | Q: 50; P: 146,166,280,287 | writer/reader reference; classified by kind above |
| `services/main/src/modules/graph/slim-command.ts` | S: 5 | writer/reader reference; classified by kind above |
| `services/main/src/modules/home/projection-health.ts` | P: 7 | writer/reader reference; classified by kind above |
| `services/main/src/modules/hub/admitted.ts` | P: 27 | writer/reader reference; classified by kind above |
| `services/main/src/modules/hub/work-page.ts` | Q: 66 | writer/reader reference; classified by kind above |
| `services/main/src/modules/identity-merge/outbox-event.ts` | P: 30 | writer/reader reference; classified by kind above |
| `services/main/src/modules/identity-merge/resolution.ts` | Q: 20,41; P: 22,40 | writer/reader reference; classified by kind above |
| `services/main/src/modules/lexicon/catalog.ts` | Q: 53 | writer/reader reference; classified by kind above |
| `services/main/src/modules/lexicon/change.ts` | Q: 104,295; G: 20,65,104,125,293,296,318; P: 66,126 | writer/reader reference; classified by kind above |
| `services/main/src/modules/lexicon/render.ts` | Q: 184 | writer/reader reference; classified by kind above |
| `services/main/src/modules/library/public.ts` | P: 45 | writer/reader reference; classified by kind above |
| `services/main/src/modules/library/ratings.ts` | Q: 89,97; P: 12,130 | writer/reader reference; classified by kind above |
| `services/main/src/modules/library/read.ts` | Q: 120; P: 97 | writer/reader reference; classified by kind above |
| `services/main/src/modules/library/stats.ts` | P: 82 | writer/reader reference; classified by kind above |
| `services/main/src/modules/management-reads/decision-basis.ts` | Q: 36; P: 25,57,60,86,95 | writer/reader reference; classified by kind above |
| `services/main/src/modules/management-reads/read-store.ts` | Q: 43; P: 140 | writer/reader reference; classified by kind above |
| `services/main/src/modules/media/commands.ts` | P: 111,121,363,450,456 | writer/reader reference; classified by kind above |
| `services/main/src/modules/media/summary.ts` | Q: 261,845 | writer/reader reference; classified by kind above |
| `services/main/src/modules/onboarding/choices.ts` | P: 144 | writer/reader reference; classified by kind above |
| `services/main/src/modules/onboarding/contract.ts` | P: 33,53 | writer/reader reference; classified by kind above |
| `services/main/src/modules/onboarding/suggestions.ts` | P: 197 | writer/reader reference; classified by kind above |
| `services/main/src/modules/outbox/account-deletion-journal.ts` | F: 89 | writer/reader reference; classified by kind above |
| `services/main/src/modules/outbox/event-handlers.ts` | P: 21 | writer/reader reference; classified by kind above |
| `services/main/src/modules/outbox/receipt-custody.ts` | Q: 408; P: 428,433,594,677; S: 11,28,39,74,111,113,157,180,406,408,413,416,427,428,434,435,449,469,496,498,499,507,514,515,593,601,602,603,607,619,701,706,710 | writer/reader reference; classified by kind above |
| `services/main/src/modules/outbox/relay-position.ts` | S: 2,5,12,32,33,36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/outbox/relay.ts` | Q: 453,457,662,745,823,939,1071; P: 209,210,211,279,340,396,415,441,457,512,514,608,700,780,840,866,870,871,872,880,1053,1076,1102,1135,1173,1208,1244,1372,1373,1374,1667,1674,1675,1682,1690; S: 11,45,63,64,67,69,70,83,85,116,132,170,171,179,188,200,207,209,211,214,239,249,252,257,258,259,262,277,291,339,424,444,449,451,454,478,513,858,873,874,883,884,1674,1675,1680,1681,1686,1687,1689,1698,1699,1704,1714,1715,1723,1724,1727,1747 | writer/reader reference; classified by kind above |
| `services/main/src/modules/owner/operations.ts` | P: 393,712,735 | writer/reader reference; classified by kind above |
| `services/main/src/modules/owner/placement.ts` | Q: 26 | writer/reader reference; classified by kind above |
| `services/main/src/modules/owner/relocation.ts` | Q: 60,62; P: 131,137,142,147,160,203 | writer/reader reference; classified by kind above |
| `services/main/src/modules/owner/schema.ts` | P: 21,107 | writer/reader reference; classified by kind above |
| `services/main/src/modules/package/outbox-event.ts` | Q: 26,30; P: 45 | writer/reader reference; classified by kind above |
| `services/main/src/modules/package/release-recommendation.ts` | Q: 118,161,163,169,171,174,241,244,254,263,267,277,395; P: 31,435 | W: raw writer plus consumers |
| `services/main/src/modules/post/backfill.ts` | Q: 102,106,112,114,120 | W: raw writer plus consumers |
| `services/main/src/modules/post/identification-read.ts` | P: 34 | writer/reader reference; classified by kind above |
| `services/main/src/modules/post/identification.ts` | P: 111 | writer/reader reference; classified by kind above |
| `services/main/src/modules/post/outbox-event.ts` | Q: 20; P: 31 | writer/reader reference; classified by kind above |
| `services/main/src/modules/post/read.ts` | P: 73 | writer/reader reference; classified by kind above |
| `services/main/src/modules/pro-site/store.ts` | P: 89 | writer/reader reference; classified by kind above |
| `services/main/src/modules/profiles/access.ts` | P: 118,122,132,135,136 | writer/reader reference; classified by kind above |
| `services/main/src/modules/profiles/credits.ts` | Q: 75,76,82,89,91,95; P: 136 | W: raw writer plus consumers |
| `services/main/src/modules/profiles/library.ts` | Q: 93 | writer/reader reference; classified by kind above |
| `services/main/src/modules/profiles/outbox-event.ts` | Q: 29; P: 36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/profiles/read-contract.ts` | P: 25 | writer/reader reference; classified by kind above |
| `services/main/src/modules/profiles/read.ts` | P: 180 | writer/reader reference; classified by kind above |
| `services/main/src/modules/progress/disclosure.ts` | P: 61 | writer/reader reference; classified by kind above |
| `services/main/src/modules/projection/command.ts` | Q: 73; P: 84,107,108,131 | writer/reader reference; classified by kind above |
| `services/main/src/modules/projection/read.ts` | P: 15,62 | writer/reader reference; classified by kind above |
| `services/main/src/modules/projection/schema.ts` | P: 4,100,102 | writer/reader reference; classified by kind above |
| `services/main/src/modules/proposal/access.ts` | P: 23,24,250,255 | writer/reader reference; classified by kind above |
| `services/main/src/modules/proposal/graph.ts` | Q: 66,120,124,140,142,150 | W: raw writer plus consumers |
| `services/main/src/modules/proposal/outbox-event.ts` | P: 30 | writer/reader reference; classified by kind above |
| `services/main/src/modules/protection/admitted.ts` | P: 55 | writer/reader reference; classified by kind above |
| `services/main/src/modules/protection/outbox-event.ts` | P: 41 | writer/reader reference; classified by kind above |
| `services/main/src/modules/protection/reconcile-restored.ts` | Q: 248; P: 74,83,84,163,169,170; S: 49 | writer/reader reference; classified by kind above |
| `services/main/src/modules/protection/work.ts` | Q: 108,112,125,171,172,176,231,232,234,245,249,304,306,322,327,331,424,432,433,435,444,449 | W: raw writer plus consumers |
| `services/main/src/modules/query/concept-set.ts` | P: 9,23,24,39,55,74,80,84 | writer/reader reference; classified by kind above |
| `services/main/src/modules/query/resource-contract.ts` | P: 95 | writer/reader reference; classified by kind above |
| `services/main/src/modules/query/resources.ts` | P: 220,433,640,641,644,810,818,819,821 | writer/reader reference; classified by kind above |
| `services/main/src/modules/query/seek-index.ts` | P: 75,120,136 | writer/reader reference; classified by kind above |
| `services/main/src/modules/query/template-read.ts` | P: 243 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rankings/projection.ts` | P: 227,230,245,321 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rankings/read.ts` | P: 195 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rankings/realm-threads.ts` | P: 168,322,339 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/aggregate-api.ts` | P: 2,41 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/aggregate-inventory.ts` | P: 255,256,260,392,398,426,509 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/aggregate.ts` | Q: 35; P: 140 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/context.ts` | Q: 70,161,163,182,191,195,203,242,244,250,254,262 | W: raw writer plus consumers |
| `services/main/src/modules/rating/experience-aggregate.ts` | Q: 38,57,81; P: 183 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/global-aggregate.ts` | Q: 65,83,97; P: 212,245,258,273,337,364 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/global-api.ts` | P: 2,12,63,80 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/global.ts` | Q: 109,111,120,129,133,141,264,266,271,275,282,351,355,372,386,390,399 | W: raw writer plus consumers |
| `services/main/src/modules/rating/observation.ts` | Q: 108,320,322,329,333,340,444,449,475,491,495,504 | W: raw writer plus consumers |
| `services/main/src/modules/rating/policy.ts` | Q: 63,242,245,254,263,265,272,314,316,321,323,330 | W: raw writer plus consumers |
| `services/main/src/modules/rating/populations.ts` | P: 38,290 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/projection-health.ts` | P: 11,39,52,53,57,62 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/question-presentation.ts` | Q: 150,415; G: 19,108,148,185,347,388,413,428; P: 109,186 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/release-aggregate.ts` | Q: 49,56,78; P: 209 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/release-api.ts` | P: 2,9,60 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/release.ts` | Q: 129,131,138,193,202,206,424,440,444,521,525,533 | W: raw writer plus consumers |
| `services/main/src/modules/rating/rollup-api.ts` | P: 3,48 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/rollup-read.ts` | Q: 174,177,192; P: 181,242,243 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/target-aggregate.ts` | Q: 79,82,87,115,118,139; P: 64 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/target-api.ts` | P: 3,37,44,46,66 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/target-read.ts` | P: 32,122,134,140 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rating/target.ts` | Q: 315,316,348,354,359,365,435,437,500 | W: raw writer plus consumers |
| `services/main/src/modules/reading-position/boundary.ts` | P: 44,190 | writer/reader reference; classified by kind above |
| `services/main/src/modules/reading-position/contract.ts` | P: 43 | writer/reader reference; classified by kind above |
| `services/main/src/modules/reading-position/errors.ts` | P: 16 | writer/reader reference; classified by kind above |
| `services/main/src/modules/reading-position/read.ts` | Q: 95 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realization/command.ts` | Q: 84,106,111,122,130,132,137 | W: raw writer plus consumers |
| `services/main/src/modules/realization/outbox-event.ts` | P: 17 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realization/read.ts` | P: 35 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-admin/history.ts` | Q: 28,109 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-directory/contract.ts` | P: 22 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-directory/index.ts` | Q: 121,225,240; P: 64,69,73,74,85,187,188,206,266,268,300,304,305,313,322,325 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-directory/read.ts` | P: 87,89 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-directory/source.ts` | Q: 47,86,117 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-profile/commands.ts` | Q: 40,49,56,69,97,98,253,256,264,348,350,360; P: 300,398 | W: raw writer plus consumers |
| `services/main/src/modules/realm-profile/outbox-event.ts` | Q: 26; P: 37 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reads/public-decision-index.ts` | Q: 67,82,91; P: 240 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reads/read-contract.ts` | P: 12,36,53,57 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reads/read-realm.ts` | P: 101,132 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reads/read-zone.ts` | P: 45 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reply/graph.ts` | Q: 47,92,94,100,102,106,126,128,134,136,140,276,280,306,321,323,331 | W: raw writer plus consumers |
| `services/main/src/modules/realm-reply/outbox-event.ts` | Q: 44,55; P: 89 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reply/thread-contract.ts` | P: 89 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reply/thread-read.ts` | Q: 53; P: 117,497 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-reply/thread-store.ts` | P: 85 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-submission/graph.ts` | Q: 50,78,81,87,89,95 | W: raw writer plus consumers |
| `services/main/src/modules/realm-submission/outbox-event.ts` | Q: 30,66; P: 42,76 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-submission/reads.ts` | P: 73 | writer/reader reference; classified by kind above |
| `services/main/src/modules/realm-submission/resource.ts` | Q: 104 | writer/reader reference; classified by kind above |
| `services/main/src/modules/recommendation/derived-generation.ts` | P: 206,209 | writer/reader reference; classified by kind above |
| `services/main/src/modules/recommendation/generation-schema.ts` | P: 55,58,77,99,100,105 | writer/reader reference; classified by kind above |
| `services/main/src/modules/recommendation/ranking-schema.ts` | P: 47,61 | writer/reader reference; classified by kind above |
| `services/main/src/modules/recommendation/ranking.ts` | P: 149,217,241,279,286,357,465,467,477,503,505,532,535,591 | writer/reader reference; classified by kind above |
| `services/main/src/modules/recommendation/zero-candidates.ts` | Q: 10,31 | writer/reader reference; classified by kind above |
| `services/main/src/modules/relation/change.ts` | Q: 456,585; G: 454,464; P: 592 | writer/reader reference; classified by kind above |
| `services/main/src/modules/relation/schema.ts` | G: 60 | writer/reader reference; classified by kind above |
| `services/main/src/modules/relation/traversal.ts` | Q: 111; P: 57,548 | writer/reader reference; classified by kind above |
| `services/main/src/modules/release/command.ts` | Q: 114,148,152,160,167,169,174 | W: raw writer plus consumers |
| `services/main/src/modules/release/outbox-event.ts` | P: 28,73 | writer/reader reference; classified by kind above |
| `services/main/src/modules/release/read.ts` | P: 434 | writer/reader reference; classified by kind above |
| `services/main/src/modules/review/contract.ts` | P: 42 | writer/reader reference; classified by kind above |
| `services/main/src/modules/rights/offering.ts` | Q: 75,147,179,181,186,188,191,208,215,243,245,258,262,271,314,322,334,342 | W: raw writer plus consumers |
| `services/main/src/modules/rights/outbox-event.ts` | P: 34 | writer/reader reference; classified by kind above |
| `services/main/src/modules/safety-queue/store.ts` | P: 223 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search-disclosure/private-continuation.ts` | P: 6,49,65 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search-disclosure/public-fields.ts` | Q: 69; P: 45,66,115,122,147,153,245,258,289 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/card-window.ts` | P: 11 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/fields.ts` | Q: 82,173; P: 131,176 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/labels.ts` | P: 19 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/name-preferences.ts` | Q: 66,69,74,77,79 | W: raw writer plus consumers |
| `services/main/src/modules/search/names.ts` | Q: 77,79,83,85,87,129,130,135,139,141,195,196,199,201,203 | W: raw writer plus consumers |
| `services/main/src/modules/search/ranked.ts` | Q: 92; P: 98,183 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/ratings.ts` | P: 50,51 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/result-cards.ts` | P: 52,53,173,177,184,185 | writer/reader reference; classified by kind above |
| `services/main/src/modules/search/snapshot.ts` | Q: 23; P: 28 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/admitted.ts` | G: 11,115 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/change.ts` | Q: 518; G: 15,516,536,567 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/command.ts` | Q: 73,137,150,152,156,158,176,178,182,184,218,222,228,230,324,326,335,338,340; G: 11,300,306,328,359 | W: raw writer plus consumers |
| `services/main/src/modules/semantic/finite-rule.ts` | G: 43,137,194 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/generation-guard.ts` | Q: 55,58,86,89; G: 18,26,27,28,39,76,85,86,88,89,90,94 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/model-custody.ts` | G: 177,302,394 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/outbox-event.ts` | Q: 29,82,142; G: 32,80,109,141,168,175; P: 46,106,172 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/read.ts` | Q: 50; G: 22,50,82; P: 26,85 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/reasoning.ts` | G: 39,51,85,86,113 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/schema.ts` | G: 36,37,75,124,192 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/stage-schema.ts` | G: 24,50,61 | writer/reader reference; classified by kind above |
| `services/main/src/modules/semantic/staging.ts` | Q: 354,451,490,492,501,504,510; G: 13,122,123,131,137,273,300,312,319,324,326,330,332,414,418,449,512,527,530,536,537,540,547,558,606,610,636,642; P: 419 | W: raw writer plus consumers |
| `services/main/src/modules/source/author-credit.ts` | P: 129,130 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/child-native-support.ts` | P: 130,131 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/child-native.ts` | Q: 54,117,118,125,133,135,139 | W: raw writer plus consumers |
| `services/main/src/modules/source/child-recovery.ts` | Q: 71,87,89,162,171,205; P: 23,41,42,43,59,60,220,222 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/child-retirement.ts` | Q: 44,98,99,108,110,114; P: 57 | W: raw writer plus consumers |
| `services/main/src/modules/source/field-control-native.ts` | Q: 157,159,169,177,188,190,195 | W: raw writer plus consumers |
| `services/main/src/modules/source/graph-projection.ts` | Q: 85,87,97,99,106,180,193,232; P: 27,116,123,124,148,149 | W: raw writer plus consumers |
| `services/main/src/modules/source/native-work-adoption.ts` | P: 56,130,289,554,600,601 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/native-work-proposal.ts` | P: 27,35,52,53,94,100 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/outbox-event.ts` | P: 46,87 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/reconcile-author-credit-retirement.ts` | Q: 90,92,96,105; P: 22,23,24,41,50,120,121 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/reconcile-author-credit.ts` | Q: 99,106; P: 26,27,50,57,58 | writer/reader reference; classified by kind above |
| `services/main/src/modules/source/reconcile-restored.ts` | Q: 109,111,119,128; P: 40,41,42,139,140 | writer/reader reference; classified by kind above |
| `services/main/src/modules/space/create-zone.ts` | Q: 127,129,149,154,160,170,174,181 | W: raw writer plus consumers |
| `services/main/src/modules/space/create.ts` | Q: 119,223,225,242,246,256,260,267,306,308,314,318,326 | W: raw writer plus consumers |
| `services/main/src/modules/space/outbox-event.ts` | P: 38,72 | writer/reader reference; classified by kind above |
| `services/main/src/modules/space/policy.ts` | Q: 114,119,126,128,133,199,202,207,209,214 | W: raw writer plus consumers |
| `services/main/src/modules/statement/graph.ts` | Q: 294,404,542 | writer/reader reference; classified by kind above |
| `services/main/src/modules/statement/populated-conversion.ts` | Q: 27,29,113,121,173,206; P: 170,175,176,177,264 | writer/reader reference; classified by kind above |
| `services/main/src/modules/statement/read.ts` | Q: 91,252,465,628,650,727,790; P: 76,142,420,422,438,454,467,532,577,594,678,715,747,791,809,852 | writer/reader reference; classified by kind above |
| `services/main/src/modules/statement/seek.ts` | Q: 321,396,401,420; P: 223 | writer/reader reference; classified by kind above |
| `services/main/src/modules/statement/subject-read.ts` | P: 228,667 | writer/reader reference; classified by kind above |
| `services/main/src/modules/statement/upgrade.ts` | Q: 23,62,151; P: 77 | writer/reader reference; classified by kind above |
| `services/main/src/modules/structure/change.ts` | Q: 342,391,393,429,437,446,467,470,609,613,615,620,664,724,726,1593,1597,1605,1723,1726,1842,1844,1851,1884,1887,1898,1900,2285,2291; P: 1919 | W: raw writer plus consumers |
| `services/main/src/modules/structure/label-index-backfill.ts` | Q: 75,80,82,85,89 | W: raw writer plus consumers |
| `services/main/src/modules/structure/outbox-event.ts` | Q: 32,94,149; P: 65,111,177 | writer/reader reference; classified by kind above |
| `services/main/src/modules/structure/progress-outbox.ts` | P: 31,36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/structure/read.ts` | Q: 35,192,251; P: 134,151,175,231,238,287,315,369,382,475 | writer/reader reference; classified by kind above |
| `services/main/src/modules/structure/seal-read.ts` | Q: 41; P: 24,99 | writer/reader reference; classified by kind above |
| `services/main/src/modules/structure/stage-schema.ts` | P: 45,46 | writer/reader reference; classified by kind above |
| `services/main/src/modules/structure/stage.ts` | P: 29,30,41,54,55,270,316,317,338,339 | writer/reader reference; classified by kind above |
| `services/main/src/modules/studio/outbox-event.ts` | Q: 32; P: 49 | writer/reader reference; classified by kind above |
| `services/main/src/modules/studio/works.ts` | P: 88 | writer/reader reference; classified by kind above |
| `services/main/src/modules/target/resolve.ts` | Q: 79,166,375; P: 175,352,385 | writer/reader reference; classified by kind above |
| `services/main/src/modules/theme/activation.ts` | Q: 159,233,237,248,254,256,262,277,278,284,286,290; P: 203 | W: raw writer plus consumers |
| `services/main/src/modules/theme/first-party-lifecycle.ts` | Q: 238,364,366,374,383,385,393; P: 478 | W: raw writer plus consumers |
| `services/main/src/modules/theme/outbox-event.ts` | P: 53,102 | writer/reader reference; classified by kind above |
| `services/main/src/modules/theme/store.ts` | P: 20,50,51,62,100,126,148,153 | writer/reader reference; classified by kind above |
| `services/main/src/modules/verification/assessment-producer.ts` | F: 73 | writer/reader reference; classified by kind above |
| `services/main/src/modules/verification/graph.ts` | Q: 76,137,140,143,150,154,161,190,192,197,201,209,342,403,409,899,971; P: 403,409,448,449 | W: raw writer plus consumers |
| `services/main/src/modules/verification/operations.ts` | P: 144,172,581,891 | writer/reader reference; classified by kind above |
| `services/main/src/modules/verification/outbox-event.ts` | P: 44 | writer/reader reference; classified by kind above |
| `services/main/src/modules/verification/schema.ts` | P: 126,257 | writer/reader reference; classified by kind above |
| `services/main/src/modules/verification/store.ts` | P: 1615,1821,1955,1963 | writer/reader reference; classified by kind above |
| `services/main/src/modules/vote/access.ts` | P: 355,366,373 | writer/reader reference; classified by kind above |
| `services/main/src/modules/vote/graph.ts` | Q: 64,105,109,129,131,137,176,178,184 | W: raw writer plus consumers |
| `services/main/src/modules/vote/outbox-event.ts` | P: 91 | writer/reader reference; classified by kind above |
| `services/main/src/modules/web-publication/command.ts` | Q: 73,120,122,127,129,135,341,365,367,381,383,388; P: 308 | W: raw writer plus consumers |
| `services/main/src/modules/wiki/evidence.ts` | P: 112 | writer/reader reference; classified by kind above |
| `services/main/src/modules/wiki/history-read.ts` | Q: 209; P: 84,330 | writer/reader reference; classified by kind above |
| `services/main/src/modules/wiki/history-schema.ts` | P: 83 | writer/reader reference; classified by kind above |
| `services/main/src/modules/wiki/validate.ts` | P: 134 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work-activity/read.ts` | Q: 68,128,137,149 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work-contents/read-contract.ts` | P: 44 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work-contents/read.ts` | P: 148,452 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/activate.ts` | Q: 298,300,324,325,326,328,329,331,477,487,495 | W: raw writer plus consumers |
| `services/main/src/modules/work/author-credit-retirement.ts` | Q: 59,115,116,125,127,131; P: 24,72 | W: raw writer plus consumers |
| `services/main/src/modules/work/author-credit.ts` | Q: 63,94,143,145,175,176,181 | W: raw writer plus consumers |
| `services/main/src/modules/work/catalogue-import.ts` | Q: 136,167,173,191,195,201,203,213,214,218,228,229,231 | W: raw writer plus consumers |
| `services/main/src/modules/work/command-envelope.ts` | Q: 49,73,75,80,82,88; P: 16,135 | W: raw writer plus consumers |
| `services/main/src/modules/work/content-recovery-coverage.ts` | Q: 299; P: 307 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/derivations.ts` | Q: 120,147,149,155,158,161,245,389,391,400,404,411,530 | W: raw writer plus consumers |
| `services/main/src/modules/work/edit.ts` | Q: 97,151,153,158,161,167,203,205,210,212,218,355,361,370,377,379,385 | W: raw writer plus consumers |
| `services/main/src/modules/work/fixed-release.ts` | Q: 164,194,196,202,204,207,318,320,330,336,339,345,475; P: 70,140,517 | W: raw writer plus consumers |
| `services/main/src/modules/work/history.ts` | Q: 308,364; P: 32,45,339,391 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/merge-command.ts` | Q: 13,35,37,40,45,48 | W: raw writer plus consumers |
| `services/main/src/modules/work/metadata-command.ts` | Q: 35,96,141,150,169,176,178,183,281,314,321,337,344,346,351; P: 79,118,119,425 | W: raw writer plus consumers |
| `services/main/src/modules/work/metadata-read.ts` | P: 56,136,162 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/organization-publication-evidence.ts` | Q: 58 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/outbox-event.ts` | Q: 27; P: 40 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/read-contract.ts` | P: 89,92,147 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/read-header.ts` | P: 65,116 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/read-rating.ts` | P: 74,87,88,96 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/read-session.ts` | Q: 298; P: 92,105,247,394,435 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/read-stats.ts` | P: 39,134 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/receipt.ts` | Q: 36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/reconcile-derivation.ts` | Q: 165,169,177,197,222,226; P: 24,29,30,31,133,135,146 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/reconcile-fixed-release.ts` | Q: 155,161,164,171,199; P: 37,38,39,122,124,135,233,234 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/reconcile-restored.ts` | Q: 98,204,222,225,230,236,323,359,368,372,381,400,423,425,536,541,550,554,563,575,630,649,651,679,681,683,804,814,818,827,850,876,879,1013,1023,1027,1036,1049,1071,1073,1178,1187,1189,1197,1208,1239,1241,1424,1443,1446,1455,1480,1512,1514,1561,1625,1646,1648,1748,1771,1773,1896,1908,1912,1921,1940,1964,1966,2133,2174,2177,2185,2204,2257,2466,2473,2491,2495,2506,2507,2546,2572,2578,2583,2733,2738,2747,2751,2760,2772,2794,2797,2800,2914,2928,2932,2942,2953,2973,2976,3096,3111,3115,3125,3142,3160,3163,3294,3306,3310,3320,3337,3355,3358,3531,3543,3564,3568,3577,3612,3630,3635,3638,3855,3874,3878,3887,3930,3950,3953,4123,4133,4137,4146,4181,4199,4202,4429,4433,4441,4449,4491,4655,4662,4666,4674,4698,4738,4757,4761; P: 135,136,272,276,277,278,301,310,317,473,474,475,505,512,730,731,732,767,775,919,920,921,973,981,1107,1108,1109,1146,1156,1279,1280,1281,1350,1351,1364,1591,1599,1706,1714,1812,1813,1814,1856,1864,2083,2098,2099,2304,2305,2306,2366,2380,2623,2624,2625,2698,2706,2843,2844,2845,2886,2894,3023,3024,3025,3065,3073,3211,3212,3213,3258,3265,3401,3402,3403,3496,3503,3689,3690,3691,3794,3802,4011,4012,4013,4077,4085,4308,4309,4310,4381,4388,4527,4532,4533,4534,4615,4626; S: 47,271,279,427 | W: raw writer plus consumers |
| `services/main/src/modules/work/reconcile-slim-metadata.ts` | Q: 135,150,196,199,209; P: 102,104,111,112,152,202; S: 3,22,40,72,78,79,153,159,163,189,202,226,230,231 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/reconcile-title-control.ts` | P: 23,24,60,65 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/reject-realm.ts` | Q: 89,169,171,178,182,189,289,294,313,325,329,338 | W: raw writer plus consumers |
| `services/main/src/modules/work/restore-lineage.ts` | Q: 194,299,479,531,534,541,543,565,769,778,783,819,822; P: 57,58,76,78,85,94,95,103,106,155,159,161,214,217; S: 12,72,86,87,96,104,114,167,172,173,210,298,300,304,306,310,314,322,544,596,761,765 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/seal.ts` | Q: 37,39,46,50,57 | W: raw writer plus consumers |
| `services/main/src/modules/work/search-continuation.ts` | P: 13,47,78,79,80,81,101,102,103,104,110,111,112,122,128 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-disclosed-fields.ts` | P: 44 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-facets.ts` | Q: 33; P: 42,102,105 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-grouped-rated.ts` | Q: 71; P: 53,274 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-grouped.ts` | Q: 252,344; P: 143,150,151,152,258,288,295,301,315,316,320,323,329,346,347,373,374,402,414,431,432,476,478,483 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-joined.ts` | Q: 74; P: 336 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-multifield.ts` | Q: 52; P: 135 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-presentation.ts` | Q: 26; P: 15,35,43,64 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-public.ts` | Q: 71,246,365,470; P: 222,354,397,401,412,417,423,471,479,481,491,492,510,530,531 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-readiness.ts` | Q: 177,227,361,370; P: 187,206,318,330,358,370,384 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/search-supports.ts` | Q: 31; P: 55,63 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/select-main.ts` | Q: 85,164,166,173,177,184,320,326,335,349,372,376,384 | W: raw writer plus consumers |
| `services/main/src/modules/work/select-realm.ts` | Q: 107,195,197,204,208,216,369,374,397,420,424,433 | W: raw writer plus consumers |
| `services/main/src/modules/work/serial-projection.ts` | P: 461,499,595,607 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/summary-serial.ts` | P: 28,29,52,58,59,60 | writer/reader reference; classified by kind above |
| `services/main/src/modules/work/title-control.ts` | Q: 607,636,637,641,643,646,711,715,725,728,735,737,740,757,759,761,764,768,769 | W: raw writer plus consumers |
| `services/main/src/modules/work/translation-links.ts` | Q: 86,198,227,229,236,239,242 | W: raw writer plus consumers |
| `services/main/src/modules/zone-browse/store.ts` | Q: 88,149; P: 220 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone-modules/browse.ts` | Q: 186; P: 213 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone-modules/contract.ts` | P: 53 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone-modules/editor-lists.ts` | P: 94 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone-modules/genres.ts` | P: 84 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone-modules/read.ts` | Q: 78,175 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone-modules/replies.ts` | Q: 40 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone/configuration.ts` | Q: 273,278,645,654,672,680,684,690 | W: raw writer plus consumers |
| `services/main/src/modules/zone/outbox-event.ts` | Q: 27,31,72; P: 45,81 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone/owner-create.ts` | Q: 131,133,146,155,159,167; P: 35 | W: raw writer plus consumers |
| `services/main/src/modules/zone/query-budget.ts` | P: 13,22,36 | writer/reader reference; classified by kind above |
| `services/main/src/modules/zone/realm-attachment-withdrawal.ts` | Q: 27,43,48,55,62,63,116,119 | W: raw writer plus consumers |
| `services/main/src/modules/zone/route.ts` | Q: 95; P: 47,127,426 | writer/reader reference; classified by kind above |
| `services/main/src/operations/backpressure.ts` | Q: 112 | writer/reader reference; classified by kind above |
| `services/main/src/routes/agents.ts` | P: 37,42 | writer/reader reference; classified by kind above |
| `services/main/src/routes/catalog.ts` | P: 49 | writer/reader reference; classified by kind above |
| `services/main/src/routes/catalogue-candidates.ts` | P: 31,41,50 | writer/reader reference; classified by kind above |
| `services/main/src/routes/classification.ts` | P: 54,72,100,154,232 | writer/reader reference; classified by kind above |
| `services/main/src/routes/collection-grain.ts` | P: 22 | writer/reader reference; classified by kind above |
| `services/main/src/routes/collections.ts` | P: 60,63,66,167,274,307,378 | writer/reader reference; classified by kind above |
| `services/main/src/routes/composition-reads.ts` | P: 28,30 | writer/reader reference; classified by kind above |
| `services/main/src/routes/compositions.ts` | P: 114,122,142,187,233,499,524,541,560 | writer/reader reference; classified by kind above |
| `services/main/src/routes/content.ts` | P: 102,396 | writer/reader reference; classified by kind above |
| `services/main/src/routes/contexts.ts` | G: 193,210; P: 2,104,106,114,130,156,167,171,175,241,259,319 | writer/reader reference; classified by kind above |
| `services/main/src/routes/contributions.ts` | P: 74,104,142 | writer/reader reference; classified by kind above |
| `services/main/src/routes/dependencies.ts` | S: 179 | writer/reader reference; classified by kind above |
| `services/main/src/routes/events.ts` | P: 31,35,38,96 | writer/reader reference; classified by kind above |
| `services/main/src/routes/graph-queries.ts` | P: 54,65,77,144,204 | writer/reader reference; classified by kind above |
| `services/main/src/routes/health.ts` | P: 99,100 | writer/reader reference; classified by kind above |
| `services/main/src/routes/lexicon.ts` | Q: 213; G: 90; P: 81,91,349 | writer/reader reference; classified by kind above |
| `services/main/src/routes/library.ts` | P: 2,37,44,46,55,60,71,80,149,151,185 | writer/reader reference; classified by kind above |
| `services/main/src/routes/member-replies.ts` | P: 37,40 | writer/reader reference; classified by kind above |
| `services/main/src/routes/operations.ts` | S: 76,78 | writer/reader reference; classified by kind above |
| `services/main/src/routes/package-install-requests.ts` | P: 24 | writer/reader reference; classified by kind above |
| `services/main/src/routes/polls.ts` | P: 28,108 | writer/reader reference; classified by kind above |
| `services/main/src/routes/post-identification.ts` | P: 23,26 | writer/reader reference; classified by kind above |
| `services/main/src/routes/posts.ts` | P: 21 | writer/reader reference; classified by kind above |
| `services/main/src/routes/pro-sites.ts` | P: 22 | writer/reader reference; classified by kind above |
| `services/main/src/routes/profiles.ts` | P: 172 | writer/reader reference; classified by kind above |
| `services/main/src/routes/progress.ts` | P: 162 | writer/reader reference; classified by kind above |
| `services/main/src/routes/projections.ts` | P: 74 | writer/reader reference; classified by kind above |
| `services/main/src/routes/protection.ts` | P: 78,139 | writer/reader reference; classified by kind above |
| `services/main/src/routes/publication.ts` | P: 124,140,167,203 | writer/reader reference; classified by kind above |
| `services/main/src/routes/query.ts` | P: 3,61,63 | writer/reader reference; classified by kind above |
| `services/main/src/routes/rating-global.ts` | Q: 111; P: 5,26,55,90,125 | writer/reader reference; classified by kind above |
| `services/main/src/routes/rating-question-presentations.ts` | G: 48; P: 2,39,49,262 | writer/reader reference; classified by kind above |
| `services/main/src/routes/ratings.ts` | P: 168,199,221,405,418,439,471 | writer/reader reference; classified by kind above |
| `services/main/src/routes/reading-positions.ts` | P: 22,25,75 | writer/reader reference; classified by kind above |
| `services/main/src/routes/realizations.ts` | P: 42,54 | writer/reader reference; classified by kind above |
| `services/main/src/routes/realm-profile.ts` | P: 14 | writer/reader reference; classified by kind above |
| `services/main/src/routes/realm-reply-threads.ts` | P: 42 | writer/reader reference; classified by kind above |
| `services/main/src/routes/recipes.ts` | P: 45,278,319,327,341,355,372,432,458,486,537 | writer/reader reference; classified by kind above |
| `services/main/src/routes/relations.ts` | P: 27,38,111,150 | writer/reader reference; classified by kind above |
| `services/main/src/routes/releases.ts` | P: 72,83 | writer/reader reference; classified by kind above |
| `services/main/src/routes/resource-relations.ts` | P: 33,51,98,108 | writer/reader reference; classified by kind above |
| `services/main/src/routes/reviews.ts` | P: 194 | writer/reader reference; classified by kind above |
| `services/main/src/routes/safety-cases.ts` | P: 37 | writer/reader reference; classified by kind above |
| `services/main/src/routes/search-generations.ts` | P: 21 | writer/reader reference; classified by kind above |
| `services/main/src/routes/search.ts` | P: 201,230,242,266,279,286,310 | writer/reader reference; classified by kind above |
| `services/main/src/routes/semantic.ts` | G: 34,38,80; P: 31,36,38,81,126 | writer/reader reference; classified by kind above |
| `services/main/src/routes/source-supports.ts` | P: 78,123,144,152,829 | writer/reader reference; classified by kind above |
| `services/main/src/routes/sources.ts` | P: 174,187,212 | writer/reader reference; classified by kind above |
| `services/main/src/routes/spaces.ts` | P: 43,86,99 | writer/reader reference; classified by kind above |
| `services/main/src/routes/studio.ts` | P: 79,129,166,173,191,241 | writer/reader reference; classified by kind above |
| `services/main/src/routes/themes.ts` | P: 42 | writer/reader reference; classified by kind above |
| `services/main/src/routes/web-publications.ts` | P: 34 | writer/reader reference; classified by kind above |
| `services/main/src/routes/wiki.ts` | P: 43 | writer/reader reference; classified by kind above |
| `services/main/src/routes/work-metadata.ts` | P: 54,68,82,98,107 | writer/reader reference; classified by kind above |
| `services/main/src/routes/works.ts` | P: 51,127,259,298,324 | writer/reader reference; classified by kind above |
| `services/main/src/routes/zones.ts` | P: 68,73,77,149,151,217,232,301,444,518,540,636,666,681,715 | writer/reader reference; classified by kind above |

## Final size and opening recommendation

- **Current-function slice:** 8 sessions, 1 S + 7 M, explicit implementation/caller sites in A1–A8, eight new tests and existing qualification files, 0 native changes/builds, 0 mandatory migrations for fixed-owner adapters; a separate Discover coverage column is conditional.
- **Enumerated semantic-convergence plan:** 36 table slots; after explicitly splitting C24/C25, **40 sessions** (8 S + 32 M planning slots). This includes the eight A fixes. B1 and further owner gaps are excluded, so this is a backlog size, **not a promise that 40 sessions finish all C3**.
- **Strict global-counter retirement added:** 21 M writer waves, **79 raw builder files**. Combined enumerated budget: **61 sessions** (8 S + 53 M), before B1/unresolved owner work. The waves overlap C02/C11/domain writers; coalescing a proved small duplicate reduces this budget. Conversely a restore path or insufficient bounded owner proof requires splitting; do not pretend this estimate is measured.
- **Native work:** four definite native specifications C01–C04; C10 adds selected-model validation. Six named production Java files change across C01–C04 (CommandInvariant, CommandPolicy, CommandService, MetadataRestorePolicy, StatementRestorePolicy, StatementUpgradePolicy) and additional registry/index work depending on C10/B1. Twelve native reference files is the audit set, not twelve required changes. Build/qualify the shared image at activation; several tasks can share it.
- **Migrations:** 0 demonstrated mandatory migrations merely for preserving immutable proof evidence or binding fixed Main consumers; up to 6 named conditional owner changes (notification cursor scope only if generalized, semantic stage, Realm directory, Discover coverage, derived generation basis, permanent Realm history boundary). Their exact necessity is not established. Existing migration files stay historical; add free-number migrations rather than editing applied ones.
- **Files/tests:** the only exact complete-system counts established are the census and 79 raw builders. The consumer plan names concrete sites and capability tests, but a unique final touched-file/test total is unresolved because dependency protocol, owner splits and migration necessity are unresolved. Count it from final briefs before approving full pre-opening work; do not call all census files modifications. Every executable item names its existing/new acceptance proof; no acceptance ID is claimed green by this analysis.

**Recommendation: defer broad C3 convergence; implement A1–A8 and preserve exact
evidence formats.** There is no proven opening-dependent immutable-data rewrite
cost to buy off with a new format now. The real deferred cost is more bounded
replay/rebuild work and owner-specific cutover qualification, whose populated
duration remains unmeasured. A complete pre-opening convergence would be many
sessions, with unresolved design input; it is not the eight-session defect slice.
