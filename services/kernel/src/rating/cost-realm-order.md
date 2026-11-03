# Protected Realm rating order cost

This derivation covers the landed standard-question, one-partition `createRealmRankSource.page` in
[realm-rank.ts](realm-rank.ts). It precedes physical samples. It does not establish a measured pass.
Content's publication, custom questions, membership, repair and erasure contracts remain in the
[owner README](README.md#protected-realm-rank-source); Search owns predicates and partition composition.

## Candidate seek

Let L be the requested limit (1–100), C the consumed candidate rows (0–L), and V the released figures (0–C).
`realm_rank_score_idx` has equality prefix `(partition_no, question_id, population_id, prior_generation)`
and descending suffix `(score, subject_id)`. The first query starts at that prefix. Continuations add the
strict tuple inequality `(score,subject_id) < (after.score,after.subject)`, without an OR or OFFSET.
The index therefore visits at most C live matching tuples and has O(log N + C) shared B-tree/heap blocks
for N indexed rows, under the adopted visible-work criterion. UUID breaks score ties. Stale generations,
other questions and populations are outside the selected index interval, rather than post-seek filters.
The selected projection needs heap tuples; this is not a claim of an index-only scan.

Every consumed row prepares native subject Access, reads current identity, and, unless missing or redirected,
verifies Access. Denied rows still cost work. Filtering cannot increase C, refill a page or reveal withheld keys.
A full withheld batch has V=0 but C=L and a signed, encrypted continuation; its next page may be empty.

## Source-derived finite envelope

Successful, non-racing calls use these dispatches. Rollback/error paths fail closed, and are not successful
page samples. `observe` uses a fresh repeatable-read read-only transaction each time.

| Work                                                                   | Invocations | Application statements | Examined row envelope |
| ---------------------------------------------------------------------- | ----------: | ---------------------: | --------------------: |
| Initial and final `readRealm` with native Access                       |           2 |                  2 A_R |                 2 R_R |
| Prior observation: BEGIN, partition, prior, COMMIT                     |           2 |                      8 |                     4 |
| Candidate observation: BEGIN, partition, generation, rank seek, COMMIT |           1 |                      5 |                   2+C |
| Current subject Access plus identity                                   |           C |                  C A_S |                 C R_S |
| Final observation: BEGIN, partition, generation, COMMIT                |           1 |                      4 |                     2 |

The eight BEGIN/COMMIT occurrences are charged through harness `controlStatements`, not discarded.
Thus rows <= `8+C+2R_R+C R_S`; data plus control statements <= `17+2A_R+C A_S`.
An inactive prior skips the candidate statement, reducing this bound. Empty and terminal pages still pay both
Realm checks, both prior observations and both generation/partition observations.

The authority constants are from the real callees, not fitted to results:
[Access preparation/formula](../access/permission.ts), [native work declarations](../access/work.ts),
[Realm eligibility](../community/eligibility-access-work.ts), [membership proof](../community/membership-access-work.ts),
[subject eligibility](../semantic/eligibility.ts), and [current identity](../semantic/read-subject-identity.sql).
Verified actor authentication precedes the port invocation and is setup, not an omitted in-page authentication call.
The port uses the native factory's identity association; it cannot accept a reconstructed actor as authority.

For M admitted human identities (actor plus optional delegating principal), total inverse groups G, and R configured
resource grant roles containing this action, the finite key expansion is K=2G+2M. M<=2 and each identity admits
at most 1,000 groups. Each group contributes owner/member roles; each identity also contributes its direct and
active-account keys. These caps bound expansion independently of historic grants or other accounts.
For a conservative envelope allow two targets and two branches even though these two read actions have neither
Global governance reach nor explicit/public formula expansion. Each `(target,branch,key)` probes at most R+4
native grant/denial rows: action grant, R role grants, three denial reasons. Temporal non-overlap/current-next
LIMIT seeks bound each key. The native declaration also charges finite formula intermediates.

Preparation candidates cost at most `K(R+6)+10` rows; the final formula at most `K(4R+21)+21` rows.
Both include their native probes and intermediate envelopes, exceeding the harness's relation-scan-only rows.
Add `M+G` inverse rows, at most `16G` membership-proof rows (Realm declaration; organization proof is smaller),
two time rows, and two assignment rows if delegated. Domain verification adds:

- Realm: one preparation binding (7), current head/host/revision (9), second binding (7), current ban (`2M+2`);
  total `25+2M`. Closed ban history is excluded by the current partial index.
- Subject: preparation and verification visibility/security points (2); current identity adds four indexed
  tuples (subject, partition, latest redirect and latest revision). Both history seeks use ORDER BY/LIMIT 1.

For the fixed test authority M=1, G=1, no delegation: `R_R=186+20R`, `R_S=165+20R` (including identity).
R is counted from the installed server catalogue before capture. The fixture asserts its native inverse has
exactly one group. Maximum dispatches are `A_R=10` (binding, two times, inverse, candidates, membership,
head, binding, ban, formula) and `A_S=9` (two visibility, two times, inverse, candidates, membership, formula,
identity). A subject whose grants require no group proof is cheaper. This gives statements <= `37+9C`.
For other admitted authority shapes the corresponding statement envelope is
`A_R<=8+M+G+D`, `A_S<=7+M+G+D`, with D=1 if assignment preparation runs, otherwise zero.
The general row envelopes follow the preceding terms; the measured constants apply only to the declared fixture.

## Growth check and limits

[The native growth check](../../test/rating/growth-realm-rank-source.test.ts) uses 256/1024/4096, L=64 and
fixed native authority. Independent sweeps grow selected candidate depth, unrelated question/figure keys, then
subject revision and closed authority history. Each capture calls first, strict deep, withheld, terminal and vacant
partition pages, and checks the newly returned withheld continuation with another terminal call: six pages,
three full consumed batches. Rows <= `3*bound(64)+3*bound(0)` and statements use the same sum, including
48 transaction controls. Rows/statements remain constant; shared hit+read blocks obey the harness logarithmic
bound, never elapsed time. All touched relations pass the shared access-path guard, including native authority;
separate first/deep EXPLAINs require the ordered index, and captured statement/relation evidence retains authority,
identity and the strict tuple seek. No custom cost classifier replaces harness counters.

Decision: use native votes to establish authority/prior and production-shaped finalized figure snapshots for bulk
cardinality, leaving the publication trigger as the sole rank/generation writer. This keeps setup outside page cost.
The fixture copies native subject release/source and figure prior fields, computes scores with the native Bayesian
formula, and retains generation changes through ordinary figure writes. It does not prove vote aggregation,
custom-question publication or lifecycle convergence. History setup appends immutable revisions and nonoverlapping
closed denial intervals; no authority is fabricated. Cursor witnesses are minted by native traversal only after
each scale's writes settle; refreshing the verified credential retains its bound authority fields.

The shared harness separates catalogue analysis/freshness from application statements and reports its own
catalogue count; the finite application bound is not a bound on first-use SQL compiler analysis. Plans and missing
counters/preparation failures are not samples. Database-engine invisible multiversion work is outside the adopted
architecture criterion. Native setup may fail before any case (including the previously reported consent-writer
`new.scopes` failure); that is unmeasured, never a rank regression or a pass. Physical acceptance is deferred to
integration; this derivation and authored check alone do not close measurement.
