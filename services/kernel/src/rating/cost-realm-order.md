# Realm rating order cost

This derivation covers both the complete Search traversal and the retained scored-only
`createRealmRankSource.page` compatibility port in [realm-rank.ts](realm-rank.ts). The latter's `limit` bound is
not a proxy for complete Search ordering.

## Native order primitives and complete Search readiness

Search remains at `index_not_ready`: the delivered native primitives supply current canonical population/name seeks,
but still lack scored canonical-name ties and complete predicate execution. The Semantic ID-key rebuild inventory
is separate. The bounds below cover the delivered primitives, not successful complete Search pages or a consumer
inferred from an interface.

One `createRealmRankOrderSource.observe` capture performs current Realm authorization (`A_R` statements and
`R_R` physical rows), selected-question metadata/provenance authority (`A_Q` statements and `R_Q` physical rows
for the authority alone), prior eligibility/freshness, and rank-publication observation. Its fixed SQL is:

- Question home: BEGIN, SET LOCAL, partition point read, question/label/lifecycle point joins, COMMIT: five
  statements/control statements; at most four physical metadata rows (one home and three point-joined records).
- Population home: BEGIN, partition point read, pending EXISTS, prior point read, COMMIT: five statements/control
  statements and at most three physical rows. Pending EXISTS visits at most one exact population key.
- Publication sequence point read: one statement and one returned observation, with no rank population scan.
- Canonical population observation: one statement through `partition_subjects_canonical_frontier`, visiting at most
  P occupied native population counter rows and P home point joins, where P <= 4,096. The 4,097th row fails closed.

Thus each capture uses `12 + A_R + A_Q` statements/control statements. Its fixed relation reads visit at most
`7 + 2P` physical table rows, plus the sequence observation and `R_R + R_Q`. The five transaction controls comprise
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
| Exact figure proof         | 4 (3 when empty)                  | One home and at most two physical figure/rank rows per requested ID, at most 256 IDs                                         | At most 256 proofs       |

The scored seek's exact B-tree equality prefix is
`(partition_no, question_id, population_id, question_identity, prior_generation)`, followed by the strict
`(score DESC, subject_id DESC)` tuple and `LIMIT B`. Its index is `realm_rank_score_idx`; the inventory uses
`(question_id, population_id, partition_no)`. A point-joined figure supplies publication-pending state. Ordered
index work is `O(log N + B)` for one partition's selected prefix, with O(B) retained candidates. The compatibility
order is not the required canonical score/name/ID order. The existing `public_figure_realm_rank` trigger remains
the sole projection writer.

For a future complete Search page, preserve the existing collector's useful size U (1–100), at most three rounds,
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
one canonical name read, and one complete figure proof. There are six finite-frontier observations in total.
For a nonempty B-row page the source bound is `58 + 4A_R + 4A_Q` statements/control statements, with 24 transaction
controls, at most `30 + 12P + 3B + 4R_R + 4R_Q` physical table rows plus four sequence observations, and O(P+B)
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
question evidence. The installed `public_figure_realm_rank` publication trigger remains the sole projection writer.
The controller's worker policy defers native and broader acceptance checks until integration; this derivation is a
source bound for Performance review, not a measured growth result.
