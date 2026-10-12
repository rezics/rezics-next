A Collection change cost does not depend on the Collection's size

This verdict is about proportional SQL/Fuseki **call-count growth for the retained
flat-member insert commands**. Their growth fits inserted operations and a bounded
segment split exactly; it does not establish constant elapsed time or independence
from tree height for every Collection operation. Cross-parent group moves and
deferred occurrence-search rebuilding have separate size-dependent paths below.
Those need the manager's scale-rule assessment before any fix.

## Measured statements and calls

Evidence: retained BUILD `20261012t012253-be1683-f1` (QA root
`20261012t012253-be1683`), staged `.temp/ref/command-cost-{4,16,64}.json` and
`command-cost-compare.md`. These are existing measurements, not a new QA run.
The JSON arrays contain one, one and three Collection changes, respectively.
Columns below preserve **all five commands in issuance order**, rather than
comparing medians of different batches. `k` is the number of inserts; `s` is one
when that batch splits a full segment, otherwise zero.

| Purpose / observed group | 4 cut | 16 cut | 64 cut, first | 64 cut, second | 64 cut, third | Growth and source attribution |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Inserted-target authorization/read sessions: SQL | 32 | 96 | 128 | 128 | 128 | `8k`: three `WITH access`, two `-- access`, one `WITH content`, two `SELECT access` per new target; singleton reader sessions |
| Synchronous template-seek entity projection: variable SQL | 24 | 72 | 96 | 147 | 147 | `6k + 51s`: two new subjects per insert; split adds 16 existing placement subjects and one segment; each subject uses SELECT/INSERT/DELETE |
| Remaining SQL, including fixed projection subjects, admission and settlement | 93 | 93 | 93 | 93 | 93 | Constant residual for this workload |
| **All SQL statements** | **149** | **261** | **317** | **368** | **368** | **`93 + 14k + 51s`** |
| Inserted-target reads: Fuseki POSTs | 16 | 48 | 64 | 64 | 64 | `4k`: two 604-byte requests, one 11,842-byte request and one 1,023-byte request per target |
| Changed-existing-placement consistency read: Fuseki POST | 0 | 0 | 0 | 1 | 1 | One 3,643-byte batched request for the 16 placements moved by the local split |
| Remaining Fuseki calls: owner/header, target existence, admission/receipt, boundary seek, profile lookup and command dispatch | 12 | 11 | 11 | 11 | 11 | One initial-empty case difference; includes one committing dispatch and one GET in every command |
| **All Fuseki requests** | **28** | **59** | **75** | **76** | **76** | **`11 + 4k + s + e`**, where `e=1` only for the initial-empty command |

The SQL statement-name classes exposed by the profiles reconcile to the totals:

| Recorded span name after `pg.query:` | 4 cut | 16 cut | 64 first | 64 second | 64 third | Exact fit to these samples |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `WITH access` | 13 | 37 | 49 | 49 | 49 | `1 + 3k` |
| `-- access` | 8 | 24 | 32 | 32 | 32 | `2k` |
| `WITH content` | 4 | 12 | 16 | 16 | 16 | `k` |
| `SELECT access` | 65 | 97 | 113 | 130 | 130 | `49 + 4k + 17s` |
| `INSERT access` | 23 | 39 | 47 | 64 | 64 | `15 + 2k + 17s` |
| `DELETE access` | 14 | 30 | 38 | 55 | 55 | `6 + 2k + 17s` |
| `BEGIN access` | 5 | 5 | 5 | 5 | 5 | Constant |
| `COMMIT access` | 5 | 5 | 5 | 5 | 5 | Constant |
| `SET access` | 10 | 10 | 10 | 10 | 10 | Constant |
| `UPDATE access` | 2 | 2 | 2 | 2 | 2 | Constant |

Thus 4-cut → 16-cut SQL grows by 112 and Fuseki by 31: eight additional
inserts cost 112 statements and 32 target calls, offset by the initial-empty
call. The next four inserts add 56 statements and 16 calls. With `k=16`
unchanged, a split adds 51 statements and one call. The last two batches have
different Collection sizes but **zero statement/call-count growth**.

SQL text, bind values, table names and Fuseki query bodies are deliberately absent
from telemetry ([instrumentation](../../../../packages/observability/src/runtime.ts),
`PgInstrumentation` has `enhancedDatabaseReporting: false`). `access`/`content`
are recorded database namespaces, not proof of a statement's table. The purpose
groups combine ordered span patterns and code inspection; they are not named
owner spans. Fuseki byte-size classes distinguish the repeated singleton reads,
but cannot by themselves name each query. The 93-statement and 11/12-call
residuals are not independently attributed query by query.

### Work inside the committing Fuseki call

Exactly one `fusekiCalls[].nativeWork` is non-null per command; the remaining
27/58/74/75/75 calls have no populated native-work object. This is not evidence
that their engine work is zero. The committing calls report:

| Native counter | 4 cut | 16 cut | 64 first | 64 second | 64 third | What grows |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `current_adds` | 63 | 171 | 227 | 264 | 264 | `3 + 14k + 37s + 4e` |
| `current_deletes` | 2 | 3 | 3 | 35 | 35 | `3 + 32s - e` |
| `validation_focuses` | 46 | 111 | 143 | 241 | 241 | `15 + 8k + 98s - e` |
| `revisions_adds` | 14 | 14 | 14 | 14 | 14 | Fixed revision anchor |
| `revisions_deletes` | 0 | 0 | 0 | 0 | 0 | None |
| `other_adds` | 31 | 39 | 43 | 44 | 44 | `27 + k + s` |
| `other_deletes` | 3 | 4 | 4 | 4 | 4 | Initial case, then fixed |
| `durable_commits` | 1 | 1 | 1 | 1 | 1 | One commit |
| `text_adds`, `text_updates`, `text_deletes` | 0 | 0 | 0 | 0 | 0 | No text-index mutation in this dispatch |

These formulas are exact descriptions of five samples, not independently
qualified capacity models. Focus counts include native/canonical validation;
they are not a count of Collection members read. Split deltas change 16 existing
placements' segment and position triples. Literal-byte counters also depend on
order-key lengths and lexical values: the last two commands have equal counts
but `current_literal_bytes` of 659 and 812. Fuseki bytes sent/received across all
calls are 82,030/31,872; 215,428/57,338; 282,749/70,337; 302,997/92,142;
303,313/92,312. No total-size slope for bytes or latency is identified here.

## Actual population and fit

There is **one** curated Collection, initialized empty. The seed grows it with
`works.slice(offset, min(target, offset + 16))`, then advances the same head and
appends the returned occurrences. The 64-cut profiles are three successive
commands on that same Collection, not three changes of a 64-member Collection.

| Cut / command | Members before `m` | Inserts `k` | Members after `n` | Split `s` | Public corpus Works already created |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 / first | 0 | 4 | 4 | 0 | 4 |
| 16 / first | 4 | 12 | 16 | 0 | 16 |
| 64 / first | 16 | 16 | 32 | 0 | 64 |
| 64 / second | 32 | 16 | 48 | 1 | 64 |
| 64 / third | 48 | 16 | 64 | 1 | 64 |

Derivation: [seed BUILD](../../../../tests/qa/fault-recovery/work-profile-seed-build.test.ts)
initializes the handles once and retains them across scales;
[population growth](../../../../tests/qa/support/seed-checkpoint-population.ts)
lines 106–121 caps each member batch at 16;
[corpus owner](../../../../scripts/load/work-profile-corpus.ts) lines 288–301
finishes the primary Work axis before the population axes. Its size table sets
mounted membership to 4/16/64. There is also one fixed metadata-only Recipe Work,
created by population initialization, so explicitly created root Works number
5/17/65. The public Works' Contributions and other associated resources are not
additional Collection members; this is not a census of every RDF subject/type.

For this command recipe the measured slopes are **14 SQL statements and four
Fuseki calls per inserted member**, plus **three SQL statements per additional
template-seek projection subject** and one batched Fuseki consistency read per
split. A split adds 17 projection subjects, hence 51 SQL statements. The two
equal `k=16, s=1` batches are a direct counterexample to fitting these counts
proportionally to `m` or `n`; total corpus Works are also fixed at 64 for all
three large-cut commands. Medians 149/261/368 and 28/59/76 obscure those controls.

No reproduction was needed: existing fixed-batch samples, statement classes,
native deltas and the 32-member segment implementation separate the apparent
growth. No isolated stack or new QA run was started.

## Iteration and projection paths

The Collection owner installs the `collection-membership` Structure profile;
this route delegates to the shared admitted Structure command.

| Code path | Iterated set / bound and resulting work |
| --- | --- |
| [Collection route](../../../../services/main/src/routes/collections.ts), lines 133–138, 362–375 | One Collection → Structure query; request permits 1–16 operations |
| [Admitted change](../../../../services/main/src/modules/structure/change-admitted.ts), lines 134–145; [Collection profile](../../../../services/main/src/modules/collection/structure-profile.ts), lines 18–23 | Distinct inserted targets only; each is passed to `resolveTargets` in a separate reader session |
| [Work reader](../../../../services/main/src/modules/work/read-session.ts), lines 373–411; [summary reader](../../../../services/main/src/modules/media/summary.ts), lines 486–519; [target resolver](../../../../services/main/src/modules/target/resolve.ts), lines 375–385 | Account/principal/preferences, disclosure/hydration, exact target heads and closing fences for that singleton, explaining the repeated SQL/Fuseki group |
| [Structure mutation](../../../../services/main/src/modules/structure/change.ts), lines 1272–1287, 1412–1424, 1456 | Fixed pins and resource-existence validation use submitted insert targets; one operation loop, no old-member enumeration |
| Same mutation, `ancestry`, `locate`, `membersOf`, lines 992–1006, 1063–1082, 1118–1129 | Ancestors bounded by depth 16; one indexed boundary/segment range bounded at 32 members, with cached order keys |
| Same mutation, `split`, segment-key/local-key rebalance, lines 1022–1059, 1095–1103 | Split loads/rewrites upper half of one full segment (16 existing occurrences); dense-key repair rewrites at most that segment, not the Collection |
| Same mutation, `Working.get`, diff/consistency loops, lines 880–903, 1473–1557 | Exact retained records; unchanged placements skipped; one batched graph read for changed existing placements |
| [Immutable tree](../../../../services/main/src/modules/structure/tree.ts), lookup/apply; mutation lines 1567–1574 | Changed keys and their ancestor pages; page entry/byte limits bound each page, while larger trees can increase path height |
| Mutation lines 1594–1673 | One guarded dispatch; RDF updates and validation focuses follow changed records, segments and parents |
| [Native membership validation](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/CommandService.java), lines 1913–1923; [focused list validator](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/TemplateIndexService.java), lines 809–819 | ItemList shape is intercepted: fixed list fields and at most one changed member are copied, rather than enumerating every `itemListElement` |
| [Mutation policy](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/ModelMutationPolicy.java), lines 116–146 | Scalar head/count changes avoid inbound member closure; dependent ItemLists use the bounded membership validator |
| [Native template capture](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/TemplateIndexService.java), lines 42–46; [SQL template seek projection](../../../../services/main/src/modules/query/seek-index.ts), lines 137–151 | Capture current/revision subjects in the command plan; SELECT/upsert/delete per delta entity, not per retained Collection member |

The existing [native focus test](../../../../infra/jena/command-module/src/test/java/com/rezics/jena/CompositionChangeFocusTest.java)
asserts equal validation focuses/current-graph quad reads for 16 inserts at
10/100/1,000 existing placements. This is corroborating source coverage; it was
**not rerun** here and is not Collection-specific retained-run evidence.

### Size-dependent branches outside the measured insert recipe

- **Cross-parent group move:** `height()` in Structure mutation lines 1134–1151
  walks all descendants through `segmentsOf`, `membersOf` and `get`, reached at
  lines 1213–1215 to check depth. A single move can visit a subtree containing
  most of the Collection. Its read-work variable is descendant occurrences and
  segments, not submitted operation count. This is a code-established class A
  path by the scale rule; its SQL/Fuseki slope is not measured by these inserts.
- **Deferred occurrence-search projection:**
  [OccurrenceLabelIndex](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/OccurrenceLabelIndex.java)
  lines 90–98 queues fixed state during dispatch. Later `project`, lines 122–162,
  clears retained projections and walks generation placements in batches;
  lines 145–150 also skip earlier rows with an offset on every batch. Total
  rebuilding follows population and repeated prefix traversal can add further
  work. These are background calls, absent from the measured request profiles;
  zero text mutations in the committing call do not prove free eventual upkeep.
  The manager should assess this separately under the scale rule.

Smallest bounded design: retain segment-local mutation and bounded membership
validation, batch the submitted targets in one reader session, maintain subtree
height summaries for cross-parent moves, and project changed occurrence labels
incrementally instead of rebuilding the generation (proposal only; no code changed).

## Limits and verification

Not proven: a universal size-independent Collection change, a total-member SQL
or Fuseki slope for group moves, total engine tuples visited by every query,
whole-stack/background cost, page-height behavior beyond these cuts, or a
latency/capacity guarantee. Target-reader retry/authority outcomes may change
the counts; these five profiles are successful seed commands. The staged JSON
does not independently carry member counts or operation bodies; those were
derived from the seed's deterministic command construction and issuance order.

Only this report is changed. `task docs:check` passed its 13 checker tests, then
failed solely because this report is not reachable from `docs/README.md`; the
manager can link it after review. A temporary analysis wrapper asserted the
count/native-counter fits against all five profiles successfully. No runtime QA
was necessary for the read-only analysis, and no owner path, route contract or
kernel state was changed.
