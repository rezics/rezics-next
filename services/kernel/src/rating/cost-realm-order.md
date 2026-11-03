# Realm rating order cost

This derivation covers both the complete Search traversal and the retained scored-only
`createRealmRankSource.page` compatibility port in [realm-rank.ts](realm-rank.ts). The latter's `limit` bound is
not a proxy for complete Search ordering.

## Complete Search page

Let U be the requested useful-page size (1–100), B the size of one native Search batch, R the number of collector
rounds (at most 3), and C the total raw candidates checked in the page. The existing collector gives
`B <= min(200, 2 * remainingUseful + 1, remainingCandidateAllowance)`, `R <= 3`, and
`C <= min(600, 6 * U + 3)`. The native producer reads no more than B candidates from any ordered source in one
round. It does not scan the Semantic key-traversal rebuild path or infer a provider from `SubjectSource`.

The scored phase first reads the finite `rating.realm_rank_generation` partition frontier for the selected question
and Realm, using `(question_id, population_id, partition_no)`. It accepts at most 4,096 distinct subject-home
partitions; the 4,097th inventory row fails closed. For each active partition, one repeatable-read statement seeks
at most B candidates. Its exact B-tree equality prefix is
`(partition_no, question_id, population_id, question_identity, prior_generation)`, followed by the strict
descending `(score, subject_id)` seek and `LIMIT B`. The index is
`realm_rank_score_idx(partition_no, question_id, population_id, question_identity, prior_generation,
score DESC, subject_id DESC)`. The score seek joins only the exact current public-figure key and subject key; pending
figures and pending prior work cannot be released. With P active partitions and N_i rows under one partition's
prefix, rank heap rows are at most P*B and ordered-index work is
`O(sum(log N_i + B))`. The list and per-partition statements are bounded by 4,096, regardless of unrelated
subjects or history.

Search merges the returned partition frontiers by score descending and subject UUID descending. Text predicates use
the existing Search compiler and are evaluated against the candidate IDs in the active Search generation; other
filters and current disclosure continue through the existing reader. A text mismatch remains a consumed private
candidate so a later matching score can be reached without advancing past a hidden key in the public cursor.

When the scored frontier is exhausted, the unscored phase issues one `name_sort ASC, id ASC` Search seek, with
missing names last and a maximum of B hits. Each hit is grouped by its subject-home partition and receives one exact
batched native figure/rank eligibility observation. For G nonempty groups (`G <= min(B, 4,096)`), the SQL returns
exactly the requested ID set or fails closed. A complete figure read is the only evidence that a row is unscored;
score zero remains scored, below-threshold figures are withheld, and an inactive prior yields all-unscored only
after the population pending observation is complete. This phase costs at most B Search hits, B figure/rank
eligibility rows, G bounded partition observations and `O(G log N + B)` native index work. It never estimates an
unscored total or scans the canonical population.

Each cursor observation captures the live Realm read decision, one exact selected-question and label-head read plus
its current provenance authority, same-Realm prior generation/eligibility/freshness, rank publication generation,
active definition meaning, Semantic canonical generation and active Search generation. It reobserves these before
and after each producer read and before returning the page. A canonical-generation sequence is incremented by
subject, redirect, selected-fact, selection-state and subject-page-publication writes. Any observed change restarts
the request. The generation is an invalidation fence; the existing Search index remains the only name catalogue.

Let A_R/R_R be the statements and examined rows in one current Realm authorization, A_Q/R_Q those in the
selected-question provenance authority, and A_S(C)/R_S(C) the existing bounded SubjectSource disclosure work for
the C consumed candidates. One producer capture performs one question observation, one prior observation, one
rank-publication point read, one definition-pointer read and one canonical-generation point read, plus the Search
generation/format reads. On the current pool path this is `13 + A_R + A_Q` SQL statements/control statements,
`8 + R_R + R_Q` returned rows, and five transaction-control statements before any cache-miss definition body read;
each cache-miss body adds its existing bounded release read. The question observation contributes two metadata
point reads and three transaction controls. The prior observation contributes its exact partition, freshness and
prior reads and two transaction controls. These selected-question terms are per capture and do not collapse
standard-question evidence into admitted custom-question evidence.

For R rounds, with S scored reads, P_r active scored partitions in round r, T unscored reads and G_r nonempty
unscored partitions, the complete Search page uses at most `2 + 2*S + 2*T <= 14` producer captures. Its SQL
statement/control envelope is source-derived as:

`O * (13 + A_R + A_Q + D) + sum_r(4 + 5*P_r) + sum_r(4*G_r) + A_S(C)`

where O is the number of captures, D is a possible release-body cache miss, 4 is the partition-inventory
transaction/read, 5 is a per-partition scored read including two transaction controls, and 4 is one grouped
unscored figure proof including its two controls. The corresponding returned-row envelope is:

`O * (8 + R_R + R_Q + D_R) + sum_r(1 + P_r + P_r*(2 + B_r)) + sum_r(G_r + U_r) + R_S(C)`

where D_R is the optional release-body row count, B_r is that round's batch size, and U_r is the number of unscored
hits. Access and SubjectSource terms remain their actual native implementations, not constants inferred from the
consumer interface. Search control calls are also bounded: at most one ordered unscored Search request per
unscored read, plus at most one text-admission request for each nonempty scored partition.

At peak, the scored adapter retains at most P_r*B_r source candidates and the merged output of that same bounded
frontier: O(P_r*B_r) hit objects, with eight partition reads in flight. The unscored adapter retains O(B_r) Search
hits and proofs. Across the full collector, current SubjectSource checks see at most C raw candidates. Thus memory
is independent of relation size and unrelated history; the concrete ceiling is 4,096*200 candidates per scored
frontier, before object overhead. An acceptance growth fixture should keep the one-partition 256/1024/4096
population scales separate from multi-partition frontier growth, and should account for the actual selected-question
reads and both Search and native provider work.

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
