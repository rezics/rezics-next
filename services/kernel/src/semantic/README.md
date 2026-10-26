# Semantic

This module owns subject facts and their item projections, partition paging, and immutable definition releases with editorial activation history.

## Authorization

Semantic writes use the route action and authority below. When the authority and target are in different partitions, the route binds a server-owned anchor, validates it, and evaluates Access before checking out the target command partition. Same-partition checks stay on `authorizeCommand`. Community Context anchors are looked up by `(route, context_id)` at command time; the Global Context anchor verifies the seeded global row. Context creation uses the parent creation authorization path.

| Semantic write                     | Action                 | Authority anchor                           |
| ---------------------------------- | ---------------------- | ------------------------------------------ |
| Subject creation                   | `subject:create`       | Global Context                             |
| Subject merge                      | `subject:merge`        | Global Context                             |
| Subject moderation: hide           | `moderation:hide`      | Global Context                             |
| Subject moderation: take down      | `moderation:takedown`  | Global Context                             |
| Subject moderation: restore        | `moderation:takedown`  | Global Context                             |
| Statement proposal                 | `statement:propose`    | Global Context                             |
| Candidate acceptance and rejection | `context:accept`       | Selected Global or community Context       |
| Candidate adoption                 | `context:adopt`        | Selected Global or community Context       |
| Statement moderation: hide         | `moderation:hide`      | Global Context                             |
| Statement moderation: take down    | `moderation:takedown`  | Global Context                             |
| Statement moderation: restore      | `moderation:takedown`  | Global Context                             |
| Bulk write request                 | `subject:batch_write`  | Global Context                             |
| Each bulk create command           | `subject:create`       | Global Context                             |
| Each bulk proposal command         | `statement:propose`    | Global Context                             |
| Definition publication             | `definitions:publish`  | Global Context                             |
| Definition activation              | `definitions:activate` | Global Context                             |
| Community Context creation         | `context:create`       | Global Context parent, with creation proof |

## Cost

These bounds follow `subject.ts`, `page.ts`, `item.ts`, `definitions.ts`, `bulk.ts`, `fences.ts`, their SQL, `http/subjects.ts`, `http/bulk.ts`, `semantic/http/definitions.ts`, and the subject/definition migrations and schema dumps; they are derivations, not measurements.
Let N be total subjects, P subjects in the anchor partition, F stored fact rows of one subject, at most 512, d page depth, s page size, i batch ids, at most 256, D definition revisions (bounding both releases and activations), and M activated vertical manifests together with the bundled catalogue. U×t is one subject's editorial history.
For several subjects, F denotes their maximum; logarithms mean `log(2 + size)`.
Rows means rows examined, including filtered rows, not just returned rows; blocks means shared blocks accessed, including index, heap, and payload blocks, rather than cache misses or elapsed time.
A B-tree point probe examines O(1) rows and O(log size) blocks; range retrieval adds its visited rows and blocks, and inserts add logarithmic index work per row.
The table gives the supported indexed access shape, not a promise that PostgreSQL always chooses it; a possible partition scan is identified explicitly.
Fact indexes have size up to N times F, so write `L = log(N(1 + F))`; with bounded F this is O(log N).
Command history can grow without new subjects: let H count receipts/outbox/write-basis rows and `C = log(2 + H)`; it cannot honestly be bounded by N alone.
For variable-size subject payloads add B shared blocks, where B is the total payload blocks read or written (including the receipt); growth checks hold B fixed. Structural validation caps decimal strings at 127 characters and time years at 16 digits, so every value has a fixed maximum size. Bounds assume fixed payload sizes; definition validation enforces a 4 MiB release limit before publishing, with 1,024 types, 4,096 properties and 64 properties per type, and validates cold reads too. A cold read is linear in the release's canonical bytes and happens once per digest per process. A warm cache, keyed by digest, serves later requests from the validated body. Those requests touch the subject's type and the properties on its facts; they do not iterate the release. Their rows, blocks and statements are constant in M.
`writeFacts` refuses more than 512 facts for one subject before SQL. Creation and slot expansion both use that path. Each slot's `log_seq` stops at 33, and only an expand row may use 33.
`pageSubjects` enforces 1 <= s <= 100 at read entry (default 25) and fetches s + 1 subjects by primary key. A batched read refuses more than 256 ids before SQL.
For batches, g is the number of nonempty partitions, at most min(i, 4096), and P is the largest touched partition; for authorization, G is resource permission rows, U membership-history rows examined, q candidate organizations, and A total Access rows.
A sourced batch has at most 100 commands. T is the number of distinct source tuples among the candidates a read would show, bounded by the statements on that page. Source-fence reads use content's `readFences`: one statement per tuple partition, at most 100 tuples, so a larger page takes `ceil(T / 100)` statements in that partition.
`subject_pkey(route, subject_id)` and `fact_pkey(route, subject_id, slot_id, log_seq)` locate a subject and one slot. `fact_label (route, subject_id, language) WHERE kind = 'label' AND operation = 'assert'` reaches label rows without the subject's other facts.
Counts below exclude the separately listed authorization cost unless a subsection includes it. A page read uses BEGIN, SET, partition SELECT, one page SELECT, COMMIT (five statements). A subject read adds one statement per slot view and one batched read per related partition.
For commands, K denotes seven framework statements per successful fresh attempt: BEGIN, two SETs, time SELECT, another SET, fence SQL, COMMIT; add one receipt SELECT when configured and the body statements below.
The fence statement updates one `core.partition` row through `partition_pkey`, inserts one `core.outbox` row per event through `outbox_pkey`, and optionally one `core.receipt` and one `editorial.write_basis` row through `receipt_pkey`, `write_basis_pkey` and `write_basis_partition_no_position_key`; their partition foreign keys probe `partition_pkey`.
Contention retries stop at three attempts; fence waits and retries use the deadline (default two seconds), so the stated counts are per attempt, with extra constant-size partition polls, rather than a claim about machine speed.

### Command and receipt

- Touches: `runCommand` reads time without a relation and 0/1 receipt by its full PK; fresh fence writes partition 1, outbox 1 (2 for bootstrap), basis 0/1, receipt 0/1 as above. Replay authorizes before receipt, returns its saved response, and skips body/fence. Grow total N and H; fix F, event count and authorization evidence.
- Bound: Fresh rows O(1), blocks O(C), statements K + 1 + body for receipted commands; replay rows O(1), blocks O(C), six framework statements, no writes.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Command and receipt stays within its bound as N grows`

### Subject creation

- Touches: `createSubject`: insert 1 `semantic.subject` via `subject_pkey`; one `insert-facts.sql` inserts F `semantic.fact` rows via `fact_pkey` and F subject FK probes; receipt stores the resolved item, fence emits 1 event. Grow total N; fix F, partition and command history size.
- Bound: Rows O(1 + F), blocks O((1 + F)L + C), two body statements, ten including receipted command; F <= 512 in `writeFacts` before any insert.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Subject creation stays within its bound as N grows`

### Anchored subject read

- Touches: `read-subject.sql` probes one subject, its latest redirect and its latest revision, and reads its non-statement facts. Each property reads that slot's compact rows or, once expanded, its current adoption and its selected candidates by key, plus at most 32 current rejections through `acceptance_current_rejected`. It does not read the slot's other candidates or `semantic.acceptance` history. HTTP then fills related labels, eligibility, visibility and redirects with one batched read per related partition. Grow the subject's history through proposals, verdicts and adoptions in Global and in a Context, and one hidden statement; the subject stays fixed. A route key adds one source-fence read for the statements shown.
- Bound: Rows O(F + 32 × properties), blocks O((F + related) log N). Semantic statements are O(related partitions), bounded by the subject's own item values. Access still runs one permission check per related id. Independent of P and U×t. F is at most 512.
- Growth check: `test/semantic/growth-reads.test.ts`: `Anchored subject read stays within its bound as the subject's history grows`

### Batch label fill

- Touches: `readLabels` takes at most 256 ids, groups them by partition, and issues one statement per partition. Each id is an exact `(route, subject_id)` pair: one `subject_pkey` probe and one `fact_label` probe. The label probe reads label rows only. Grow that partition and the total; the eight subjects stay fixed.
- Bound: Rows O(i × labels), blocks O(i log N), one statement per nonempty partition. Independent of P. i is at most 256.
- Growth check: `test/semantic/growth-reads.test.ts`: `Batch label fill stays within its bound as its partition grows`

### Partition keyset page

- Touches: `page-subjects.sql` reads s + 1 subjects by `subject_pkey` with a bound limit, then each of those rows probes `fact_label` for its label rows only. The label probe is a per-row read. `readPartition` reads one `core.partition` row. Grow the partition, the total and page depth; the check uses page size 1.
- Bound: Rows O((s + 1) × labels), blocks O((s + 1) log N), five statements. Independent of P, of d, and of facts other than labels.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Partition keyset page stays within its bound as d grows`

### Item projection and related labels

- Touches: `resolveItem` uses the facts already returned and reads no relation. Related subject labels, eligibility, visibility and redirects are one batched read per related partition, at most 256 ids, not one read per id. Property labels come from the cached release. Grow the related partitions and the total; the subject and its six related ids stay fixed.
- Bound: Projection reads no rows. Related fill rows O(i × labels), blocks O(i log N), semantic statements O(related partitions). Independent of P. Access permission checks remain one per related id and are bounded by that same fixed id list.
- Growth check: `test/semantic/growth-reads.test.ts`: `Related labels of a subject read stay within their bound as the related partitions grow`

### Definition publish

- Touches: `publishRelease`: validate/hash one body, insert 0/1 `semantic.definition_release` through `definition_release_pkey(route, digest)`, conflict does nothing; receipted command emits 1 event even on existing digest. Grow D and H; fix body size and authorization evidence.
- Bound: Rows O(1), blocks O(log D + C), one body statement, nine including command; no scan of prior releases.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition publish stays within its bound as D grows`

### Definition activate

- Touches: `activateRelease`: read 0/1 release body via `definition_release_pkey`; activation SQL reads latest head through backward `definition_activation_pkey(route, head)` then inserts 0/1 activation with expected-head conflict protection and release FK probe. Grow D; fix body size, H and authorization evidence.
- Bound: Rows O(1), blocks O(log D + C), two body statements, ten including command; stale head writes no activation and rolls back.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition activate stays within its bound as D grows`

### Definition read

- Touches: `readRelease`: a malformed digest does no SQL. A cache hit reads 0/1 digest through `definition_release_pkey` and returns the cached body; a miss reads the body, validates it, checks the digest and freezes it. The cache holds only validated, digest-checked bodies, and a release is immutable, so a hit does not read the body. HTTP authorizes the global context first. Grow D; exercise a warm and a cold cache.
- Bound: Rows O(1), blocks O(log D) on a hit. A cold read is linear in release bytes, once per digest per process. Zero or one data statement; no history scan.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition read stays within its bound as D grows`

### Active definition lookup

- Touches: `activeRelease` / HTTP active endpoint: backward activation PK probe for route 0 with LIMIT 1 reads 0/1 head; cache miss adds Definition read. Subject commands call `activeRelease` for this pointer; a cache hit adds no body read. Grow D; fix active body size and authorization evidence, exercise a cold cache. The manifest rows below bound request cost in M.
- Bound: Rows O(1), blocks O(log D), one data statement on a cache hit and two on a miss. A subject request pays this pointer; a cache hit adds no definition-body statement.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Active definition lookup stays within its bound as D grows`

### Definition bootstrap

- Touches: `bootstrapRelease`: outer latest-head probe; when absent, command repeats probe, publishes 0/1 release, inserts first activation and emits 2 events, no receipt/basis. Uses definition PKs and fence indexes above. Grow D and H; fix body size, including already-active fast path.
- Bound: Rows O(1), blocks O(log D + C), one statement if active, otherwise eleven including command; race recovery may add one head lookup after rollback.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Definition bootstrap stays within its bound as D grows`

### Typed validation

- Touches: `checkTyped` in `rules.ts` checks a supplied release and input in memory, uses the portable checks, which cache compiled validators per release/property and returns referenced item targets without fetching them; it is not wired into subject HTTP on this base. Grow D; fix supplied release, input values and cache state.
- Bound: Zero relation rows, shared blocks or SQL statements; work follows supplied statement/qualifier/reference values, with no internal input-count cap and no iteration over D releases.
- Growth check: `test/semantic/growth-definitions.test.ts`: `Typed validation stays within its bound as D grows`

### Request authorization

- Touches: Subject/definition HTTP checks call Access preparation then final resource check; no semantic relations. Default Access reads account/optional assignment by `account_pkey`/`principal_assignment_pkey`, resource grant/role-grant/denial prefixes through their temporal GiST PKs, and organization memberships through `organization_member_pkey` plus organization account PK; candidate organizations cause up to two membership statements each. Grow total N or D; hold this Access neighbourhood fixed.
- Bound: Rows O(1 + G + U + q), statements O(1 + q); temporal GiST access has a conservative O((1 + q)A) block bound, not the B-tree point-probe guarantee. Independent of N, P, d, D with Access data fixed; uncapped G, U and q exceed the criterion through evidence fan-out and permission history scans.
- Growth check: `test/semantic/growth-subjects.test.ts`: `Request authorization stays within its bound as N grows`

### Subject creation across manifests

- Touches: HTTP `createSubject` on the active release. A warm cache resolves the activation pointer and looks up datatypes for the new facts only. Grow M; fix the subject's type, fact count and authorization evidence.
- Bound: Rows, blocks and statements constant in M. In-process work touches that type and those properties through the digest cache.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`

### Statement proposal across manifests

- Touches: HTTP `proposeStatement` on the active release. A warm cache resolves the activation pointer and checks the one property on the subject's type. Grow M; fix the statement and authorization evidence.
- Bound: Rows, blocks and statements constant in M. No iteration of the release.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`

### Candidate acceptance across manifests

- Touches: HTTP `decideCandidate`. Acceptance does not load a release body. Grow M; fix the candidate and authorization evidence.
- Bound: Rows, blocks and statements constant in M.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`

### Candidate adoption across manifests

- Touches: HTTP `adoptCandidates` on the active release. A warm cache resolves the activation pointer and checks that one property on the subject's type. Grow M; fix the selection and authorization evidence.
- Bound: Rows, blocks and statements constant in M. No iteration of the release.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`

### Anchored read with related labels across manifests

- Touches: HTTP subject read. `readSubject` loads the subject's facts and calls `slotView` for each property of its type, then `readRelease` for related property labels and one batched related read per partition for related subjects. A warm `readRelease` reads the digest only. Grow M; fix the type, F, related ids and authorization evidence.
- Bound: Rows, blocks and statements constant in M. In-process work uses the type's properties and the facts' properties. A cold release read is linear in release bytes, once per digest per process.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`

### Candidate listing across manifests

- Touches: HTTP `listCandidates`. One `readRelease` per distinct candidate release, then datatypes for that candidate's fact only, plus one `slotView`. A warm `readRelease` reads the digest only. Grow M; fix the property, page size and authorization evidence.
- Bound: Rows, blocks and statements constant in M. No iteration of the release. A cold release read is linear in release bytes, once per digest per process. A route key adds one `readFences` per tuple partition among the candidates shown, T probes chunked at 100, independent of N and of the subject's history.
- Growth check: `test/semantic/expansion.test.ts`: `subject commands and reads stay within budget at 10 and at 100 vertical manifests`

### Sourced bulk write

- Proposal install hooks return replacement values and never mutate command input.
- Touches: One `readFences` statement per source-tuple partition (at most 100 tuples) before the receipt and before deduplication; one anchored media reference probe per cover; each command then pays its single-request cost plus one document insert or one media claim by key. Same-partition fence reads run inside the command. Grow N; fix the command count at the batch cap.
- Bound: O(commands × log N). At most 100 commands. No path scans a partition or table, or grows with N, U×t or M beyond index depth.
- Growth check: `test/semantic/imported-fields.test.ts`

### Source-fence disclosure

- Touches: Subject views, candidate listings, and the search source read each issue one `readFences` statement per tuple partition among the candidates that read would show. The search source read adds the same per read.
- Bound: T probes, `ceil(T / 100)` statements in a partition, independent of N and of the subject's history.
- Growth check: `test/semantic/imported-fields.test.ts`

Structural value limits bound subject payload blocks B by F for accepted inputs; shared-block growth checks keep payload size fixed.
Default authorization has separately anchored but uncapped evidence fan-out; its costs cannot be proved bounded using subject and definition counts alone.
All writes serialize on their own `core.partition.position` counter, with definitions sharing partition 0; this is a partition-local lock/counter, not a global counter across all subject partitions.
Fact/subject and activation/release joins and foreign keys stay on the same route, while related-label and Access evidence reads cross partitions as separate reads without a cross-partition join or transaction; the in-process release cache affects constants, not the cold lookup bound.
The global context is inserted once by migration and has no runtime semantic read/write path; this base has no semantic update, erasure, background projection writer or definition-history listing to cost.
