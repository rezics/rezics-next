# Complete public filter source and privacy reduction log

This contract owns the native Semantic Source, retained projection and privacy log, captured-window
repair verification and registration-home ACK binding. The adjacent TypeScript file defines the shared
protocol; `public-filter-source.ts`, `public-filter-source-binding.ts` and their native storage implement it.
The installed maintained population and default-root implementation remains Search-owned. Source delivery
and typing do not establish native acceptance, physical growth bounds or whole-journey readiness.

The shared authority is [Filtered lists](../../../../docs/filtered-lists.md). This boundary follows complete
indexed observations, immutable accepted meaning, public disclosure now, same-statement qualifiers and the existing
pure matcher. It selects the per-home reduction log with property/order-key narrowing and all-home logical coverage. It does not revive sampled witnesses,
leaf verdicts, final replay, home certificates or an identity-basis sweep. Original `subjectSource.read/count`,
256 IDs **per native Source call**, the separate 64-envelope relay limit and Search's source-chunk repair stay intact.
No private Library predicate or fact enters this projection.

## Native evidence and authority boundaries

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
| `semantic/statement-disclosure.ts:withPublicStatementReader/statementAudience/withStatementReader/readStatementAs`                 | AsyncLocal reader can expose private evidence. New public producer must explicitly use the public audience, including inside an editor's request context.                                                                                   |
| `semantic/statement-disclosure.ts:disclosureAccount/keepStatementPrivate/changeStatementDisclosure`                                | Native account-target consent storage and terminal retraction, including `accountAgentsForSubjects`; no account epoch/generation is invented.                                                                                               |
| `semantic/disclosure.ts:readCandidateDisclosure`, `semantic/moderation.ts:readSubjectVisibility/moderateSubject/moderateStatement` | Current candidate/subject moderation and security revision; these do not establish whole-query negative/order safety.                                                                                                                       |
| `semantic/fences.ts:sourceTuple/readAnchoredFences/enforceSourceFence/candidateSources/withoutFencedEntries`                       | Actual revision-source provenance and tuple routing; `content/source-fences.ts:readFences` accepts at most 100 tuples and groups one native partition at a time.                                                                            |
| `semantic/references.ts:readSubjectReference`, `semantic/read-item-identity-version.sql`                                           | Original identity and terminal redirect require separately released/reanchored reads. Identity-only revision is insufficient for selected-fact changes.                                                                                     |
| `search/source.ts:IndexedStatement/SubjectSource`                                                                                  | Scalar facet values and same-statement item qualifiers; no candidate/source identity and no full dependency list. Existing `number` quantity matching stays unchanged; privacy positions never convert to Number.                           |
| `search/current-leaf.ts:holdsCurrentStatements`, `search/current-filter-plan.ts:compileCurrentFilter`                              | Pure same-statement and Boolean/unknown conformance; neither observes authoritative privacy heads.                                                                                                                                          |
| `command/command.ts:runCommand/currentCommand/commandTime/mintReadTime/authoritativeTimeValue`                                     | Actual authorization-before-receipt, live transaction T, serializable attempts, event validation and partition fencing; command callbacks run before receipt/outbox, never on replay.                                                       |
| `command/fence.sql`, `partition/partition.ts:readPartition`, `route/route.ts:partitionOf/routeOf`                                  | Native home is one of 4096 partitions containing 16 routes; partition position advances at successful command fence. Ownership epoch is independent of catalogue identity epoch.                                                            |

`semantic/public-filter-source.ts:publicFilterSource(config)` installs the native
`readPublicFilterProjectionPage`, home `readPrivacyReductionHeads` and `readPrivacyReductionPage` readers.
`recordPrivacyReduction(tx, reduction)` appends the original privacy log and keyed pending barriers in the
actual authorized writer transaction. Its installed population reader uses maintained native coverage; repair/ACK alone cannot substitute for it.
All methods return actual counted work even on changed/unready/unavailable outcomes. Invalid shape or impossible
route/digest/limit rejects before enumeration. Missing metadata is an explicit unready/unavailable result.

Search owns the canonical `PublicFilterQueriedObservation` in
`search/public-filter-consumer-contract.ts`; Source imports and re-exports that EXACT type. Its only snapshots
are actual PIT or immutable prepared build/generation. The closed `PublicFilterConsumerOperations` and test-only
`test/search/support/public-filter-consumer.ts:createPublicFilterConsumerFixture` / `PublicFilterConsumerFixture`
are committed shared contracts. The production
`search/public-filter-consumer.ts:createPublicFilterConsumerOperations` installs the actual capture and
repair job against native custody. Source never exports the test helper from production or clones its
engine, registration, Source or ACK implementation. Missing population authority still prevents serving.

The selected native public Source binding declarations now live in
`public-filter-source-binding.ts`: `NativePublicSource`, `PublicFilterSourceDefinition`,
`PublicFilterSourceBinding` and `createPublicFilterSourceBinding(pool, routing, access)`.
`resolve({source, meaning, capture}, context)` must resolve the actual Source instance and full immutable
compiler input to a native definition. `join({queried, execution?}, context)` resolves native queried observation,
covered cut and retained execution. Source-owned configuration/read-definition rows are persisted and independently
validated; matching strings or constructor identity alone never become registration or Source coverage. Existing
`PublicFilterNativeSource` and `JoinedPopulationRequest` declarations in that module remain intact. The adjacent
`subject-source-key-pages.ts` retains its existing rebuild-only `readSubjectKeyPage` compatibility port separately
from the implemented `SubjectSourceKeyPages.read` native inventory. The admitted support bridge consumes the
installed Source factory directly and does not consume the rebuild interface. Missing fixed-cut or foreign owner operations remain explicitly unavailable.

### Admitted-job support bridge

`identity-source-support.ts:createIdentitySourceSupportReader` consumes those exact definitions and existing
projection types. Its request and result are closed in `identity-source-support-contract.ts`. It independently
resolves the native Source/meaning/capture binding before traversal and again before returning a page.
It reads immutable admitted generations rather than changed mappings or returned hits, and resolves current
terminals only after complete genuine native mapping-step custody and an exact current control-job comparison. Each bounded step releases its home before
reading another home or the Source. Outer completion requires end-of-keyset reads for every admitted input and
completion of every current projection sub-frontier. A progress page cannot certify exhaustion.

The bridge owns `search-source.ts:readIdentitySourceProjection`, an internal operation using the ordinary
anonymous original eligibility, fresh native T and sticky public statement audience before the actual Source
projection. Its asynchronous identity scope admits only an already installed mapping for the exact pending
job and epoch. Existing source, owner, dirty, current redirect and control checks remain. The scope cannot
make a previous mapping, another job, cancellation or moved ownership available and never changes permission.
Ordinary reads outside that scope remain pending. Missing original or incomplete proof is unavailable/unready;
only an actual current original visibility/Access refusal yields a null projection. Full candidate, related-item,
account, source-tuple and field disclosure remain with the native projection producer.

The existing native token sealing primitive binds a bounded support cursor to job/epoch, owner, immutable input
refs, native mapping custody and exact Source definition. It retains only scalar key locators and one native
projection continuation within eight scalar keys and 2048 payload bytes, never source bodies, arrays of originals
or cached allow decisions. Input limits include
examined originals and native projection inputs; one-key steps can retain an original and spend their next step
on its projection. Missing native implementations remain unavailable. This bridge exports no engine writer registration,
drain, ACK, participant completion, publication or account-erasure operation. The few native outcomes in
`test/semantic/identity-source-support-outcomes.test.ts` remain later integration proof, without a stub pass.
`facet-population-contract.ts` owns the adopted `FacetPopulationRequest` and `FacetPopulationPage` declarations.
The sole `createFacetPopulationSource(config)` factory uses exactly the PublicFilterSourceFactory configuration.
`readFacetPopulationPage({population,frontier,inputLimit,capture})` retains native finite creation/change coverage,
immutable definition/meaning/consumer linkage and final validation; opaque observation/frontier locators are never
caller coverage. Limits remain 1..1000 under every lower native cap. Its retained native traversal is implemented;
missing binding/key-page producers still return typed unavailability, never empty completion.

Search's `service.ts:createSearchService`, `public-runtime.ts` and `public-filter-consumer.ts` retain
ordinary query, custody and repair composition; `indexer.ts:createSubjectIndexer` remains its physical writer.
Current whole-page population/finalization authority remains the sequential default-serving obligation. Actual
`semantic/list-outbound-links-by-property.sql` pages `(order_key, target_subject_id, statement_id)` and
`list-inbound-links-by-property.sql` pages `(order_key, source_subject_id, statement_id)`, with Context-over-Global
suppression. Those projected relation keysets are useful native evidence but neither a complete current descriptive
selection stream nor immediate authoritative reduction observation. Their relay positions cannot substitute for
the original native privacy log or its immutable cut.

## Complete native facet population extension

The separate extension adopts the closed types in [facet-population-contract.ts](facet-population-contract.ts),
also exported as types from `semantic/index.ts`. The selected module/export is
`semantic/facet-population.ts:createFacetPopulationSource(config: Parameters<PublicFilterSourceFactory>[0])`,
returning `{readFacetPopulationPage(request): Promise<FacetPopulationPage>}`. This declaration does not change
the three existing Source readers or establish callable availability.

`FacetPopulationRequest` carries `population`, opaque nullable `frontier`, `inputLimit` and
`capture: Extract<PrivacyReductionObservationRequest, {kind: 'population'}>`. The canonical capture retains its
exact queried/start/execution/context union. Resolve the registered complete native catalogue definition and
its actual Source/incarnation/meaning and immutable PIT/prepared consumer linkage internally. Neither caller
strings nor diagnostic consumer status establish that linkage. Registered-definition lookup and native
key-page inventory use the original Source binding and retained traversal described above. Missing original
coverage remains unavailable; no caller proof fields or duplicate registry can replace it.

A successful page enumerates anchored subject identities, including excluded and order/privacy-relevant inputs,
with a retained observation and frontier. It supplies no public values or permission verdicts. Preparation visits
native homes with authoritative empty results, releases each home before visiting another, and drains finite
captured ordinary creation/change and dependency windows before a native seal/CAS can return `complete`.
An insertion behind the key frontier must enter that bridge. Missing/moved/pending ownership, uncertain identity
or metadata never means empty; lost observations or log gaps invalidate the build. Later changes feed replacement
work rather than indefinitely extending the captured window. Search separately exhausts each subject's complete
projection; sampled Source statements and named membership probes cannot discover unseen values.

### Cost

- Touches: native Source/definition/consumer/capture metadata, bounded native keys and captured change windows, retained frontier/seal records, including failed/replayed work.
- Bound: `inputLimit` is 1..1000 examined keys including rejects, rereads and lookahead; all lower native Source/capture/step, SQL, byte and deadline limits still apply. No served-request catalogue scan or per-key home/dependency vector is admitted.
- Growth check: reuse the existing measured Source/population controls; this declaration supplies no runtime or growth evidence.

The native repair producer retains its creation bridge in the original immutable
`public_filter_repair_step` input/successor chain. Enrollment installs the ordinary
`core.consumer_checkpoint` named by `publicFilterCreationConsumer(bootstrap)` before
admitting the original home receipt. `readPublicFilterCreationWindow(pool, input,
context, retained?)` captures a finite native home interval; replay validates the
same retained interval rather than extending its through-position.
`readPublicFilterCreationEvent(pool, {bootstrap, window}, context)` reads one exact
outbox event and preserves its event-count/sequence boundary. Missing positions,
changed ownership, missing pins and partial event groups remain unavailable.
The repair producer routes actual Subject and Account change events through their
separate native repair phases before returning to that retained successor. These
window readers feed the independently verified terminal chain and native settlement/ACK described below.
They do not independently establish receiver settlement or eligibility of an old served observation.

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
revision/release, original revision `source`, typed native `statement` and nullable matcher `indexed` representation.
`statement.id` equals candidate; `statement.rezics` preserves its pin/revision. Qualifiers remain attached to this
statement. Typed native values preserve exact quantity amount/unit and unknown values even where existing indexed
scalar matching has a narrower representation. `indexed: null` is REQUIRED for somevalue/novalue or any qualifier whose datatype/value cannot be
represented without loss by `IndexedStatement`. This includes a concrete item with a quantity qualifier; do not
copy only its item qualifiers and claim completeness. It also includes a concrete item with a somevalue/novalue
qualifier: retain that qualifier alongside every concrete qualifier and its foreign dependency. Unknown qualifier
coverage cannot be dropped merely because the main value is concrete. The native record remains present with exact identity,
release pin, rank, ordinal, units, references and source. Null is unresolved matcher coverage, never absence.
A complete native stream and a complete scalar-matcher representation are different properties. Search must
preserve unresolved coverage through its existing Boolean planner (`not_proven`), including NOT, until its admitted
native plan can evaluate that evidence. It cannot call the scalar matcher on a filtered empty list and negate false.
Unknown coverage never becomes false under NOT. No arbitrary group
representative may replace hidden original support.

Dependencies include original AND terminal subject keys, selection slot/candidate (including disclosure,
acceptance/retraction/moderation), exact imported tuple, every foreign value and qualifier subject, consent account
and source subject/candidate, and Collection population dependencies when applicable. These are native identities,
not permission verdicts. No dependency is optional merely because a value was excluded or failed Access. Public
reads use current installed Access, native T and current fences; caller editor rights do not change the view.
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

## Native read clock, deadline and Access

The factory requires `clock: KernelClock` from `clock.ts`, the SAME validated domain clock installed by
`http/kernel.ts:createKernel` and `createKernelAccessResolver` into Access. Every read request carries
`PublicFilterReadContext` (`Pick<AccessContext, 'deadline'>`); a public page shares the existing absolute request
wall-time deadline from `request/deadline.ts`, including waits, start, execution and final observation. Worker
steps establish their own bounded step deadline through that same seam before starting work. No retry or frontier
resume extends a page deadline; a subsequent page is a new operation, never reuse of expired evidence.

Use actual `access.prepare/preparePage` before resource checkout, AFTER all freshness/owner waits, immediately
before applying the read transaction; prepare afresh on every retry. Use `mintReadTime(client, clock)` on that
native read transaction and pass that opaque `AuthoritativeTime` to `Access.authorize/authorizePage`; never cast a
Date/string into T. Applying commands instead use `runCommand`'s fresh attempt T and
`accessCommandAuthorization` preparation. Evidence is bound to that attempt, deadline and resource/page; foreign
reads release their own checkouts before the next owner or sink. `requireAccessDeadline`, existing statement
timeouts and actual wall time bound execution; domain clock injection does not extend authentication or TTLs.

Public projection uses the ONE existing sticky `withPublicStatementReader(fn)` exported by
`semantic/statement-disclosure.ts`. It stays public through nested `readStatementAs`, `withStatementReader`,
`statementAudience` and `privateLinks`, including inside a publisher's private scope. Keep the SAME bearer,
current Auth/Access and resource eligibility; do not mint an anonymous actor, replace request headers, blacklist
fields or mirror private facts. Normal standalone private hydration remains private. The default public audience
alone is insufficient inside an editor AsyncLocal scope. Native public resource eligibility still uses the
existing owning-module Access seams; the public statement audience is not a permission certificate.
`mintReadTime` itself executes `command/read-time.sql`; its work is charged, never free clock metadata. Public
projection/Access transactions use that existing seam. Internal privacy-head observations disclose no public
facts and do not mint another permission T or reuse a projection's allow. Their own native cut is separate from
T. If an observation implementation needs extra clock/Access/owner statements, those count within the SAME
two-statement page ceiling; the current helpers alone are not a proof that such a plan exists.

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
reverse routing. `affected` preserves bounded cause/provenance; it is not copied facts. Both arrays share the
append's 1000-key input ceiling. Index subject-wide scope and affected source inputs, never translated labels.

The canonical Search capture retains the actual admitted `FilterDocument`, `TextNode`, accepted release/type,
Source binding, order, size and typed keyset. Derive its FULL key closure through the SAME `admitFilter`,
`compileFilter`, `compileText` and sort compilers, not a second interpreter or requirements AST/ABI. Saved
expansion is retained against the immutable accepted release; remaining saved nodes reject. OwnerLeaf anywhere
under NOT/OR/expanded saved input rejects before native I/O. Compatibility DSL fields must match the retained
shared input and cannot override it. Explicit undefined is absent filter/text. Native registration binds this
immutable definition against caller mutation. Population callers supply no key vector or positive-leaf list.
Do not use only `matched_queries`, positive leaves, returned candidates or a released-property whitelist.

Closure is the union over the FULL admitted trees, regardless of Boolean truth or engine matches:

- Include the configured implicit subject type even without an explicit type leaf. `and` and `or`: union every child; `not`: recurse unchanged. `type`: include `type`; `statement.in` and
  `statement.range`: include the containing `property`, including every same-statement qualifier dependency.
  Qualifier changes map to the containing source property, not only their own qualifier property. Saved expansion
  contributes every expanded branch and retains the accepted release/read-definition binding.
- `TextNode.term/phrase`: include `field:labels`, `field:aliases`, `field:descriptions`; `and/or/not`: recurse
  through every child, including negative/unreported text. Actual `text.ts:parseText/compileText` and
  `db/search/indices/subjects.json` define search_text from names (labels AND aliases) and descriptions. Text with
  `order:id` still has these dependencies; relevance is not the only order with text membership inputs.
- Include the actual `order` key and `field:id` tie-breaker for EVERY admitted order. `name` additionally includes
  `field:name_sort` and `field:labels`, covering all language choices, missing/overlong-name behavior and fallback.
  `collections` includes `function:public_collection_count` (current public Collection membership/eligibility),
  plus the name closure and id. `rating` includes `function:public_rating` (published Global score, threshold,
  standard question/population/prior epoch and scored/unscored phases), plus native name/id fallback inputs.
  `relevance` includes every actual score/boost input of the admitted text/plan and id; `id` includes id.
  Inspect actual sort declarations in `query.ts` and `rating-query.ts` rather than inferring functional inputs
  from order spelling. New admitted input paths require extending this ONE closure before publication.
- Returned field language/alias/description fallback choices and original/terminal identity remain current-row
  disclosure dependencies even where no query text/order reads them. Every returned row gets subject-wide
  reduction checks; no fixed language whitelist or missing translation may prove irrelevance.

A `subject` impact intersects any nonempty query closure, for that subject anywhere in the admitted population,
including excluded subjects. For returned originals AND terminals it also intersects the own-row check even if
its changed fields are outside query keys. A `keys` impact intersects query closure by source-input identity, or
intersects ALL keys for a returned original/terminal. A foreign `dependency` must first resolve to every affected
SOURCE key through complete internal routing; unresolved routing is never noEffect.

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
including excluded subjects, tuple/qualifier/consent and Collection dependencies.

The population input is ONLY canonical `queried`, retained `start`, actual `context.deadline`, plus the native
`execution` locator for final revalidation. Start is `{start: null}` without an execution. Final supplies the
retained start AND execution returned by actual `operations.query`. Resolve the immutable registered definition,
FULL filter/order key closure and actual returned original/terminal own rows INTERNALLY from native state.
No caller `requirements`, `filterAndOrderKeys`, `returnedSubjects`, nullable consumer/queried diagnostic mode,
live snapshot or `readStatus` verdict is accepted. The Source-owned `PublicFilterQueryRequirements` and
`PublicFilterReturnedSubject` duplicates are removed. `PublicFilterAcknowledgementNeeds` describes native
execution evidence only; it is no ACK setter or callable permission.

Validate physical incarnation, consumer/projection generations, accepted meaning, registered Source/read definition,
immutable PIT/build/generation, covered cut, retained execution/start and deadline independently. Missing, wrong,
closed, expired or unknown registrations cannot yield clean public-ready `observed`. A latest live-target ACK
cannot certify old PIT/prepared data. Starting a NEW execution on an already unsafe old observation must fail even
when every reduction predates that execution's start: compare its retained covered cut as well as its start.
A copied locator is not authority, and an independent Source final check cannot trust diagnostic Search status.

With `start: null`, `observed.start` identifies a retained native consistent start cut. Revalidation passes that
same token, returning relevant current `unacknowledged` and `changed` home heads plus `blocking` summaries.
Heads are narrowed by query keys AND returned originals/terminals through the native indexed path. Each summary
names a home, pending/changed phase and filter_or_order/returned_subject/unresolved scope. At most one summary per
(home, phase) uses unresolved first, then filter_or_order, then returned_subject when scopes overlap; this is not an unbounded impact list. Unknown routing returns unresolved and cannot
admit. Relevant changes remain in `changed` and `blocking` even after current ACK removed pending work. `coverage: all_native_homes` means current
complete logical coverage, NOT an array of every home. `changed` contains homes with reductions committed since
the start even if already repaired/ACKed now; it is empty at start. Duplicate heads are not emitted within either
array; a home may occur in both. Both arrays use current epochs/lossless positions. `routingComplete: false`
prevents a complete irrelevance classification. Partial coverage, expired/lost start evidence, ownership movement
or missing retained change history is unready/unavailable. A token never authorizes disclosure on its own.

Search records this actual start evidence before execution, comparing contiguous ACKs for that exact queried
observation, then revalidates immediately before disclosure. Relevant pending/changed classification is part of the two coverage reads; separate keyed own-row work remains inside the whole page cost. Log paging is asynchronous repair work; it is NOT an uncharged
per-query fallback that scans history after enumerating heads. All reads compose into the same page allowance. Changed relevant heads prepare/restart even if
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

No complete finite-progress layout has been established by the source-only reports. They disprove specific
shortcuts, not every native design; neither ran a native probe or captured rows, blocks, bytes, or served share.
See the [current](../../../../docs/research/public-filter-native-cut-current.md) and
[deep](../../../../docs/research/public-filter-native-cut-deep.md) reports for evidence and counterexamples.

Before a real public-filter producer is admitted, its owners need a concrete, commit-visible indexed NARROWED
behind/change path, atomic registration and maintenance, and complete durable custody of old writers and retained
copies. It must join the actual native Source identity and read definition, current owner availability and epoch,
and a bounded lifecycle. The existing narrowed observation protocol remains canonical: the same PIT or prepared
observation checks both its original covered cut and retained start. A reduction committed during execution stays
detectable after repair and ACK; a new execution on an already unsafe older observation must also be rejected.
There is no extra coverage sweep.

Native top-level snapshot visibility can catch a lower-allocated XID that commits late, but an XIP split copies,
sorts, enumerates and probes active XIDs even when no home changed. Packing or retaining the token does not make
that work free. An xmin scan can read many already-committed unchanged heads. Last-key-only tracking can lose an
earlier relevant change; key/history scans and per-definition summaries must prove their K/L read work or
registration fanout and atomic completion. A transactional global stamp is a separate cross-home placement and
serialization choice, not adopted here. The shared coverage limit remains two statements and
`64 + 2 * (behind homes + changed homes)` examined rows per page, with all 4,096 homes logically covered and
actual metadata, probes, removed rows, control bytes and maintenance charged. If the selected final split reads or
probes active XIDs, its independent fixed-data-scale growth check holds 1, 8 and 64 allocated native XIDs across
the inclusive measured read. Growth fails the adopted bound, which has no active-XID term; this adds no allowance
and no concurrency axis to layouts independent of active XIDs.

Physical write-block verification can drain admitted shard writes while blocked, but it cannot identify a delayed
old request or prevent it after unblock. External versions, refresh, checkpoint CAS and finite delete retention do
not establish physical absence after an old write resumes. Keep physical no-resurrection and retained-copy
custody mandatory; no permanent soft tombstone or independent fence is selected. Foreign repair must advance the
dependent source's own anchored version and establish repaired-winner visibility; a same-version conflict alone
does not prove repair. Cold internal key enumeration may reuse subject-PK seeks without label/history hydration,
but finite activation still needs a retained creation/change bridge, log-gap and movement recovery, and reverse
dependencies for currently ineligible inputs. All-role erasure locators and actual minimized-source completion
remain owner prerequisites. Semantic/editorial/Zone, shared-history and Content delivery ownership remain intact.

No new service/store, ABI, coordination layer, global serializer, numerical allowance, public enumeration/Source
API, matcher, or private fact copy is selected. Native plans and actual maintenance captures must prove the
existing ceilings before feasibility or growth is claimed.

## Native acceptance and cost

`public-filter-projection.test.ts` dynamically loads only the exact future producer module. It uses the migrated DB,
real Access and HTTP create/propose/accept/adopt/moderation; no fixture SQL manufactures selected facts, hints or
consent. It requires 300 selected relation values, a descriptive facet, hidden prefixes and complete absence,
noncombinable crossed qualifiers, compact expansion, rank, retained frontier/replay, release A after B activation,
source mutation and foreign target reduction. Public audience is checked inside an editor AsyncLocal context.
Separate native cases preserve somevalue/novalue qualifiers on concrete values, their complete pin/identity and
concrete foreign qualifier dependencies through suppression, without requiring consumer execution.
The support fixture captures native rows (including removed rows), blocks, statements, backend IDs and wire bytes.

`privacy-reduction-log.test.ts` requires actual subject/tuple/consent/Collection reductions with ordinary
indexers absent, monotonic bounded history, same-home concurrency, receipt/revoked replay, nonreduction/noEffect
and a deferred COMMIT fault rolling domain/head/log back together. Independent home/history cases create/hide
one subject in every home without needing consumer execution. The deterministic tuple/subject-home collision
retains ALL ordered unique entries, scopes only subject assertions by `cause=subject`, and retains tuple impacts,
receipt replay, same-home concurrency and rollback assertions.

Population cases use the actual Search-owned helper/operations and real physical PIT/prepared observations.
They retain registered all4096-behind coverage and caught-up all4096 history, unrelated-key narrowing, own-row
reductions, excluded NOT/name-order changes and reduce-then-ACK. A controller waits outside the measured async
scope while native query/status work shares ONE inclusive capture. No synthetic heads, ACK, returned set, source
identity or casted ready evidence is used. Missing producers remain actual red assertions, never skips or success.
Primitive projection/home/append/log tests remain independent of consumer execution.

### Native measurement attribution

Capture WHOLE `operations.query` plus `readStatus` ONCE, including start/execution persistence, engine, original/
terminal own-row checks, final guard and result bookkeeping. All unclassified statements/plans/bytes remain in
whole-operation accounting. Independently assert both the existing whole direct/prepared/composed page bounds
for actual output slots and the privacy-coverage subset, without granting bookkeeping another allowance.

Actual native role SQL starts with EXACTLY ONE leading comment: `/* semantic.privacy-start */`,
`/* semantic.privacy-final */` or `/* semantic.own-rows */`. Tests select roles from existing `capture.statements`
and native `capture.plans` Query Text, match occurrences AND backend IDs, and require start plus final; missing
or untagged coverage FAILS rather than counting as zero. No table-name classifier, fake tagged SQL or new harness
API is used. Separate own-row work is one keyed statement bounded by page size plus those subjects' pending
reductions, outside the coverage subset but INSIDE whole-page cost. Own-row work merged with final uses
`semantic.privacy-final` and counts as COVERAGE in full. If a native plan needs a third coverage statement,
report raw medians as a failed bound; do not increase the two-statement or row limit.

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

### Co-owner review boundary and remaining evidence

The canonical import/re-export is `PublicFilterQueriedObservation` from Search. Source retains
`PublicFilterDependencyKey`, nullable `PublicFilterProjectionRecord.indexed`, `PublicFilterReadContext`,
`PrivacyReductionObservationRequest.population.{queried,start,execution,context}` and
`PrivacyReductionObservation.observed.blocking`. It removes duplicate requirements/returned-subject input types
and the live/null-consumer shortcut. The factory and exactly THREE Source readers are unchanged. These are
current shared interfaces, not native feasibility evidence. Their installed binding and captured-window
repair implementation are described below; the complete serving and growth obligations remain distinct.

### Required integration schedule not yet frozen

The native binding now resolves the registered Source identity and immutable read definition through the
installed Source and Search custody modules. Maintained population and the default page root have separate Search-owned acceptance. The following full
integration schedules remain required native acceptance obligations:

- A relevant local, tuple, foreign target/qualifier, consent or Collection reduction during actual PIT/prepared
  execution, with complete local AND FOREIGN repair/refresh/actual ACK before final; pending is empty but the
  ORIGINAL immutable execution still prepares/restarts. Repeat irrelevant excluded keys (serve), own-row unrelated
  keys (prepare), zero-hit NOT/name-order and a new query on an already unsafe old observation. Local/native
  narrowed races are executable here; Search's complete FOREIGN/native transport schedules remain required.
- No-trigger imported tuple repair: fence one tuple while Search is paused, withhold it immediately, resume with
  NO unrelated subject edit, injected anchor event or checkpoint advance; actual physical document removes only
  fenced support before ACK. Ordinary-trigger keyed repair does not close this red schedule.
- Delay real old writes before send and after native effect/ambiguous response; physically delete/refresh, allow
  native `gc_deletes` pruning, then release every old writer. After ACK no old/ambiguous write becomes visible,
  and deleted engine documents remain physically absent. Real drain and durable all-writer/retained-copy custody
  are required; checkpoint CAS, finite delete retention, permanent soft tombstones and candidate suppression
  cannot substitute. `aroundApply` is an actual enrollment/observation seam, not a coverage certificate.
- Retain original AND terminal own rows across real native redirects, full current subject/candidate/field Access,
  pending identity epoch, late registration/restoration and moved/missing ownership. Exact affected-subject and
  dependency locators plus minimized-source completion are still missing for all-role editorial/agent/Zone
  erasure. `accountAgentId` alone omits other roles and verified terminals. Accounts shared-history receipts/
  outbox/durable work and Content delivery retain their own custody obligations. Observe the FULL existing owner
  family: `session.lifecycle`, `holding.kind/status`, `entry.owner_write_seq`, including same-state writes.
  No private-fact mirror, permission certificate or fabricated completion port fills the Source erasure gap.

### Adopted feasibility evidence and remaining proof

The [current native-cut report](../../../../docs/research/public-filter-native-cut-current.md) and
[deep native-cut report](../../../../docs/research/public-filter-native-cut-deep.md) were read in full. Both are
source-inspected evidence and proposed schedules; neither ran native probes, proves a complete bounded layout,
or proves impossibility of every layout. Their factual missing-invariant conclusions apply to this SAME canonical
Source/Search boundary. No runtime producer, global counter, new store/engine, resolver/factory/ABI or larger
numerical allowance is selected by this adoption.

A real producer needs indexed narrowed commit-visible behind/changed access with atomic registration and
maintenance, complete owner coverage and durable old-writer/retained-copy custody. Per-home sequences, UUIDs,
wall time and precommit allocation are not a global commit-order cut. Cross-table partial index predicates do not
exist. Colocated summaries only close lost-dirty with full atomic maintenance, and their definition/consumer fanout
must itself be bounded. Latest-key state loses earlier relevant reductions; key-leading indexes and history
classification multiply examined work. A global transactional UPDATE lock is a conditional one-database proposal,
not selected cross-home command placement or serialization.

Ordinary PostgreSQL statement visibility handles lower-XID late commits. Application work uses the original
indexed pending/behind/changed paths; it does not enumerate active XIDs or meter invisible engine versions.
Growth acceptance still counts every design-visible key, row, fanout and expansion under the unchanged bounds.
A lower-XID reduction visible after start must remain pending or leave a later applied change generation that
the current final observation detects, even after repair and ACK.

Refresh of a same-version external-write conflict may preserve the OLD winner: FOREIGN repair needs dependent
source-own anchored advancement and actual repaired winner/visibility. Native engine write-block verification
drains admitted writes only while installed, not delayed requests after unblock. Cold internal subject-key
traversal still needs lossless concurrent creation/change handover, pinned required-log retention and gap/epoch
recovery; legacy label/history hydration is neither public truth nor cheap key enumeration. Unknown custody or
registration cannot become none/erased/clean, and permanent preparation fails quiescent finite progress.

Remaining serving implementation includes indexed changed/behind/cut observations and the complete default
page root. The installed native identity/definition, captured-window repair and all-writer/retained-copy custody
bodies still owe native acceptance. All-role minimized-source completion, the direct/prepared/composed growth
matrix and served-share at 64/512/4096 with rising reduction rates and actual latency remain required proof. Default public queries, API surfaces, Source256 compatibility and main
acceptance remain distinct obligations. No helper/type/protocol pass here claims runtime availability, native
feasibility, public default queries, the main gate or completion of this remaining matrix.

## Separate complete population extension

`facet-population.ts:createFacetPopulationSource(config: Parameters<PublicFilterSourceFactory>[0])`
returns `FacetPopulationSource` from [facet-population-contract.ts](facet-population-contract.ts).
The closed request/page types and factory are exported additively from `semantic/index.ts`.
The existing three reader signatures are unchanged. This is preparation work on the existing caller/worker
lifetime, with no new scheduler, Source registry, matcher or native acknowledgement API.

`population` names the native `PublicFilterSourceBinding.join` result's exact immutable `readDefinition`.
The canonical `capture` is passed unchanged to native observation and execution readers; input objects and
fingerprints never establish registration, permission or immutable custody. Joined execution starts must match.
The native binding and current key-page implementations preserve explicit unavailability for missing owner
coverage; their metadata does not establish engine readiness.

Each home retains the first observed ordinary position before its key traversal continues, then fixes the
last key page's position as its creation/change upper fence. Exact outbox position/sequence seeks drain that
finite interval, including rejected events and behind-frontier creations. A separate bounded native point
resolves each routable event locator to an anchored subject. No sampled values, returned hits, counts or named
membership probes establish membership. Missing sequence/count/epoch evidence invalidates instead of skipping. An expected subject event whose
anchor metadata is missing stays unready; unrelated product event subjects are not assumed to be subjects.
Native PIT renewal is validated by the binding reader; a rotating PIT transport locator does not change
the retained immutable observation identity.
Native complete empty key pages advance; missing, moved and identity-pending homes never imply emptiness.

Every call revalidates the same retained consumer and native privacy observation, including final seal.
An indexed predecessor CAS commits the step's subjects and scalar frontier together. Replay returns the
committed successor; an allowance too small for that page yields readiness. The frontier is an opaque UUID,
not serialized population, permission or home vector. Key traversal applies the lower native 256 examined-key
cap; ordinary event and anchor reads are separate charged steps so inputLimit=1 remains meaningful.
Native costs, failures, replay, result slots and frontier attempts remain charged to PublicFilterCost.

A complete population is not a published facet generation: Search separately exhausts every subject's
projection, evaluates the existing matcher and validates final current disclosure and consumer publication.
Native producer adoption and the unchanged later acceptance remain required; typechecking is not native proof.

### Selected native binding and key-page declarations

`subject-source-key-pages.ts` publishes `SubjectSourceKeyCursor`, `SubjectSourceKeyPage` and
`SubjectSourceKeyPages`, with synchronous `createSubjectSourceKeyPages(pool, routing: Uint8Array, access)`.
`read({partition, after, inputLimit}, context)` returns explicit `eligible` completeness/continuation with native
epoch/position and IDs, `identity_pending`, or the closed `unavailable` result. Search's publication bridge adopts
these exact declarations. `SubjectSourceKeyTraversal` preserves the separate existing `readSubjectKeyPage`
capability on the ordinary subjectSource; the canonical factory port is `SubjectSourceKeyPages.read`.
The native current inventory checks routing, identity availability and current owner epoch/position. The separate
fixed-cut compatibility port remains unavailable until its creation/change handover is established.

### Adopted native bootstrap binding

`public-filter-source-binding.ts` declares the existing synchronous
`createPublicFilterSourceBinding(pool, routeKey, access)` factory and its additive
`PublicFilterSourceBootstrapBinding` subtype. Constructors validate configuration; native work belongs to async
methods. Source-owned registration, native cuts, adoption intent and retained repair state are persisted.
Missing privacy/projection or foreign physical receipt authority returns typed unavailability; metadata never
substitutes for owner coverage or an engine acknowledgement.

`resolve` retains the canonical Search capture union (legacy, mixed discovery and suggestion prefix), accepted
meaning, native Source configuration, expanded root/read definition and dependencies. `join` validates the exact
Search observation and optional derived execution independently of that execution's batch size/keyset.

`begin` owns pre-arm admission and the original consistent native Source cut before Search opens its PIT or
retains a prepared generation. `adopt` links actual committed Search custody to that same cut. `recover` resolves
native uncertainty without recapture; `abort` cannot dispose unresolved physical or receiving custody.
`repairPage` returns bounded current projections and genuine Source-owned-home observations/receipts for local
and foreign routing, including partial projection frontiers. Only committed own-home advancement determines an
external replacement version. `settle` validates the original bootstrap, same old cut/execution, Source receipts,
all configured owner domains and real Search dispatch/visible-winner/retained-copy custody. Neither a generic
caller receipt nor a successful engine callback certifies completion. Account proof stays with Accounts.

Generation completion is `public-filter-source-binding.ts:readNativePublicFilterPublicationCompletion(
binding: PublicFilterSourceBinding, request: NativePublicFilterPublicationRequest,
context: PublicFilterConsumerContext): Promise<NativePublicFilterPublicationCompletion>`, also exported by
`semantic/index.ts`. Decision: pin the generation job to the original bootstrap/observation/execution;
compose original terminal verification, independent Search settlement and the installed all-home Source reader.

The first request is `NativePublicFilterPublication = Readonly<{job: string; bootstrap: string;
queried: PublicFilterQueriedObservation; execution: string}>`, after actual Search retention and before dispatch
or adoption uncertainty. The retained bootstrap snapshot kind must match the exact Search observation kind.
Search may provide a deterministic bootstrap locator equal to the existing publication job UUID; Source retains
that original locator and exposes it to completion as `0:<job>`.
Resume with `{job: string}`. Source checks the actual `search.generation_publication`
job, binding and physical consumer/incarnation and retains only locators on its existing bootstrap. Restart
resolves and adopts that same observation, without a latest-observation lookup or a new cut.
The callable advances only the existing bounded per-home settlement/ACK frontier. Search independently reads
original dispatch/winner/copy/refresh/writer and physical incarnation evidence; Source verifies its original
terminal chain, immutable enrollment, owner epochs and contiguous creation obligations. No transaction spans
foreign I/O. A clean population, count, complete bit, callback, caller token or Account erasure barrier cannot
replace these proofs. Current changes and late writers require native owner repair.

Before resolution the result is `PublicFilterBindingFailure`. Once resolved, incomplete repair returns
`{status: 'pending'; publication: NativePublicFilterPublication; reason: PublicFilterBindingFailure['reason'];
cost: PublicFilterCost}` so Search resumes that tuple without completion.
Completion carries `publication`, `definition: PublicFilterSourceDefinition`, original
`covered: PrivacyReductionStart` and non-null joined `execution`, observed `observation`,
`terminal: Readonly<{step: string; root: string}>`, `settlement: NativePublicFilterRepairSettlement` and
`cost: PublicFilterCost`. The all-native-homes observation uses the original execution/start, complete routing
and no pending, unresolved or unacknowledged homes. Decision: changed-since-start remains a disclosure fact;
original verified repair plus current native ACK and independent settlement can complete maintenance.
Changed information stays intact and never authorizes disclosure of an old execution. Search
composes the callable through its existing writer fence and owns activation and reader-safe retirement.
Native receiving, restart and growth need acceptance.

### Native Source metadata ownership

`public-filter-source-binding.ts` exports the synchronous
`createPublicFilterSourceBinding(pool, routing: Uint8Array, access): PublicFilterSourceBootstrapBinding`.
Its declarations retain the canonical Search Subject/mixed/prefix capture union and Search-owned queried
observation. The bootstrap and original receipt types remain in the adjacent implementation.

Migration `20261030222921_public_filter_binding.sql` owns Source tables in `semantic`:
`public_filter_source` has `(partition_no,source_id)` identity and an independently stored configuration,
route fingerprint and owner epoch; `public_filter_read_definition` has
`(partition_no,read_definition)` and immutable configuration/release/type/root/compiler keys.
The internal constructor association routes only to that actual configuration. A structural copy,
foreign pool/Access/route key, unpublished meaning or substituted retained input cannot establish it.
`resolve` registers these Source-owned rows and rereads their native identity before returning.
This is metadata, not a current disclosure or permission result. Source's three privacy/projection
readers retain their independent contracts and budgets.

Migration `20261105090000_public_source_repair_custody.sql` adds the immutable publication job/observation/execution
locators and a unique job lookup to that original bootstrap. It stores no Search engine receipts.

`public_filter_bootstrap`, keyed by `(partition_no,bootstrap)`, owns pre-PIT native cuts and atomic
adoption intent. `public_filter_bootstrap_account` retains original Account/claim owner heads under
`(partition_no,bootstrap,account_partition)`. `public_filter_repair_step` owns bounded retained Source
repair continuations; `public_filter_repair_advance` owns only subject-home Source advancement.
Neither table is a Search definition/observation/execution registry. Search remains sole writer of
its canonical custody, physical incarnation, PIT/prepared and visible engine receipts.

The Source cut is a persisted native `pg_snapshot`, owner epoch and source-home position, identified by the
bootstrap locator. It precedes PIT/prepared dispatch. It is neither an engine publication fence nor all-home
privacy coverage: those remain independently required by the existing privacy readers. `begin` checks the
real Search registration via `readGenerationPublicationCustody`, then records the cut. Mixed roots retain
all 4096 Account/claim homes through bounded retained enrollment steps; incomplete capture is unready. Original
heads and baseline receipts are immutable, so reduce/restore/repair ACK cannot renew them.
`adopt` requires exact canonical custody, consumer, definition, snapshot kind and original covered locator.
The Source adoption row stores only the canonical observation locator, never a copied PIT or execution record.
Recovery resolves real Search custody without recapturing a cut, including retain/open committed before adoption;
a missing or uncertain Search record remains pending. Abort persists an admission barrier and retains
unknown physical custody as pending. The committed Search reader cannot prove closure/transfer from an absent
or expired observation, so Source cannot finalize that abort on such an answer.

Repair retains scalar native key/projection frontiers and Source-content digests, without copying projection
bodies. It enumerates raw original keys, including hidden/rejected inputs, independently of execution hits.
Native Source advancement commits at the subject's own home through the command fence; only that committed
bigint position can precede a replacement projection. Projection completion and final original/start/cut
privacy revalidation remain mandatory. A moved owner, changed Source or missing Account repair owner is
unavailable. No whole rebuild or creation/change coverage is inferred from one page. Search's committed
`readPublicFilterRepairSettlement` verifies actual repaired winners, dispatch, copies, writers and refresh
custody through its staged native owner reads. Source `settle` uses the independently verified original
terminal chain and its indexed closed-home windows, rather than clean serving population eligibility.
Each funded settlement step replays that exact original window before and after the genuine Search
settlement, checking native owner, retained pin, baseline receipt and current original Source/Account
heads around the staged foreign work. A changed owner, security witness, tuple or incomplete seal remains
unavailable. No native connection remains held across the foreign phases.

The original repair pages now retain independently verified prefix metadata in
`semantic.public_filter_repair_step`. `readRepairStep` replays each actual native
key, advancement, projection, Account tuple or creation-event successor before
adopting it. Payloads, limits, locators and existing proof roots stay immutable;
only the exact original successor can extend the prefix. A partial unique index
locates its tip without walking prior pages. Trigger metadata and successor-FK
keyed reads are admitted before submission and retained in failed-call accounting.
Recovery can verify one older original
page per funded repair invocation. The empty terminal successor binds this same
prefix and its exact definition, queried observation, covered/start and execution;
it does not call the served-population reader. This closes captured page replay,
not current population eligibility. The same original pages now retain an indexed `verified_home` only
when independent replay closes that exact captured window. The complete terminal retains an `ack_after`
frontier; it advances one home only after the real registration-home ACK has committed and Source has
adopted that native receipt. Crash recovery repeats that same home, never a newer baseline.

The internal step API is `readRepairStep(request: NativeSourceRepairStepRead,
context: PublicFilterConsumerContext): Promise<NativeSourceRepairStepVerification>`. Its request is exactly
`{bootstrap, queried, execution, predecessor}`. It resolves the stored successor for that exact predecessor
and returns its native step ID, original predecessor, ordered bounded locator list, and stored incomplete
frontier. An incomplete step's frontier is its stored step ID; `null` is returned only for a durably verified
complete step. The locator list comes from the original retained page, including an empty list for a proven
empty page. A caller array, newly built projection, current equivalent page or absent item cannot fill it.
The bootstrap keeps its `0:<UUID>` locator; the native lookup validates that original format before extracting
the UUID used by SQL. `readRepairReceipt(request: NativeSourceRepairRead, context)` independently resolves each
listed locator against its own original retained page. Both readers use basic immutable Search custody and
never call Search's settlement reader.

The verifier consumes the existing original-page readers in `public-filter-projection.ts`:
`readOriginalPublicFilterProjectionPage` retains the actual page on production, and
`readRetainedPublicFilterProjectionPage` re-reads that same page for replay and verification. The existing
`public-filter-creation-window.ts` exports `readPublicFilterCreationWindow` and
`readPublicFilterCreationEvent`; they resolve the enrolled bootstrap's original creation checkpoint and
bounded outbox interval, then verify each actual event position and event-group continuation. These are
Source-owned native readers, not a replacement ledger. Missing enrollment, pruned or partial event groups,
owner movement, stale original rows and uncertain results remain unavailable. A complete result requires the
verified original window chain and its terminal successor; reaching home 4096 or observing an empty page alone
does not complete it.

Migration `20261031235550_public_source_repair_custody.sql` stores each step's original input limit and receipt
protocol, each Source advancement's same-command transaction ID/native transaction provenance, and the ordered
SHA-256 locator digests in a bounded packed field. It freezes the step and advancement rows and enforces the
original advancement event at commit. Existing rows without that original provenance or digest list remain
unverifiable; no current transaction or equivalent page upgrades them.

The ACK transaction locks the same registration and home summary as change apply, checks the exact native
consumer and holds the original physical target/incarnation point through commit. Its complete original
Subject and independent Account/claim baseline, captured successors and genuine mixed physical settlement
cover precisely that baseline prefix. It records the actual observation, execution and native Search
settlement locator on that summary. It never takes a maximum delivered position, changes
`last_change_generation`, or rewrites covered/start/baseline generations. Source positions, Account enqueue
revisions and the native revision/claimRevision stay distinct. A later position or enqueue remains behind;
ACK never retires a Source pending key. Existing reverse-enrollment apply receipt adoption and Source
home/key revision CAS retain responsibility for pending retirement across every captured registration.

The installed maintained-population/page-root path owns current coverage through refills and final projection.
Captured-prefix repair/ACK never independently authorizes old observations or default delivery.

New original repair traversals include Account rows, Account intents and claim
intents in each native home. Each arm seeks at most one raw key; all returned
lookahead rows and bytes are charged before the bounded merge. A claim intent's
route locates its claim home, independently of the Account ID. Repair releases
that home, resolves the actual Account owner and retains the exact claim-home
frontier for resumption. The independent verifier derives the same transition
from native keys and owner facts. Original traversals without this claim-input
coverage remain retained but cannot acquire a complete terminal proof. Delivered
intents still require the separately retained creation-event bridge, and these
key traversals do not acknowledge either native tuple domain.

The native checkpoint row for an enrolled original window cannot be advanced,
renamed or deleted by ordinary checkpoint delivery while its enrollment retains
it. Verification does not release that retention obligation. Native retirement
still has to drain its actual users, writers, copies and captured obligations
before releasing enrollment and pins; the checkpoint guard grants no retirement
or repaired coverage.

### Realm and board native authority identities

`PublicFilterDependency` also accepts `{kind:'realm', route, realm}` and
`{kind:'board', route, board}`; `PublicFilterDependencyKey` accepts `{kind:'realm', realm}`.
Each UUID is canonical native identity and its route must match the original command home.
The existing dependency impact carries these locators, and `PrivacyReduction.cause` accepts
`realm` and `board`. A board cause checks the native Content board point in the same transaction:
its one broad log entry includes that board and, for a Realm board, its actual immutable parent Realm.
A global board has no invented Realm. Other genuine bounded affected keys remain supported.
No affected-Subject enumeration occurs in a broad writer. The scoped owner supplies compiler Realm
keys and actual Content writer/support callsites; this Source slice supplies neither an evaluator
nor a new installed scoped API.

Realm keys and authority locators share exact structural `authority/realm/route/UUID` routing in
the existing Source key enrollment and pending B-trees. Board authority gets its own exact native
key and its parent Realm key covers absent/new/empty-board membership. Complete immutable compiler
closure enrollment retains negative, excluded and ordered dependencies. The existing unresolved
routing barrier also remains conservative until genuine complete routing/apply and physical settlement;
an empty reverse lookup cannot independently certify no effect. These are the original Source
indexes and receipt frontiers, not a resource safety clock or permission copy.

### Cost: native captured-prefix settlement

- Touches: original repair predecessor/window proofs and pins, keyed current Source/Account authority,
  actual Search physical receiver/writer/copy/refresh custody, and the same registration home summary.
- Bound: one retained home per funded ACK step, with native verification on both sides of staged foreign
  work; joins, control keys, failures and replay remain charged. No serving sweep or allowance reset is added.
- Growth check: mixed ACK gap/p+1, missing-seal, old-cut, late-writer and physical no-resurrection controls
  remain deferred native obligations. Authored regression and workspace typing do not establish their outcome.
