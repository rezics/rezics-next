# Search index and producer protocol: current evidence audit

Observed through 2026-10-28 12:04 UTC. This is evidence for adoption and landing decisions, not a new product
contract. The scoped Done-when conditions are **not established on main**. Development contains the original
index/relay/rebuild paths and substantial later specifications, but the required guarded producer, physical
incarnation lifecycle and default composition remain incomplete. Existing queued implementations own those gaps.

## Sources and revision boundaries

| Pin | Actual revision and use                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M   | `90ffc5216ae62d52d4534696b3e6957b9ffbe8f8`, observed main. `git ls-tree -r` contains none of `services/kernel/{src/search,db/search,test/search}` or `services/kernel/scripts/search.ts`.                                 |
| D   | `3f587a8b5494992a46d976df56d9752453a29ed4`, observed dev. All scoped Search code, tests, node scripts, `events/log.ts` and Semantic Search source are identical to audit base `34dbc5607bf58f36722fb7e252df58fc1120d541`. |
| L   | `1ac6ed6e0668f04e30025c41e59ceaf3bdee5061`, `legacy-final`; inspected with `git show`, never executed or ported.                                                                                                          |
| T   | `7ff5c2aa6034f8fbd9951cf477c040804b125f65`, local `rezics-next-discussion` reference.                                                                                                                                     |

A later ref read observed dev `79ada9bf4e15a44560c1d419b16be6041d90c998`; its scoped diff against D is empty.
The matrix retains D so its citations remain fixed while unrelated development continues.

The entire main-checkout `.temp/goal/managers/search.md` was read. Its Done-when section requires **all conditions
merged on main and passing `bun scripts/gate.ts`**, not merely accepted worker changes. Its observed SHA-256 is
`e5f17936d686a5a3758c4d1d92b1c8bb83222f0da8a466053fb8faf822a0b2fa`.
`AGENTS.md`, `tools/goal/README.md` and `services/kernel/README.md` were read for precedence and gate semantics.

Original authority: [ADR-0032](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0032-opensearch-index-tier.md),
[ADR-0033](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0033-dbos-work-and-cloudevents.md),
[ADR-0034](https://github.com/rezics/rezics-next-discussion/blob/7ff5c2aa6034f8fbd9951cf477c040804b125f65/docs/adr/0034-partition-row-tokens-cursors.md),
and partitioned-core sections 5–6 at T. Superseded self-built index designs are not additional requirements.
Later approved contracts are the D [Search README](https://github.com/rezics/rezics-next/blob/3f587a8b5494992a46d976df56d9752453a29ed4/services/kernel/src/search/README.md#L774)
and [worker harness README](https://github.com/rezics/rezics-next/blob/3f587a8b5494992a46d976df56d9752453a29ed4/services/kernel/test/search/README.md).
Physical UUID/lineage, safe no-write settlement, native structural fences, bounded sort readiness and default
composition are required current contracts, even where their implementation is explicitly staged unavailable.
They are not new proposals discovered by this audit.

Below, `D:src/...`, `D:test/...`, `D:db/...` and `D:scripts/...` mean paths under `services/kernel/` at D;
other pins use the same convention. Line numbers identify inspected source, not inferred future implementations.
Current and legacy repository root `LICENSE` files specify AGPL-3.0; T has no top-level licence file. This report
summarizes those sources without copying implementation. ADR-0032 identifies OpenSearch as Apache-2.0; no external
project was cloned, installed or executed. API/disclosure implementation is considered only at producer, freshness,
generation and real-worker proof boundaries.

Classification: **proven** means the stated source property or specifically recorded runtime result is established;
**contradicted** means inspected code does the opposite; **incomplete** means only part is delivered;
**indirect** means a helper/controlled fixture or older revision proves a narrower claim; **missing** means the
named artifact or required runtime evidence was not found. None implies a current whole-main pass.

## Requirement and evidence matrix

| Requirement and authority                                                                                           | Inspected proof                                                                                                                                                           | Classification at D; main                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original: one documented local OpenSearch 3.x + ICU command                                                         | `README.md:22–33`, `package.json:7`, `db/search/opensearch/Dockerfile:1–2`, `scripts/search.ts:25–37,82–143`; `scripts/check.ts:693–718`; `test/search/node.test.ts:9–51` | Proven wiring: `bun run search up`, digest-pinned 3.9.0 + ICU, bounded heap, persistent local volume, disposable check node. Current native execution incomplete; absent M.                                                                                                                   |
| Original: cjk-bigram-v2 is actual index settings, no stored-value folding                                           | `db/search/indices/subjects.json:2–45,66–94`; `src/search/indices.ts:34–46`; `src/search/document.ts:69–87`; L assembler and analyzer test below                          | Proven source chain: NFKC_CF before standard tokenizer, Han/kana folding, bigrams, CJK stopwords. `cjk_bigram_v2` is the settings identifier for the logical hyphenated profile. Full mapped-field/runtime proof incomplete.                                                                  |
| Original: all legacy analyzer/token/phrase cases                                                                    | L `g585AnalyzerTest.java:60–115`; `test/search/index-definition.test.ts:12–98`                                                                                            | Proven test inventory: all eight token/normalization assertions and 17 query/expected-set cases, 15 titles. Phrase execution covers `names`; other mapped fields and original literal/language assertions are indirect.                                                                       |
| Original: one public subject document, own anchor state, no target-name fanout                                      | `src/search/indexer.ts:37–67`; `src/search/document.ts:69–130`; `src/semantic/search-source.ts:164–205,271–344`; `test/search/indexing.test.ts:134` and `facts.test.ts`   | Proven deduplication, anchor routing, own RR source snapshot, visible/nonredirect index versus delete, `_id=subject`, public source-derived fields. Actual default invalidation/source composition incomplete.                                                                                |
| Original: external partition-position versions, replay safety                                                       | `src/search/document.ts:109–130`; `test/search/node.test.ts:24–37`; `test/search/indexing.test.ts` replay/deletion cases                                                  | Proven serialization of each actual snapshot position with `version_type=external` and safe-integer refusal. Indirect replay evidence; external versions alone do not protect against delayed writes after tombstone pruning.                                                                 |
| Original: per-index/partition checkpoint advances only after visible effects                                        | `src/events/log.ts:133–159,218–248`; `src/events/compare-advance-checkpoint.sql:7–14`; `src/search/indexer.ts:68–81`; `src/search/write-actions.ts:27–100`                | Proven short snapshot/released I/O/epoch-position CAS. Contradicted for accepted 409 in actual indexer: checked winner refresh exists only in unused helper.                                                                                                                                  |
| Original: contiguous bounded relay/error behavior                                                                   | `src/events/log.ts:52–127`, `src/events/read-log.sql`; `test/log.test.ts`; Search projection tests                                                                        | Proven default 64 envelopes; gap, epoch, unknown type and invalid schema stop a valid prefix; apply failure prevents CAS, lost CAS returns busy. Durable distinction between pre-apply busy and visible lost/stopped is incomplete.                                                           |
| Original boundary: checkpoint-derived `as_of`, typed node failures and generation restart                           | `src/search/freshness.sql:2–15`, `freshness.ts:6–49`; `service.ts:194–230,330–338,378`; `opensearch.ts`; freshness/node tests                                             | Proven wiring to the selected generation's consumer; oldest unapplied timestamp or database now, absent retained next envelope errors. API-wide correctness excluded; false producer acknowledgement would invalidate this watermark premise.                                                 |
| Required: source calls <=256 IDs, every chunk visible, exact per-chunk versions                                     | `src/semantic/search-source.ts:184–191`; `src/search/indexer.ts:55`; `test/search/indexer-source-batches.test.ts:123–310`; `coverage-projection.test.ts:409–442`          | Contradicted: one unchunked source read. Controlled source-batch specification and real-command producer specification exist; implementation is already held work.                                                                                                                            |
| Required: native bounded sort before every write; replay into a genuinely ready new generation                      | `src/search/bounded-sort-keys.ts`; `document.ts:82`; `indexer.ts:67–68`; bounded sort and generation-readiness tests                                                      | Helper has recorded native proof; default write path omits it. Readiness migration incomplete; pending committed writer patch is not in D or M.                                                                                                                                               |
| Required: physical name + observed engine UUID + protocol + fresh consumer and durable population lineage           | `src/search/coverage.ts:1–87,107–137`; `coverage-store.ts:198–307`; `db/search/schema.sql`; `indices.ts:41–77`; initialize/lifecycle tests                                | Storage shape partly proven; runtime initialization/publication/retirement stubs unavailable. Existing-name acceptance and numeric discovery do not establish incarnation identity or known-empty provenance.                                                                                 |
| Required: durable shared enrollment before source/HTTP; no lock/client held across external I/O                     | Search README:918–939,962–1066; `coverage-projection.ts:1–13`; `indexer.ts:83–101`; `runner.ts:83–91`; projection/writer tests                                            | Incomplete: exact-once optional hook exists, coordinator throws, runner bypasses it. Raw core CAS does not serialize sink effects. The old rebuild also retains an advisory-lock client across HTTP (`generations.ts:86–104,196–204`); lifecycle replacement must satisfy the newer contract. |
| Required: safe abort, no-anchor skip, ambiguous non-expiry, actual advanced/lost/stopped settlement                 | Search README:983–1050; `coverage-store.ts:318–379`; `coverage-no-write.test.ts`; `coverage-projection.test.ts:263–407`                                                   | Contradicted/incomplete store prerequisite: no-write method throws; only completed slots can be replaced; visible source without structural fence is rejected by current codec/schema. Stopped pending correction exists, described below.                                                    |
| Required: real native home/basis, committed structural event fences, pending-zero and ordinary-lag preservation     | Search README:904–955,1041–1050; certification/canonical/projection tests; native Semantic boundary                                                                       | Incomplete. D lacks `src/semantic/identity-basis.ts` and `identity-maintenance.ts`; no substitute tuple or snapshot-head fence is permissible. Store comparisons alone cannot supply native proof. Existing Semantic dependencies remain dependencies.                                        |
| Required: old writers cannot defeat delete retention; unknown requests quarantine/fresh recovery                    | Search README:934–960,1033–1050; `coverage-writers.test.ts:172–307`; canonical cases:199–242                                                                              | Contradicted for raw runner; staged two-process native schedule and actual-pruning probe exist. Process failure or elapsed lease never establishes no dispatch/completion. No passing integrated native evidence found.                                                                       |
| Original: fresh-generation replay, per-partition count reconciliation, atomic alias publication                     | `generations.ts:105–194`; `reconcile.sql`; `test/search/generations.test.ts:81–235`; rebuild-limits tests                                                                 | Proven original algorithm/source: bounded rounds/concurrency, quiet head/checkpoint bracket, mismatch/timeout refusal, one remove+add `_aliases` request. Controlled source + real engine is indirect; no canonical membership/UUID certification.                                            |
| Required: missing AND extra keys, resumable bounded population, no gap jumps; zero hits never certify unknown state | Search README:918–929; `coverage.ts:98–120`; population, certification and lifecycle tests                                                                                | Incomplete runtime; explicit unavailable stubs. Equal per-partition counts are diagnostics, not replacement proof. Bootstrap's immediate alias publication contradicts later coverage readiness.                                                                                              |
| Required: conditional activation/retirement, never-reused names, late requests cannot recreate targets              | `runner.ts:67–117`; `indices.ts:41–77`; coverage-store allocation/reclaim; lifecycle tests:157–292; subject-auto-create test                                              | Original 15-minute grace/index-then-checkpoint cleanup is implemented. Shared lifecycle fencing and deployment auto-create policy incomplete; pending policy patch alone does not fence old writers or publication.                                                                           |
| Required: actual default worker, rebuild and CLI use the same guarded producer and native sources                   | `src/work/modules.ts:69–78`, `registry.ts:77–111`, `src/search/work.ts:28–41`; `scripts/search.ts:146–171`; `test/search/support/outcome-worker.ts:75–113,158–170`        | Contradicted/incomplete: Search is registered but Semantic is absent; Search mounts raw runner with unkeyed source. CLI supplies route key but uses old rebuild; no shared coordinator/certified lifecycle. Held composition/verification work already owns this.                             |
| Required: actual node/producer tests, measured work and final main/root gate                                        | Test ledger and recorded results below; Search README Cost sections:365–424,637–709,1140–1183                                                                             | Missing final integrated native and root-gate proof. Older helpers, SQL growth probes, formatting and typechecks cannot discharge it.                                                                                                                                                         |

## Legacy case accounting

Read-only reference: L `infra/jena/command-module/src/main/java/com/rezics/jena/FilteredGraphTextAssembler.java:13–41`
and [L analyzer test](https://github.com/rezics/rezics-next/blob/1ac6ed6e0668f04e30025c41e59ceaf3bdee5061/infra/jena/command-module/src/test/java/com/rezics/jena/g585AnalyzerTest.java#L60).
The D token test covers traditional Chinese five bigrams; halfwidth voiced kana; katakana/hiragana equivalence;
mixed Tokyo/kana boundary; fullwidth Latin case folding; keyword normalization order; empty input; and combining
dakuten. Its phrase table covers both Chinese spellings, the distinct index title, three katakana spellings, four
voiced-glass spellings, unvoiced crow, small/large kana distinction, two Latin spellings, Latin transliteration
negative and longer-title negative. No legacy token or phrase input/expected-set pair is absent.

L repeats that phrase matrix across `label`, `body`, `publicTitle`, `privateBody` and asserts each hit retains its
original literal and lowercased language (`:60–91`). D uses `names` only; `descriptions` and `search_text` share the
analyzer by mapping, and one English description tests `copy_to` (`index-definition.test.ts:100–138`). Thus all
**semantic case pairs are represented**, but full applicable mapped-field/original-value parity is indirect.
Smallest additional proof is the same corpus/expected sets through each current public text field plus unchanged
`_source` values; private legacy fields are not permission to add private data to this public index.

L's remaining tests (`:119–end`) concern old-profile replacement qualification, population/quarantine and a fixed
Jena rebuild probe. They are lifecycle behavior references, not extra `_analyze` cases or requirements to recreate
Jena/RDF controls. Current equivalents belong to bounded-generation and physical-coverage acceptance, still pending.

## Concrete findings, ordered by impact

1. **Raw writers can invalidate the checkpoint's visibility/coverage claim.** D `src/search/runner.ts:83–91`
   mounts the unguarded indexer; `src/events/log.ts:153,231–244` releases snapshot locks before the external effect.
   Minimal schedule: writer A holds a live snapshot at version 10; B deletes at 11 and advances; after actual delete
   version pruning A sends version 10, resurrects the document, then loses core CAS. Losing CAS cannot undo A's sink
   write. Required proof is the existing two-process `coverage-writers.test.ts:216–264` plus ambiguous-response/process
   cases: native pruning must be observed, the competing writer must be blocked before source/bulk, and unresolved
   attempts must prevent newer certification. The independent probe at `:175–205` observes 409 before pruning and 201
   after pruning, rather than assuming a short sleep proves it. This is already covered-producer/lifecycle work.

2. **A genuine 409 is accepted without proving the winner searchable.** D `src/search/indexer.ts:68–81`, especially
   `:76`, permits completion and checkpoint CAS without physical refresh. Minimal schedule: an independently written
   higher-version winner is realtime-readable but not search-visible; the relay gets a version conflict and advances
   before that winner becomes searchable. `writeIndexActions` already solves this boundary (`:95–99`) and has native
   recorded proof, but the default producer does not call it. Smallest acceptance: route that same pending-winner
   schedule through `createSubjectIndexer`, observe the actual checkpoint and require checked complete-shard refresh;
   failed/malformed refresh must leave it unchanged. Existing visibility-wiring and projection acceptance own this.
   The duplicate indexer validator also accepts wrong operation keys or success-with-error bodies (`:73–77`), which
   the shared helper rejects; reuse and test that validator rather than maintaining two contracts.

3. **A valid large envelope cannot progress through the native source.** D `src/search/indexer.ts:55` submits all
   deduplicated IDs; `src/semantic/search-source.ts:186` refuses more than 256. One admitted envelope containing 260
   same-home subject IDs therefore throws on every retry, without reaching sink or checkpoint. The independently
   verifiable acceptance already exists at `test/search/indexer-source-batches.test.ts:123–310`: <=256 per call,
   complete union/deletes, each snapshot's own version, later-chunk failure and genuine retry. Its source is controlled;
   `coverage-projection.test.ts:409–442` and `coverage-writers.test.ts:389–441` additionally require real command anchors.
   This is the existing held source-batching implementation, not a new work item.

4. **Numeric generations and equal counts can publish an unproven physical population.** D `indices.ts:41–46`
   treats an existing target as usable; `generations.ts:108–111,125–194` resumes it and compares only cardinalities;
   `runner.ts:43–51` publishes first-generation alias before replay. Minimal counterexample: an unfinished generation
   with advanced checkpoints contains wrong key B instead of visible key A in the same partition. Equal counts pass,
   no replay corrects A, and the alias switches. Recreating a numeric name with a new UUID can likewise inherit its
   consumer name. Existing `coverage-lifecycle.test.ts:83–155`, `coverage-initialize.test.ts:28–96`, population gap/resume
   tests and `bounded-generation-readiness.test.ts:341–366` expose these cases. Require exact keys/provenance and actual
   UUID/lineage before alias publication, including empty targets. Population, lifecycle and production composition
   are already queued owners; the original atomic alias request itself is present.

5. **The real default path is not the required source/composition path.** D `src/search/work.ts:37` omits the route
   key, so `src/semantic/search-source.ts:271` skips `withoutFencedEntries`; the CLI does pass a validated key
   (`scripts/search.ts:150–167`). Minimal source counterexample: an adopted imported statement has a current source
   fence and must be suppressed; the unkeyed default snapshot retains the entry. The existing real CLI fence test
   proves only the keyed CLI path. Separately, `src/work/modules.ts:69–78` has no Semantic registration, while the
   actual outcome child requires it at `test/search/support/outcome-worker.ts:107–113`; current default initialization
   cannot satisfy that guard. Smallest acceptance is the held real-source/default-worker suite with native commands,
   source fences and relation-event convergence, then the same sources through actual rebuild/CLI. Native rating
   source composition is also a held dependency; its optional adapter is not evidence of default adoption.

6. **Current storage cannot settle the producer's safe no-write and null-fence paths.** D `coverage-store.ts:324`
   only replaces completed attempts; `:368–370` throws on `settleNoWrite`; `:344` plus current schema require paired
   source/fence. Minimal cases: a source error before any mutating request leaves an enrolled slot that cannot retry;
   a link-only envelope cannot record a real skipped CAS result; a visible ordinary source snapshot without an
   observed structural event cannot record completion without inventing a fence. This is a prerequisite defect of
   the staged producer, not a claim that the raw runner currently enrolls slots. `coverage-no-write.test.ts:128–238`
   and its generated outcome cases require exact physical/home/attempt/revision CAS, reopen/replacement, preservation
   of valid certificates, null-fence completion without promotion, and rejection of ambiguous relabeling. The stopped
   committed correction below implements source changes but has no completed integrated runtime proof.

7. **Native bounded sort preparation is not in the default writer or generation readiness.** D `document.ts:82`
   emits the raw label, `indexer.ts:67–68` sends it directly, despite the implemented native helper. Minimal admitted
   name `U+FDFA` repeated 250 times expands beyond the 512 UTF-16-unit normalized-key contract; mapping input-length
   `ignore_above` is insufficient. Existing `bounded-sort-indexer.test.ts:76–end` checks actual native values, preserved
   names/versions and failure-before-checkpoint, while `bounded-generation-readiness.test.ts:269–425` checks replay,
   legacy/empty readiness, physical mapping failures and resumed old checkpoints. The stopped writer patch prepares
   keys, but neither its landing nor the separate generation migration is proved. No new cursor/API design is proposed.

## Pending committed implementation is not merged evidence

Read-only control-plane SQLite task/attempt state was checked against actual Git refs. At 12:02 UTC the sort,
node-policy and no-write attempts changed from running to **stopped**; their committed heads remained unchanged.
Older continuation JSON snapshots saying a different attempt/state were not treated as live truth. No services,
processes or queues were changed or probed by this audit.

| Existing owner slice                                           | Pinned committed evidence                                                                                                                                                     | Actual distinction                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native sort writer                                             | `8d8250d7978aab2dbaf4af75af258aec51d89845`, `src/search/indexer.ts:68–72`                                                                                                     | Stopped; calls native preparation, still one unchunked read and old 409 handling. Not in D/M.                                                                            |
| Native node auto-create policy                                 | `800f0818595375b311a149bfa4b67fa92f463d4d`, `scripts/search.ts:13,98`, `scripts/check.ts:708`                                                                                 | Stopped; adds exact ordered `action.auto_create_index=-*subjects-g*,+*` to both launch paths. No passing final native policy evidence inspected; not in D/M.             |
| Safe no-write store correction                                 | `262942298ac4ab6bf918d6a72d4fb2fc1de3aa79`, `coverage-store.ts:340–386`, codec and forward migration `db/search/migrations/20261028061011_search_nullable_observed_fence.sql` | Stopped; implements settlement, replaceable terminals and nullable observed fence. Must still prove migrated-pool tests; not in D/M.                                     |
| Generic pre-snapshot admission                                 | `9f07eb5f8fb0fb8e62689d835e3141c6afa40a4d`, `src/events/log.ts:134–166,230–241`; `test/project-snapshot-{admission,options}.test.ts`                                          | Stopped earlier. Callback occurs inside transaction before checkpoint ensure; false commits/busy, throw rolls back. Required full owner acceptance unproved; not in D/M. |
| Source batching / shared visibility wiring                     | `18ff947641f8d20a97b78f357922e0bd7fc865a9` / `87449ab8b87169c73df081306cf0150da0845474`                                                                                       | Held dependent owners; no completed implementation claimed.                                                                                                              |
| Covered producer / population / lifecycle                      | `6252f4f93fe5c6c254c4504644ced14c31d0638e` / `07afa136e26c087fb6bd402b5ed64abbcddece6d` / `febe770171a6c90cdeb98d2045aad205b59431be`                                          | Held dependent owners. Staged contracts/tests are not runtime delivery.                                                                                                  |
| Production coverage composition / bounded generation migration | `9f67236fb2123f4839d00ed30b52f97e1ae0c01d` / `ebb305b566fa9db72ef9d60a6dfb66e034e1841d`                                                                                       | Held; must adopt the same producer in runner, worker, rebuild, retirement and real fixture controls.                                                                     |

The production composition brief requires native keyed/fenced/rating/listing sources, real worker lifecycle and
clock, bounded startup maintenance without deadlocking later starters, guarded replay plus diagnostic partition
counts and certificate before atomic alias, cursor grace, conditional retirement/drain and permanent nonreuse.
These are existing acceptance dependencies, not a proposal to split another implementation from this audit.

## Test and command evidence ledger

| Named gates/tests inspected                                                                                                                                            | What they actually establish; remaining limitation                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node.test.ts`, `index-definition.test.ts`                                                                                                                             | Real configured node required, version/plugin discovery, native `_analyze`, native phrase/search and version conflict. Initial implementation command records at `171d72ee55d15b84aed16bc4da8072a33e2240b2` and `a1933b959b368d8be0b5a9fca90703afb0a4ade7` contain exit-zero kernel checks with only `$ bun scripts/check.ts` output; no per-case current coverage can be recovered from those summaries.                                                           |
| `bulk-visibility.test.ts`                                                                                                                                              | Actual recorded `bun run --cwd services/kernel check test/search/bulk-visibility.test.ts` at `02de8b52d2614e524175a6d7c12a11539e822550`: exit 0, **18 pass, 0 fail, 48 assertions**. Real pending winner, mixed two-shard writes, missing delete and negative malformed/refresh boundaries. Proves the helper, not D's producer.                                                                                                                                    |
| `bounded-sort-keys.test.ts`                                                                                                                                            | Actual recorded focused command at `3aef73ab315d0a6fc295941a88ada0544f02b0c2`: exit 0, **1 pass, 0 fail**, reported 2,471 assertions. Native normalization and pagination helper only; no default/rebuild adoption.                                                                                                                                                                                                                                                 |
| `indexing.test.ts`, `generations.test.ts`, `rebuild-limits.test.ts`, `retire.test.ts`                                                                                  | Real engine and migrated DB, but fake `SubjectSource` and manually appended outbox envelopes. Cover dedup/version/delete/replay, relay failure/pause, reconciliation mismatch/races/timeout, max three/exclusion/resume and timed grace/checkpoint deletion. They cannot prove native Semantic invalidation, coverage or default process composition.                                                                                                               |
| `rebuild-source-fences.test.ts`, `bounded-sort-indexer.test.ts`, `indexer-source-batches.test.ts`, `bounded-generation-readiness.test.ts`                              | Keyed actual CLI/source fence and malformed-key refusal; native writer and generation readiness specifications; controlled capped-source/chunk failure specification. Final integrated writer/migration runtime evidence remains missing.                                                                                                                                                                                                                           |
| `coverage-store.test.ts`, `coverage-no-write.test.ts`                                                                                                                  | Real database allocator, row/CAS/schema/retirement and no-write correction acceptance. Manually supplied tuples demonstrate storage semantics only; they do not certify actual native state. No-write is explicitly staged red on D.                                                                                                                                                                                                                                |
| `coverage-projection.test.ts`, `coverage-writers.test.ts`, `coverage-worker-child.ts`                                                                                  | Shared exact-once body, durable-before-I/O, native source, actual CAS loss/stopped valid prefix, safe abort versus applied/lost response, competing processes, observable engine pruning, 409 and >256 anchors. Runtime unavailable in D; writer specification's formatting pass never proved these cases ran.                                                                                                                                                      |
| `coverage-initialize.test.ts`, `coverage-population.test.ts`, `coverage-certification.test.ts`, `coverage-lifecycle.test.ts`                                           | Observed UUID/protocol/nonreuse; recreated/unknown empty; restartable bounded frontier, <=256 chunks and retained-log gap; real full-basis/home certification and ordinary versus structural lag; equal-count wrong IDs, late alias/certificate/HTTP retirement races. Native fixture preconditions and stubs keep delivery unproved.                                                                                                                               |
| `canonical-coverage.test.ts`, `coverage-default-worker.test.ts`                                                                                                        | Registered lossless generation/original-home event; helper AND default certificates; real A/B/C then paused ordinary hide with unchanged raw hit metadata; merge/repoint/reversal/replay, zero hits, ambiguous fresh recovery, rebuild/lineage/drain. No caller-minted readiness accepted. Both remain mandatory after smaller lifecycle tests.                                                                                                                     |
| `outcomes.test.ts`, `relation-facet-outcomes.test.ts`, `worker-outcome-adapter.test.ts`, `supervisor-lifecycle.test.ts`, `real-source-composition.test.ts`             | Wrappers require all **13** frozen Search and **6** relation-facet cases, child exit zero, zero skipped/todo. Actual child now calls `startWorker` with decorated full default list and original post-launch starters, one SDK owner per process; it does not manually replace missing Semantic. Native pause/resume/replacement stop, outage/rebuild/restart, finite convergence, sequential/concurrent ownership and startup cleanup still need integrated proof. |
| `freshness.test.ts`, `growth-query.test.ts`; `test/log.test.ts`, `test/growth-events.test.ts`; `growth-indexing.test.ts`; `test/semantic/growth-search-source.test.ts` | Existing tests inspect post-call watermark reads; real DB bounded log/checkpoint, freshness, reconcile and retirement rows/blocks; native source snapshot/history/count growth. `growth-indexing.test.ts:166–216` measures SQL directly with fixed affected partitions, not whole native rebuild work. None measures new coverage protocol.                                                                                                                         |
| Required `test/search/growth-coverage.test.ts`, `test/semantic/identity-invalidation.test.ts`                                                                          | Both named by Search README:1095–1101; absent at D. Coverage cost proof must measure actual metadata/source/external writes, statements/rows/blocks/bytes and pool retention; identity event atomicity is an existing native dependency. Missing acceptance artifacts are evidence gaps, not permission to redefine completion.                                                                                                                                     |

Recorded raw results were read from the main checkout's `.temp/goal/runs/` command-execution records, matched by
the above commands and committed heads; worker `outcome=passed` alone was not used as runtime evidence. Several
specification records explicitly report formatting/typecheck success while native execution is deferred. The
generic admission owner's recorded no-file kernel check selected **60 of 886 files in affected mode**, then lacked
a final passing acceptance record; its queued comparison was not classified as stuck or successful.

One recorded promotion is `stabilize-blocked`, pinned main base
`4031f5a86c8599ea8db9730c6b8bd9e4c218582d` and development input
`bc2d98c0652a0b68587552e2ed94bb68b86b48db`. Its actual failed command selected
`test/content/media-outcomes.test.ts`, `test/imports/identity-growth.test.ts`,
`test/imports/identity-outcomes.test.ts`, `test/imports/media-boundary-growth.test.ts`; output ends
`error: Kernel tests failed for 4 file(s):` and `Failed workspaces: services/kernel`.
This is historical failure evidence at those pins, **not** a new failure measured at D or M. No inspected result
establishes a successful root gate for the final scoped implementation. It is not a blocker for writing this report.

## Exact remaining proof obligations

- Land the existing dependencies and their unchanged native acceptance on an identified integration revision.
  Node-policy proof must exercise both actual local/check launch settings and deleted-target late bulk refusal;
  production deployment must supply the same ordered policy. Explicit creation of a fresh target must still work.
- Finish source batching, sort preparation and shared write acknowledgement in the **same** producer. Run their
  existing focused owner suites, including a real producer/checkpoint 409 schedule; retain full case counts and
  actual node identity/plugin evidence. Extend applicable public-field legacy parity evidence without adding
  private fields or copying legacy controls. No existing acceptance assertion may be weakened.
- Establish the exact no-write correction and generic snapshot admission contracts first, then native producer
  enrollment, actual CAS outcome, structural-event fencing and ambiguous quarantine. Run the existing projection
  and writer suites, including actual pruning and process-failure schedules. An ordinary unit/mock green is insufficient.
- Prove initialization, bounded resumable population, all-home certification, activation and retirement against real
  DB/source/engine; run initialize/population/certification/lifecycle/canonical suites unchanged. Demonstrate wrong
  equal-count keys, unknown/recreated empty UUIDs, retained-log gaps, max-three/monotonic nonreuse, late publication,
  unresolved old HTTP, and fresh-target recovery. Reconcile actual per-partition counts before the single alias switch.
- Prove bounded sort migration and real default adoption through `coverage-default-worker.test.ts` plus the original
  generation/rebuild-limit/retirement/CLI-fence suites. The default module list must really contain native Semantic;
  the keyed/fenced/rating/listing source and same coordinator must serve worker, rebuild and CLI. Preserve real
  clocks, source eligibility, cursor restart/grace, drain and owned-resource cleanup. Helper setup cannot stand in.
- Execute unchanged frozen API wrappers and default-worker/composition/lifecycle verification with all declared
  cases and zero skip/todo, proving native witness convergence and checkpoint-derived `as_of`. This audit does not
  discharge the separate API/disclosure audit. The harness README's description of the old manually invoked driver
  is stale at D; its required full-default-runtime proof remains valid and pending.
- Supply the two named missing acceptance artifacts above through their existing owning contracts, and measured
  coverage growth evidence. Charge actual certification's three full native basis reads, reader's two basis reads,
  4096 native-home/core captures, checkpoint/coverage points, HTTP requests/bytes and all pool work as specified in
  Search README:1140–1183. Fixed-home bounds are not measurements or engine latency claims; capacity remains unmeasured.
- Finally merge the completed implementation and unchanged acceptance onto **main**, then retain successful
  `bun scripts/gate.ts` output pinned to that main commit, with exact workspace/file/case coverage. Preserve separate
  root typecheck evidence required by the implementation contracts. Neither dev integration, stopped worker commits,
  historical helper results nor this report's existence acceptance substitutes for the original Done-when gate.

Interpretive decisions: applicable public fields replace legacy Jena field architecture; the underscore analyzer
identifier implements the hyphenated profile; later approved coverage/no-write/UUID/default contracts are required
despite staged stubs; absent native exports are dependencies rather than newly invented defects; obsolete driver prose
does not override inspected code; old gate failures are revision-specific. No unresolved product choice or authority
contradiction was needed to reach these conclusions. Recommendation: retain the original completion bar and use the
existing owner dependency chain, requesting the precise native and main-gate evidence above before declaring it met.
Across the ADRs, legacy replacement tests and current coverage contracts, the shared pattern is that source truth,
sink visibility, checkpoint progress and publication are distinct observations: evidence at one boundary cannot
silently stand in for another. Implement that pattern in the existing PostgreSQL/relay/OpenSearch stack.

Audit validation is report existence, formatting and `git diff --check` only. No tests, gates, services, installs,
builds, Docker operations or check-host commands were launched. No product file or external checkout was changed.
