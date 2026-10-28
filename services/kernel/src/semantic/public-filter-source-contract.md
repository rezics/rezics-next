# Complete public filter source and privacy reduction log

This is a closed future native producer boundary, owned by Semantic and submitted to Search for review before
implementation. The adjacent TypeScript file exports types only. It does not implement or compose a source,
compiler, preparation runner, acknowledgement writer, database schema or permission service. Native acceptance is
intentionally red until actual producers exist. Search review and runtime/default/API/three-scale evidence remain
necessary; a typed fixture is not main/runtime proof.

The shared authority is [Filtered lists](../../../../docs/filtered-lists.md). This boundary follows complete
indexed observations, immutable accepted meaning, public disclosure now, same-statement qualifiers and the existing
pure matcher. It selects the per-home reduction log with property/order-key narrowing and all-home logical coverage. It does not revive sampled witnesses,
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
`publicFilterSource(config)` and `recordPrivacyReduction(tx, reduction)`. The selected factory methods are exactly
`readPublicFilterProjectionPage`, `readPrivacyReductionHeads`, `readPrivacyReductionPage`, as declared beside this document. No runtime stub is added.
All methods return actual counted work even on changed/unready/unavailable outcomes. Invalid shape or impossible
route/digest/limit rejects before enumeration. Missing metadata is an explicit unready/unavailable result.

Search's complete-plan compiler/admission, preparation freshness observation, refresh-visible reduction ACK writer, complete
foreign registration barrier and query start/revalidation integration are missing on this base. This document
names their evidence needs through `PublicFilterAcknowledgementNeeds`; it does not create a competing consumer
interface, metadata validator, factory, index format or sink. Existing source/indexer/checkpoint interfaces do not
satisfy these needs. Search owns the exact executable consumer surface and receives this producer for review.

Actual consumer call sites inspected are `search/service.ts:createSearchService` (its local `admitQuery` calls
`admitFilter`/`compileFilter` and current hit disclosure) and `search/indexer.ts:createSubjectIndexer`. They do not
export the complete-plan start/revalidation or consumer-specific privacy ACK ports described here. Actual
`semantic/list-outbound-links-by-property.sql` pages `(order_key, target_subject_id, statement_id)` and
`list-inbound-links-by-property.sql` pages `(order_key, source_subject_id, statement_id)`, with Context-over-Global
suppression. Those projected relation keysets are useful native evidence but neither a complete current descriptive
selection stream nor immediate authoritative reduction observation. Their relay positions cannot substitute for
the missing log/cut. No Search or publication-hook implementation is changed here.

## Complete bounded selected facets

`readPublicFilterProjectionPage` receives an actual original subject, immutable `meaning.digest/release/type`, input limit and
nullable retained frontier. Verify the digest and accepted meaning against stored releases; active release changes
must not substitute another meaning. Facet declarations come from that accepted release. Preserve the selected
statement's own release and datatype/unit meaning independently of the request pin. Include selected descriptive
facets and outgoing declared relation facets, never inbound edges or undeclared relation properties.

`PublicFilterProjectionObservation` fields have one spelling: `partition/epoch/position` from `readPartition`, `subject` from the
original native anchor, `terminal` from current direct redirect resolution, `revision` from latest subject revision,
`securityRevision` from `semantic.subject.security_revision::text`, `currentRelease` from stored subject release.
Read these coherently in the source snapshot. No missing subject/release/owner becomes a zero-version complete
empty result. Genuine existing label-only subjects can complete an empty facet stream. A hidden subject yields no
public facets only after a complete current native observation; its safety dependency still matters to queries.

`PublicFilterProjectionRecord` preserves `subject`, `terminal`, actual `slot`, `candidate`, selected `rank` and `ordinal`, native
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

Page `repairLocators` are INTERNAL maintainer-only metadata, separate from public `records`. They retain the
original subject/slot/candidate/property and complete dependency locators for selected but currently INELIGIBLE
inputs as well as eligible ones. Neither withheld values nor those dependency IDs enter the public index. Public
record dependencies are also internal provenance, not public fields. Retain locators through suppression and
restoration as required by native selection history; a visible-output-only reverse map cannot establish coverage.

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
retained replacement frontier; do not mix its rows into complete. Foreign head changes likewise prevent complete. `requiredHeads` on the final page contains only that bounded
step's heads; earlier dependency observations stay in the retained build, never an unbounded last-step sweep.
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
`transactionId` and `AuthoritativeTime`. Verify `currentCommand(tx).partition` and T; `transactionId` comes from the existing `runCommand` body context,
not `currentCommand`, which does not export it. It performs no independent
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
| Source eligibility/identity unlink                                 | Native `semantic/account-agents.ts:unverifyAccountAgent` reversal and the native erasure/subject identity command when public support is lost. Missing append, with source original retained; shared pending identity epoch is additional gating.                                                                                                                |

These are integration obligations, not changes to any shared writer here. Existing publication hooks remain closed.
Native implementation owners must distinguish actual removal from restore, unchanged proposal, rejection of an
unselected candidate, successful replay and genuine noEffect. Whole-query safety must include excluded-subject homes.

### Affected keys and narrowed admission

`PrivacyReductionLogEntry.impacts` is a bounded union: `subject` affects EVERY key of that original subject;
`keys` records affected source keys; `dependency` records the authoritative foreign locator requiring complete
reverse routing. `affected` preserves bounded cause/provenance; it is not a list of copied facts. Both arrays share
the append's 1000-key input ceiling. Index affected keys and subject-wide scope, not translated labels or invented
catalogue IDs. `PublicFilterDependencyKey.property` uses `FilterStatement['property']` from `@rezics/filter`;
the `type` branch matches `FilterDocument.type`/`FactClause.facet: 'type'`; `order` uses actual
`search/query.ts:SearchPlan['sort']` (`relevance/name/id/collections/rating`). These are dependency identities,
not a second grammar or an assertion that all these orders are admitted. Actual `currentClauseKey` includes
values/ranges/qualifiers for matcher identity; reduction routing uses the affected containing source property,
including changes to any qualifier on that statement. Saved filters must already be expanded by admission.
Order dependencies include the admitted order's actual inputs (including name/id tie breakers); incomplete
mapping cannot be noEffect. No property whitelist is introduced here.

A query waits only for unacknowledged reductions whose affected keys occur in its FILTER OR ORDER. Every returned
row additionally checks unacknowledged reductions of ITS OWN SUBJECT. A subject-wide foreign target reduction
routes to every affected SOURCE property/order key, including sources excluded by the engine result. Comparing
only the target's own changed property is unsafe. Source/population authorization, original/terminal and current
candidate/field checks remain required independently of narrowing. Missing reverse registration, unknown cause,
withheld source or incomplete foreign routing stays preparing, never irrelevant. Global blocking is permitted
only as an initial launch slice; it does not satisfy the final served-share gate.

### Current heads, history and ACK

`readPrivacyReductionHeads({kind: 'home', partition})` reads one actual current home head for native history and
producer verification. Its `home` result distinguishes explicit initialized zero from failure. It is not a query
coverage algorithm. The `population` request always logically covers ALL4096 homes/current physical owners,
including excluded subjects, tuple/qualifier/consent and Collection dependencies. `consumer` identifies an actual
Search registration: physical target/incarnation, consumer/projection generation, and nullable meaning/read
identity where inapplicable. The operation must read actual ACK state; request fields are locators, never ACK
positions or callback truth. `consumer: null` means NO ACK exists and all nonzero heads are behind. It cannot
pretend history is caught up. An unknown non-null registration is unready, not an empty successful observation.

With `start: null`, `observed.start` identifies a retained native consistent start cut. Revalidation passes that
same token, returning current `unacknowledged` and `changed` home heads. `coverage: all_native_homes` means current
complete logical coverage, NOT an array of every home. `changed` contains homes with reductions committed since
the start even if already repaired/ACKed now; it is empty at start. Duplicate heads are not emitted within either
array; a home may occur in both. Both arrays use current epochs/lossless positions. `routingComplete: false`
prevents a complete irrelevance classification. Partial coverage, expired/lost start evidence, ownership movement
or missing retained change history is unready/unavailable. A token never authorizes disclosure on its own.

Search records this actual start evidence before execution, reads the relevant log intervals and compares actual
contiguous ACKs, then revalidates immediately before disclosure. Changed relevant heads prepare/restart even if
current ACK covers them: the earlier engine result might still contain the removed evidence. Irrelevant changes
may proceed only under complete source-key routing plus returned-subject checks. No saved allow, wall-clock or
UUID ordering substitutes for the native cut. Independent pending identity epoch also prepares. The final
current authoritative observation is the disclosure consistency boundary; ordinary 60-second/five-minute
freshness remains separate.

`readPrivacyReductionPage` uses an exclusive `after` and observed inclusive `through` in one home/epoch. Validate
nonnegative positions, `after <= through`, 1..1000 raw-key limit and real retained head. Its `head.position` is
exactly the requested observed `through`, not a later unbounded window. `after` advances over EVERY examined key,
including rejected/tombstoned entries; charge lookahead without skipping it. Complete exhausts that fixed window,
not future reductions. `after == through` is complete empty only with real retained coverage. A window limit is
not EOF. Pruned required history or epoch mismatch is unready/changed, never empty complete repair.

ACK is monotonic only after local searchable/prepared repair AND all dependent FOREIGN repair is refresh-visible.
Delivery, outbox/checkpoint settlement, dispatch and local repair alone cannot advance it. Registration racing
an ACK either belongs to its complete repair frontier or stays fenced from publication until a later repaired
observation. Sink/source generation fencing must prevent late old snapshots, lost CAS and delete-version pruning
from resurrecting data. A crash after sink effect/ambiguous response cannot acknowledge assumed success: replay
must establish actual winner visibility and shard success. Foreign privacy position is NOT native subject source
external version. Dependent own-home refresh must genuinely advance the anchored source version before an
external-version sink repair; existing unchanged-version 409 responses cannot prove repair. That native refresh
producer and Search's guarded ACK advancement are missing here; no fictitious default composition is named.

### Efficient native observation feasibility and missing primitive

The required physical path is indexed behind/changed access, not 8192 examined head rows. Start and final reads
SHARE at most 2 statements and `64 + 2 * (unacknowledged homes + changed homes)` examined rows per PAGE, counting
removed rows and all owners. Even a native aggregate/hash/JSON over all heads examines all underlying rows and
fails the caught-up bound. Head/ACK comparison via an unindexed join is not an efficient behind index. PostgreSQL
cannot use a cross-table partial-index predicate to index `head > consumer_ack`; implementation needs a native
transactionally maintained behind relation/index for the actual consumer identity, or an equivalently proven
access path. ACK advancement and new reductions must update that relation without a lost-dirty race.

There is NO current native behind index, retained commit-visible change cut, privacy log/counter or atomic
registration/ACK composition in this base. `core.partition.position` and `command/fence.sql` serialize only a
home; they provide no total commit ordering across homes. A sequence allocated before COMMIT is not such ordering:
an earlier allocated reduction can commit after the start read. A clean/dirty bit alone loses reduce-then-ACK
changes. Ordinary relay arrival time, `AuthoritativeTime` or a transaction UUID cannot fill this hole. An opaque
`PrivacyReductionStart` deliberately specifies required evidence, NOT a claim that storing a token solves it.

Before native implementation can return `observed`, the owner must supply the exact same-transaction reduction
registration and commit-visible indexed changed-since-start primitive, its owner-availability coverage and native
SQL/captures proving the two-statement shared ceiling. It must preserve changes through ACK until all live start
cuts no longer need them, bound retained-cut lifecycle, and fail closed on crash/pruning/lost cuts. Cross-owner
availability itself is charged; pooled per-owner queries cannot secretly exceed two statements. Existing
per-home fences alone do not prove feasibility. This specification does not choose a new coordination service,
Search ACK storage or a fake commit-order field. No actual plan/capture exists to report a numeric pass or to
justify raising a budget. The missing primitive is an explicit implementation dependency for Semantic/Search
and Performance review, not an exemption from logical coverage or accounting.

## Native acceptance and cost

`public-filter-projection.test.ts` dynamically loads only the exact future producer module. It uses the migrated DB,
real Access and HTTP create/propose/accept/adopt/moderation; no fixture SQL manufactures selected facts, hints or
consent. It requires 300 selected relation values, a descriptive facet, hidden prefixes and complete absence,
noncombinable crossed qualifiers, compact expansion, rank, retained frontier/replay, release A after B activation,
source mutation and foreign target reduction. Public audience is checked inside an editor AsyncLocal context.
The support fixture captures native rows (including removed rows), blocks, statements, backend IDs and wire bytes.

`privacy-reduction-log.test.ts` requires actual subject/tuple/consent/Collection reductions with ordinary
indexers absent, monotonic bounded history, same-home concurrency, receipt/revoked replay, nonreduction/noEffect
and a deferred COMMIT fault rolling domain/head/log back together. Its 4096-home test genuinely creates/hides one
subject in every home; no consumer means all heads are behind. It measures both start and final observation
against the shared two-statement/behind+changed ceiling, retaining excluded subjects and an additional reduction
between reads. Bytes, points, blocks and backend work remain captured/charged. The former vector-specific
16-point/16-KiB assertions are removed; no replacement control byte/point allocation is invented. Actual captures
must resolve any remaining allocation with Performance. Missing factory/404/503 is not growth evidence.

Only this task's unconditional missing-Search throws were removed from executable producer acceptance. No native
behavior assertion was replaced by skip/todo/mock truth. The exact scenarios and prerequisites remain REQUIRED
below. Green producer tests would not prove NOT/order/default/API safety.

### Pending native integration/readiness matrix

| Required scenario                                                                                                                                                                                          | Actual prerequisite missing / evidence status                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete projection, retained crash frontier, compact expansion, accepted release A after B, crossed qualifiers, hidden prefixes/absence, current dependencies/public audience/internal ineligible routing | `semantic/public-filter-source.ts:publicFilterSource` and native current-selection keysets/retained build; executable native producer assertions, red before DB work today.                                                         |
| Atomic home log, replay/revoked replay, noEffect, concurrency, tuple/consent/Collection immediate reduction                                                                                                | `recordPrivacyReduction` plus append in each listed authoritative writer; executable native producer assertions, red before DB work today.                                                                                          |
| All4096 initialized homes with genuine history; excluded-subject coverage; behind and changed pre/post capture                                                                                             | Native behind/commit-visible cut and complete owner coverage; executable producer capture scenario, red/unexecuted today.                                                                                                           |
| Caught-up small-page observation with all4096 homes/history                                                                                                                                                | Real Search registered physical consumer, all local+foreign refresh-visible repair/ACK; zero behind/changed homes must fit shared 2 statements/64 rows, with native bytes/points/blocks measured. No fake caught-up callback.       |
| Reduce then ACK during query: final current heads are clean but changed-since-start remains visible                                                                                                        | Same real consumer plus native commit-visible cut; pause actual query between engine result and final observation, reduce and genuinely repair/ACK, then require preparing/restart. Unimplemented/unexecuted.                       |
| positive harem, NOT harem and order remain preparing until local AND dependent foreign refresh, including excluded subjects                                                                                | Search complete admitted plan execution, native local+foreign sink refresh ACK and current key routing; unimplemented/unexecuted.                                                                                                   |
| reduction between execution and disclosure: revalidated current head changes and prepares                                                                                                                  | Actual query execution/disclosure seam plus native start/revalidation; unimplemented/unexecuted.                                                                                                                                    |
| late old source snapshot cannot resurrect an indexed or prepared row after ACK                                                                                                                             | Actual sink external-version fencing, dependent own-home refresh and prepared generation CAS; unimplemented/unexecuted.                                                                                                             |
| late foreign dependency registration checks already-reduced owner and blocks ACK until repaired                                                                                                            | Complete internal ineligible locators, actual native registration/publication barrier plus foreign repair routing; unimplemented/unexecuted.                                                                                        |
| crash after sink effect with ambiguous response cannot ACK before actual winner refresh                                                                                                                    | Actual sink crash/ambiguous-response schedule, refresh-visible winner verification and guarded ACK; unimplemented/unexecuted.                                                                                                       |
| pending identity epoch prepares independently; published epoch alone does not acknowledge privacy                                                                                                          | Actual Search query seam and independent identity epoch read; unimplemented/unexecuted.                                                                                                                                             |
| missing moved or unavailable owner is not pristine; explicit initialized empty home has head zero                                                                                                          | Native observation initialization/ownership-failure schedules; producer dependency unimplemented/unexecuted, not a Search-only scenario.                                                                                            |
| privacy log rejected-key history resumes all keys under bounded pages and lossless positions beyond Number.MAX_SAFE_INTEGER                                                                                | Native history maintenance/pruning/rejected-key fixture and real counter boundary; producer dependency unimplemented/unexecuted.                                                                                                    |
| Narrowing: unrelated key reductions do not block; matching-key reductions on excluded subjects do block; returned subject-wide reductions block every key                                                  | Actual admitted filter/order inputs, indexed complete reverse routing and real consumer ACK/revalidation; unimplemented/unexecuted.                                                                                                 |
| Three-scale served share at64/512/4096 with arrival rate rising with population                                                                                                                            | Search direct/prepared native plans, actual repair/ACK latency and served/preparing counters; unimplemented/unexecuted. Zero data, fabricated ACK, lowered mutation rate, omitted foreign work and permanent preparing cannot pass. |

Search owns the real consumer functions (review responsibility names `readPrivacyAcknowledgement` and guarded
monotonic advancement are NOT current exports), compiler/preparation/freshness/admission and default/API tests.
Semantic owns complete projection, authoritative append, native log/observation and dependent own-home refresh.
Performance reviews native physical captures. The manager obtains co-owner review before runtime implementation.

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

- Touches: logical all4096-home population/dependency coverage through indexed behind/changed reads, actual
  consumer-specific ACK, source-key routing, returned-subject reductions, current candidate/source authority and
  independent identity epoch. Include every raw/rejected/reread/removed row, byte, backend and owner checkout.
- Bound: both observations together at most 2 statements and
  `64 + 2 * (homes with unacknowledged reduction + homes whose head changed since start)` examined rows per PAGE.
  Never scan all heads or hide scans in aggregates/hashes/JSON. Physical bytes/points/blocks/connections are
  measured and charged; unresolved control byte/point allocation goes to Performance with actual capture, not an
  invented exemption or larger limit. Main direct/ready/composed page budgets in Filtered lists remain unchanged;
  the observation is shared once across composed reads. No connection is held across another owner or engine I/O.
- Growth check: genuine4096-home history plus caught-up zero/small pages, behind/changed and reduce-then-ACK
  schedules with native pre/post capture. Search additionally owns 64/512/4096 population/matches/sparse/history/
  owner/alias/deep-page and composed16-read/128-slot cases, actual repair/ACK latency and served share that does not
  fall as reduction arrival grows with population. Existing Source256 checks or this type-only fixture are not
  that evidence. Report exact missing primitive/capture before claiming feasibility or growth success.
