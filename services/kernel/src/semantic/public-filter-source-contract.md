# Complete public filter source and privacy reduction log

This is a closed future native producer boundary, owned by Semantic and submitted to Search for review before
implementation. The adjacent TypeScript file exports types only. It does not implement or compose a source,
compiler, preparation runner, acknowledgement writer, database schema or permission service. Native acceptance is
intentionally red until actual producers exist. Search review and runtime/default/API/three-scale evidence remain
necessary; a typed fixture is not main/runtime proof.

The shared authority is [Filtered lists](../../../../docs/filtered-lists.md). This boundary follows complete
indexed observations, immutable accepted meaning, public disclosure now, same-statement qualifiers and the existing
pure matcher. It selects the approved coarse per-home reduction log mechanism. It does not revive sampled witnesses,
leaf verdicts, final replay, home certificates or an identity-basis sweep. Original `subjectSource.read/count`,
256 IDs **per native Source call**, the separate 64-envelope relay limit and Search's source-chunk repair stay intact.
No private Library predicate or fact enters this projection.

## Current native evidence and missing functions

The following are actual code, not proposed ports:

| Actual export/call site                                                                                                            | Relevant evidence and limitation                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `semantic/search-source.ts:subjectSource`                                                                                          | `read(partition, ids)` uses a repeatable-read snapshot and `core.partition.position`; `count` is internal population accounting. Neither is a bounded complete selected-facet stream. Its absent position fallback is not adopted here.     |
| `search-source-subjects.sql`, `search-source-position.sql`                                                                         | Subject route/id, visibility, `security_revision`, `current_release`, redirect and real bigint partition position.                                                                                                                          |
| `search-source-facts.sql`, `search-source-adoptions.sql`, `search-source-statements.sql`                                           | Current snapshot implementation folds fact history, resolves Global adoption, filters hidden/disclosure/retraction and excludes relations. These queries cannot be copied as a bounded whole-degree page.                                   |
| `semantic/slots.ts:resolveSlot/latestAdoption/currentAcceptance/slotView/expandSlot`                                               | Compact virtual selection versus expanded candidate/adoption state. `slots-read-compact.sql` joins actual revision/release; `slots-read-selection.sql` preserves selection ordinal. `resolveSlot` currently reads all compact slot history. |
| `semantic/candidates.ts:proposeStatement/decideCandidate/adoptCandidates`                                                          | Native editorial operations allocate real subject revision and immutable candidate identity; inspect exported names in this module when wiring, rather than installing a second selection interpreter.                                      |
| `semantic/subject-page-candidates.ts:pageSubjectPageCandidates`                                                                    | Native bounded `(route, subject_id)` candidate window; `size+1` sentinel is not consumed. Includes excluded subjects. Its cursor observes partition epoch/position, not public permission.                                                  |
| `semantic/candidates-read-subject-revision.sql`                                                                                    | Latest actual `semantic.revision.revision` for the original subject, not an event timestamp or transaction UUID order.                                                                                                                      |
| `semantic/statement-disclosure.ts:statementAudience/withStatementReader/readStatementAs`                                           | AsyncLocal reader can expose private evidence. New public producer must explicitly use the public audience, including inside an editor's request context.                                                                                   |
| `semantic/statement-disclosure.ts:disclosureAccount/keepStatementPrivate/changeStatementDisclosure`                                | Native account-target consent storage and terminal retraction, including `accountAgentsForSubjects`; no account epoch/generation is invented.                                                                                               |
| `semantic/disclosure.ts:readCandidateDisclosure`, `semantic/moderation.ts:readSubjectVisibility/moderateSubject/moderateStatement` | Current candidate/subject moderation and security revision; these do not establish whole-query negative/order safety.                                                                                                                       |
| `semantic/fences.ts:sourceTuple/readAnchoredFences/enforceSourceFence/candidateSources/withoutFencedEntries`                       | Actual revision-source provenance and tuple routing; `content/source-fences.ts:readFences` accepts at most 100 tuples and groups one native partition at a time.                                                                            |
| `semantic/references.ts:readSubjectReference`, `semantic/read-item-identity-version.sql`                                           | Original identity and terminal redirect require separately released/reanchored reads. Identity-only revision is insufficient for selected-fact changes.                                                                                     |
| `search/source.ts:IndexedStatement/SubjectSource`                                                                                  | Scalar facet values and same-statement item qualifiers; no candidate/source identity and no full dependency list. Existing `number` quantity matching stays unchanged; privacy positions never convert to Number.                           |
| `search/current-leaf.ts:holdsCurrentStatements`, `search/current-filter-plan.ts:compileCurrentFilter`                              | Pure same-statement and Boolean/unknown conformance; neither observes authoritative privacy heads.                                                                                                                                          |
| `command/command.ts:runCommand/currentCommand/commandTime/mintReadTime/authoritativeTimeValue`                                     | Actual authorization-before-receipt, live transaction T, serializable attempts, event validation and partition fencing; command callbacks run before receipt/outbox, never on replay.                                                       |
| `command/fence.sql`, `partition/partition.ts:readPartition`, `route/route.ts:partitionOf/routeOf`                                  | Native home is one of 4096 partitions containing 16 routes; partition position advances at successful command fence. Ownership epoch is independent of catalogue identity epoch.                                                            |

Missing producer module: `services/kernel/src/semantic/public-filter-source.ts` with exactly
`publicFilterSource(config)` and `recordPrivacyReduction(tx, reduction)`. Factory methods are exactly
`pagePublicFacets`, `readPrivacyHeads`, `pagePrivacyLog`, as declared beside this document. No runtime stub is added.
All methods return actual counted work even on changed/unready/unavailable outcomes. Invalid shape or impossible
route/digest/limit rejects before enumeration. Missing metadata is an explicit unready/unavailable result.

Search's actual compiler, preparation freshness observation, refresh-visible reduction ACK writer, complete
foreign registration barrier and query start/revalidation integration are missing on this base. This document
names their evidence needs through `PublicFilterAcknowledgementNeeds`; it does not create a competing consumer
interface, metadata validator, factory, index format or sink. Existing source/indexer/checkpoint interfaces do not
satisfy these needs. Search owns the exact executable consumer surface and receives this producer for review.

## Complete bounded selected facets

`pagePublicFacets` receives an actual original subject, immutable `meaning.digest/release/type`, input limit and
nullable retained frontier. Verify the digest and accepted meaning against stored releases; active release changes
must not substitute another meaning. Facet declarations come from that accepted release. Preserve the selected
statement's own release and datatype/unit meaning independently of the request pin. Include selected descriptive
facets and outgoing declared relation facets, never inbound edges or undeclared relation properties.

`PublicFacetSource` fields have one spelling: `partition/epoch/position` from `readPartition`, `subject` from the
original native anchor, `terminal` from current direct redirect resolution, `revision` from latest subject revision,
`securityRevision` from `semantic.subject.security_revision::text`, `currentRelease` from stored subject release.
Read these coherently in the source snapshot. No missing subject/release/owner becomes a zero-version complete
empty result. Genuine existing label-only subjects can complete an empty facet stream. A hidden subject yields no
public facets only after a complete current native observation; its safety dependency still matters to queries.

`PublicFacetRecord` preserves `subject`, `terminal`, actual `slot`, `candidate`, selected `rank` and `ordinal`, native
revision/release, original revision `source`, typed native `statement` and matcher `indexed` representation.
`statement.id` equals candidate; `statement.rezics` preserves its pin/revision. Qualifiers remain attached to this
statement. Typed native values preserve exact quantity amount/unit and unknown values even where existing indexed
scalar matching has a narrower representation. Unknown coverage never becomes false under NOT. No arbitrary group
representative may replace hidden original support.

Dependencies include original AND terminal subject keys, selection slot/candidate (including disclosure,
acceptance/retraction/moderation), exact imported tuple, every foreign value and qualifier subject, consent account
and source subject/candidate, and Collection population dependencies when applicable. These are native identities,
not permission verdicts. No dependency is optional merely because a value was excluded or failed Access. Public
reads use real anonymous/public Access, native T and current fences; caller editor rights do not change the view.
Release an owner before checking another owner. Never hold a transaction/checkout across foreign I/O or a sink call.

### Frontier and version stability

A build retains a durable generation, keyset frontier and staged selected records/dependency registrations on
existing owner durable infrastructure. The opaque continuation points to bounded retained state, not a giant JSON
snapshot, request-time history fold, leaf verdict cache or long-lived database snapshot. Traverse native keys in
stable indexed order: property/slot identity, selected ordinal/candidate and dependency phase; history maintenance
must provide current indexed selection before native implementation can claim bounded steps. No OFFSET or repeated
whole compact-slot/adoption-array folding per step. Compact/expanded conformance is mandatory.

Capture actual source evidence at generation start. Verify the local subject revision/security/currentRelease,
owner epoch and complete dependency heads before publishing complete. Partition position is real source fencing
for the observation and downstream sink, not an assertion that all unrelated partition writes changed this subject.
An unchanged subject can retain its frontier across unrelated commands; the producer must account for any changed
required dependency. Local selection/source changes abandon partial generation publication with `changed` and a
retained replacement frontier; do not mix its rows into complete. Foreign head changes likewise prevent complete.
Retain pending work rather than erase the active frontier on every poll. Under quiescence finite current input
finishes; a replay rereads at most one step. Native implementation must supply indexed current-selection access
where current helpers still fold history; no schema/runtime implementation is claimed here.

Every raw key, reject, duplicate, lookahead, reread, Access point and dependency phase is charged. A 16-key step
cannot return 16 records after reading an unbounded hidden prefix. It returns `progress`, possibly no records, with
a strictly advanced retained frontier. `complete` closes all pages of that exact generation, including all-hidden
and absent cases. Consumers stage progress; they cannot disclose negatives from intermediate pages. No 128-value
sample or 32-witness ceiling can truncate completeness. No repeated start-at-zero strategy is admitted.

## Authoritative per-home privacy log

The future native storage needs home-leading head and `(partition, position)` history keys. `position` is bigint
throughout the native interface, canonical decimal only at a serialization boundary. It is a dedicated monotonic
privacy counter, not UUID/time order, `securityRevision`, catalogue identity epoch or an outbox delivery checkpoint.
A genuinely initialized pristine home has explicit zero. Missing initialization on an existing home is unready;
missing, moved or unavailable ownership cannot be inferred pristine. New owner acquisition preserves log/head;
ownership epoch mismatch forces a new current observation, never resets the counter or inherits an old ACK.

`recordPrivacyReduction` accepts only a live existing authorized `CommandTransaction`, its executor-minted
`transactionId` and `AuthoritativeTime`. Verify `currentCommand(tx).partition` and T. It performs no independent
checkout, cross-home write or post-commit callback. Lock/increment the native home head and append its bounded cause
and affected keys in this SAME reduction transaction. Head/log/domain state all commit or all roll back. Concurrent
serializable reductions cannot reuse/regress positions; retry uses the existing command executor. Uncommitted
returned entries are not ACK evidence. At most one bounded entry per authoritative reduction invocation, deduplicated
by native command identity and affected operation; successful receipt replay never enters the body. Repeated native
noEffect/nonreductions do not advance. A command that really removes public evidence cannot choose noEffect.

No fact bodies, private source consent, user predicates or saved permissions enter the log. `affected` has at most
1000 native keys and is sufficient to find bounded repair work through maintained reverse dependencies. A broad
subject/tuple/Collection cause names the native key for paged repair rather than enumerating all affected subjects
in the transaction. Existing outbox/durable owner work routes repair; no new worker/service or scheduler is needed.

### Concrete producer ownership

| Reduction                                                          | Existing authoritative transaction that must append; future integration status                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject hide/takedown, foreign target hide/takedown                | `semantic/moderation.ts:moderateSubject` body, subject's actual partition, before receipt/outbox. Missing append. Foreign referencing sources must not wait for link/Search relays.                                                                                                                                                                              |
| Candidate hide/takedown                                            | `semantic/moderation.ts:moderateStatement`, holder's partition. Missing append.                                                                                                                                                                                                                                                                                  |
| Selected public candidate removal/suppression/rejection/retraction | `semantic/candidates.ts:adoptCandidates/decideCandidate` and `semantic/bulk.ts` native reduction branches; selection removal affects exclusion/order too. Missing append; install at actual changed public selection, not every proposal.                                                                                                                        |
| Consent withdrawal                                                 | `semantic/statement-disclosure.ts:changeStatementDisclosure` terminal retract body, candidate/subject home, using native account-agent ownership. Missing append. No invented account epoch. Account unlink/erasure that removes eligibility also needs the account-agent native command's authoritative home before async cleanup.                              |
| Imported source tuple takedown                                     | `content/source-fence-command.ts:takedownSourceFence`, `tupleRoute(routeKey, source, external_id)` home; `content/takedown-source-fence.sql` increments real security revision. Missing privacy append. Content event delivery alone is too late.                                                                                                                |
| Collection public population reduction                             | `library/collections.ts:createCollectionCommands`'s `updateCollection/deleteCollection/removeMember` native bodies, actual Collection/owner route. Missing privacy append; ordinary `collectionEvents`/source projection is not immediate invalidation. Dynamic completed-publication replacement must append where that generation is authoritatively replaced. |
| Source eligibility/identity unlink                                 | Native `semantic/account-agents.ts` verification reversal/erasure and subject identity command when public support is lost. Missing append, with source original retained; shared pending identity epoch is additional gating.                                                                                                                                   |

These are integration obligations, not changes to any shared writer here. Existing publication hooks remain closed.
Native implementation owners must distinguish actual removal from restore, unchanged proposal, rejection of an
unselected candidate, successful replay and genuine noEffect. Whole-query safety must include excluded-subject homes.

### Current heads, history and ACK

`readPrivacyHeads` returns exactly requested current homes or a typed failure, charging every control read and all
owner pools. It cannot return partial successful coverage. Coarse population coverage includes all possible source,
excluded-subject, tuple, qualifier, consent and Collection homes: conservatively all 4096 native homes. This is
privacy control coverage, not resurrected 4096-original identity traversal. Narrowing requires independently
reviewed complete population/dependency proof; returned-candidate homes are insufficient.

`pagePrivacyLog` is a bounded `(after, through]` native keyset page in one home/epoch. Validate nonnegative positions,
`after <= through`, 1..1000 raw-key limit and real retained head. Progress advances after every examined key,
including rejected/tombstoned entries; lookahead is charged but not skipped. Complete means that fixed through
position was exhausted, never that future reductions cannot occur. Preserve history needed by live consumers;
missing/pruned required history is unready and requires complete repair, not an empty complete page.

Search records required heads BEFORE execution and requires its actual refresh-visible ACKs to cover them. After
execution it rereads all current required heads immediately before disclosure; a changed head, pending owner,
missing ACK or pending identity epoch prepares. The consistency boundary is the final current authoritative
observation, not an index timestamp. Candidate disclosure checks remain separately required. Ordinary 60-second
freshness and five-minute readiness are independent of immediate reduction safety.

ACK is monotonic only after affected local searchable/prepared repair AND every dependent foreign repair is
refresh-visible. Ordinary relay delivery, outbox/checkpoint settlement, dispatch and local repair alone cannot
advance it. Dependency registration must observe already-down tuples/targets: registration racing an ACK is either
included in its complete repair frontier or fenced from publication until a later repaired observation. Source/sink
versions and generation lifecycle must prevent late old snapshots from resurrecting data after ACK. A crash after
external effect or ambiguous sink response cannot acknowledge assumed success; replay establishes actual winner
refresh visibility/shard success under real sink fencing. No new certificate can fill a missing sink guarantee.

## Native acceptance and cost

`public-filter-projection.test.ts` dynamically loads only the exact future producer module. It uses the migrated DB,
real Access and HTTP create/propose/accept/adopt/moderation; no fixture SQL manufactures selected facts, hints or
consent. It requires 300 selected relation values, a descriptive facet, hidden prefixes and complete absence,
noncombinable crossed qualifiers, compact expansion, rank, retained frontier/replay, release A after B activation,
source mutation and foreign target reduction. Public audience is checked inside an editor AsyncLocal context.
The support fixture captures native rows (including removed rows), blocks, statements, backend IDs and wire bytes.

`privacy-reduction-log.test.ts` requires authoritative native subject and tuple reductions with ordinary indexers
absent, lossless monotonic pages, authorization-before-receipt/revoked replay, nonreduction restore and a deferred
transaction fault rolling back subject/head/log together. Its named explicit dependency failures preserve the
remaining same-home concurrency/noEffect, consent/Collection, empty/moved home, rejected-history and whole-query
positive/NOT/order/race/crash scenarios. These are red requirements, not mock tests or runtime evidence. Search
must bind its real ports before those consumer cases can execute; no guessed callback makes them pass.
The 4096-home scenario creates real subjects and real privacy history in every native home and captures coarse
observation. Missing factory/404/503 is never a growth pass. No numerical feasibility claim exists until it runs.

### Projection and preparation step

- Touches: native current-selection keysets, every raw/rejected/reread/dependency key, original/terminal Access,
  source/qualifier/consent owners, bounded records, retained build frontier and existing durable work.
- Bound: one internal `PublicFilterCost` per step; input keys at most 1000, result writes at most 1000, one frontier
  write, at most 8 Access plus dependency points per input, rows at most `64 + 16 × input`, blocks at most six per
  budgeted row, 16 statements per backend, four engine searches, one connection per backend, responses at most 4 MiB.
  Split large dependency work into retained phases. Finite total input is linear; replay rereads at most one step.
  Fixed scalar counters count actual work, not guessed Access exemptions. Harness captures backend work separately.
- Growth check: native captures at 64, 512, 4096 relevant items, history independently growing, hidden prefix,
  compact/expanded, interruption/replay and late dependency registration. Every step obeys exact ceilings, no slack;
  examined rows constant and blocks logarithmic for fixed step, total preparation linear. Initial red is not proof.

### Privacy append and history page

- Touches: one home head lock/increment, bounded cause/affected keys and append in existing transaction; bounded
  history keyset and retained repair frontier, with every rejected key/lookahead charged.
- Bound: one native command's bounded append, no cross-home fanout in reduction transaction. History/preparation
  pages use the step ceilings above, including rows/points/statements/bytes and failed work. Head positions never
  convert to Number. One connection per backend, released before another owner or external sink.
- Growth check: native commit/rollback/replay/concurrency and rejected-history pages at 64, 512, 4096 entries,
  actual owner pools and tuple/consent/target/Collection reductions while ordinary relays are paused.

### Public query head observation and revalidation

- Touches: entire coarse population/dependency home set, both current head observations and actual Search ACK reads,
  candidate disclosure, source-to-searchable lag and independent identity epoch gating.
- Bound: direct per-read candidates `min(600, 6s + 3)`, at most six catalogue searches or three owner seeks; ready
  candidates `2s + 2`, at most two index reads. Both use points `16 + 8c`, rows `64 + 16c`, blocks six per budgeted
  row, responses `16 KiB + 4 KiB × c`, requests `64 KiB + 1 KiB × c`, 12 statements per PostgreSQL backend and one
  connection per backend/page. Head observations are included, never exempted. Coarse capture has zero candidates
  and therefore tests the fixed control allowance. If native work exceeds it, send the exact capture to Performance
  and the manager; retain correctness, never silently narrow homes or raise budgets. No conflict is claimed without
  that native evidence. Composed pages retain 16 reads/128 total slots, totals 816 candidates/6784 points/14080 rows,
  72 statements/96 searches and one connection per backend; fixed control work is shared. Preparation remains bounded
  separately, but cached authority cannot replace the final current observation.
- Growth check: Search owns direct catalogue/prepared public native checks (Commerce owner-local, page owner
  composed), at 64/512/4096 population and matches, sparse `s+1` positives, independent history, owner pools, aliases/
  duplicates and deep cursor pages. First/deep/sparse and composed 16-read/128-slot cases all obey exact ceilings;
  engine profile iterator work constant/logarithmic, no full-match sort/count. Include all 4096 genuine privacy
  homes/history and current revalidation, crash after sink effect and registration races. Existing 256 proof tests
  and the type-only contract do not satisfy this evidence.
