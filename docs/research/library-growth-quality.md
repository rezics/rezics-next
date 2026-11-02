# Library bounded work: retained-source quality review

Research date: 2026-11-03. Owner: Commerce, for the Library Goal. This report is research and an acceptance
inventory, not a new behavior authority, a passing growth measurement or a promotion proof.

## Finding and source binding

**Current-dev complete evidence for Library Done when clauses 1, 4, 5 and 6 remains unrecorded.** There are
substantial native growth suites, but declarations, discoverable wrappers and earlier source reviews do not prove
their execution. Several frozen outcome adapters explicitly refuse missing producer or measurement bindings.
No native assertion failure, flakiness rate, successful population measurement or infrastructure startup failure
was observed in this attempt: the final launch policy prohibits acceptance, native, browser, root, worker-check
and remote-check runs. Their status is **deferred / not run**, not passed or failed.

The clean controller-retained source was `9c22ac533be07f70aa231b0f00895d969a7b3ad7`, also the attempt base and
initial worktree HEAD. Its commit subject is `fix(web): distinguish retired and queued appearance caller controls`.
The local `dev` ref observed during review was `2faf5ef76228791d6d742e045170c31cac3ed87a`; it differs from the
retained source. No merge, cherry-pick or rebase was authorized or performed. Consequently this report neither
substitutes that moving ref for the bound source nor establishes acceptance on it. Integration must record the
actual checked dev SHA alongside results. Main promotion remains parked; no proof was registered.

Decision: inventory the retained source under deferred validation, keep every unmeasured clause open, and apply
the maintainer's corrected C3 as derived static additive bounds without implementing allocation protocols.
This decision was sent with `bun tools/goal/src/cli.ts inbox send commerce info` (exit 0).

## Exact outcome authorities

The following are verbatim [Library Goal](../goals/library.md#done-when) clauses. Identifiers below refer to their
ordinal positions, not new requirements. All remain unmeasured here.

| Clause | Exact text |
| --- | --- |
| G1 | Curated and built-in Collections share identity, visibility, common members/filtering, ordering where applicable, notes, follows, export and Zone mounting. Curated duplicate occurrences stay editable; removing a mount does not delete its Collection. |
| G2 | Owners manage exclusive states, independent labels, copies/holdings and every supported progress mode, including rereads and noncontiguous completed units. Clearing one personal fact preserves other facts and their Library presence under the existing authority. Stored subject references and accepted profile meaning remain intact. |
| G3 | Definition-driven Library profiles work consistently across compatible subject types, release changes and historic reads/Undo. Generic labels and curated edits need no invented profile or state. |
| G4 | Everything, state, Liked, Continue and canonical browsing meet the adopted native owner-query/disclosure contracts. Filtering and owner-local plans work wherever the common Collection abstraction appears, with next-read owner-write visibility, honest preparation/unavailable responses and bounded native work. |
| G5 | Following, private owner counts and History use their existing owner boundaries. Public discovery contains no private Library facts; publication is explicit, never inferred from payment, import mappings or personal edits. |
| G6 | Lifecycle cleanup covers the complete owned graph and shared payload custody, with immediate terminal fencing, real participant completion and no resurrection. Ordinary exact Undo remains governed by shared deletion. |

Sole behavior authorities remain [Library and Collections](../library-and-collections.md),
[native owner queries](../library-owner-queries.md), [Continue](../library-continue.md),
[filtered lists](../filtered-lists.md), [dynamic Collections](../dynamic-collections.md),
[labels](../library-labels.md), [profile consumers](../library-profile-consumers.md),
[private follow counts](../private-follow-counts.md), [deletion](../deletion.md),
[Collection presentation](../collection-presentation.md) and [Collection source](../collection-source.md).
The [module inventory](../../services/kernel/src/library/README.md) describes source implementation;
the [terminal participant boundary](../../services/kernel/src/library/erasure-participant.md) explicitly
distinguishes implemented registration from complete cleanup. Neither inventory is execution evidence.

## Three scales, populations and physical ceilings

The [filtered-list growth contract](../filtered-lists.md#three-scale-checks) says:
“Use three geometric scales, **64, 512 and 4,096** (ratio 8; 4,096 is the growth harness cap).”
It also requires: “Keep the page's own neighbourhood fixed and write one check per axis”.
These are the owning filtering scales. Other existing Library suites have their own admitted geometric scales;
they must be retained, not silently replaced. The original personal outcome's 0/100/1000 comparison is a separate
statement-equality scenario, not a substitute for the filtering contract's native growth measurement.

**Actual seeded populations in this attempt: none; actual measured work: unavailable at every scale.** Numbers
below are source-defined fixture targets or explicitly labeled arithmetic, never observed database totals. The
eventual runner must retain per-relation populations in the hot partition, same-owner and other-owner buckets,
derived-state readiness, seeding writes and operation-induced history. A scale label alone supplies none of that.

| Source/case | Declared scale and population meaning | Fixed neighborhood / required measurement |
| --- | --- | --- |
| `specs/dynamic-collections-outcomes.test.ts:778` and `:941` | 64/512/4096 independently for population, matches, sparse, history, owner-pools and aliases | Empty complete Everything page; public sparse first/deep/final pages return 10/10/1 unique visible subjects. Measure preparation as well as reads. |
| `test/library/owner-filter-growth.test.ts` | 64/512/4096 retained completed sessions for the selected subject | Two HTTP pages, limit 2; three qualifying label/session/copy subjects. Actual candidates, pools and dependency work must be captured. |
| `test/library/collection-kind-growth.test.ts` | 64/512/4096 loop iterations, each adding a Book and duplicate Movie to the selected Collection and a Book to another Collection | Selected occurrences are source-arithmetic 1 + 2s, other occurrences s; owner/other/anonymous read mixed kind. Counts exclude prior fixture state and are not measurements. |
| `test/library/growth-personal-reads.test.ts` | Multipliers 1/4/16; 500s neighbors in each of reader, same-partition other-owner and other-partition buckets | Source-arithmetic 1500/6000/24000 unrelated rows per selected fact relation, plus probe rows and envelope history; one point or 20 results plus lookahead. |
| `test/library/follow-counts-growth.test.ts` | Multipliers 1/4/16; driver seeds 128s keys for each of four separate axes | Source-arithmetic 128/512/2048 keys. Target-followers case expects total 129/513/2049; outgoing count stays 1. Count totals are asserted outcomes, not measured cost. |
| `test/library/erasure-owned-graph-growth.test.ts` | 16/64/256; six real consumable sessions per scale, each with 100+s progress records, before terminal deletion | Source-arithmetic 696/984/2136 record calls for those six sessions. Separate unrelated-owner sweep; whole purge envelope and failed/replayed work remain in capture. |
| `specs/library-outcomes.test.ts:1103` | Seed targets 0/100/1000, plus existing fixture and mutation rows | Member insert/page, entry write/page, unit record; equal statements, nonnegative buffers. No full rows/bytes/candidate ceiling is established by this comparison. |
| `specs/library-labels-outcomes.test.ts:752` | 8/32/128 unrelated labels/assignments plus s subjects assigned to the measured label | Assignment, rename, logical delete; rows read/written, statements and buffers. Source and prefix scenarios separately require 64/512/4096. |
| `specs/library-profiles-outcomes.test.ts:794` | 64/512/4096 unrelated facts | One profile-backed entry write; equal statement, read/write row and read/write byte counts. Migration also needs actual page/receipt observations. |
| `specs/library-shelves-outcomes.test.ts:1260` | 256/1024/4096 entries, active sessions and inactive sessions requested from the driver | 60 visible subjects; first/deep/state/type/finished pages, summary, facets and personal writes. This driver explicitly lacks shaped seeding. |

Paths beginning `test/` in this report are relative to `services/kernel/`.

The physical filtering ceilings are owned by [filtered lists, Budgets](../filtered-lists.md#budgets):

- Whole common page: at most 16 reads and 128 total output slots. Per read, `1 <= s <= 100`, at most 32 leaves.
- Direct candidates `c <= min(600, 6s + 3)`; at most 6 catalogue searches and 3 owner keyset seeks. Up to three
  refill rounds remain the existing contract, not an authorization to introduce another protocol.
- Access/dependency points `16 + 8c`; PostgreSQL examined rows including removals `64 + 16c`; shared blocks at
  most six per budgeted examined row. Request bytes `64 KiB + 1 KiB*c`; response bytes `16 KiB + 4 KiB*c`.
- One-read page: at most 12 statements/backend; composed page: `8 + 4R`. One connection/backend for the page.
  Ready-result reads use at most `2s + 2` candidates and 2 index reads, with the other physical ceilings retained.
- Preparation step: at most 1000 inputs and result writes, one frontier write, 8 points/input, `64 + 16*input`
  examined rows, 16 statements/backend, 4 engine searches, one connection/backend and 4 MiB response bytes.
  Total work is linear in relevant input, and interruption rereads at most one step's input.
- Numeric counted ceilings receive no slack. The generic harness's statistical allowances do not relax them.
  Catalogue engine work includes query-tree/shard iterator steps, not merely HTTP calls or result size.

One concrete test-authority discrepancy needs owner review before claiming G4: `owner-filter-growth.test.ts:46`
uses the comment `c <= 6P+8 = 20` at P=2. Its two-page assertions allow 24 statements, 768 rows, 4608 blocks,
172032 request bytes and 196608 response bytes. The current direct contract gives c<=15 at s=2; corresponding
two-read arithmetic is 608 rows, 3648 blocks, 161792 request bytes and 155648 response bytes. The source test is
therefore insufficient to certify the current tighter candidate-derived ceiling even if it passes. No failing
execution or impossible spec pair is claimed; retain the frozen assertions and obtain the missing owning
measurement/derivation instead of treating the looser assertions as authority.

The [follow-count bound](../private-follow-counts.md#cost-bounds-and-operational-limits) requires a constant-row
indexed total read, one management evaluation (zero for resolved self), two constant-size health reads and O(log N)
indexed work independent of followers, identity-group size and history. Reconciliation/cleanup pages are <=100;
segments <=100 pages. [Library lifecycle](../library-and-collections.md#lifecycle-and-terminal-erasure) requires
strictly-before-720-hour Undo and immediate terminal fencing; a page's boundedness never proves whole-graph erasure.

## Owning suite inventory and case coverage

This is a source inventory. Every row's execution status is **not run**; no persona has a passing result here.
The suite files below are the concrete integration handoff, not a new acceptance implementation.

| Clauses | Existing kernel suites | Declared scale families / coverage |
| --- | --- | --- |
| G1, G2 | `growth-personal-reads`, `growth-personal-writes`, `growth-sessions`, `growth-members`, `growth-collections`, `growth-published-logs`, `growth-listing` | 1/4/16; personal points/pages/writes, session history, duplicate curated edits, notes, delete, publication/retraction and listing effects. |
| G1, G5 | `collection-kind-growth`, `collection-presentation-growth`, `collection-list-facts-growth`, `collection-batch-growth`, `collection-rules-growth` | 64/512/4096; kind, FULL helpers, presentation CAS/privacy, batches/transfer and saved-rule CAS/replay/denial. `collection-preview-growth` also contains native preview behavior; do not infer a three-scale measurement from its name. |
| G1, G5 | `collection-publication-growth`, `growth-curator-list`, `growth-sitemap`, `growth-sitemap-discovery` | Publication 1/4/16, curator list 64/256/1024, sitemap 256/1024/4096; retry/duplicate ordering and public/private/unlisted/deleted exclusion. |
| G1, G4 | `collection-source-native-growth`, `canonical-source-runtime-growth`, `growth-canonical-source` | Curated Source 16/64/256; canonical 64/512/4096. First/deep/negative original probes and duplicate evidence are distinct from complete common-page filtering. |
| G4 | `owner-filter-growth`, `page-growth`, `growth-preparation-native-reader` | Owner filter 64/512/4096; page 1/8/64 with independent entries/sessions/follows/other-owner axes; preparation reader 256/1024/4096. Producer completion and original failure prefixes remain separate obligations. |
| G2, G3, G4 | `label-catalogue-growth`, `label-prefix-growth`, `label-assignment-growth`, `label-assignment-command-growth`, `label-assignment-lifecycle-growth`, `label-full-growth`, `library-entry-tiles-growth` | 64/512/4096; labels, concurrency/capacity/CAS/replay, prefix windows, FULL tiles and private source boundaries. |
| G2, G4 | `shelf-active-growth`, `shelf-page-created-asc-growth`, `shelf-page-activity-asc-growth`, `shelf-page-activity-desc-growth`, `shelf-page-finished-asc-growth`, `shelf-page-finished-desc-growth` | 256/1024/4096; native active probes and fixed-order first/deep/negative readers. These do not replace the whole shelf driver or profile migration outcome. |
| G5 | `follow-counts-growth`, `follow-count-bootstrap-growth`, `growth-maintenance-history-page`, `growth-maintenance-session-page`, `growth-bulk-outcome-page` | Counts/bootstrap 1/4/16; private maintenance/history/outcome pages 256/1024/4096. Counts vary unrelated followers, targets, history and target followers separately. |
| G6 | `collection-retention-growth`, `copy-retention-growth`, `member-retention-growth`, `label-retention-growth`, `published-log-retention-growth` | Collection 1/8/64; copy/member/label/log 64/512/4096. Exact episodes, due seeks, native worker envelopes and replay are distinct from terminal completion. |
| G2, G3, G6 | `entry-due-command-growth`, `entry-due-store-growth`, `entry-retention-worker-growth`, `entry-incarnation-cutover-growth`, `entry-incarnation-precondition-growth`, `entry-restore-growth`, `entry-restore-preparation-growth`, `entry-retained-delete-growth` | Due/worker 256/1024/4096; incarnation and retained lifecycle helpers 64/512/4096. All-pool original/restore/clear evidence and exact historical replay must remain intact. |
| G6 | `erasure-owned-graph-growth`, `account-fact-purge`, `account-fact-purge-boundaries`, native retention/HTTP suites and `native-source-custody` | Owned graph 16/64/256; immediate fence, child-before-parent, shared payload custody and actual participant completion need their own original cases. |

Suite names in this table end in `.test.ts`. `growth-scales.test.ts` and `growth-loops.test.ts` inspect source
declarations/inline loops only: neither grows a database nor measures one native operation.

The five wrappers `outcomes.test.ts`, `labels-outcomes.test.ts`, `profiles-outcomes.test.ts`,
`dynamic-outcomes.test.ts` and `shelves-outcomes.test.ts` bind their unchanged originals in `specs/` through native
drivers. `follow-counts-outcomes.test.ts` additionally binds the original count suite. Required persona coverage
is owner, another authenticated viewer, anonymous and suspended/terminal, with current authorization on replay,
private-existence concealment, all Collection visibilities, release/profile variants and all supported progress
modes. Source inspection confirms these obligations, not that every growth case exercises every persona:
for example, mixed-kind reads explicitly loop owner/other/anonymous, while personal point growth authenticates
one owner. Coverage must be reported per actual case, not inherited from another suite's title.

## Missing evidence, repair outcomes and bounded next briefs

Each row is a proposal for the existing owning manager, not a dispatch or a continuation. Exact G-clause text is
above. Quoted owner text below identifies the narrower missing outcome. No overlapping Members writer is proposed.

| Clause and exact owner requirement | Reproducer or concrete missing binding | User-visible repair outcome; owner, likely paths and bounded proposal |
| --- | --- | --- |
| G1; Library and Collections: “One capability suite varies definitions and fixtures across curated, Everything, state, public/unlisted/private and mounted Zone surfaces.” | `native-dynamic-driver.ts:129-150` refuses Zone mount, export, durable bulk, projection redelivery and complete Source/Search inspection. Run deferred command A below unchanged. | Commerce/Library with existing Source and Zones owners: bind one delivered export/mount capability to the original native driver, preserving credentials and Collection identity. Likely `test/library/support/native-dynamic-driver.ts`, existing Source/Zone fixture exports. Reuse the producer owner; do not implement a second common Members path. |
| G2/G3; Goal: “Stored subject references and accepted profile meaning remain intact.” | `native-profiles-driver.ts:84,106,110,227-254` refuses legacy receipts, migration latches/crash, page transaction/EXPLAIN, original HTTP receipt observations and affected-row attribution. The 64/512/4096 profile-write case cannot certify its full SQL tuple. | Commerce/Library profile owner: one native migration page with exact pin/receipt and crash boundary, then bind the original scenario. Likely `profile-migration-*.ts` and `test/library/support/native-profiles-driver.ts`; shared affected-row capture stays with Performance. No fabricated legacy state or generated-binding edits. |
| G2/G4; filtered lists: “Each page or preparation step supplies one INTERNAL cost object with named actual candidates (including duplicates/rejects/lookahead), Access/dependency points, backend engine work and output-slot counters.” | `native-labels-driver.ts:315-336` refuses rowsWritten, peak-memory/candidate observations and reservation/point/wire observations; `native-shelves-driver.ts:170` refuses production-shaped heads/counters. | Existing Library labels/shelves owners: expose one authentic measured label page or shaped shelf population through the original driver, with candidate provenance and whole request capture. Likely those support drivers and existing label/shelf observation seams. Separate byte/affected-row producer work belongs to Performance. |
| G4; Goal: “with next-read owner-write visibility, honest preparation/unavailable responses and bounded native work.” | `native-dynamic-driver.ts:141-164` refuses durable preparation, independently shaped population, owner-plan/Search/candidate observations and state-reference repair. `owner-filter-growth.test.ts:46` also uses the looser candidate derivation described above. | Existing Members/owner-query repair owner, coordinated with Search/Semantic: deliver one missing native producer/counter binding and reproduce direct first/deep/negative limits at 64/512/4096; retain original assertions and add the missing exact physical evidence through its owning seam. Likely owner-query/Members contracts, current driver and shared capture ports. Do not open another Members implementation. |
| G4; Members preparation contract: “Charge Core time, Access, every control/body/DBOS statement and rollback within the existing per-backend, per-attempt ceiling.” | Its Cost section explicitly lacks original SQL plus Core logical phase/attempt markers. Named `first202`, `duplicate`, `quota-full retirement`, fixed-statement 40001 and real COMMIT-failure schedules remain unproven by aggregate statement attribution. | Existing Performance/Core capture owner: export authentic phase/attempt and original-occurrence provenance, then existing Library preparation owner binds those schedules. Likely `test/support/growth-*`, Core command observation seam and preparation native tests. Derive static additive prices including retry/rollback prefixes under the original deadline; no runtime funding, transfer or no-refill work. |
| G5; private follow counts: “Following counts are private.” | Count growth exists, but `follow-counts-driver.ts:187,212` refuses Auth account-operation workflow hosts. `outcome-driver.ts:1023` refuses cross-pool wire/backend attribution; original History/maintenance and account-lifecycle completion cannot be inferred from count-read growth. | Existing Accounts/Auth operation-host and Performance pool-capture owners: bind the genuine account operation and one internal-pool capture boundary, then rerun unchanged count persona/lifecycle cases. Likely count driver, Auth test-host export and shared growth capture. Commerce retains count outcomes; do not recount followers or return zero on unavailable health. |
| G6; Library lifecycle: “Acknowledgement means actual cleanup or no applicable data, never dispatch.” | `erasure-participant.md` explicitly withholds ACK until graph/locator custody closes. `native-conformance.ts:136` refuses real account-delete host; label cleanup run/page/crash observations are unavailable at `native-labels-driver.ts:380-396`. | Existing Library terminal participant owner with Accounts/Work/store owners: prove one remaining exact-locator disposition and late-delivery fence with native rollback/commit-before-ack recovery. Likely `erasure-participant.*`, producer locator hooks, shared custody APIs and existing terminal native fixtures. Keep `purge.complete` false until every participant really completes. |
| G1/G4/G5/G6; Goal: “Specified, implemented, exposed, tested and promoted are separate states; a passing local check alone does not complete a Goal.” | No authorized current-source native execution in this attempt; moving dev differs from retained source. Active repair task assignments could not be confirmed: read-only `inbox log --to commerce --grep Library --limit 12 --json` exited 1 with `Error: workers cannot read the shared manager inbox`. | Commerce manager attaches these gaps to its existing repair owners and integrates the report. The existing check owner executes original acceptance on the recorded integrated dev SHA and returns artifacts. This authorization refusal is not a product defect or startup failure; no new task, speculative repair or promotion registration is requested here. |

The older Members Cost paragraph and filtered-list preparation prose still describe child-reservation transfers.
The maintainer's current corrected C3 instruction takes precedence for this review. Those paragraphs are not a
reason to implement runtime funding or weaken any numeric bound. Adoption/reconciliation belongs to the owning
documents and existing writer; this research changes neither them nor the frozen outcomes.

## Capture boundaries and failure classification

The supported [kernel runner](../../services/kernel/README.md#tests) prepares real isolated PostgreSQL fixtures,
Auth, Access, Definitions and kernel requests. Its placement must remain intact. `outcome-driver.ts` instruments
Library-created pools as well as the shared pool. Its `native.capture` explicitly throws:
`Native cross-pool wire/backend attribution unavailable; refusing incomplete cost evidence` when internal SQL
would otherwise be incompletely attributed. Its older `measure` merges internal statement/plan lists but returns
only statements/buffers; that is insufficient for full physical filtering acceptance even when it returns.
Do not omit internal executor, History, DBOS, Access, connection setup or cleanup pools from the measured closure.

Retain actual per-repetition native plans, examined and removed rows times loops, shared blocks, client statements,
original request/response bytes and distinct backend connections. Keep independent background work separate but
bounded. Count producer-native units from their actual ports; missing counters are not zero. Retry captures must
retain success and abort prefixes, SQLSTATE 40001/40P01, failed statement, COMMIT/ROLLBACK and the successful retry.
The harness's inconclusive retry verdict is not an unconditional pass and cannot waive a stricter per-attempt bound.

| Evidence class | Actual observation here | Required disposition after integration |
| --- | --- | --- |
| Assertion failure | None executed; no failure count | Preserve original failing assertion, case/persona/scale, source SHA and exit. If it also fails on the base, label baseline failure; do not attribute it to this report. |
| Flakiness | No repeated executions; unknown | Preserve each run and forced contention schedule. Separate variable contention from consistent per-occurrence work violations; do not retry until green and discard failures. |
| Missing producer/measurement | Explicit refusal strings and absent exported ports above, from source | Keep affected clause open; hand the exact missing native binding to its existing owner. These are source gaps, not observed thrown exceptions in this attempt. |
| Infrastructure before assertions | No service/check was started | Retain exact first error and runner stage/exit; route environment failures to the existing check owner. Never describe zero assertions as a product pass. |
| Deferred acceptance | All native/growth/persona cases | Preserve the deferral explicitly. Documentation delivery success supplies no native or Goal completion evidence. |

## Commands, exits and evidence custody

No acceptance command below was executed. Exit codes, native populations, assertion totals, measured maxima,
check UUIDs and native evidence paths are **not available**, rather than zero. These exact root-relative commands
are a handoff to the supported integration runner, not instructions to bypass the launch validation policy:

```sh
# A: unchanged owning outcomes and their genuine native drivers
bun run --cwd services/kernel check test/library/outcomes.test.ts test/library/labels-outcomes.test.ts test/library/profiles-outcomes.test.ts test/library/dynamic-outcomes.test.ts test/library/shelves-outcomes.test.ts test/library/follow-counts-outcomes.test.ts

# B: all existing Library growth suites; shell expansion is deterministic in this checkout
bun run --cwd services/kernel check $(git ls-files 'services/kernel/test/library/*growth*.test.ts' | sed 's@^services/kernel/@@')

# C: representative original native physical and terminal boundaries
bun run --cwd services/kernel check test/library/owner-filter-native-closure.test.ts test/library/members-preparation-durable-native.test.ts test/library/collection-source-native.test.ts test/library/native-source-custody.test.ts test/library/account-fact-purge-boundaries.test.ts
```

Command B includes declaration guards in addition to native growth suites; their pass cannot replace the latter.
Commands A and B also include assertions that currently have explicit unavailable adapter bindings. Do not skip
them. For each actual later run, record source SHA, command, placement, exit, case/persona totals and returned
artifact paths. A path not returned by the runner is not evidence. A selected-suite command is not the complete
Library Goal or its Web visual acceptance.

The supported profile option is `GROWTH_PROFILE`, with a destination inside the workspace; remote runs return its
workspace-relative artifact. `GROWTH_PROFILE_REQUIRED=1` makes a failed/incomplete export fail rather than merely
warn. Use separate destinations under `.temp/library-growth-quality/` for each run; none exists from this attempt.
Profiles should retain relation sizes, seeding, repetitions, occurrences, attempts and background attribution.
The older personal outcome writes `.temp/library-outcome-*.json`; those statement/buffer traces alone do not
meet the filtering contract. Keep all run artifacts uncommitted.

Useful diagnostic prefixes include `Native Library dependency_unavailable:`,
`Native cross-pool wire/backend attribution unavailable; refusing incomplete cost evidence`,
`Statement count changed at scale`, `GrowthBoundError`, `GROWTH_REVIEW` and
`GROWTH_PROFILE <destination> was not written:`. Prefixes identify a classification starting point; only the
actual case, captured phase and original error establish whether failure occurred before assertions.

No code workspace, test file, package manifest or lockfile changed. Workspace typechecking and changed-test
landing commands therefore do not apply. The report's nonempty-file validation is documentation validation only;
native, growth, browser, visual, root, worker and remote acceptance remain deferred after integration.

## Earlier evidence and primary-source comparison

[Library terminal implementation review](library-terminal-native-implementation-review.md) binds its historical
inspection to `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f` and explicitly did not run native acceptance. Its statement
that Library had no terminal consumer is historical, not the current implementation inventory. The current
participant document now describes a registered participant while deliberately withholding whole-graph proof.
[Entry lifecycle native audit](library-entry-lifecycle-native-audit.md) likewise keeps lifecycle/profile native
gaps red; bearer-clock repair is not automatic-purge proof. The [growth harness review](performance-growth-harness-design.md)
is explicitly design evidence without experiments. None can be rebound to today's source by citation alone.

Primary sources inspected, without building, installing or running reference code:

| Source, local path and licence | Finding relevant to this repository |
| --- | --- |
| PostgreSQL, reused `/home/edge/projects/rezics/rezics-next/.reference/library-shelf-maintenance/postgres`, commit `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; `doc/src/sgml/perform.sgml:755-765`; PostgreSQL License in `COPYRIGHT`. [Pinned source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/doc/src/sgml/perform.sgml), [official EXPLAIN documentation](https://www.postgresql.org/docs/18/using-explain.html). | Actual per-node row counts must account for loops; output rows alone do not establish scanned work. Use native plan measurements, preserving filter removals and physical access paths. |
| Same clone/commit/licence, `contrib/auto_explain/auto_explain.c:36-49,104-107,163-200`; [pinned source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/contrib/auto_explain/auto_explain.c), [official auto_explain documentation](https://www.postgresql.org/docs/18/auto-explain.html). Sparse clone files were read with `git show HEAD:<path>`. | Analysis, buffers and nested-statement logging are explicit settings; per-session capture coverage matters. One observed application pool does not prove complete internal-pool attribution. |

The sources share a distinction between returned results, actual executor work and the scope of observation.
For Bun/PostgreSQL/DBOS/OpenSearch here, retain the existing owning runner and native fixture ports, derive a static
sum of all owner phases and failure prefixes, and bind every unit to authentic producer observations. Recommend
no upstream code transplant, modeled backend, new allocator, runtime transfer protocol or parallel Members writer.
The manager can adopt this sequencing: close measurement/producer seams with their existing owners, execute the
unchanged three-scale scenarios on integrated dev, then judge each clause from complete returned evidence.

Only the declared report changes in repository source. The sole additional write is the shared reference
`.reference/INDEX.md` entry for this PostgreSQL reuse, required for research provenance. No owner decisions were
adopted into behavior documents, no continuation was enqueued, and no main promotion or Goal completion is claimed.
