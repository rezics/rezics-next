# Realm rating order cost

This derivation covers both the complete Search traversal and the retained scored-only
`createRealmRankSource.page` compatibility port in [realm-rank.ts](realm-rank.ts). The latter's `limit` bound is
not a proxy for complete Search ordering.

## Native order primitives and complete Search readiness

`createRealmRankOrderSource.readScoredCanonicalPartition` supplies the additional scored canonical-name seek.
Search owns its binding into `realm-rating-native.ts`, complete predicate execution, merge and disclosure. The
Semantic fixed-cut ID-key rebuild inventory is separate. The bounds below cover delivered Rating source, not
integration, release, successful complete Search pages or native acceptance. The rebuild scheduling binding
described below is required before retained or invalidated homes become available.

One `createRealmRankOrderSource.observe` capture performs current Realm authorization (`A_R` statements and
`R_R` physical rows), selected-question metadata/provenance authority (`A_Q` statements and `R_Q` physical rows
for the authority alone), prior eligibility/freshness, and rank-publication observation. Its fixed SQL is:

- Question home: BEGIN, SET LOCAL, partition point read, question/label/lifecycle point joins, COMMIT: five
  statements/control statements; at most four physical metadata rows (one home and three point-joined records).
- Population home: BEGIN, partition point read, pending EXISTS, prior point read, COMMIT: five statements/control
  statements and at most three physical rows. Pending EXISTS visits at most one exact population key.
- Committed publication frontier: one statement through `realm_rank_generation_population_idx` for the exact
  question/population, at most S generation rows, S home point joins and S canonical-state point joins, S <= 4,096.
  The 4,097th row fails closed. The digest includes all selected publication generations, native epochs/positions
  and canonical coverage revisions. An uncommitted sequence increment is not publication evidence.
- Canonical population observation: one statement through `partition_subjects_canonical_frontier`, visiting at most
  P occupied native population counter rows and P home point joins, where P <= 4,096. The 4,097th row fails closed.

Thus each capture uses `12 + A_R + A_Q` statements/control statements. Its fixed relation reads visit at most
`7 + 2P + 3S` physical table rows, plus `R_R + R_Q`. The five transaction controls comprise
three from the question snapshot and two from the prior snapshot. Global/standard questions use current
`definitions:read`; admitted custom questions use current owning-Realm readability. Their authority terms must
remain distinct in growth evidence. Publication digest changes do not change measurement identity.

Each primitive now performs two complete captures, before and after its native read, including an empty figure
proof. The captures bind selected population, question identity/revision/publication/provenance, prior
identity/generation/eligibility, Realm authority/revision, rank-publication generation, and the population home's
epoch/position, plus the canonical population's committed per-home generation and epoch/position. Pending population work refuses observation even if the scored set is empty. Retired questions
refuse observation. A changed capture restarts; current authority denial fails closed. Conservatively binding
population position may restart for unrelated work in that home; it does not scan that work.

The remaining per-primitive work is bounded as follows, independently of unrelated history:

| Primitive                  | Additional SQL including controls | Native input/physical relation rows                                                                                          | Retained candidates      |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Scored partition inventory | 4                                 | One home point and at most 4,097 generation rows; the 4,097th fails closed                                                   | At most 4,096 partitions |
| Scored partition seek      | 5                                 | One home, one generation, at most B rank rows with exact figure and subject point joins (at most 3B physical candidate rows) | B, with B <= 200         |
| Scored canonical seek      | 5                                 | One home, one generation, one canonical coverage row, at most B rank rows and 2B exact figure/Subject point joins             | B, with B <= 200         |
| Exact figure proof         | 4 (3 when empty)                  | One home and at most two physical figure/rank rows per requested ID, at most 256 IDs                                         | At most 256 proofs       |

The scored seek's exact B-tree equality prefix is
`(partition_no, question_id, population_id, question_identity, prior_generation)`, followed by the strict
`(score DESC, subject_id DESC)` tuple and `LIMIT B`. Its index is `realm_rank_score_idx`; the inventory uses
`(question_id, population_id, partition_no)`. A point-joined figure supplies publication-pending state. Ordered
index work is `O(log N + B)` for one partition's selected prefix, with O(B) retained candidates. The compatibility
order is not the required canonical score/name/ID order. The existing `public_figure_realm_rank` trigger remains
the score projection writer; the additional native capture and bounded rebuild below maintain only its name key.

## Scored canonical call and update protocol

Search calls `source.readScoredCanonicalPartition(actor, { realmId, questionId, partition, after, limit },
observation, { deadline })` on the existing `createRealmRankOrderSource({ pool, access, tokens })` factory.
`observation` is the complete result of `source.observe` for the same actor/Realm/question; use
`source.listScoredPartitions` for the finite frontier. The new method copies the actor, request, continuation and
observation before suspension and retains the original deadline through the existing bounded read/cleanup path.
Before and after captures compare the complete canonical homes and committed `scoredHomes`, as well as all
existing question/prior/publication/provenance/Realm bindings. The native read must match the observed home epoch
and position. This applies to first, continuation, withheld and empty pages.

`after` is null or `{ score: string, name: string | null, subjectId: string }`. Continue using the consumed
candidate's returned `key`. Its score is the exact stored numeric text in 0–10 arithmetic; candidate `score` and
`mean` retain the selected question's existing display units (custom questions multiply by two). Never rebuild
the continuation from a displayed custom score. Each candidate also supplies `name`, `securityRevision` and the
existing figure fields. These are private internal candidates, including hidden/redirected Subjects, with no
Subject disclosure grant. Search owns the signed/encrypted outer continuation and complete predicate admission.
A full raw page may require an empty terminal read; no lookahead, refill, fallback or fetched-prefix filtering runs.

The equality prefix of `realm_rank_scored_canonical_idx` is
`(partition_no, question_id, population_id, question_identity, prior_generation, prior_epoch)`. The ascending
tuple `(-score, canonical_name IS NULL, COALESCE(canonical_name,'') COLLATE "C", subject_id)` implements score
descending, name ascending with missing last, and Subject ID ascending. First and continuation statements are
distinct; the continuation has one strict tuple range. The missing flag distinguishes a missing name from an
empty string. A materialized window selects at most B rows before LEFT point joins to the exact figure and
Semantic Subject. Missing rows, name disagreement, pending publication, or disagreement with any published
figure value fail the whole read; joins never discard or refill a candidate. Any final sort is over at most B
rows, not a complete score tie. Index positioning is `O(log N+B)`; joined points add `O(B log F+B log T)` for figure
and Subject relations. Retained memory is `O(P+S+B)`.

A successful scored canonical read costs at most `29 + 2A_R + 2A_Q` statements/control statements and
`17 + 4P + 6S + 3B + 2R_R + 2R_Q` physical relation rows, B <= 200. These include both complete captures,
the native home point, generation/coverage points, rank seek and both candidate joins. If Semantic's whole
population has no Subjects in a retained inventory home, a cursor-independent exact-prefix `LIMIT 1` probe
must prove absence before returning an empty page. An orphaned rank refuses readiness.

Migration `20261114151915_realm_rank_canonical_order.sql` installs the column, index, coverage state and the
`realm_rank_canonical_name` trigger on Rating's existing projection. It edits no Semantic table, trigger or
selection rule. Every native score insert/update copies `semantic.subject.canonical_name` through that trigger,
with a share lock on the existing Semantic population generation. The same-transaction figure publisher
continues to maintain rank generations. A concurrent Semantic change either follows the lock and invalidates
coverage, or causes a stale serializable/repeatable-read writer to fail; it cannot certify an old key as current.
No canonical value comes from a caller or from a second label-history observer.

Rename, missing-name transitions, Subject insertion/removal, identity, redirect and security changes advance
Semantic's existing committed `canonical_generation`. A scored read requires the entire home's completed
coverage generation to equal it, even when the requested continuation would return zero rows. Validating only
the names fetched after a cursor would miss a renamed row which crossed that cursor. Conservative invalidation
of a whole home avoids that omission. Current Subject security and subsequent Search disclosure remain required.

`rebuildRealmRankCanonicalOrder(tx, { partition, limit: 200 })` in `realm-rank-convergence.ts` invokes the installed
native `rating.rebuild_realm_rank_canonical_order` function inside the owning Subject-home command. One invocation
locks the current active home, Semantic generation and Rating coverage state, then seeks at most 200 rank primary
keys in `(question_id,population_id,subject_id)` order. It updates only those name keys via the same capture trigger
and retains its continuation transactionally. `complete: false` requires another durable command page. An exactly
full batch requires an empty terminal page. `restart: true` is for the first page of an explicit forced rebuild;
ordinary continuation omits it. Receipt/replay remains owned by the caller's native command, never by a request.

A changed Semantic generation resets the next bounded pass. Score publications behind its cursor are safe
because every new/updated score already captures the current name; score deletions need no repair. A missing
Subject, moved/frozen home, serialization failure or interrupted command cannot advance coverage. The cursor,
updated keys and completed coverage commit together. Coverage revision is included in the whole publication
digest, so rebuilding also invalidates in-flight observations. A ready no-op performs no key walk. Total repair
work is linear in the home's rank population per stable generation, independently bounded per page; persistent
Subject changes may postpone readiness and never permit stale ordering.

For R consumed rebuild keys, R <= 200, the native function has at most `11 + 4R` statements/cursor controls,
including its outer call, fetch/close/return and nested trigger SQL, and at most `6 + 4R` physical relation visits.
Charge the owning command's authority, receipt, transaction controls and effects separately. Retained key/cursor
memory is O(R); indexed update work is O(R log N). Ordinary figure upsert adds at most two capture executions
(BEFORE INSERT and conflict UPDATE), each with two point reads; deletes add none. Index construction is migration
DDL work over retained rank rows, not request work. There is no migration data backfill or request-time repair.

The default worker binds this Rating command to Content's canonical-work effect. Semantic's startup inventory
and mutation wakes notify outstanding homes, including retained empty homes. Each receiving command commits one
page. A full page emits a durable continuation with the original notification. A terminal page verifies coverage
for the locked current generation and advances Semantic's delivery watermark for the original generation in the
same transaction. A later notification can acknowledge a newer generation; missing or stale coverage continues
to return `index_not_ready`.

For a complete Search page, preserve the existing collector's useful size U (1–100), at most three rounds,
`B <= min(200, 2 * remainingUseful + 1, remainingCandidateAllowance)`, and at most
`C <= min(600, 6 * U + 3)` consumed candidates. Derive the finite partition frontier P, native canonical-name seek,
complete predicate/admission work and current Subject disclosure from the actual delivered implementation before
claiming complete-order costs. A finite useful-page collector alone cannot establish a complete native predicate
or turn an unavailable/partial figure read into an unscored proof. Missing native evidence never means empty EOF.

Performance must review these source-derived terms and the future complete producer terms before acceptance.
The existing compatibility growth fixture's selected-question costs and transaction-control assertions still need
reconciliation; no successful complete-order three-scale evidence is claimed here.

## Native canonical names and figure proofs

`subjectSource.canonicalNames.observe` performs the single finite-frontier statement described above. Its digest
includes each occupied home's committed `canonical_generation`, epoch and position. Native Subject changes update
that generation in the same transaction; an uncommitted sequence value cannot certify a published name. Names
extend `semantic.subject`, and counts/generations extend its existing `partition_subjects` counters. No second
catalogue or public Realm score projection is installed.

One canonical name read performs two fresh frontier observations plus BEGIN, a home point, one ordered Subject
seek and COMMIT: six statements/control statements, with two transaction controls, at most `4P + 1 + B` physical
rows and O(P+B) retained memory. B <= 200. `subject_canonical_name_seek` has equality prefix `(route/16)` and strict
ascending tuple `(canonical_name IS NULL, COALESCE(canonical_name,''), subject_id)` with C collation. The missing
flag distinguishes an empty string from a missing label. Candidate index work is O(log N+B); request-time reads
never reconstruct names from term history. The native label-head writer and privileged fact minimization/removal
refresh the Subject key transactionally. Those write costs are separate from these read bounds.

`createRealmRankOrderSource.readCanonicalPartition` performs four complete selected-question/Realm captures,
one canonical name read, and one complete figure proof. There are six canonical frontier observations and four
scored publication frontier observations in total.
For a nonempty B-row page the source bound is `58 + 4A_R + 4A_Q` statements/control statements, with 24 transaction
controls, at most `30 + 12P + 12S + 3B + 4R_R + 4R_Q` physical table rows, and O(P+S+B)
retained memory. An empty page omits the figure SQL, reducing that statement bound by one. Figure and canonical
home observations must agree. An inactive prior still requires the complete successful figure read; zero remains
scored, pending evidence fails closed, and below-threshold figures remain withheld. Raw scored candidates in this
canonical walk are explicit proofs, not an unscored result or an exhaustion assertion. Current Subject disclosure
and admitted predicate work remain required before any complete Search page can be released.

## Scored-only compatibility page

Let L be the compatibility `limit` (1–100), C the consumed scored candidates (0–L), and V the figures released
after current Subject disclosure (0–C). The candidate seek uses the same exact equality prefix
`(partition_no, question_id, population_id, question_identity, prior_generation)` and strict descending
`(score, subject_id)` tuple. It reads at most C matching rows, with `O(log N+C)` shared rank-index blocks. The
projection point-joins the selected `public_figure` to read pending-publication state.

`readVisibleRatingQuestion` runs twice on every successful compatibility page, including empty and terminal pages.
Each question observation uses the question-home repeatable-read transaction, reads the question and current label
head together, releases the connection, then checks current provenance authority. For one compatibility page,
`A_R/R_R` are the two selected-Realm observations, `A_S/R_S` are the per-candidate Subject checks, and
`A_Q/R_Q` are each selected-question provenance chain. Successful calls use at most
`29 + 2*A_R + C*A_S + 2*A_Q` statements/control statements and
`14 + C + 2*R_R + C*R_S + 2*R_Q` examined rows. Memory is O(C). This compatibility port has no unscored phase
or cross-partition merge.

## Growth evidence

The protected Realm rank growth fixture remains a native integration acceptance. Its EXPLAIN must bind the actual
question identity before the prior generation and prove the complete index prefix above; selected-question reads,
their transaction controls and the standard question's provenance must be counted separately from admitted custom
question evidence. The installed `public_figure_realm_rank` publication trigger remains the score writer.
The controller's worker policy defers native and broader acceptance checks until integration; this derivation is a
source bound for Performance review, not a measured growth result.

Independent Semantic producer handoff: `readSubjectKeyPage({ partition, epoch, after, through, inputLimit }, context)`
in `semantic/subject-source-key-pages.ts` unconditionally returns `{ status: 'unavailable', reason: 'source_pending' }`
at the supplied source revision, even for a stable eligible home. Semantic owns a complete fixed-cut key traversal
and its native change bridge; current canonical pages cannot certify an older cut. The first writable paths are
that module and its `subject-source-key-pages-owner.sql` / `subject-source-key-pages-read.sql` statements. Delivering
actual progress/complete key pages at the requested epoch/cut unlocks the existing Search rebuild consumer. This
is a separate producer outcome, not a request for additional proof or a larger candidate allowance.
