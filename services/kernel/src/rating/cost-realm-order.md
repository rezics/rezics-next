# Protected Realm scored page cost

This derivation covers the retained scored-only `createRealmRankSource.page` in
[realm-rank.ts](realm-rank.ts). It does not establish the complete scored/unscored canonical order required by
Search. Search owns selection controls, predicates and cross-partition composition. Until a bounded current
Semantic canonical population and `name_sort` seek is available, the Search reader must remain `index_not_ready`.

## Ordered seek

Let L be the requested limit (1–100), C the consumed scored candidates (0–L), and V the figures released after
current Subject disclosure (0–C). The live index prefix is
`(partition_no, question_id, population_id, question_identity, prior_generation)`; its descending suffix is
`(score, subject_id)`. Both seek statements bind the selected question's actual `question_identity` before
`prior_generation`. The first page seeks at the equality prefix. Continuations add the strict
`(score,subject_id) < (after.score,after.subject)` predicate, without an OR or OFFSET. The ordered B-tree therefore
positions in O(log N) blocks and reads at most C matching rows, for O(log N+C) shared blocks as the rank relation
grows. The projection also point-joins the selected `public_figure` to read pending-publication state.

UUID descending remains the scored-only compatibility tie. It cannot prove the requested canonical-name order.
There is no unscored complement in this port. A complete native provider needs the current canonical name key in
its ordered seek; sorting a bounded UUID-ordered score prefix cannot supply it.

## Selected-question observation

`readVisibleRatingQuestion` runs twice on every successful page, including empty and terminal pages. Each call
opens a fresh repeatable-read transaction, reads the question home with `partitionReadClient`, and reads the
question and current label head together with `question-read.sql`. The owned transaction contributes three
control statements (BEGIN, SET LOCAL and COMMIT) and the two point reads. It releases that connection before the
current provenance check: `definitions:read` for a standard question, or native `readRealm` authority for a
Realm-authored question. Let A_Q and R_Q be, respectively, all statements/control statements and examined rows in
that actual provenance chain. One selected-question observation is therefore at most `5+A_Q` statements and
`2+R_Q` rows. The two observations add six transaction-control statements to every page.

## Source-derived envelope

For the compatibility page, A_R/R_R describe one `readRealm` with current native authority; A_S/R_S describe one
current Subject authorization and identity read. These authority envelopes include their real Access callees,
not only their final SQL. The row envelope below counts returned native rows and Access intermediates; the native
ordered rank seek contributes C consumed rows, including denied candidates. The generation and selected-question
identities are exact equality bindings, not post-seek filters.

| Work | Calls | Statements and controls | Rows |
| --- | ---: | ---: | ---: |
| Initial/final selected-Realm authorization | 2 | `2 A_R` | `2 R_R` |
| Prior observation (`readPartition`, freshness, prior; BEGIN/COMMIT) | 2 | 10 | 6 |
| Candidate observation (partition, generation, rank seek; BEGIN/COMMIT) | 1 | 5, or 4 when the seek is skipped | `2+C` |
| Current Subject authorization and identity | C | `C A_S` | `C R_S` |
| Final generation observation (partition, generation; BEGIN/COMMIT) | 1 | 4 | 2 |
| Selected question and label head plus provenance authority | 2 | `2(5+A_Q)` | `2(2+R_Q)` |

Thus successful calls use at most `29 + 2 A_R + C A_S + 2 A_Q` statements/control statements and
`14 + C + 2 R_R + C R_S + 2 R_Q` examined rows. Inactive or identity-mismatched priors skip the scored seek;
they do not prove or return an unscored phase. Memory is O(C) for the retained candidate rows and cursor state.
There is no dependency set or merge frontier in this compatibility API, so this bound makes no claim for D or F in
the complete-order journey.

The fixed test authority in the older standard-question fixture expanded A_R=10 and A_S=9, giving
`49 + 9C + 2 A_Q` statements/control statements before expanding the standard question's `definitions:read`
provenance. A Realm-authored selected question uses Realm provenance and its separately derived A_Q/R_Q. Keep
those paths distinct. Ask Performance to review the selected-question authority expansion; never fit the Q terms to
observed growth counts.

## Growth evidence boundary

The existing growth fixture still uses the former statement/control ceilings and its EXPLAIN omits the actual
`question_identity` equality. Those assertions do not establish this derivation. Reconcile the fixture to the
question and label reads, current provenance authority, all controls, the actual index prefix and no-Sort plan
before treating its 256/1024/4096 samples as acceptance. Standard and admitted custom questions require distinct
evidence. The installed publication trigger remains the sole writer; this page does not certify vote aggregation,
the complete canonical population, name/prior/access continuation invalidation or the unscored phase.
