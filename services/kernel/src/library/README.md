# Library

Library is the kernel module for a person's shelves and reading state, and for the public projection of public Collection membership.

`shelf-contract.ts` re-exports the callable `createShelfReads` and `admitShelfRead`. The default kernel installs
`createDefaultShelfReads`: six fixed native date orders, one selected-page active-session batch, exact owner-private
root/trie type lookup, maintained counter-key summary and byte-budgeted dictionary facets, using the existing opaque
cursor codec. Reads check current owner Access and account/authentication state; list additionally admits
`progress_session:list` and the current `reading_progress` gate. Cursor bindings include the normalized predicate,
effective size, current partition epoch, maintenance epoch and active generation. FULL uses the existing subject batch.

The maintenance producer implements `ShelfMaintenanceOps.initialize` and generation-keyed `shelf_count` storage.
Native read activation still needs the same-RR gate/readiness/current-generation adapter (`ShelfReadGenerationReader`)
and the summary/facet readers' binding to that storage. Those readers currently accept only a proven complete active
nil generation. The consumer aliases the published maintenance types rather than inventing its gate table.
Missing/incomplete evidence returns typed retryable
`dependency_unavailable`, including for an apparently empty owner. It never becomes ready zero counts. No native
readiness, source-currentness, full shelf outcome or growth proof is claimed by these callable readers or source typing.

## Scope and implementation boundary

[Library and Collections](../../../../docs/library-and-collections.md) owns the capability. This README adopts its
required behavior and inventories native code; requirements below do not establish shipped runtime. The shared
[dynamic](../../../../docs/dynamic-collections.md), [Collection source](../../../../docs/collection-source.md),
[filtered-list](../../../../docs/filtered-lists.md), [label](../../../../docs/library-labels.md) and
[profile-consumer](../../../../docs/library-profile-consumers.md) contracts own their respective seams. Indexed
observations and shared source-scoped concurrent identity currentness supersede their older per-page proof/replay,
whole-selected-slot, universal-key-budget and identity-basis protocols. Shared owners revise their ABIs; Library
adds no alternate mode or budget. The saved dynamic rule editor is adopted by the
[Collection editor](../../../../docs/collection-presentation.md); holding-derived game-platform filters remain deferred.

Native curated Collections store ordered occurrences, including repeated subjects, notes and order. Entries, copies,
progress sessions/units/history, follows and published logs have production commands/readers. The public subject
listing stores public Collection pairs and counts; it is not personal membership truth.

Current implementation evidence is narrower than the capability:

- `createCollectionPublicationFinalCommand` and `createCollectionPublicationFinalActivation` in
  `collection-publication-final.ts` use the actual Library operation/source/creation-receipt reader, the same
  worker pool and mounted Access/current consent reader, and ordinary `runCommand`. Every attempt restores the
  original initiator inside authorization preparation, compares its full native tuple and delegates ordinary
  Collection authorization at that attempt's time before receipt lookup. The body rechecks the actual staging
  seal, episode, pinned rule, selected output inventory and current owner/source fences before invoking the
  native output hook. That hook switches target visibility and selects B in the same transaction, then writes
  output provenance from the actual Core callback. The returned result is reread from the committed episode and
  contains only its locator and selected output reference. Private working inputs and public/unlisted outputs
  remain separate. Whole-query staging still refuses while the actual publication work-admission/getter and
  Search-owned work branch are unavailable; no empty result, copied proof or fallback authority is supplied.
- `collection-reads.ts` reads stored headers and ordinal curated occurrence pages. Dynamic headers omit curated
  counts/timestamps. Private saved members use the sole owner-filter binding and Source reader; public/unlisted
  members use only the Source's activated explicit COMPLETE output, including current original/terminal disclosure.
  BASIC and FULL share those boundaries. Missing bindings or incomplete canonical output remain unavailable.
- `collection-rules.ts` supplies `parseCollectionRule`, `admitCollectionRule`, `collectionRuleActions`,
  `prepareCollectionRuleAuthority`, `authorizeCollectionRule`, `readSavedCollectionRule`, `insertSavedCollection`
  and `updateSavedCollectionRule`. Definition admission uses shared parse/release expansion and the Search native
  Boolean compiler, with the common preparation declaration's supported `id` order. Saving a private definition
  requires current parent/account and every expanded private-family scope/gate/Access, including before replay;
  it requires no newly created Source or result/preparation receipt. The ordinary single-partition insert/CAS,
  rule revision, digest, receipt and event paths remain authoritative. Public creation still requires an unavailable
  whole-query publication producer; explicit selected-set publication below has its separate consent and meaning.
  Rule ASTs have one private row copy, are absent from receipts/events/public projections, and are cleared by the
  existing account retention path. Editing a rule changes its Source generation and invalidates the old selection.
  Existing built-in identities/rules remain immutable and private.
- `admitSavedCollectionMemberQuery` shares the common owner-family admission/compiler with ad-hoc member queries,
  reads the stored accepted release and preserves expanded saved meaning across activation. An additional filter
  is a bounded shared conjunction under that accepted release. The exact curator must be current before the rule
  is loaded. `bindOwnerFilterRead` and `readBoundOwnerFilterPage` retain native scoped binding, Source execution,
  complete-original closure and genuine preparation behavior; their unavailable producers are not bypassed.
- `readCollectionSourceMembers` generalizes the existing canonical member caller to an explicit Source scope;
  `readOwnerMembers` retains its private built-in wrapper. The public branch accepts only `activated_output`,
  no private query, and uses the same signed keyset, work ledger and fresh Source/subject revalidation. FULL facts
  revalidate that Source after foreign reads. Sitemap dynamic timestamps come from currently authorized stored
  metadata only after the ordinary explicit-output reader succeeds; no dynamic DTO gains times or counts.
- `GET /v1/collections/:collectionId/rule` returns only `{rule: SavedCollectionRule}` to the exact current
  curator with current `collection:update` and every private-family action/gate from the stored expanded rule.
  It reuses `prepareCollectionRuleAuthority` and `collectionRuleActions`, performs final native account/floor,
  Collection/source-generation and partition-epoch checks, and never re-admits old meaning against a new release.
  Unknown, foreign, curated and built-in targets are concealed. Public metadata contains no criteria. Web serves
  `/library/rules/new` and `/collections/{id}/rule`, uses the shared structured filter composer, native choices,
  private create, stable write intents and explicit conflict reload preserving the draft. Existing dynamic member
  reads retain honest preparing/unavailable states. Source typing is not native/privacy/whole/main or visual proof.
- `collection-source-native.ts` supplies metered stored-header metadata, native authorization, raw fact/member ranges
  and original-subject probes. The output driver reads only a selected explicit COMPLETE membership generation
  at the current Collection source fence; it never reads live private facts. Missing/pending output and headerless
  references remain unavailable. These helpers do not implement the shared members service or the adopted complete
  indexed filter/identity plan.
- `builtin-identity.ts` deterministically derives Everything/state IDs. `builtin-reference-store.ts` binds exact
  entry witnesses; it does not prove copy/session-only whole-state-set support, all siblings or writer coverage.
  These helpers implement neither Liked identity nor its Content reaction integration.
- Pin/kind columns, retained-entry/due storage, labels/reservations, source-head hooks and canonical tables exist.
  `entry-store.ts` accepts private pins for entry insert/update and pin/kind for copy insert/update, with
  `readEntryFact`/`readCopyFact` native readers. `progress-store.ts` accepts session pins and exposes `readSessionFact`.
  NULL-pin readers use the temporary owner-gated fixed contract. Current pinned facts remain readable without a job.
  The explicit migration runtime below supplies live-fact cutover; native integration proof is still pending.
  Label DAOs provide
  metadata lifecycle and reservation admission, not HTTP commands, complete assignment undo/pages or automatic purge.
- The native [owner sequence allocator/schema](owner-write-sequence.md) and
  [owner fact invalidation ABI](owner-fact-version.md), including full changed-row UPDATE coverage, are integrated.
  `entries.ts` allocates and persists owner write order for entry set, retained clear and exact Undo.
  These primitives establish neither complete owner-query coverage nor dynamic/canonical runtime readiness.
- Shared `FilterDocument`/`OwnerLeaf` and `parseFilter`/`admitFilter`/`walkFilter` deliver structural owner grammar,
  including saved expansion. `owner: true` is not authorization or a native owner plan.
- The common members route now accepts the adopted JSON `filter` and `sort=id` inputs through
  `owner-filter.ts`. It uses strict JSON and shared release admission, expands saved filters before private-family
  admission, binds owner facts to the authenticated viewer, and checks each family's native list scopes and gates.
  BASIC and FULL requests both reach that admission. Filtered/canonical execution remains explicitly
  `dependency_unavailable`: the native owner directory exists, but complete Source execution is not integrated.
  Admission consumes the actual `compileCurrentOwnerFilter` exports, which share Search's Boolean
  interpreter with catalogue-only compilation. No raw ordinal window is returned as
  a filtered page. Existing unfiltered occurrence reads retain their current contract.
- Admission now also returns `owner: OwnerFilterLeafProvider | null`. Its full-key native entry, live-parent label,
  retained session and retained copy points are bound to that admitted viewer and private family set, with the
  original request deadline. The caller must use its source-authorized snapshot and the same `NativeCollectionWork`
  ledger as the Source read. Every SQL point reserves rows, points, keys, statements, bytes and misses before dispatch;
  pin/text hydration requires a same-snapshot size point and a sufficient reservation first. `readPresence` reads only
  fixed-width current native support and does not depend on profile/pin readiness.
  `matchOwnerFilterSupport` checks a profiled supporter against its immutable accepted release, including actual session
  mode/unit and same-copy kind/status. `ownerFilterStateWinner` selects live native sequence order before
  `matchOwnerFilterState` tests profile/set/state. Missing accepted meaning or sequence stays `not_proven`.
  `matchOwnerFilterCatalogue` consumes the actual shared Semantic leaf evidence and pure matchers; incomplete or
  changed-basis negative evidence stays unknown. `evaluateOwnerFilterLeaves` requires all deduplicated observations
  before invoking the shared compiler. Admission also supplies the expanded query/release digest for cursor and
  preparation binding. `prepareCollectionMemberFilter` composes admission with the actual Source ABI and its caller's
  reserved allowance, returning only the real producer's opaque Source handle. These exports do not discover
  candidates, prove complete canonical absence, authorize originals/terminals, allocate another budget or implement
  the unavailable native Source/support execution.
- `owner-filter-plan.ts` supplies the common caller, bounded native candidate matching, shared Source reservation
  composition, selective identity revalidation, confidential current-basis cursors and useful-page enforcement.
  It gathers the current live entry winner before matching state; label, session and holding branches retain
  independent native support. FULL attaches the existing shared summary/facts batch and revalidates afterwards.
  A sparse admitted read delegates durable reservation and enqueue to `MembersPreparation`; only an actual
  preparing episode can produce the existing 202 body. BASIC and FULL share the same native admission path.
  `bindOwnerFilterRead` delegates to `bindNativeOwnerFilterRead`: native admission provenance, authenticated actor,
  current Collection incarnation/generation, actual Source preparation and its committed scoped capture are checked
  at the real read time or exact registered command attempt. `withOwnerFilterNativeRead` transfers Search's existing
  time and reservation without changing the binder's arguments. Binding and closure spend that same reservation.
  `readOwnerFilterCandidateClosure` delegates to `readNativeOwnerFilterClosure`: complete indexed canonical groups,
  independent native entry/label/session/copy locators, ordinary original and terminal guards, immutable accepted
  releases and shared Semantic catalogue evidence. Source-local snapshots close before foreign evidence. Final
  owner-fact, account, Source and scoped identity checks include excluded and nonmatching originals. Missing groups,
  full bounded windows and changed evidence remain unproved; no successful empty closure is returned.
  Private saved collections use the existing whole private raw drivers and custody capture rather than rejecting
  their null built-in kind. State Sources now prepare all independent native entry/label/session/copy ranges in the
  existing canonical generation, through `owner-index.ts:readOwnerNativeFactPage`. Its label range uses the actual
  assignment primary key, including retained and unidentified originals; no assignment witness is manufactured.
  The generation's committed `originalCoverage: 'owner-facts-v1'` distinguishes this population from older entry-only
  generations. Closure consumes the same bounded canonical group continuation, then current full-key private facts;
  the existing matcher chooses native state sequence before testing accepted profile/set/state. Unidentified live
  labels, incomplete groups, changed owner/source/scoped fences and denied originals remain unproved under NOT.
  The original per-call raw/physical allowances and retained preparation authority are unchanged. No request-time
  owner/alias scan, public/Everything permission or new positive receipt supplies coverage. The native cases in
  `test/library/owner-filter-native-closure.test.ts` await controller-owned execution; typing is not journey proof.
  This does not supply `requireCollectionRuleExecution`'s missing saved-rule admission body or a private working
  Source for publication replay after public activation. Those cases remain unavailable. The Semantic scope/public-capture
  modules retain their own producer qualifications. Combined native journey and physical-bound proof of this closure
  remains controller-owned after actual runtime release; source typing does not certify those outcomes.
  their null built-in kind. The admitted actual curator can also bind that private working Source after selected
  public activation. `owner-filter-working-source.ts` carries the immutable native query admission, actor, actual
  time/attempt and transferred ledger through all ordinary Source and closure calls. Working metadata uses the
  current native curator/incarnation/epoch/source/rule/fact fences, with no public output generation or receipt.
  Saved working meaning uses its stored accepted rule release; it does not acquire a built-in release or a public
  output proof. Final Source comparison includes the current curator and rule revision/release alongside capture.
  The existing canonical capture/repair producer and native custody retain a distinct `private_builtin` identity
  for the working facts; public output never certifies that capture. Private working reads require an explicit
  owner filter on the existing members route; the ordinary unfiltered public/unlisted request continues to read
  selected COMPLETE output. Current Collection/account and every expanded family scope/gate/Access are still
  checked before and after work. Neither working reads nor preparation update the public head, output members or
  its cursor basis. Publication B uses the existing native atomic output hooks and observed Collection revision;
  failed/refused B retains A, and a third retained allocation still refuses without actual disposition.
  Whole-query publication now consumes this distinct private working Source through its own current native
  admission. The Semantic scope/public-capture modules retain their own producer qualifications. Complete public
  disclosure, public/frozen input support, retained preparation/default worker integration and physical bounds still
  require combined native verification; source typing does not certify those outcomes.
- Members preparation's private [C3 parent composition](members-preparation-contract.md#cost-and-required-native-evidence)
  transfers the complete declared children from one caller ledger, including constant History registration and
  receiving. `fundMembersPreparationHistory` binds those children to the native History original, Pool, WorkClient
  and unchanged deadline. Each native phase consumes its exported price; repeated phases consume only the original
  retry child, including failed prefixes. The legacy standalone History original retains its three-attempt limit.
  Decision: the composed Members original uses finite declared retry capacity and the native deadline without an
  additional attempt-count limit. This allocation seam requires explicit owner declarations; native producer/dispatch
  integration and useful prepared pages remain required. Neither its budget nor a retained locator grants Source
  authority. The Source declaration/receiver, final native physical verification, bounded result/frontier storage,
  completed readback and coordinated cleanup remain integration work; the runtime stays unmounted.
- `command/operational.ts` and [Core's frozen contract](../command/README.md#operational-transactions) now provide
  the Accounts-owned additive event-free fenced transaction and same-client DBOS intent in source. Library's
  consumer/preparation/native custody implementation remains required pending; this is no readiness receipt.
- `createCollectionSource` composes current native authorization, scoped observations and indexed canonical
  generations. `canonical-source-store.ts` implements successor/group seeks, bounded native raw-driver repair,
  checkpoints and complete publication CAS. The sole default Library WorkModule supplies its operational client
  and maintenance queue. Missing Semantic scope/public capture remains retryable unavailability; the provisional
  Semantic factory returns `source_unready`, never current/ready-empty. Native useful outcomes remain pending.
- `collection-kind.ts` projects mixed defaults or stored explicit choices without member observations.
  Owner overrides bypass observation access. Metadata reads do not enqueue work; native mutation effects and the
  admitted repair boundary drive raw100/4096-byte steps, generation/version CAS, canonical unique votes, indexed
  Type winners and bounded retired-generation cleanup. Account-fenced operational transactions retain work with
  its owning account; the existing Library erasure inventory includes all four local kind stores. The native
  preparation binding resolves native retained Source/identity records and current audience authority; missing scoped
  Type/disclosure and authenticated continuation producers remain typed unavailable, and cannot certify a winner.
  The Semantic scoped-observation factory is a provisional typed unavailable adapter using its closed declarations.
- `work-module.ts` registers Collection listing effects and ordinary entry, label and copy retention. `account-fact-purge.ts` exports
  `purgeAccountFactsPage` for entry/copy/follow, without a terminal whole-graph worker. It still omits most of that graph.
- Semantic's `identity-epoch-store.ts:identityEpochStore`, admission/receiving custody, native birth mappings and
  bootstrap are implemented. Mapping maintenance, fixed participants, final coordinator and whole-query Source2a
  remain missing runtime producers. Existing point Access/disclosure, `subjectSource` and projection checkpoints
  do not close them.
  Content reaction commands exist, but inspected worktree/dev has no `readLiked`/`readLikedVersion` implementation;
  obtain actual raw/version and DDL receipts rather than inferring delivery from an earlier receipt description.
- `work-module.ts` registers Collection listing and the [terminal participant boundary](erasure-participant.md).
  It runs the integrated entry/copy/follow purge pages, records explicit pending evidence and never mistakes those
  pages for a complete graph or no-data proof. Full graph cleanup and shared custody remain incomplete.

### Kind original controls

The additive `collection_kind_audience_origin` control is owned alongside the current Kind observation. It records
one exact original/expiry/formula/Source generation and immutable request deadline per Collection/audience, without
an Actor or permission verdict. The original Access factory captures it only after the installed evaluator allows
the current Collection. Native admission joins that control to the exact consent consumer and current observation;
a consumer alone cannot admit an original. Preparation generations are opaque producer UUIDs, unlike routed
Collection and Account IDs. The forward migration removes only the obsolete generation route check.

Consent changes cancel originals in the same home. Observation deletion cascades the bounded original control;
existing migrations and ordinary Collection tables are unchanged. The full callable declarations and remaining raw
interval/foreign receipt operands are documented in [Access](../access/README.md#native-kind-audience-contract).
Source checkpoints are post-vote progress, not committed pre-Type raw input. Neither a capture, a consent enrollment
nor a current scoped observation manufactures the Semantic committed repair receipt and all five owner closures.

### Native whole-query episode storage

`collection-publication-episodes.ts` exports `createCollectionPublicationEpisodes({pool,access,clock?})`.
Its `begin(actor,{collectionId,revision,visibility},requestKey)` is also the Collection command factory's
`beginCollectionPublication`. It uses ordinary current owner `collection:update`, every expanded private-family
read/list check and gate, pinned accepted rule bytes, the native private working Source identity, and the actual
command's account/fact fences. Admission runs before receipt replay. One command allocates routable operation,
immutable source and building output references, captures the original admitted initiator, holds the current
Collection revision CAS, and commits their commitment in the exact native creation receipt. An existing header is
locked without rewriting its native Source fence, preserving selected A's original publication proof. The Collection retains the sole query
AST. Desired visibility stays in the immutable target until activation; pending B does not select public membership
or replace A. Unknown whole-query cardinality stays NULL, with no complete receipt; explicit selected-output hooks
refuse such builds.

`readCollectionPublicationInitiator` independently verifies original native source bytes, digest, target, transaction,
write basis and exact creation receipt PK/commitment. Accounts' native restorer repeats its independent checks.
`readCollectionPublicationEpisode`, `readCollectionPublicationRule` and `readCollectionPublicationEpisodeVersion`
return private domain data on the supplied client. Missing/collected evidence has no reconstruction path. Current
rule use compares incarnation, Collection/rule revision, source generation, accepted release and canonical rule digest.
`advanceCollectionPublicationEpisodePhase` delegates mechanical admission to the existing live Core work-step port
and performs version CAS; it cannot complete output. `collection-publication-service.ts` binds begin and owner-private
status to those readers, while `collection-publication-work.ts` registers staging and delegates activation to the
single restored-initiator body in `collection-publication-final.ts`. `builtin-materialization.ts` uses the existing parent-creation capability and native
and performs version CAS; it cannot complete output. The final human command and output-selection body are exported;
the owning work-admission/getter, bounded query staging and default receiving composition remain independent
dependencies. Their unavailable implementations are not successful empty results. `builtin-materialization.ts` uses the existing parent-creation capability and native
grant initializer for the first owner write (logical revision 0 to native revision 1), keeping Everything/state IDs
stable and accepted meaning pinned in the native header. Its storage title defaults to `Everything` or the accepted
state identifier until an owner changes it; no query AST is retained there. Liked refuses. The existing canonical
Source producer shares its identity allocator with original commands: it allocates an actual native scope only,
without claiming capture, observation, repair or custody completion. No public/frozen/full-query completion proof is claimed.

The work-admission/getter independently reread this committed episode and its original initiator receipt, current
pinned rule/release, private working identity, complete canonical Source generation, scoped identity observation,
current native receipt/custody, and unknown-size B on that same Core client. Missing current Source or scoped
prerequisites remain unavailable. Bounded query staging is implemented; final human command and default receiving
composition remain independent dependencies. Their unavailable outcomes are not successful empty results.

The existing terminal participant invokes `purgeCollectionPublicationEpisodes` in bounded owner-indexed pages,
removing private source/operation/initiator snapshots even when completed public A is retained. The three families
join its native probe inventory. Current account fences prevent late creation. Foreign principal/operator custody,
shared Core history and receiving/SDK minimization remain explicit pending obligations; local exhaustion cannot ACK.
The focused episode suite adds original native creation, replay/current authority, changed rule and receipt-retention
and built-in first-write assertions. These native assertions have not been executed here.

### Explicit membership Publication hooks

`collection-source-output.ts` exports `beginCollectionSourceOutput`, `appendCollectionSourceOutput`,
`completeCollectionSourceOutput`, `cancelCollectionSourceOutput` and `readCollectionSourceOutputInventory`.
The first four use the actual caller-owned Core command transaction with current `collection:update` authority
bound to that Collection; they hold its curator's native `shareAccount` fence through commit. The caller supplies
an explicitly selected membership set through ordinary Source/subject admission and emits its ordinary Collection
update event. These hooks do not implement query evaluation, another command runner or grants. The ordinary
selected-set HTTP consumer is `collection-publication.ts`, described below.
The native output test calls them through real Access-authorized Core commands. The production native source
reader consumes their selected COMPLETE facts; no private-query producer or test inserts ready output.

Append admits at most 100 strictly ordered subject UUIDs and a 4096-byte checkpoint/input, checks the exact prior
frontier and source fence, and commits rows with its checkpoint. Native member insert/update/delete hooks independently maintain actual row counts and tuple writer fences.
COMPLETE requires both that inventory and its append checkpoint to equal the declared exact number of
members, including genuine empty output, and selects the generation atomically with advancing the Collection
source fence. A pending B never replaces selected A. Any visibility transition changes that native fence, so an old
selection cannot be resurrected by a later visibility change. Private or deleted Collections are not output.
A known unlisted Collection remains governed by ordinary known-ID Access, never public discovery.
`NativeCollectionMetadata.outputGeneration` is the selected native generation; `authority='activated_output'`
selects only the output driver. The native raw-page and original-probe functions are its current consumers;
canonical factory integration still awaits the shared producers below. `outputPublication` carries the exact native
`CollectionOutputPublication` locator described in [native capture](../../../../docs/collection-source.md#existing-owner-native-capture-and-custody).
The active saved-output identity uses the distinct `active_explicit_output` scope with selected `outputGeneration`,
`publicationTransactionId` and positive `publicationPosition`, retaining the real curator and existing owner/
receiving/source binding. Native output hooks stage an immutable receipt under the live Core command callback;
a deferred constraint requires its actual same-transaction Core write basis, native xid and source/head/member
fences at commit. The lower native capture scans that COMPLETE generation only, checks exact raw exhaustion/count
and holds the final writer fences. This is structural custody and supplies no original/terminal subject or viewer
authority. Pending B leaves A selected; subsequent activation, source changes, rekey/delete and account fences
invalidate fresh A use. Existing held A can still be revalidated/released without new read authority.
Frozen ownership after account T/curator minimization, destination disposition and full native/main proof remain
pending. No Account is invented from a Collection ID and no public catalogue capture is reused.

`collection-source-order.ts` publishes the shared raw ordinal data types and the CollectionSource
`readRawOrdinalPrefix` call. `readNativeCollectionRawOrdinalPage` uses the all-state
`collection_member_raw_ordinal` index with a strict `(ordinal_key,member_id)` seek and raw limit 1–100.
Retained deletion episodes advance its frontier and consume work; they provide no disclosed membership or
canonical completeness. The projection excludes notes and other retained payload, and its statements, rows,
points, keys and bytes use the existing native Source work ledger. Native observation and current source fences
are checked on each page. The public factory call remains explicitly unavailable pending the shared scoped binding.

Source storage retains at most two generations, including cancelled, abandoned and superseded copies. With no
actual destination-disposition producer, a third allocation returns `dependency_unavailable`; it never reuses a
lease, infers NoData or deletes a source copy. Source-local inventory returns the exact retained generation keys
and member counts in one indexed bounded range. It does not certify receiving/control/reader cleanup or terminal
account erasure. Terminal public freeze and the actual shared disposition binding remain pending.

### Whole-query publication staging

`collection-publication-staging.ts` is the sole bounded staging producer. Its literal entry point is
`stageCollectionPublicationStep(tx: OperationalTransaction, locator: CollectionPublicationLocator,
options: CollectionPublicationStagingOptions)`. The original module also exports
`readCollectionPublicationStagingCheckpoint` and `readCollectionPublicationStagingSeal`. The first takes the genuine
operational transaction and shared `NativeCollectionWork`; the second freshly reads native committed state on either
an admitted work transaction or the actual authorized final Collection command. Returned references are not grants.

The episode's ordinary begin command allocates a `whole_query` generation in the existing native output namespace.
`expected_members` remains NULL while B builds; zero is reserved for a genuinely known empty selection or
an exhausted whole query at final activation. The original two-retained-generation limit, curator/SDK/epoch writer
guards and destination disposition requirements remain. B never changes the selected head A. Selected-list append
hooks refuse whole-query generations. Final activation uses the ordinary `completeCollectionSourceOutput` hook with
its same shared work ledger and exact episode locator/version/phase/selected-A snapshot. The hook independently
rereads the native staging seal, rechecks local episode/rule/owner fences, and switches visibility and B atomically.

Each step admits and reads the whole current publication definition on the same Core client before Source/Type work. It
uses the shared Source, id order, compiler and evaluator, transferring one allowance in every dimension. A private
bounded frontier retains at most one unfinished canonical subject and native leaf progress. Unused suffix/lookahead
is charged and sought again after the last settled key. Positive and excluded subjects retain their native evidence
references; complete original/terminal, raw, negative and order dependencies remain in the native Source capture and
scoped observation. Neither a raw-source exhausted bit nor a first canonical page seals the query. Canonical native
capture exhaustion, all query decisions, final current custody/identity/source fences and whole-definition equality
are required. Rows, evidence, checkpoint CAS and native exhaustion receipt commit together. The fresh seal reader
checks the exact receipt/header native transaction, version, member/evidence fences, native canonical generation and
current custody/identity/source, including the actual owner fact-source fence, before returning a count. A caller
cannot supply a count, completion flag or proof. The retained definition digest excludes only the scheduling phase;
each step still compares the whole getter result before and after foreign work. Moving a sealed episode to
`awaiting_activation` therefore does not reinterpret its pinned meaning or invalidate its unchanged native seal.

The delivered Search work-context union has a distinct `collection-publication` branch. Its admission rejects a
locator without the live Core work-step and exact owner namespace, then independently rereads the immutable episode
and exact original creation receipt before checking current Source evidence. The getter returns only the complete
current pinned definition and native references; it does not issue Source acknowledgements, complete-cut proofs,
viewer permission or activation authority. Source capture and repair remain with the existing bounded canonical and
scoped-observation producers. Catalogue leaf sealing remains unavailable until Search exposes its actual current
public Source/index proof in addition to the private owner capture. No index dependency is invented for a pure owner
query. The original public DYNAMIC whole-query/lifecycle/C5 outcomes remain unproved. The focused output-mode
assertions exercise real native interrupted/replayed allocation, unknown versus empty cardinality, ordinary-hook
refusal, changed fences, selected-A preservation and the third-copy limit; they are not a whole-query pass.

Retention/custody inventory: `collection_publication_staging` is keyed by `(route,collection_id,generation)`, with
exact publication and account indexes; it retains only immutable rule/native source/custody references, digests,
scope basis and a bounded frontier, never another private AST or Actor. `collection_publication_staging_evidence`
adds the exact canonical subject key, including excluded decisions. `collection_publication_staging_seal` retains
the native version/fences/commit position. All three are noncascading FK descendants of the existing retained output
and join its positive account-erasure inventory, including after source curator minimization. Account/receiving and
native admission fences reject late writers. Disposition must remove evidence/seal before staging and output; there
is no new cleanup participant, reclaim, lease ACK, public Search payload, work payload mirror or terminal completion.

### Whole-query publication transport declarations

`collection-publication-http.ts` exports `collectionPublishQueryRequestSchema`,
`collectionPublicationStatusSchema`, their static DTO types and `collectionPublicationStatus(episode)`.
The selected routes are `POST customMethod('/v1/collections/:collectionId', 'publish')`
(`POST /v1/collections/{collectionId}:publish`, operation `collection.publish_query`) and
`GET /v1/collectionPublications/:id` (operation `collection_publication.get`). Both require current
`collection:update` and the existing `gate:collections`; status is owner-private and `private, no-store`.
The endpoints are mounted through the ordinary gated native API and use the existing `collection:update` action.

The closed request is `{revision,visibility:'public'|'unlisted'}` with ordinary Idempotency-Key. Revision zero
allows an actual logical built-in's first materialization by the owning command. Requests supply neither an
owner nor a selected set, private query, pins or evidence. The closed status is
`{id,collectionId,visibility,phase:'staging'|'awaiting_activation'|'refused'}` or
`{id,collectionId,visibility,phase:'complete',publication:{generation}}`. The complete generation comes from the
actual native output publication receipt. Other phases never expose B's working generation or selected A as B's
result. The projector is used only after native current authority; it does not read, admit or complete work.
Internal creation retains its required `durableInitiator` commitment unchanged.

The actual native episode types live in `collection-publication-episode-contract.ts`; the distinct mechanical
role's locator and admission/getter declarations live in `collection-publication-work-admission.ts`. Their body
validates current native episode and private Source evidence on the same Core client before returning pinned work
data. The mounted service uses the real begin/status/initiator readers; the single existing Library WorkModule
registers locator-only staging and final activation. This boundary does not claim successful whole-query publication,
final activation or public Source proof.
`collection-publication-http.test.ts` retains the unmet real API/default-worker acceptance and focused closed
grammar/privacy assertions. It uses the existing native fixture and actual output rows/receipt, with no replacement
worker or domain backend. Schema availability and local typing do not establish that native acceptance.

### Explicit selected-set publication

The distinct whole-query seam in `collection-publication-work-admission.ts` rejects clients without
the original live Core work-step, exact fenced owner namespace and native attempt time before IO. Its published
locator and result declarations remain unchanged. It consumes the real episode, operation/source, creation receipt,
current rule and native Source readers. A current pinned definition is returned only while the private working Source,
identity observation, repair receipt, custody and unknown-size B still match the exact episode. Selected-set output
rows cannot supply that authority. This admission does not establish whole-query completion, disclosure support or
activation, and the original public DYNAMIC whole-query/lifecycle/C5 outcomes remain unproved.

`POST /v1/collections/{collectionId}:publishSelected` takes the closed body `{revision,subjectIds}` and ordinary
Idempotency-Key. `subjectIds` is an explicit selection of 0–100 distinct raw native Subject IDs. Calling this
method consents to publishing the current title/description/presentation metadata and changing visibility to
`public`, together with **only that verified selected set**. An explicit `[]` requests an empty publication; an
omitted array is invalid. This is not publication of an entire saved-query snapshot. Complete saved-query result
publication remains a separate producer and outcome; neither a first page nor a query-wide count fulfills it.

The target must be an actual stored active saved-dynamic Collection with the current caller as curator. Curated
Collections and logical built-ins retain their existing live semantics and are concealed as unsupported targets.
Another owner, including an owner on the same route, cannot read the private rule through this command. Ordinary
current `collection:update`, private leaf scopes/gates/Access, account share fencing and native header CAS apply.
All of those checks also precede Core receipt replay. Selected original and terminal identity/disclosure and actual
Source membership are prepared after releasing the parent home. Every raw reference and every complete-original
private fact reference consumes current original/terminal disclosure before fact hydration and canonical
deduplication; an unobserved original cannot borrow a positive from a different alias. Saved predicates use the
existing owner-filter interpreter and native complete-original closure, never a publisher evaluator or raw-point
self fallback. A selected nonmember is concealed, and an unproved selection returns `503 dependency_unavailable`
without a write. No whole-source scan, result truncation, query count, Actor or permission payload is published.

Preparation consumes the existing `bindOwnerFilterRead`, `CollectionSource`, `readOwnerFilterCandidateClosure`
and scoped-observation declarations. The binding must supply the same actual command attempt T, source and scoped
capture. The current native read binding and complete-original closure are typed unavailable adapters; the scoped
Semantic producer also remains unavailable. Consequently this checkout cannot yet claim successful native selected
publication, including empty publication. Their real producer modules replace those adapters; the publisher grants
no allowance, readiness, positive/empty membership or permission in their place. It deliberately refuses an activated
public output as evidence of current private saved-query membership. A producer must supply that owner Source before
a later selection can be verified; changing a header alone never opens personal predicate output to public reads.

The consumer transfers one existing work reservation, holds conservative charges for the native output work before
verification, and charges all raw identity/disclosure, Source and private fact work to the remainder. It allocates
no extra raw100 budget for output. Exceeding any dimension is unavailable, even for a syntactically valid 100-ID
selection. The final owning transaction compares the exact native source generation, visibility, incarnation,
revision and stored definition and revalidates the scoped capture through its existing source-local `tx` port.
No foreign home is opened while the parent is held. Relevant changes roll back the entire command.

One authorized Core command changes public visibility/header revision, calls begin/append/complete on the existing
output hooks, and emits the ordinary Collection updated/listing events and receipt. Only COMPLETE advances the
source fence and selects the generation. Complete A stays selected until verified complete B commits; no building
generation or partial set is returned. The existing two-retained-generation refusal and uncertain destination
disposition stay unchanged: no timeout deletion, NoData inference, cleanup ACK, new participant or worker is added.
Account erasure/minimization retains its existing ownership and pending native proof.

The closed response is `{collection,publication:{generation,state:'complete',itemCount}}`. `collection` is the
saved-dynamic metadata DTO, without predicates, pins, curated counts/times/order or member notes; `itemCount` is
the exact verified canonical selection size, privately returned to the current curator, not a public query count.
No pending or unavailable response can masquerade as a complete empty result. `collection-publication.test.ts`
adds ordinary native empty/nonempty, exact-selection, membership denial, CAS/source race, replay/current authority,
two-generation refusal and closed-input cases using the existing fixture. Those cases require the actual pending
Source producers; source typing is not native, privacy, whole-command, protected-use, visual or promoted-main proof.

The independent canonical runtime cannot be completed by substituting `identityEpochStore.readMappings` for the
shared whole-source observation. That real API observes at most 100 specified originals; it does not register or
observe complete excluded/order/population dependencies, retain a scoped reader revision, or fence first apply
into the fixed Library participant. The current canonical ABI still requires the superseded whole-identity
`basis.identity.digest`; `readIdentityBasis` and `readSealedSubjectIdentity` named in its old handoff have no
current native exports, and the owner contract forbids reinstating their global home sweeps. The adopted scoped
register/arm/finish/revalidate factory is callable but its native producer returns unavailable in this checkout. Its binding must come
from Semantic; this slice supplies neither a replacement identity protocol nor a third participant.
`semantic/identity-epoch-mapping.ts:stepIdentityEpochMapping`, the fixed Library participant's concrete export,
`semantic/public-filter-source.ts:publicFilterSource` is callable but unavailable; the shared destination-disposition producer also remains
unavailable here. Core's real `runOperationalTransaction` and `enqueueIntent` exist; a default canonical worker
must bind them to the actual shared scoped Source/admission producer before it can publish or expose readiness.
The added runtime/growth suites require successful real store/factory behavior; they intentionally do not turn
missing coverage into successful empty or preparing assertions. They have not been run in minimal mode.

### Default owner-query composition

The kernel passes its registered Search service, real Access, pool, clock and trusted route key through the
Collection and Continue factories. `builtin-runtime-query.ts` opens the actual native Collection Source with a
Core-minted read time and one transferred direct-owner reservation. Everything, state and Liked members consume
that Source's canonical prefixes and current membership; reaction-only Liked uses the Content source version,
independently of Library's fact head. Empty native Everything/Liked and Continue unions remain pure logical reads.
Raw metadata and retained scope identity discovery never execute a built-in members query recursively.

Admitted built-in filters use `createSearchScopeForService`, native id/source order, `sourcePrefix` and current
`evaluate` on that same service. Search's additive `work(result)` returns the actual preparation/evaluation receipt
without changing its existing opaque result shapes. The read-only option requires an already published scope and
never retains a definition, prepares a scope or saves evaluation progress. All refill, negative, lookahead and final-disclosure work shares
one reservation. Final reads mint a fresh native time and compare source, identity and exact source-version fences.
Continue consumes native chronological original seeks and complete Source groups, completes timestamp ties before
canonical ordering, and evaluates the existing accepted-state/session supports after releasing the owner snapshot.
It creates no preparation, persistent source header or grant, touch, receipt or work intent.

The existing Continue GET also accepts optional `view=BASIC|FULL`. An omitted view and `BASIC` preserve the original
closed response exactly. `FULL` adds nullable `subject` using the native `SubjectSummarySchema`; `continue-query.ts`
calls the existing `readSubjectSummaries` once with only the shown canonical IDs (at most 100), the request Actor,
current Access binding, deadline, trusted route key and `Accept-Language` ranges. The summary reader retains its
per-partition anchored batches and 256-ID ceiling. Unknown or currently withheld summaries remain `null`. The existing
final owner, complete Source, disclosure and version comparisons run after this batch; a changed source returns the
existing unavailable response without delivering either the page or its headers. The cursor binding, activity order,
readiness, and BASIC shape are unchanged.

This is default caller composition, not native readiness or main proof. In this checkout the actual
`identity-scoped-observations.ts` factory returns `source_unready` and `public-filter-source.ts` returns
`source_pending`/`dependency_unavailable`. The coordinator and mapping runtime modules are absent. The native
Collection Source still lacks logical headerless and Content reaction group bindings; those admitted logical
Collections return dependency unavailability rather than a false missing/empty page. Search also still refuses
owner leaves and requires the public index even for native source orders. Commerce has been asked to close that
exact native-owner interface with Search. Existing Source statement/row/byte ceilings are preserved: missing
readiness or insufficient complete work never becomes a successful partial page. No identity ACK, synthetic actor,
private Boolean evaluator, replacement index, global identity sweep or shared custody completion is supplied here.
The existing nonempty/session-only/reaction-only native user cases and the added current-source-unavailable case
remain integration evidence to run; local typing does not establish those outcomes.

### Scoped subject-search status

[Owner consumer requirements](../../../../docs/library-owner-queries.md#scoped-subject-search-consumption-required-runtime-pending)
adopt existing `subject.search` with Library/Collection scope plus all owner/catalogue/text conditions.
Search's sole `docs/subject-search-conditions.md` contract is pending adoption here; Semantic's one pure request
grammar producer follows its freeze. Verified request/logical-owner authorization bridges, native owner text
index/analyzer/ranking, complete Source2a/privacy/identity and runtime remain pending. The linked owner section
owns exact one-Library-scope preparation, Everything basis reuse, Cost and future native evidence requirements.

### Required built-ins and personal space

Use one Collection members service/surface for curated, Everything, state and Liked. Native personal facts remain
truth. The [native owner plan](../../../../docs/library-owner-queries.md#native-candidate-support-and-complete-observations)
owns the ONE private OWNER candidate/support directory, native indexed truth and complete selective dependency/
repair design, shared by Everything/state/Continue/Liked and admitted owner queries. No per-built-in membership
cache or copied exact-fact-witness store. Every qualifying producer must insert discovery coverage atomically or establish
readiness through bounded durable preparation. Missing coverage returns preparing, never false empty. Stale positive
candidates lose membership/disclosure immediately under current native checks. Logical Library/Collection list and
detail reads are pure: no repair, header/grant creation, receipt or domain event. The common members GET and the
precisely admitted subject-search consumer above may start the SAME bounded idempotent derived preparation and
work intent, keyed by actual viewer, Collection, validated
filter/sort and accepted release/meaning, under [Dynamic Collections](../../../../docs/dynamic-collections.md#model-and-identity).
It writes no domain state, header, grant, event or receipt. Members GET preparation returns `202 application/json`,
exactly `{preparing:true}`, `Retry-After` and owner-private `no-store`; retry the same validated URL and cursor.
No members, next, operation ID or partial data accompanies `202`. Genuine exhaustion stays
`200 {members:[],next:null}`; unavailable runtime/work stays `503`. Zone POST remains unchanged.
[Continue GET](../../../../docs/library-continue.md#http-contract) starts no work; the members exception does not apply.
The Accounts operational producer uses SERIALIZABLE/current deadline/contention retry, existing command gate,
request-mode actual Access/current-T finalization and actor-free work-step partition/up-to-two active/unfenced
account FOR SHARE fences. Atomic intent uses pinned DBOS `enqueueInTransaction` on the SAME pg client as derived
rows, no separate intent table/relay/new queue/second connection. Consumer uniqueness enqueues only newly created
preparation with deterministic workflowID, no deduplicationID, locators-only inputs and shared-history custody.
No receipt/event/write basis/position advance; existing DBOS recovers it and expires only terminal workflows.
Consume the actual Core API; ordinary `runCommand`/`noEffect` or enqueue after commit is not this transaction.

Everything is the unique subjects with live explicit state, effective live label assignment, retained session/history
or retained holding. Empty entry shells, trash, follows, curated occurrences, ratings and published-log snapshots
alone contribute nothing. Clearing state leaves other facts intact; removing the last qualifying fact removes presence.
Labels need no profile lookup or binding. Only live entry and retained copy/session facts with actual accepted pins
support an in-use state set and all sibling state views, even empty siblings. Labels and soft-deleted snapshots support
none. Do not infer a historical/current type. Accepted pins keep immutable meaning; support data is derived, never a
second source of authority.

For presentation and labels only, an unmaterialized PRIVATE state view selects the lexicographically smallest
currently supported accepted release digest containing that state. Discovery unions all supported sibling identities,
including empty states; each native fact retains its own accepted pin and meaning. Digest order expresses neither
chronology nor semantic compatibility. A materialized header keeps its accepted meaning, a completed public generation
keeps its own meaning, and an explicit owner rename wins. Public DTOs expose no private pins, predicates or digests.
[Dynamic Collections](../../../../docs/dynamic-collections.md) owns the detailed contract. Native selection requires
its own indexed support access path and later performance proof, never a scan over an owner's releases; that path
is not implemented.

Built-ins have stable deterministic identities and private defaults. Empty logical Everything and owner state
reference discovery need no stored header or write scope. Dynamic DTOs omit curated count, creation/update times,
order epoch and occurrence fields; no fake zeros. Every account also has a stable logical Liked that is always private, including
empty `200`; that adopted meaning does not establish implemented identity or members runtime. First authorized
materialization moves revision 0 to 1 atomically with native Collection resource grants and `shareAccount`, without a read-grant override. Denied writes create nothing.

Library contains Continue, Everything, Liked, pins and All Collections; Following and History are separate
destinations. State is a tile chip in the profile's wording and a filter; state Collections can be pinned, never
mandatory navigation tabs. Continue is a bounded native read using active-session/profile-active-state eligibility,
ranked by session activity, never full-library browser sorting. Liked uses current SUBJECT like/love reactions;
clearing or another kind removes membership. Thread/post reactions never qualify; reactions alone add neither
Everything nor explicit state. Content owns the owner-scoped reaction adapter; complete Liked source-version,
epoch/disclosure coverage and shared members integration remain missing. There is no following feed or public
follower total. An interim entry-only page is named tracked entries, never Everything.

Stored personal subject IDs and curated occurrences are immutable; new writes target the terminal. Canonical views
select the live state with highest private `owner_write_seq` among merged originals, show conflicts, retain every
original fact/reference/pin, union labels and preserve separate copies/sessions. Browsing emits
one canonical card; the editor retains every occurrence/note/order. Canonical-ID indexes establish browsing order
and uniqueness. Identity observation, publication and cursor currentness cover the actual source and complete query
dependencies, including excluded and order originals. Relevant pending work prepares; changed relevant basis restarts
the signed cursor. Continuous disjoint jobs cannot stall a finite unchanged owner source. No global active marker,
universal page gate, per-page identity-home sweep or identity-basis protocol. Original withheld support never becomes
public through terminal visibility; current original/terminal authorization remains required.
The SAME fixed `library-private-follow-counts` epoch participant covers EVERY Library canonical record, including
OWNER candidate/support directory and concurrent first-apply rekey custody. Its ACK binds exact native
transactionId AND component/job/epoch/version/scope and every prior removal/addition/fence, current terminal/
account/source admission and stale destination rejection. Follow-only completion is insufficient; no third
participant or independent ACK. Consume the semantic scoped concurrent closure through the
[owner plan](../../../../docs/library-owner-queries.md#shared-operational-identity-and-disclosure-producers);
actual native participant, whole-query Source2a and custody proofs remain required pending.

### Native identity participant prerequisites

The [Semantic contract](../semantic/identity-epoch-contract.md#complete-library-canonical-coverage-under-the-fixed-participant)
owns the fixed participant protocol. The following inventory identifies existing native seams and their missing
custody; it defines no replacement writer or completion interface.

| Existing producer                                                                       | Native boundary still required                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collection-source-native.ts:readNativeCollectionRawPage`                               | Member, entry, label, session, copy and selected explicit COMPLETE output ranges exist. Missing/incomplete output remains unavailable; public capture and terminal freeze still need their authoritative producers.                                                                                                |
| `canonical-source-store.ts` exported observation, repair and publication functions      | Indexed generation/reference/head storage supports bounded repair and publication under source fences and committed scoped observations. The default worker captures complete native dependencies; absent Semantic scope/public capture remains unavailable. Table absence or emptiness cannot establish coverage. |
| `follow-store.ts:applyFollow`, `readFollow`, `pageFollows`                              | These operate on the owner-home raw follow row. The installed Library schema has no canonical follow pair/support/total, negative-apply, target-fence or released source/receiving receipt stores. The existing public Collection listing aggregate is a different source and cannot supply this custody.          |
| `owner-fact-version.ts:readOwnerFactVersion` and native entry/copy/session/label stores | Raw facts and a mutation head exist; a complete structural inverse directory and native registration/birth/late-writer closure do not. Neither a head nor `canonical_source_fact` is a substitute membership authority.                                                                                            |

Semantic's installed `identity-receiving-effects.ts` now supplies the distinct receiving family. The original-home
structural gate and ordinary published follow-count gate retain their existing meanings. Independent owner effects
use `prepareIdentityReceivingEffect`, `lookupIdentityReceivingEffect`, same-transaction `admitHomeEffect` and
`recordIdentityReceivingEffect`, followed by released-home `reconcileIdentityReceivingEffect`. The closed Source
producer remains `identity-receiving-source.ts` with `IdentityReceivingSourceProducer`'s exact read/hold/lock/ACK
exports. That module is absent here; the actual Semantic producer throws unavailable, without a substitute permit.

`identity-epoch-participant.ts:stepLibraryIdentityEpoch` retains the exact fixed step ABI. Unknown, PREPARING,
cancelling and cancelled jobs are refused before Library effects. Complete receipt replay releases the read home
before Store reconciliation. An admitted job can process one registered source invalidation per invocation; it
still throws `identity_epoch_unavailable` until genuine ALL-role observation is available. Queue exhaustion is
never a complete receipt, a ready zero or permission to publish. This producer writes no participant-complete row,
imports no coordinator and registers no third participant or scheduler.

The Source owner's normal native handoff can call `prepareLibraryIdentitySourceInvalidation(pool, selection)`
using the existing `IdentityReceivingSelection`, or recover a retained receiving locator with
`registerLibraryIdentitySourceInvalidation(pool, effect)`. The Source must persist/retry that handoff: a crash
between Semantic preparation and local queue registration leaves the already registered expected effect pending.
The owned scope namespace is `library.identity.source.<role>.invalidate`, with roles member, entry, label,
session, copy and output. These scopes mean only basis invalidation; they do not acknowledge OLD withdrawal,
NEW addition, first-apply closure, whole-role rebuild, target fences or completed public output. The Source reader
must resolve each exact scope/disposition/effect key from its committed manifest, not infer it from selection JSON.
Its immutable source ID is the actual Collection ID for this handler. An absent canonical state is unavailable.

In the same admitted native receiving transaction, the handler locks the actual source and active owner account,
retains both working/ready generation bases, clears both ready/build pointers and checkpoints, marks mapping pending,
and registers structural `(original,source,incarnation,role)` existence. Facts, original IDs, pins, sessions, copies,
values and write sequences remain untouched. There is no per-fact/session/history directory or membership mirror.
The actual native receiving effect and its six-scalar frontier commit with those changes. Replays resolve that
receipt before mutation, so a lost response cannot invalidate a newer build. Source/receiving/control custody and
Source ACK precede dequeue; an ACK failure leaves the exact work pending. A partial pending index selects one raw
work key without scanning completed history, including lower-key registrations arriving behind previous work.
All nested native calls share the existing five-second work deadline or a shorter caller deadline.

The installed `native-source-custody.ts:createNativeLibrarySourceCustody` supplies actual bounded `capturePage`,
`finishCapture`, same-CommandTransaction/native-T `readAndHold` and `releaseHold`. This participant consumes
Semantic's receiving record/Source lock rather than substituting metadata for those holds. The missing Source
adapter must bind its committed manifest to the actual capture identity/receipt and retain the hold through exact
receiving/control custody. No capture-ID/generation relation is guessed here. Cross-home source/account/control
custody and public dynamic/frozen output authority remain unavailable. The local queue presently accepts only
same-home account/source/receiving/control work, under the actual account barrier; it cannot create late private
control copies after terminal T. Ordinary destination disposition is separate from identity hold release.

Remaining native bindings are the Source manifest/registration and six-driver generation/rebuild implementation,
complete owner candidate/winner/label/support/first-apply closure, and the existing follow owner's source delivery,
canonical pair/support/total/outgoing/negative and source/target fences. State repair must use highest live native
`owner_write_seq` and keep conflicts; null is unbuilt. These handlers supply no alternate business writer or fake
empty coverage. Actual mapping/Search/coordinator publication is also required for published undo acceptance.

Retention inventory: `identity_epoch_participant_work` stores exact receiving locators at the account/control home;
`identity_epoch_source_basis` retains detached source bases at that same home; `owner_identity_scope` stores structural
existence there. All have partition/owner-leading discovery indexes. Receiving native effect/frontier and control
custody remain in the existing Semantic ledgers, with their existing erasure-role/receipt obligations. Events contain
job locators only; no new DBOS payload, worker or workflow output is created. These private links and bases survive
uncertainty until actual irreversible Source/receiving/control closure, never timeout or local count exhaustion.
Library's erasure probe now names all three stores, and its missing-custody inventory prevents an ACK while their
minimizer/late-item handoff is absent. Inherited job subject/operator-role locators for these Library copies also remain unbound;
the owner-prefix probes do not certify absence for those other roles. Neither local invalidation nor Semantic
reference exhaustion proves erasure.

Cost: one exact registered work key, native source/account/gate/receipt points, one source-state mutation and one
structural directory point per step; zero original fact enumeration, engine calls or history scans. Existing
command/callback/Source hold/control ACK/replay work and all retained copies remain charged to shared limits.
No native Cost, positive reversal, full composition or growth pass is claimed. Minimal verification is local
kernel typing; the existing frozen refusal and later six-driver/custody/growth acceptance remain required.

### Native owner state-write sequencing (required; runtime incomplete)

[Owner state-write order](../../../../docs/library-and-collections.md#owner-state-write-order) owns the rule. Entry
create/update, physical clear and Undo restore must increment one per-account counter in the owner's partition,
using `UPDATE ... SET seq=seq+1 RETURNING seq` in the same authorized transaction as the fact, receipt, source hooks
and outbox. Initialization is part of the first authorized write, never GET. Live entries store the result as private
`owner_write_seq`; all of an owner's entries share that partition and total order, with contention only among that
owner's state writes. Do not derive this order from a global coordinator, clock/UUID sorting, max of unrelated
per-slot revisions or an executor hook.

Native receipt replay skips allocation. Failed/denied/CAS-stale/expired/occupied operations roll back counter changes
with the fact; branded `noEffect` cannot persist a counter update. Successful state-setting writes allocate even if
their value equals another row. Use native bigint for counter and stored sequence, no Number truncation, reset,
wrap or client-selected value; overflow explicitly aborts the write. Physical payload purge and derived repair
allocate nothing. Epoch maintenance consumes `owner_write_seq` and re-keys only derived indexes, never originals.
The counter is private ordering data, never permission, an account lifecycle generation, a membership witness store
or a disclosed aggregate.

The delivered [`allocateOwnerWriteSeq` ABI and schema](owner-write-sequence.md) require a live native execute transaction,
same-owner attribution and matching partition. Private `owner_write_counter` storage and nullable positive bigint
`entry.owner_write_seq` / `entry_deleted.owner_write_seq` exist; null is legacy/unsequenced, with no default/backfill.
Production row adapters and set/clear/Undo binding, bounded migration/cutover/readiness, epoch consumer and complete
terminal cleanup remain missing producers. Existing unsequenced values must not be ordered by dates, transaction UUIDs, source-type positions or fabricated zero.
The [native cutover plan](../../../../docs/library-owner-queries.md#sequencing-cutover-bounded-cuts-and-native-proof)
requires complete authoritative native state-write evidence, exact verified locators and bounded live-write cutover,
or explicit real owner reassertion. Affected winner/NOT-state/Continue state stays unready; independent complete
original/presence/label/session/holding paths need not all wait. Fresh supported writers must set real sequences
before canonical readiness. Unknown chronology is a required producer gap, not a permanent launch exception.

The distinct delivered [`readOwnerFactVersion` ABI](owner-fact-version.md) reads one exact owner head in the caller's
native snapshot. Its bigint result is private invalidation metadata; `null` means unbuilt, never zero or ready absence.
It provides no authorization, bootstrap, identity-epoch or whole-query coverage proof. Full changed-row UPDATE hooks
are integrated for entries, copies, sessions, label assignments and label parents. Each actual row change, including
a separate sequence stamp, pays automatic trigger work; genuine no-change updates do not. Never disable coverage or
add a manual duplicate head increment. Multiple row changes can advance the head repeatedly while the state-write
allocator increments once per successful state write. Complete owner indexes/plans and canonical/source/Content
version integration remain required under [owner predicates](../../../../docs/library-owner-queries.md).

### Required filtering, actions and cross-owner dependencies

Evaluate complete identified catalogue or private owner observations. Admit filter, source and order together:
bounded direct plan, otherwise bounded prepared indexed results, otherwise `422` before enumeration. Pages are filled
or final, or preparing, never chains of successful empty pages. Use per-plan derived row/statement/buffer/byte
allowances including label parents, native authority and preparation; no universal candidate multiplier or 256-key
cap. Preserve shared grammar and pure matcher semantics, same-statement qualifiers, units and unknown under NOT.
Owner-only NOT state includes no entry; missing catalogue evidence never proves a property. Current disclosure covers
membership, exclusions, order and fields, including NOT; an index revision grants nothing. Healthy catalogue freshness
is <=60 seconds; >5 minutes behind returns readiness. Privacy reduction is immediate and owner reads see own writes.
Private facts never enter public indexes; unchecked public totals/facets are forbidden.

Follow a readable unlisted Collection through the same abstraction. ItemList export preserves permitted curated
occurrence notes/order/multiplicity and emits unique dynamic subjects without private facts. Mount through Semantic's
Collection source contract. Bulk preview/execution bind the same admitted filtered/selected population, reject stale
selection, prevent replay effects and retain inspectable partial failures. Existing stub factories satisfy none of these
runtime obligations; no new bulk/export ABI is defined here.

Use the [native persona contract](../../../../docs/library-continue.md#native-authorization-boundary): no valid
suspended bearer exists. Suspension advances the authentication floor/fences before Auth revokes sessions. The actual
pre-suspension token receives `401`, JSON `invalid_credentials`, and
`WWW-Authenticate: Bearer error="invalid_token"`. Correct-password sign-in receives `403 ACCOUNT_SUSPENDED` with no
session. Kernel's defensive `403` is not a fixture scenario; never invent SQL/token personas. Preserve missing,
invalid and revoked `401`, scope `403` with `insufficient_scope` challenge, and unknown/private concealment.
Invalid credentials never downgrade to anonymous on public/unlisted reads.

Capability acceptance uses the same scenarios across curated, Everything, state, public/unlisted/private and
mounted Zone sources, varying definitions and fixtures. Include membership, bulk, ItemList export, unlisted follow,
mount, lifecycle and actual cost, not membership alone. Real filters are harem-tagged light novels, books strictly
over 1,000,000 words (equality/absent counts excluded), both together, sparse matches and withheld harem under positive
and NOT predicates. The native runtime and cross-surface evidence remain incomplete; this adoption runs no native tests.

Unresolved producer dependencies are specific:

- **Semantic/Definitions:** immutable accepted pins and state-set meaning, current original/terminal disclosure,
  canonical mapping and source-scoped concurrent identity currentness, complete catalogue projections, and Zone composition
  through Collection source. The old digest/home-sweep ABI is superseded, not a prerequisite to reproduce.
- **Search and performance:** shared admission/preparation/freshness, per-plan measured allowances and public-safe
  disclosure dependencies; Commerce supplies owner-local indexed plans. Catalogue owns harem/light-novel concepts,
  word-count properties, mappings and fixture configuration, including manual platform filtering.
- **Content:** current owner-scoped SUBJECT like/love reaction index/read adapter, not a Library reaction mirror.
- **Accounts and shared store owners:** the terminal coordinator, account read/write fence, actual participant
  acknowledgements, minimal completion outside DBOS history, and exact receipt/outbox/work payload minimization.
  Library and financial Commerce are separate participants; payment retention stays with financial Commerce.
- **Web:** shared members rendering, preparation/restart UI, Collection navigation and bounded Continue consumption.

## Explicit legacy profile migration runtime

The callable owner binding is [Native runtime binding](../../../../docs/library-profile-consumers.md#native-runtime-binding).
`profile-migration-runtime.ts` exports `createLibraryProfileMigrationRuntime`, the closed
`LibraryProfileMigrationRuntime` / `LibraryProfileMigrationProgress` / `LibraryProfileMigrationPhase` types,
`LIBRARY_PROFILE_MIGRATION_WORKFLOW`, and `registerLibraryProfileMigrationWork`. A trusted host calls
`start({ accountId, releaseDigest })`, `resume({ accountId })`, or `readProgress({ accountId })` on the factory
result. There is no HTTP start or ordinary-read mutation. The default single Library WorkModule registers
`library.profileMigration`; it runs only after an explicit start, using existing maintenance intents and retries.

The actual published release lookup precedes owner checkout. A step shares one 100-raw-row allowance across
entry/session/copy phases, uses exact revision/NULL-pin CAS, and commits pins, the source-head frontier and
successor work atomically. Entry keys materialize before NULL filtering. Sessions use their pending index;
live copies use the new retained-excluding pending index. The final source-head lock serializes monotonic
ready with live writers. Four indexed pending probes distinguish a first current writer from historical
population without needing a migration job or counting facts. NULL-pin DTO reads use the temporary fixed
contract only before ready; this supplies no unsupported current writes. Retained NULL-pin entry/copy evidence
keeps a non-migrating owner on compatibility reads. After explicit start, exact native Undo uses the captured
legacy digest for an originally NULL-pin fact, preventing a restored NULL from entering behind cutover. Existing
accepted non-NULL restoration pins remain unchanged.

The new source-head control fields are removed by its existing last-phase terminal cleanup. No receipt-history
scan, new participant, public payload or erasure acknowledgement is added. Native integration/growth evidence
is pending controller gates. The legacy HTTP-only driver's historical-fact setup requires an acceptance-owner
amendment to use the existing historical native fixture boundary; current endpoints acquire no legacy defaults.

## Partitions

Everything personal lives in the owner's partition. That includes Collections and their members, entries, progress sessions, units and history, copies, follows and published logs. A partition is `route >>> 4`. It is not a physically partitioned SQL table.

Public Collection membership is copied to each subject's partition, carrying only `public_collection_count` and pair rows. A pair is one `subject_collection` row: collection id, collection route and multiplicity. Private and unlisted membership never write those rows. Nothing in a follow, entry, session or copy is written on the subject's partition.

Sitemap discovery is internal. It follows the [partitioned sitemap research](../../../../docs/research/partitioned-sitemap-feeds.md): a partition-major walk over immutable `(route, collection_id)` keys, resumed after the last candidate examined. `readSitemapCandidates` in `sitemap-discovery.ts` reads at most a caller-chosen budget of active, public Collection identities from one partition, in route then id order, with the exact stored `updated_at`, through `sitemap-page.sql` and the partial index `collection_sitemap_public_page`, which carries `updated_at` as an included column so a page needs no heap fetch and no other index is a cheaper way to read it. It adds no catalogue copy, trigger or write-path change. The result is a discovery hint, never anonymous disclosure authority: the caller still decides what an anonymous reader may see.

## Privacy

Private state never reaches public full text, counts or "who also read". Only public Collections and published logs are public. An unlisted Collection can be read by someone who knows its id, and it is not listed. A private Collection is disclosed only to a live grant-capable curator. Everyone else receives the same not-found result as an unknown id.

Events about private state use the account or Collection id as `subject`, never a subject id. Collection updated, deleted, member-changed and listing-changed events use the Collection id. Entry, follow, progress-session, copy and published-log events use the account id. A member-changed payload also carries the member id and the subject id. An entry or follow payload may carry an id in `data`. The public listing event `com.rezics.library.subject.listed.v1` uses the subject id because that projection is public. Follows are never counted in public. A published log shows the subject id, the session state, the start and completion times, and the owner's note. It does not show amount, cursor or the completed-unit set.

### Deletion and restoration (first public contract)

[Shared deletion policy](../../../../docs/deletion.md) is authoritative. This section specifies its first-public
Library application; terminal account erasure starts at T, independently of ordinary-record undo. The Cost section
below describes today's implementation, including physical deletes. The
retained-entry command and HTTP Undo preserve exact original meaning with current authorization. Collection deletion
and exact restore DAOs are installed. The default due worker and existing terminal participant remove bounded
never-public local graphs; public Source/disposition binding, terminal full-graph closure and complete native
delete/restore/purge proof remain incomplete. Legal-hold support is deferred for first-public Library deletion:
this slice specifies no hold authority, route, destructive guard or release path and does not depend on one.
The adopted saved dynamic Collection editor uses the same terminal minimization policy; its unavailable
execution boundary is described above.

Delete commits a tombstone at kernel command time `deletedAt`; `restoreUntil = deletedAt + 30 * 24 hours` in UTC.
An authorized undo is allowed only while kernel time is strictly less than `restoreUntil`: day 29 succeeds, the
exact day-30 boundary fails even if purge has not run. Client clocks, workflow start times, receipt times and a
legal hold never extend that interval. The ordinary delete route never physically purges payload. No early-purge
route or parameter is currently exposed. If one is added, it must require a separate explicit platform purge
permission on the exact target; ordinary owner/delete authority is insufficient. That permission/action binding is
missing, so existing delete routes must not be reinterpreted as early purge.

Takedown is a disclosure hold, not a delete: withhold the least covered field or the record when a smaller
withholding does not satisfy the notice, retain other fields as allowed, and do not schedule purge solely because of
the notice. A legal-order purge is a distinct platform-authorized operation. The shared policy also says legal holds
suspend automatic purge without restoring disclosure or extending an ordinary record's undo deadline; first-public
Library does not implement that hold workflow.

For the rows below, entry, copy, label, assignment and published-log writes require the current owning account and
their operation scope (`library_entry:delete`, `copy:delete`, `library_entry:update`, or `published_log:delete` as
applicable). Collection and member writes require the curator's current Collection resource permission
(`collection:delete` or `collection:update`). Each command binds the actor, action, stable target identity, canonical
input and applicable target revision or generation; member restoration also checks the saved occurrence identity
and current Collection order/capacity. Current account, scope and resource authority are checked before receipt
lookup. An authorized same-key replay has one effect; current authority missing on replay conceals retained payload.
A stale revision or changed identity conflicts without overwriting a newer fact.

| Record / existing supported mutation                                             | Required concealment, reference and undo                                                                                                                                                                                                                                                                                                                                                                                                                | Actual gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Policy-window purge (specified, not implemented)                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exclusive `entry` / `DELETE /v1/libraryEntries/:subjectId?revision=…`            | The owner account hides the state fact immediately from all ordinary views. A permitted reference is only stable identity and deleted state. Undo restores the same owner/subject incarnation, exact state and accepted profile pin with a newer CAS revision. Copies, sessions, labels, follows and curated occurrences survive independently.                                                                                                         | Native clear retains the complete snapshot under its actual command transaction. HTTP Undo restores it only into an empty slot before the original deadline; current owner admission precedes receipt replay. Automatic due delivery remains separate.                                                                                                                                                                                                                                                                                                                                              | The skeleton identifies one person's reading state, so erase the entire private fact/incarnation and profile pin.                                                                                                                                                                                                                                    |
| Holding `copy` / `DELETE /v1/copies/:copyId`                                     | The owner account hides the holding and private location/source/note/dates immediately. A permitted reference is only its stable identity and deleted state. Undo preserves copy ID, values and pins with a newer revision; it does not mint another copy.                                                                                                                                                                                              | `entry-store-copy-delete.sql` physically deletes. The route pre-reads the row and has no retained tombstone, client CAS delete contract or authorized absent-row replay path.                                                                                                                                                                                                                                                                                                                                                                                                                       | The owner/subject holding is personal; erase the whole row and its private fields/pins, leaving no account-to-subject skeleton.                                                                                                                                                                                                                      |
| Curated `collection_member` / member DELETE                                      | The authorized curator hides that occurrence, note and count/multiplicity contribution immediately, preserving duplicate siblings. A permitted public reference is only occurrence identity and deleted state; private occurrence existence stays concealed. Undo uses the same member ID, subject, note and original placement only if current Collection order/capacity permits it.                                                                   | `collection-store-collection-member-delete.sql` physically deletes and decrements parent count. There is no retained occurrence revision/expiry or undo.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Minimize a public occurrence to its safe occurrence/parent/subject tombstone; erase a private occurrence whose skeleton is personal. The visible member count/multiplicity changes at hide, never again at purge.                                                                                                                                    |
| `collection` / Collection DELETE with revision                                   | The curator or currently authorized Collection editor hides metadata, members and every derived disclosure immediately. A permitted public reference is only Collection identity, kind and deleted state; a private Collection remains indistinguishable from an unknown ID. Undo preserves Collection ID, visibility, ordered occurrences, notes and pins, advances Collection revision/order basis, and never revives an independently deleted child. | The native DELETE now returns its committed deletion transaction ID and revision; `deletion_id` binds the immutable episode, and the authorized exact restore route consumes the existing native DAO. The original 720-hour deadline remains fixed. The default worker now removes never-public local graphs in bounded child-first pages. Public and previously-public graphs remain retained: no delivered native destination-disposition API proves that their source can be erased after withdrawal. Public pair/count withdrawal remains source-stamped through the existing listing workflow. | An ordinarily deleted public Collection is no longer an active public contribution. Erase title, description and personal attribution; retain only a safe structural tombstone and permitted relations/counts, including safe occurrence skeletons. Erase a private/unlisted Collection graph wholly, including previously-public personal remnants. |
| Label definition / label delete in the label contract                            | The owner hides the name and every assignment-derived fact immediately by current parent liveness/revision. A permitted reference exposes only allowed tombstone identity. Undo restores the same label ID/name and only still-valid assignments within the window, with a newer CAS revision.                                                                                                                                                          | `label-store.ts` provides native metadata CAS/delete/undo with original 720-hour deadlines and live-name uniqueness. The native catalogue commands and ordinary bounded purge are delivered; full HTTP/assignment caller integration remains separate. Recreation uses a new ID and can conflict with historic undo.                                                                                                                                                                                                                                                                                | Erase the whole private definition and its personal assignments through bounded exact-episode pages; keep no permanent named tombstone or live-cap charge.                                                                                                                                                                                           |
| Label assignment / unassign in the label contract                                | The owner hides only this assignment immediately. A permitted reference exposes only allowed identity and deleted state. Undo restores the same assignment identity only if its definition is live and current name/capacity constraints permit; it never revives an unrelated definition.                                                                                                                                                              | Same-row IDs/slots and `label-assignment-store.ts` provide reservation admission and deleted-parent reclaim. Individual unassign/undo DAOs and ordinary purge are delivered; full authorized command/list/HTTP integration remains separate. Restore must reacquire live capacity; reclaimed children never auto-revive.                                                                                                                                                                                                                                                                            | Erase the whole private assignment and its fact-index link; its owner/label/subject skeleton is personal.                                                                                                                                                                                                                                            |
| `published_log` / `DELETE /v1/publishedLogs/:logId`                              | The owner retracts the public snapshot immediately using the current revision. A public reference exposes only `{id, deleted:true}`. Undo is bound to the exact deletion id and revision, preserves the original published values/times and note, and never recopies current session state. The original 720-hour deadline is fixed across retries and restores.                                                                                        | A retained in-place episode stores the deletion id, revision and deadline while keeping the original snapshot private for exact Undo. The registered Library worker discovers due episodes through the partition-leading due index and minimizes payload in place. Account terminal purge removes all remaining log rows in bounded pages.                                                                                                                                                                                                                                                          | At ordinary expiry, remove the owner, session, note, state and personal times; keep only the public log id and deleted marker. Account terminal erasure removes the row and cannot be reversed. Retraction advances fact visibility once; purge does not repeat the visibility decrement.                                                            |
| Session, units, change history, progress head / start, record, complete, abandon | The account owner reads these through existing progress commands/pages while the account is active. Completion and abandonment are factual transitions, not deletion. Entry deletion leaves them available to the owner and a session may continue to support a subject in Everything. Unit removal is an existing progress record with history. There is no independent deleted reference or undo operation for these audit/history rows.              | No session/history delete API is promised. Account deletion is terminal at T and must conceal the private graph; there is no account restore to reopen it. The account-private Library purge consumer is absent, and history is unbounded even with the 20000-unit cap.                                                                                                                                                                                                                                                                                                                             | Under account erasure, erase private units/history before sessions and heads. A removed progress unit follows existing correction history until account erasure; do not invent a separate history-row delete API.                                                                                                                                    |
| Follow / follow, unfollow                                                        | The owner controls only their outgoing follow. Unfollow is a subscription state change, not deletion or a reason to remove another person's inbound preference. It has no deleted tombstone or undo operation. Account deletion is terminal and immediately ends the owner's access to outgoing state.                                                                                                                                                  | `follow-store-apply.sql` retains unfollowed rows; the account-private purge consumer for every state/reason is absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Erase every outgoing private follow state/reason and account-to-target relation; do not remove another account's inbound follow preference.                                                                                                                                                                                                          |

#### Entry deletion identity and restoration

**Adopted requirements.** Keep `library.entry` as the live owner/subject slot with its existing primary key
`(route, account_id, subject_id)`. Each successful clear moves the complete typed persisted row into a separate
private `library.entry_deleted` row. Its primary key is `(route, account_id, deletion_id)`, and `deletion_id` is
the successful native delete command's `transactionId`. This is an opaque exact locator, not authority or a routed
subject/account ID: derive `route` and `account_id` from the authorized owner, never from the locator. Do not add a
live-slot foreign key or cascade, a subject uniqueness constraint, a generic trash/version-history engine, or an
archive union in ordinary reads. Every deletion occurrence remains independent; a refill creates a new live
incarnation and never changes retained rows.

The archive keeps the full pre-delete row: `route`, `account_id`, `subject_id`, `requested_subject_id`, `state`, the
source `revision`, `created_at`, `updated_at`, original `transaction_id`, `activity_at`, `finished_at`, `type_id`,
all `type_source_*` stamps, non-null `incarnation_id`, and the accepted `library_profile_pin` with its existing
`library.library_profile_pin_valid` validation and the existing pin nullability rules. The required snapshot also
retains the original `owner_write_seq`; its nullable positive bigint column exists, but writer binding is missing.
The retained schema also has `deletion_id`,
`deleted_revision`, `deleted_at`, `restore_until`, and generated
`partition_no = route >> 4`. The due index is exactly
`(partition_no, restore_until, route, account_id, deletion_id)`. The source revision remains `r`, the deletion
revision is `r + 1`, and a successful restore inserts the saved values at `r + 2` with a fresh higher
`owner_write_seq`; reject deletion without mutation when `r > 2,147,483,644`. Restore inserts only into an empty
live slot and consumes only the selected deletion after
the insert succeeds. Occupancy or stale/expired state conflicts and leaves that archive row available. User dates,
pin, stored subject/alias and source stamps survive unchanged; lifecycle time, the restore transaction and ordering
metadata are new command facts. Undo does not copy the archive's old sequence into live state. Clear advances the
owner counter without adding a live tombstone; archive/deleted rows never compete as current live state. Missing
historical profiles use the actual legacy-null pin handling until the profile owner completes
the retained-row cutover; never infer a historical accepting type from today's profile or shelf observation. A corrupt
or unavailable non-null pinned release fails closed rather than guessing.

DELETE keeps status `204` and an empty body. Its minimal native command outcome supplies
`Library-Entry-Deletion-Id` and `Library-Entry-Deletion-Revision`; the latter is `r + 1`. Do not add an expiry
header unless its owner explicitly requires and documents it. A new
`POST /v1/libraryEntries/:subjectId:restore` has operation ID `library_entry.restore`, accepts only the closed
body `{ deletionId, revision }`, uses its own
`Idempotency-Key`, and returns the normal entry response. `revision` binds the deletion revision in the header.
Register it with `customMethod` as required by the [HTTP contract](../../README.md#http-contract).
Restore uses the exact stored `subject_id` and current source-read eligibility; redirects affect eligibility only and
never rewrite `subject_id` or `requested_subject_id`. Reuse existing native scopes, gates and pin validation; add no
profile, permission or cache authority. Use the existing `library_entry:update` owner authority and `shareAccount`
barrier for restore; delete keeps `library_entry:delete`. The locator is not permission. Missing or foreign handles remain concealed; occupied,
stale or expired restores return `409`. A successful restore consumes exactly that archive row. An exact authorized
restore replay is acknowledgement of its committed result, never a second insert; a fresh key cannot restore a
consumed row. There is no unauthenticated receipt endpoint, latest-deletion search or trash list.

Current authorization and account fencing precede exact receipt lookup on delete, restore and replay. Remove the
ordinary live-row pre-read from DELETE admission so a same-key request can replay after refill or restore. An exact
authorized replay returns its original deletion ID/revision metadata without touching the current slot. A receipt
created by the pre-retention physical-delete path may still acknowledge `204` with an empty body, but cannot claim
archive metadata that was never written. DELETE receipts store only the descriptor needed for replay, not the deleted
entry or pin.
The retained-point lookup for undo is exact and owner-authorized; it is not a new public state reader. A missing
current profile does not prevent clearing or undoing the identical previously accepted pinned value, while a fresh
profiled value still requires current profile validation after receipt handling.

Take `shareAccount` in the command authorization path before receipt lookup for entry create, update, delete and
restore, so both fresh writes and authorized replay serialize with terminal account deletion. Due work selects at
most 100 raw archive keys before later eligibility filters and advances after the last examined key. The destructive
transaction rechecks the exact `(route, account_id, deletion_id)`, authoritative due time or terminal account time;
an absent or consumed deletion is a no-op. Purge removes only that retained snapshot, never a live row by subject,
and never applies a second live-counter decrement. Register it through existing shared durable work; do not add a
Library-local timer. Minimize actual Library receipt, event, outbox and workflow payloads at exact locators under
their shared owners' retention protocols. Open shared-store and external inventory gaps remain explicit; no broader
physical-erasure claim follows from empty Library tables.

For replacement-safe fresh writes, expose opaque `incarnationId` in entry reads and write results. A revisioned PUT
body and DELETE query carry `incarnationId` alongside `revision`; the spelling is consistent across both requests.
A fresh revisioned mutation on a current non-null incarnation requires its exact guard, immediately for both
new fills and actually stamped rows. A missing or mismatched guard returns 409 without effects even when a
replacement has the same numeric revision. A create without `revision` remains valid and allocates a real non-null
incarnation through the existing `newId` allocator; updates preserve their incarnation. Parsers keep the field
optional solely to authorize and find an exact historical receipt. Omitting the field retains the original
canonical request-input digest. Current native authority and owner fencing precede receipt replay; a receipt miss
then locks the exact live primary key and checks revision and incarnation before any business write.

A current legacy NULL row remains pre-cutover and keeps its existing omitted-guard compatibility; a supplied
mismatch never bypasses it. A real row lock serializes fresh commands with stamping, updates and replacement.
No owner/global readiness marker, feature flag, receipt rewrite or historical-input exemption supplies cutover
evidence. The bounded default repair below examines at most 100 raw live primary keys per page before
null/pending filters, with CAS on observed revision, transaction identity and `incarnation_id IS NULL`, preserving
values, revision, pins and timestamps. GET never stamps. This API slice does not certify all historical NULL rows
or retained-profile readiness as migrated.

**Current implementation.** Native fills expose and persist incarnation identity. Revisioned PUT and retained
DELETE enforce the locked current-row guard after authorized receipt lookup. DELETE atomically retains the complete
row with its original sequence and returns exact receipt metadata; Undo restores its identity and values with a new
owner sequence. Pre-retention physical-delete receipts still return empty 204 without invented headers. Automatic
purge, terminal account full-graph cleanup and shared evidence minimization remain separate lifecycle work; this
fresh-write guard slice makes no completion claim for them. First-public Library legal holds remain deferred.

**Native incarnation repair.** `entry-incarnation-cutover.ts` exports the private
`cutoverEntryIncarnationsPage({pool,clock?},{partition,after,limit})`. A partition is 0–4095 and a raw page limit is
1–100. The optional internal `client` dependency reuses the worker's existing DBOS client. Discovery checks the
current native partition and materializes at most the requested number of live primary keys in
`(route,account_id,subject_id)` order, including non-null and subsequently ineligible rows. No NULL-only index,
global count or owner enumeration is required. A full page resumes after its last raw key; an underfull page ends
that partition's snapshot traversal. Progress contains only versioned routing/key coordinates, never entry payload,
revision, transaction provenance, MVCC version, pin or user chronology, and the complete page result is below 4 KiB.
The raw seek and exact source lock live in `entry-incarnation-cutover-page.sql` and
`entry-incarnation-cutover-lock.sql`, executed through their native Reylo adapters.

The source checkout is released before separately entering Core `runOperationalTransaction` in `work-step` mode
for each legacy candidate. Current partition and account fences precede an exact PK/revision/transaction/NULL lock.
The captured transient `xmin` additionally rejects any intervening row change without copying its values. Only
after that lock succeeds does `newId(route)` allocate the opaque identity, applied through the existing
`entry-legacy-incarnation-stamp.sql`. The update changes only `incarnation_id`; native source hooks remain enabled.
It allocates no user sequence, receipt, command transaction identity, event or profile stamp. Non-null identities
stay byte-equal. Account T, absent custody and unavailable partitions remain pending under their existing owners;
repair supplies neither account revival nor a cleanup acknowledgement. An exact-source CAS loser is pending too.

The single default `libraryWorkModule` registers `library.entryIncarnationCutover.every-10-minutes` on the existing
maintenance queue, with UTC cron and no automatic backfill. Each segment performs at most 100 bounded page steps;
an unfinished routing frontier continues with deterministic root/sequence workflow IDs in existing DBOS history.
Native commit before checkpoint is replay-safe. Every new scheduled sweep starts at partition zero rather than a
permanent highwater, so moved/fenced partitions, CAS losers and behind-frontier changes can be recovered. This is
technical identity repair, not owner-sequence, profile, canonical-index or full Library readiness. New native fills
already allocate non-null IDs and updates preserve them; fresh-request guard enforcement uses the locked current
row as described above. Owner GET reads expose the actual stored guard and never stamp it.

Existing first-scope concealment, Everything support from other live facts, the 18 legacy outcome pairs, and
public/private policy stay unchanged.

A deleted fact or curated member must immediately disappear from **all** ordinary point/pages, entries, state Collections,
Everything and Continue, Search, ItemList exports, sitemap discovery/output, public membership pairs/counts and any
existing feed. Personal facts have no independent public projection. Everything keeps a subject only while another
live state, label, session or holding fact supports it; entry removal is not full erasure. Collection deletion hides
all descendants through the parent even while cleanup is queued. Export/search/web adapters must recheck source
liveness rather than trust cached positives. Deferred feeds are not new launch surfaces. Saved Collection rules
require the shared Source's current live-fact authority before their execution boundary can become available.

Only the currently authorized owner or an explicitly authorized deletion-state reader can read retained payload
for undo; ordinary owner reads also conceal it. References return at most `{id, kind, state: 'deleted'}` where the
viewer may know that identity. They never include deleted title, note, state value, label name, pins or private
fields, nor reveal a private record's existence to strangers. Unknown and hidden identities share not-found.
The shared policy's legal-hold rule does not add a first-public Library hold mechanism. Retained public reads still
apply the viewer-native `subject:read`, Collection authority and platform gates to each emitted subject.

Every delete, restore and replay checks current account state/scopes, resource authority and applicable gate
**before receipt lookup**; a cached success cannot authorize a revoked, suspended, other-account or anonymous caller.
Every ordinary page rechecks current source liveness and viewer authority. Reuse `command-support.ts`/`runCommand`,
`shareAccount` and existing Collection Access checks, not a fake positive Access or the active-only `trustedAccount`
runner as an invented account restore path. Bind the receipt to owner, target stable identity/incarnation, action,
expected record revision or generation when one exists, and canonical input. Authorized
same-key replay has one effect; stale CAS fails without mutation. Missing current authority conceals payload even
on replay. Retained deletion metadata must be reachable without the ordinary live-row pre-read.

Every new owner write must also pass `shareAccount` in its command transaction, serialized against the terminal account
barrier. After T, the barrier rejects new owner writes. Account cleanup runs as durable system work bound to the
deleted account and T; it does not impersonate an active human or invoke an active-only trusted-account command.

Undo checks uniqueness and CAS atomically. An entry replacement at the same owner/subject key, occupied member
ordinal after reorder, recreated label name, Collection integer-capacity exhaustion, or live assignment cap (32) returns conflict
without overwriting newer facts, repositioning silently or allocating another identity. It may be retried with a
fresh key/revision after the conflict is explicitly resolved within the window. Tombstones do not count as live
capacity; restore must reacquire capacity. Profile absence blocks only NEW profiled values: clearing and deletion
remain allowed, and undo of the identical old pinned fact uses its stored accepted release, not today's profile.
It grants no authority to introduce new values under a missing profile.

Cursors remain live across pages, not cross-page snapshots. Recheck source deletion/generation on every page and
invalidate changed ordered bases using the shared cursor protocol; old cursors or delayed positive observations
cannot resurrect deleted values or overwrite a restored newer generation. After account deletion, late positive
consumer deliveries must also recheck terminal account state so they cannot recreate private facts. The current
listing worker reads source then releases its connection before target apply, with no monotonic compare in
`listing-apply.sql`. A receipt digest and DBOS workflow ID do not close that race. Reuse the shared listing freshness
contract's stamps/zero tombstones and reverse cleanup; an asynchronous zero alone cannot satisfy immediate public
count concealment.

### Retained independent copies

A copy is an independent owner-local identity, even when several holdings refer to the same edition.
`copy.deletion_id`, `deleted_at` and `restore_until` retain one exact deletion episode in that existing row;
`partition_no` is generated from its route. A fresh DELETE requires its numeric revision. Its exact native receipt
keeps the existing original Copy result; HTTP remains empty `204` and derives `Library-Copy-Deletion-Id` from that
receipt's transaction ID and `Library-Copy-Deletion-Revision` from its original revision plus one. An omitted guard
can only replay an already authorized old receipt. The closed `POST /v1/copies/:copyId:restore` body is
`{ deletionId, revision }`, using `copy:update` and `personal_library`, without a new role or scope. The shared
caller problem catalogue in `http/problem.ts` defines `copy_restore_stale`, `copy_restore_occupied` and
`copy_restore_expired`. Missing/foreign identities remain concealed. DTOs expose no retained state or accepted pin.

Delete advances the revision and live fact head once. The live read/list/raw-source SQL excludes retained rows;
current profile migration excludes them too. Undo restores the same original subject, accepted pin, kind/status,
user values and creation/update times, with a higher revision and a fresh transaction ID. Current original and
terminal disclosure still apply, but an absent/retired current profile cannot reject the original accepted pinned
value. Exact authorized receipt replay precedes deferred source/profile failures and produces no new fact/receipt/event.
Native current admission and the owning account fence precede receipt lookup. Terminal account deletion cannot be undone.

`copy_retention_episode` enforces the original strict 720-hour deadline; equality is expired, and retries never renew
it. Live partial indexes lead with `(route, account_id)`; `copy_retention_due` leads with
`(partition_no, restore_until, route, copy_id)`. The existing all-state owner/created index remains authoritative for
`purgeAccountFactsPage(kind: 'copy')`, which erases both live and deleted holdings under the existing terminal barrier.
There are no copy children, a second ownership graph, retained payload table, or permanent private tombstone.

The single Library WorkModule installs `library.copyRetention` and its exact-episode durable consumer on the existing
maintenance queue. Its real ten-minute DBOS schedule starts a partition-major sweep. Discovery uses an indexed native
keyset, at most eight raw keys and 4096 serialized bytes. Each physical owning-partition transaction holds the current
native owner fence and rechecks exact copy/owner/episode/revision/original deadline against native time. Early, stale,
consumed and restored episodes do nothing. A segment performs at most eight discovery pages, then persists a deterministic
continuation with its original cutoff and raw-key cursor. SDK checkpoints/recovery provide committed progress; a crash
after physical commit safely replays to a no-op. Retained physical purge does not raise the live fact head again.

Disposition of all added state: the three episode columns, generated partition and four partial indexes disappear with
the owning copy row on ordinary due purge or earlier terminal cleanup. The existing `account-fact-purge.ts` / `account-fact-purge-copy.sql` source purger remains the
owning callsite; this adds no participant or acknowledgement. `fact_source_head` must still be erased last in complete
terminal orchestration. Shared copies include `core.receipt` results for create/update/delete/restore (original Copy
values, never pins), ID-only copy updated/deleted outbox envelopes and write basis, plus DBOS inputs/checkpoints for
partition, cutoff, exact due locators and boolean purge results. Locators for shared receipt/event/work copies and their
minimizer custody remain explicitly pending under the existing shared-history owner; no fake ACK/NoData or blanket
account-erasure claim follows from local purge. Current dev has no `erasure-participant.ts`, `erasure-copy.sql`,
`erasure-collection-member.sql` or installed terminal acknowledgement callback. The native source purger's current
terminal-owner transaction is the available local disposition; no alternate participant or guessed binding is added.
The complete copy row, including subject/owner references, all three profile pins, private values and episode metadata, is personal
in every state and is removed whole. Existing safe public Collection references contain no copy values.

Native acceptance covers independent identity, authorization, strict JSON/CAS, original pins/times, hidden-source replay,
strict expiry while parked, stale work after restore/redelete, rollback, commit-before-checkpoint recovery, the default
scheduler/queue and the terminal owner barrier. The growth fixture uses the shared capture and occurrence APIs at
64/512/4096 native unrelated live/deleted holdings and histories, including actual default worker/SDK work and bytes.

### Bounded automatic purge and shared authority gaps

For an ordinary record tombstone, personal/private payload is automatically due at `restoreUntil`, without a platform
action or a new user request. Terminal account deletion is the explicit first-scope exception: account-private Library
payload is due at T, with no 30-day wait or account restore lifecycle. Use existing shared command/effects, DBOS and
queue surfaces with owner-specific indexed page adapters. This does not request or depend on a generic deletion
engine, custody registry, lifecycle state machine or replacement of shared owner history. `work/retention.ts`
collects terminal DBOS history by age and does not erase Library records; `work.ts` registers listing effects and the pending terminal participant described below.

A native runnable intent must survive commit-before-enqueue. Source selection takes **1 <= P <= 100 indexed source
rows before later eligibility filters**, including retained/ineligible rows and lookahead candidates, or uses a
proven partial due/pending index ordered by `(dueAt, route, targetId, generation)`. Advance after the last examined
source key, including ineligible rows; retained, future-due or otherwise ineligible predecessors cannot starve later
due work. Retain separate parent and child cursors. Each writing page has
bounded bytes, at most 100 source rows/effects and a finite command deadline; effects, generation/phase/sequence,
checkpoint, receipt and continuation intent commit atomically. Workflow segments contain at most 100 pages. Crash
before commit retries; commit-before-enqueue/ack redelivery uses native receipts. No OFFSET, broad
account/principal/JSON/history scan, whole-account arrays/counts, default cascade or unbounded distinct-subject walk.
Existing maintenance session and history keyset readers are reusable surfaces, not a purge implementation. Prove
bounded actual rows, bytes, blocks and statements at the specified geometric populations; counting only changed rows
does not establish a bound.

Every destructive page rechecks the authoritative record tombstone or terminal account state/T and due time in its
writing transaction, including after a pause/retry. Ordinary record work also checks `restoreUntil` or an explicit
early-purge grant. Account-private cleanup is eligible immediately at T and needs no platform grant or synchronous
consumer wait. First-public Library legal-hold support and release handling are deferred under the shared policy;
they are not prerequisites for this slice. Exhaust session units/history before their session and head, member rows
and acknowledged remote listing cleanup before Collection parents, and producer/reservation/dictionary references
before their parents.
Shared-policy skeletons retain only permitted identifier/type/relations/counts and tombstone; a private fact whose
skeleton identifies reading/ownership must be removed entirely. Completion requires indexed exhaustion and native
receipts, not an empty ordinary read, outbox checkpoint or DBOS success.

Missing production adapters and code paths (policy timing is settled by the shared contract):

- **Accounts and Library work:** terminal account deletion at T is the first-scope behavior. Accounts publishes
  `account-tombstoned.v1`; Library registers bounded partial fact cleanup with explicit pending graph evidence. Bind each page to the terminal account row and T under the
  authoritative account lock, and enqueue bounded cleanup durably without making account deletion wait. Do not add
  account restore, an account restore window, an account-generation counter or an account-restoration event.
  Ordinary owner writes must take the `shareAccount` barrier; purge work must not impersonate an active human or
  invent a `trustedAccount` bypass.
- **Kernel lifecycle/work and command owners:** use existing `shareAccount`, `runCommand`, `registerEffects`, event
  checkpoints, DBOS and queue registration. Library and other owners supply indexed page adapters and exact-locator
  minimization for their receipt/outbox/workflow payloads under existing shared retention protocols. No generic
  deletion-contract/checkpoint/page/registry engine or legal-hold authority is an implementation dependency.
- **Search/web/listing and subject-fact owners:** live generation/disclosure witnesses, active-only counters and
  bounded reverse pair cleanup/stamps covering every apply path. Existing listing freshness and shelf/bulk
  protocols are reused; missing shared subject-fact APIs remain explicit dependencies.

### Account deletion

Account deletion is terminal at T. The account-delete result for this contract contains only `deletedAt`; there is no
account restore, account restore window, account-generation counter or account-restoration event/port. Ordinary
private/unlisted reads, exports, counts and producers must be fenced immediately at T, including workers before
any effect. Accounts owns one erasure coordinator with a fixed versioned participant list: Access, Auth, Library,
financial Commerce, content/media, community/ratings/notices, Semantic/Zones, Search, Imports, and shared history and
delivery. Library acknowledges actual complete cleanup or no applicable data, never dispatch. Minimal completion
persists in PostgreSQL outside DBOS history to prevent late resurrection. Financial Commerce acknowledges its own
retention/minimization separately. Accounts emits `account-tombstoned.v1`; Library's registered terminal consumer
purges only entries/copies/follows and never acknowledges incomplete graph evidence. Private/unlisted Collection
headers and member pages check the current curator tombstone. Complete producer fencing and publication/listing
cutover remain incomplete. Cleanup is asynchronous: no consumer wait, platform grant or 30-day delay precedes the T fence or private
cleanup. The general policy's hold rule does not imply a first-public Library hold path, which is
deferred and not a prerequisite for account cleanup here.

Account-retention and child-before-parent outcomes drain actual durable cleanup at unchanged T. They inspect native
rows and persisted work state; advancing 30 days is not part of account-erasure eligibility. Crash tests arm the
failure before account deletion, then restart against the same durable stores. Ordinary per-record tombstones retain
their independent 30-day undo deadlines and can never reopen a deleted account.

The retained Collection set is **only active PUBLIC Collections at T**. These Collections remain visible with
stable Collection/member identities and de-identified account attribution; no ownership transfer or new account
identity is created. Private, unlisted and already-deleted
Collections are withheld and their personal/private payload is erased by bounded durable cleanup from T, including
previously-public Collections whose visibility is private or unlisted at T. Already-deleted Collection graphs are
erased and produce no public output. Freeze a public dynamic
Collection's LAST COMPLETELY PUBLISHED GENERATION A; discard pending B and never evaluate a fresh query at T over
undisclosed private facts. Erase private query/source data. Curated output freezes its last published
occurrences/notes; keep stable identities and de-identified attribution, with no ownership transfer or new
publication. No unlisted Collection is retained. Published-log payloads and private source sessions are erased by
bounded cleanup from T; do not revive an unpublished or retracted snapshot. Account deletion cannot be restored;
independent record tombstones keep their original deadlines but cannot reopen a deleted account.

The existing privacy contact remains the assisted removal/data-copy channel; add no legal timetable or self-serve
export. Native completion and overall evidence custody are separate claims. The inventory below lists required
cleanup, not an implemented guarantee. Logs, caches, exports, replicas and backups lack a complete Library-specific
custody inventory and enforced erasure deadline; do not make a blanket physical-erasure claim while those boundaries
remain open.

### Ordinary label expiry

`purgeLabelRetentionPage({pool}, {partition, limit, after})` is private maintenance, called by the single
Library WorkModule's registered `library.labelRetentionSweep` UTC schedule every ten minutes. It needs no user
grant. Service clock injection follows Core's native time adapter; neither a cursor cutoff nor request time can
make a row eligible for deletion. Each actual write uses the owning Core partition fence and current account
share fence before examining the exact deletion episode. Account T wins; ordinary cleanup cannot restore or
reconstitute an account, and leaves terminal cleanup to its existing owner.

Discovery walks the sixteen routes of one physical partition, seeking the existing partial
`personal_label_purge_due` and `label_assignment_purge_due` indexes by exact route, original deadline and tuple.
There are at most thirty-two empty index seeks per page. Raw discovery plus selected child keys is bounded by
`limit` (1..100); parent/fence/CAS/absence metadata points are additional fixed indexed work. A returned cursor
uses at most 2048 bytes and the entire result at most 4096. An empty partition returns an exhausted null cursor.
Internal base64url cursors contain only version, partition/route, source kind, native cutoff, exact technical
identity/revision/deletion timestamps and child highwater. They never carry a name or public list authority.

A captured parent is rechecked and locked exclusively before its owner/label child keyset is read. Child identity,
revision, slot and deletion timestamps are exact CAS predicates. A live child of the deleted parent, or an
independently expired child, is removed; a later independently deleted episode retains its original window. The
parent remains only until indexed child absence permits its exact physical delete. A later sweep retries skipped
children; restore/redelete and admission/reclamation defeat old captured episodes. No slot is released in another
row and no retained metadata is recreated. Purging already-hidden rows does not advance `fact_source_head` again;
the delete hooks still invalidate physically deleted live facts under a live parent.

No new persistent field, row or index is introduced. A sweep segment runs at most 100 page steps and checkpoints
its small cursor in existing DBOS history; a deterministic maintenance-queue continuation carries an unfinished
frontier. Commit before checkpoint is safe to retry: all SQL predicates recheck source truth, and only a real
physical deletion emits the minimal private `label.retention-purged` event. There is no user command receipt or
new permission on this internal path. Existing catalogue/assignment command receipts remain with their producers.
Shared copies added here are owner/label IDs in the Core outbox event and exact technical cursor keys in DBOS
workflow input, output and step history. The event declares the actual shared-history personal subject contract.
Their owners must minimize these private identities through shared custody; workflow age alone is not erasure and
missing durable-work custody stays pending. No new account-erasure participant or NoData acknowledgement is added.

Incarnation cutover adds personal owner custody in the same shared DBOS stores: page step inputs and outputs carry
the private raw-key boundary (route/account/subject), continuation step input and child workflow input copy that
boundary, and segment/workflow output checkpoints may retain it. Root/sequence IDs and aggregate counters are
technical progress; they do not remove the personal status of a copied owner key. Discovery's revision,
transaction ID and `xmin` stay in memory and are never checkpointed. The cutover creates no receipt/outbox payload
and no parallel custody registry or erasure participant. Accounts' shared-history minimizer owns all actual DBOS
status/input/output/operation/message/checkpoint copies and their exact locators. Until producer coverage supplies
that custody, minimization stays pending; neither a successful sweep nor workflow age proves None or permits ACK.

Native tests cover original expiry, child pages, source/commit crash cuts, stale parent and assignment episodes,
slot reuse, account T and fixed-page growth including raw SQL, control, SDK, bytes and occurrences. These outcomes
prove ordinary local expiry; the terminal inventory below still owns all live/deleted rows and incomplete shared
custody. Full label HTTP/generated-client adoption belongs to the catalogue/assignment command slice.

#### Retention inventory

Saved Collections use the existing in-place `collection` deletion episode, CAS and exact 720-hour window;
Undo leaves `rule_filter`, `rule_sort`, `rule_release_digest` and `rule_revision` unchanged. Terminal cleanup in
`collection-retention.ts` and `saved-collection-retention.ts` clears those private columns, drains
`canonical_source_reference/head/generation/scope` and `canonical_source_fact/state`, and erases
`collection_publication_staging_evidence/seal/staging` before unselected
`collection_source_output_member/head/publication/output` generations, at most 100 child rows per page.
Publication operation/source/episode references use the participant's existing publication phase; members
preparation results/headers/owner associations use its existing appended owned-graph phases.

Only actual committed active-PUBLIC output A enters `collection_retained_output` at `(route, collection_id)`:
its generation, source generation, cardinality, member fence and original native publication proof contain no account,
rule or private fact. It preserves A's original ID and subjects; pending B never supplies membership. Frozen
headers/members/head reject writes. After native custody settles, A's output account attribution and original
private publication reference are removed, then its Collection curator is cleared. Private/unlisted/deleted and
unpublished saved views have no retained set and drain through the existing physical parent disposer. Native
capture retirement includes saved working sources under terminal fences. `identity_scope_plan/effect/seal` retain their generation/capture authority until the real control handoff.
Real capture/identity/receiving holds remain pending and keep their authority intact; local exhaustion never acknowledges shared Core/DBOS history,
receipts, work payloads or foreign Source disposition. Terminal reads hide nonpublic views and public authorship
immediately. Decision: live native custody keeps physical deidentification pending while rules and unrelated
private references drain, using only a proven selected output for the account-free retained locator.

The owner directory adds private structural records, erased after native family hooks stop and before
`fact_source_head`: `owner_index_label_repair` at `(route, account_id, label_id)` (raw100 indexed children),
`owner_index_state` at `(route, account_id, pin, collection_id)`,
`owner_member_support` at `(route, account_id, subject_id, family, pin)`, `owner_member_index` at
`(route, account_id, subject_id)`, `owner_index_pin` at `(route, account_id, pin)`,
the existing `builtin_collection_reference` at `(route, collection_id)` (owner-prefix cleanup), and
`owner_index_control` at `(route, account_id)`. The existing A5 owned graph deletes the existing references first, then these new directory records in child-before-parent order,
at most 100 exact keys per page. State labels are immutable released presentation metadata; supports retain
structural original/pin scopes without session/copy/assignment IDs, revisions, notes, timestamps or fact bodies.

`library.ownerIndex` and `library.ownerIndexSweepSegment` use the existing maintenance queue. Operational
successor intents contain only fenced account IDs and native phase/key frontiers; sweep locators contain
partition and account keysets. Their DBOS input/output/history is Accounts shared-history custody, not an
additional Library intent table. Current account and partition fences precede every application. No discovery
or detail GET creates progress. Source coverage does not acknowledge identity publication, whole-query
privacy, complete Library erasure, or shared-history erasure. The fixed ALL-Library epoch participant still
must incorporate these exact structural namespaces and concurrent first applies before canonical readiness.

The account-owned native rows below live on the owner's route unless stated otherwise. Account deletion has no
account-wide Library cascade. The registered default participant purges bounded local fact and owned-graph pages
from these applied tables, but it remains pending when an exact producer locator, remote disposition or custody
proof is missing. The current schema and shelf/bulk contracts also describe planned logical stores; a planned name
without an applied table or exact locator is not treated as an existing store.

The applied private `owner_write_counter` (`seq`) and live/archive `owner_write_seq` fields are also terminal
inventory. The worker deletes the counter after dependent private facts; deleting entries and archives removes
their embedded sequences. T fences their state writers immediately. This counter is neither an account
lifecycle generation nor a public activity total. Existing `fact_source_head` removal remains last after delete hooks.

This A5 inventory also includes every planned OWNER candidate/support directory and inverse, pin-set/sibling
support, private change positions and retained old/new/parent-range repairs, dependency registrations, bootstrap
frontiers/CAS controls, ordered prepared results, operational derived records/intents and identity first-apply/
OLD-removal/NEW-addition/fence/ACK custody. Native specifications must name each actual table/key and exact native
transactionId+component/job/epoch/version/scope and workflow/input/output locators, including all prior pages and
concurrent registrations. No invented table name or follow-only completion counts as whole-role coverage.
Fence every producer/apply at T; erase child work before parents and heads/counters after hooks cannot recreate them.
Core/DBOS intent artifacts belong to actual shared-history custody, not a Library JSON scan or extra intent store.
Missing native producer, redrive, reclamation or store-owner ACK proof stays pending; empty Library rows do not
establish shared payload erasure. Public complete A retains fixed membership/current disclosure; pending B cannot
complete from private facts. The [owner plan](../../../../docs/library-owner-queries.md#shared-operational-identity-and-disclosure-producers)
owns the design, while this inventory must gain exact native locators with each implementation cut.

| Native data                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Required cleanup and current gap                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collection`, `collection_member`, `collection_listing_history`                                                                                                                                                                                                                                                                                                                                                                                                          | Ordinary record deletion retains its exact 720-hour in-place episode. The installed Library terminal participant uses owned-graph pages; saved Collections follow the terminal disposition above, including formerly-public local history after actual custody settles. Curated public-source disposition and remote listing locators still require their native owners. No whole-account acknowledgement follows from local cleanup. |
| `entry`, `entry_deleted`, `copy`, `follow`                                                                                                                                                                                                                                                                                                                                                                                                                               | Erase live and archived entry episodes, every copy and follow state/reason. Exact archive/due selectors exist, but no complete registered terminal adapter. Entry/copy/follow removal alone is not whole-graph erasure.                                                                                                                                                                                                               |
| `progress_session`, `progress_unit`, `progress_change`, `progress_head`                                                                                                                                                                                                                                                                                                                                                                                                  | Erase active/completed/abandoned sessions, units, all history and heads, including orphan heads. Exhaust children before sessions/heads; maintenance pages alone are not purge.                                                                                                                                                                                                                                                       |
| `personal_label`, `label_assignment`                                                                                                                                                                                                                                                                                                                                                                                                                                     | Erase definitions, assignments and all live/inactive reservations, children before parent. Retained metadata and assignment-admission DAOs do not implement account cleanup.                                                                                                                                                                                                                                                          |
| `shelf_type_reservation`, `shelf_type_node`, `shelf_type_root`, `shelf_type_value`, `shelf_count`; `type_preparation_header`, `type_preparation_progress`, `type_preparation_slot`                                                                                                                                                                                                                                                                                       | Fence preparation/publication; erase all staging, partial/orphan tries, zero-use values, pins and counters. Progress/slots precede headers/values; nodes/roots precede values. No whole-graph terminal worker supplies this ordering.                                                                                                                                                                                                 |
| `builtin_collection_reference`, `builtin_state_reference_source`; candidate/support data                                                                                                                                                                                                                                                                                                                                                                                 | Fence late repair and remove source children before reference/support parents; erase private discovery data. A proposed candidate/support representation has no current complete producer/cleanup guarantee.                                                                                                                                                                                                                          |
| `canonical_source_state`, `canonical_source_fact`                                                                                                                                                                                                                                                                                                                                                                                                                        | Erase every obsolete, old, building and private generation, not only the current pointer. Keep only selected permitted published output A; pending B never survives. Tables exist but store factories throw and implement no cleanup.                                                                                                                                                                                                 |
| `collection_source_output`, `collection_source_output_head`, `collection_source_output_member`, `collection_source_output_publication`, `collection_retained_output`                                                                                                                                                                                                                                                                                                     | Exact output locators are `(route,collection_id,generation)` and member suffix `subject_id`; selected and retained heads use `(route,collection_id)`. Terminal saved-view cleanup drains unselected generations and retains only proven active-PUBLIC A through the account-free native disposition above. Live native holds preserve their source authority; foreign receiving and shared-history disposition remain pending.        |
| `subject_collection`, `subject_collection_version`, `subject_listing`, `subject_collection_source_fence`                                                                                                                                                                                                                                                                                                                                                                 | Use exact Collection reverse indexes on remote subject routes; remove/reconcile pairs, versions, counts and fences without touching other public contributions. Preserve necessary anti-replay evidence until late applies are fenced. Current listing work lacks terminal cutover.                                                                                                                                                   |
| `bulk_target`, `bulk_effect`, exact operation/selection locators                                                                                                                                                                                                                                                                                                                                                                                                         | Erase manifests, request/target/effect/outcome and receipt payload for every owned operation. `pageBulkOutcomes` needs a known operation; current tables lack an account-leading complete locator. Planned operation/selection stores also need producer locators; JSON/history scans are forbidden.                                                                                                                                  |
| `published_log`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Erase published and retracted snapshots and personal links/payload at T; no active log contribution is retained. A nullable source pointer is not terminal erasure.                                                                                                                                                                                                                                                                   |
| Shared receipts/outbox/editorial/work artifacts and cleanup state                                                                                                                                                                                                                                                                                                                                                                                                        | Producers record exact receipt/event/workflow/payload locators; each store owner minimizes actual private payload and acknowledges completion. Remove nonminimal staging/checkpoints only after dependent phases finish; keep minimal terminal completion independently of DBOS retention. Dispatch or age-based history deletion is insufficient.                                                                                    |
| `fact_source_head`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Remove LAST, after producer facts and derived work are fenced/exhausted: native fact-delete hooks can recreate this owner head. Its existence is not candidate completeness or permission.                                                                                                                                                                                                                                            |
| Native data                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Required cleanup and current gap                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                                                                                                                                                                                                                       | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------                                                                                    |
| `collection`, `collection_member`, `collection_listing_history`                                                                                                                                                                                                                                                                                                                                                                                                          | Ordinary record deletion retains its exact 720-hour in-place episode. The installed Library terminal participant uses owned-graph pages; saved Collections follow the terminal disposition above, including formerly-public local history after actual custody settles. Curated public-source disposition and remote listing locators still require their native owners. No whole-account acknowledgement follows from local cleanup. |
| `entry`, `entry_deleted`, `copy`, `follow`                                                                                                                                                                                                                                                                                                                                                                                                                               | The worker removes live and archived entry episodes, copies and follows in bounded owner pages. Their shared receipts/events/work payloads and any foreign copies still require owner minimization and exact producer custody.                                                                                                                                                                                                        |
| `progress_session`, `progress_unit`, `progress_change`, `progress_head`                                                                                                                                                                                                                                                                                                                                                                                                  | The worker removes sessions, units and history before owner heads, including orphan heads. All pages use bounded owner or exact-session keys.                                                                                                                                                                                                                                                                                         |
| `personal_label`, `label_assignment`                                                                                                                                                                                                                                                                                                                                                                                                                                     | The worker removes assignments before personal labels, including deleted assignments and inactive reservations.                                                                                                                                                                                                                                                                                                                       |
| `shelf_type_reservation`, `shelf_type_node`, `shelf_type_root`, `shelf_type_value`, `shelf_count`; `type_preparation_header`, `type_preparation_progress`, `type_preparation_slot`                                                                                                                                                                                                                                                                                       | The worker removes owned staging, pins, counters and values in child-first order. Late publication and remote producer custody remain separate blockers; no whole-participant completion is claimed.                                                                                                                                                                                                                                  |
| `builtin_collection_reference`, `builtin_state_reference_source`; candidate/support data                                                                                                                                                                                                                                                                                                                                                                                 | The worker removes current source references before their parents. Candidate/support representations with no applied table or locator are not treated as existing stores. Late repair and shared custody remain blockers.                                                                                                                                                                                                             |
| `canonical_source_state`, `canonical_source_fact`                                                                                                                                                                                                                                                                                                                                                                                                                        | The shared local cleanup removes canonical facts/state in bounded pages for never-public erased graphs. It preserves public source evidence pending the actual Source and destination-disposition ports; it neither evaluates a private query at T nor certifies retained public output.                                                                                                                                              |
| `subject_collection`, `subject_collection_version`, `subject_listing`, `subject_collection_source_fence`                                                                                                                                                                                                                                                                                                                                                                 | These destination rows may be on other subject homes. The participant retains its source Collection and stays pending until actual destination withdrawal and late-first-apply custody are available; it does not scan remote routes.                                                                                                                                                                                                 |
| `bulk_target`, `bulk_effect`, exact operation/selection locators                                                                                                                                                                                                                                                                                                                                                                                                         | Erase manifests, request/target/effect/outcome and receipt payload for every owned operation. `pageBulkOutcomes` needs a known operation; current tables lack an account-leading complete locator. Planned operation/selection stores also need producer locators; JSON/history scans are forbidden.                                                                                                                                  |
| `published_log`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The worker erases published and retracted snapshots and personal links/payload at T; no active log contribution is retained. A nullable source pointer is not terminal erasure.                                                                                                                                                                                                                                                       |
| Shared receipts/outbox/editorial/work artifacts and cleanup state                                                                                                                                                                                                                                                                                                                                                                                                        | Producers record exact receipt/event/workflow/payload locators; each store owner minimizes actual private payload and acknowledges completion. Remove nonminimal staging/checkpoints only after dependent phases finish; keep minimal terminal completion independently of DBOS retention. Dispatch or age-based history deletion is insufficient.                                                                                    |
| `fact_source_head`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The worker removes the head LAST after local fact-source children; native fact-delete hooks can recreate it before then. Its existence is not candidate completeness or permission.                                                                                                                                                                                                                                                   |
| Cleanup must use bounded, indexed native phases with child-before-parent ordering and durable receipts/cursors; a Collection tombstone, terminal flag or empty account-local read is not proof that children and remote listing pairs are gone. Proposed page bounds have not been measured here. The [listing freshness contract](listing-freshness-contract.md#bounded-storage-purge-and-delivery) records the stale-positive projection race and fencing requirement. |

Library cleanup does not run broad SQL over shared stores. `core.receipt` can retain command request/response payloads; `core.outbox` must keep tombstone and projection events deliverable until durable custody is established; `core.consumer_checkpoint` is a shared stream position, not per-account state. `editorial.write_basis` and DBOS status/input/output/step/event/message histories follow their owners' retention and minimization rules. Existing age-based workflow history collection does not establish Library erasure. Exact event, receipt, workflow and payload locators, account-specific cleanup and some consumer-custody acknowledgements are still missing; do not delete shared stores by broad principal or JSON scans. No claim extends beyond the demonstrated native locators. Logs, caches, exports, replicas and backups remain explicit custody gaps.

Logs, caches, exports, replicas and backups have no complete Library-specific inventory or enforced account-erasure deadline. These are explicit custody gaps. A tombstone, `state = 'deleted'`, or exhaustion of Library-native rows does not support a blanket physical-erasure claim while those gaps remain. See the [Access deletion policy](../access/README.md#account-deletion-policy) and [Access retention inventory](../access/README.md#retention-inventory) for the shared authority boundary and shared-store coverage; the detailed Library table/locator inventory remains here.

### Collection ordinary cleanup implementation

`collection-retention.ts` is registered once by `libraryWorkModule` on the existing maintenance queue
(concurrency two). Its ten-minute schedule visits the fixed 4,096 partitions by the generated `partition_no`
and `collection_retention_due` index. Each seek returns at most eight exact owner/Collection/deletion/revision/
original-deadline identifiers, with PostgreSQL timestamp precision preserved. Each durable input/result is capped
at 4,096 bytes. Segments contain at most 32 discovery or cleanup steps; continuations retain only those exact
identifiers and the indexed cursor. Inactive partitions are explicit pending observations and retried by fresh sweeps.
The cursor is a direct index tuple lower bound, including on prepared generic plans; the initial seek starts at
negative infinity rather than filtering already-examined predecessors through a nullable-cursor disjunction.
No payload, permission claim, source readiness or foreign disposition enters a checkpoint.

Every ordinary physical page holds the native active-account share fence before locking the owning Collection.
It rechecks the current owner, deletion ID, revision, original strict 720-hour deadline at Core authoritative time,
and public/native capture custody. Restore/redelete therefore defeats an old page. A terminal/fenced account is left to the one
terminal participant. Each cleanup transaction removes at most 64 raw children from the first remaining indexed
prefix, so a commit lost before a DBOS checkpoint can safely repeat that exact episode. No live fact generation,
public count or listing decrement is emitted at physical purge. Expiry cannot extend Undo.

For never-public private/unlisted graphs, all `collection_member` rows (live and independently retained episodes,
including notes, subject support, ordinal, times and transaction metadata) precede all generations of
`canonical_source_fact` (full primary-key order), then `canonical_source_state`, then
`builtin_state_reference_source` (the existing Collection-leading support index). The built-in reference row and
the owner's bounded pin array are removed next, and the Collection head is last. Parent deletion rechecks empty
child prefixes and revision/source generation. Its title, description, visibility, presentation/cover, curator,
member/order counters, profile/built-in pins, transaction and all times disappear together. The Collection PK,
curator indexes, sitemap and due indexes follow normal row deletion. A listing-history row is public custody,
not permission to drop evidence. No cross-home transaction, global/history scan, OFFSET, JSON discovery or cascade
is used. The fixed empty probes plus one nonempty 64-key page stay below 100 raw keys per transaction.

`purgeTerminalCollectionPage` consumes the actual terminal participant's authorized command and native current
erasure scope; `erasure-owned-graph.ts` calls it through its existing receipted workflow. It rechecks the exact
current owner/head and erases independent local work without a second participant or account runtime. Its local
result never acknowledges Access erasure. Public/previously-public source evidence stays retained in both paths.
The native factory now exposes the closed [`retireCapture` owner operation](../../../../docs/collection-source.md#native-capture-retirement).
Ordinary never-public private/unlisted due cleanup calls it before its capture guard. The operation rereads the
exact capture identity, current owner/incarnation/partition and current source generation under the same live
Core command and native T. Ordinary eligibility requires the original deletion ID, revision and strict 720-hour
deadline; terminal eligibility requires the actual deleted/fenced account and current Library erasure obligation.
Active-source repair is refused. Restore/redelete and captured Undo semantics remain unchanged.

An unreleased hold blocks retirement even after source/writer generations advance. Retained revalidation and
release can use the exact deleted source or real terminal account scope without granting fresh reads or holds.
Only committed native releases with the receipt's transaction binding can be retired; a release written in this
command remains pending until a later command. One attempt examines at most 80 raw hold keys and the fixed native
account/partition/source/control/capture/receipt points (at most 100 raw keys including default discovery), deletes
released children first, then the native receipt, then the capture. A full child page leaves parents for the next
attempt. Every operation reserves actual plan bounds and returns its consumed work receipt; discovery composes
with that same fixed local allowance and absolute command deadline. Neither a locator nor an opaque capture brand
supplies authority. Non-cascading FKs and parent/control locks serialize late holding against retirement.

The existing owned-graph runner also pages the account-leading capture index, invokes the same owner operation,
and checkpoints bounded release progress through its original receipted pages and finite continuations. Blocked
captures/graphs remain pending. After the last source-writer hook and fact-source-head barrier it removes bounded
provably owned writer controls, repeating full control pages. Future Collection writes preserve the actual native
curator locator on the fence, including parent deletion; capture initialization supplies the same native owner.
After a never-public private/unlisted head is removed, ordinary cleanup also removes its exact provably owned
Collection control, after the final DELETE hook. This adds one control-key point and two indexed empty-prefix
probes; the cleanup result retains its business-graph row count. Shared active-account controls are preserved.
Account controls derive ownership from their exact native account key. Collection controls with no surviving
native provenance remain unattributed pending, never guessed from a route or globally searched/backfilled. Public,
foreign or still-referenced controls remain retained. The erasure probe inventories the capture/receipt/hold FK
family and known fence locators; capture absence proves local child absence by FK, never shared custody closure.
Output generations and immutable publication receipts have indexed actual account locators. The same positive probe
inventories their head/member FK family and publication receipt after source curator minimization. Every output
copy blocks ordinary/terminal parent/control removal until shared disposition exists, including pending/cancelled
copies. Neither output absence nor these family obligations certify global no-data or destination release.
A capture-family pending entry does not assert a receipt or hold row exists for every unfinished capture.

There is no delivered release-to-terminal reinspection/wakeup or foreign Source/destination disposition custody
port. The existing terminal pending/recovery boundary names that gap; ordinary scheduled sweeps retry released
private due captures. No new participant, scheduler, ACK or inferred destination erasure is introduced. These
guards create no capture, permission evidence or second Source engine.
`createCollectionSource` and canonical publication functions are still unavailable implementations in this tree;
there is no ordinary destination-disposition export to bind. Current metadata/raw readers, listing stamps, DBOS
success and an empty destination page cannot replace that authority. No public skeleton or completed public purge
is claimed. Access resource/grant cleanup and Core receipt/outbox/work-payload minimization remain named foreign
custody; Library does not delete their records or fabricate an ACK. Derived OpenAPI/client regeneration and full
native/default-worker, crash, public-disposition and growth proof remain integration work.

Cost: a fixed route-led due seek and account/head points, followed by one bounded child prefix and exact deletes:
O(k log R) indexed blocks and O(k) rows for k <= 64, plus fixed account/partition/empty-prefix work. Total work
follows the removed local graph. The retained native tests cover local exact episodes, non-revival, child-first
expiry and explicit public pending; the shared growth test measures the due seek. These tests do not establish
public custody, terminal completion, default-runtime crash recovery or whole-graph growth proof.

Adding ordinary Collection Undo also requires extending the exact route inventory in `test/kernel.test.ts` with
`POST /v1/collections/:collectionId/$restore`. Its `Missing` type and exact served-route equality intentionally reject
any new route absent from that inventory. The public custom-method spelling is `:restore`, as for existing lifecycle
routes. A delivery that freezes the current inventory while requiring this new route has incompatible acceptance;
neither hiding the route from the inventory nor erasing its generated client type is a valid correction.
Measurements use 256/1024/4096 rows, actual examined source keys/SQL plans/shared blocks/statements, fixed P, and
ordinary retained/future-due/ineligible predecessor rows. Counting only returned/deleted rows is insufficient.
Native page receipts, child/parent checkpoints and stale-generation guards must remain inspectable after crash/restart.

Implementation follows the existing command/effects/DBOS surfaces with owner-specific indexed pages, never a new
Library deletion engine. The [native terminal review](../../../../docs/research/library-terminal-native-implementation-review.md)
is graph/locator evidence; its older retained-log recommendation is superseded here by published-log erasure.
Completion requires each phase and shared store-owner acknowledgement, not dispatch, empty ordinary reads or an
entry/copy/follow-only purge. The default terminal participant is registered, but full native graph pages, public A freeze and exact
shared-payload minimization remain unimplemented; see its [proof boundary](erasure-participant.md).

### Projection freshness

The [listing freshness contract](listing-freshness-contract.md) specifies monotonic source stamps and public-history
zero tombstones for the existing public Collection projection. The
[account-retention report, steps 4–5](https://github.com/rezics/rezics-next/blob/a1d0b76e4975daa2cbdbd5f172d0f72039d91252/docs/research/library-account-retention.md)
records the delayed-positive race and later purge's reverse-index/fence needs. Never-public private/unlisted zeros
must leave no subject-partition holder state. The typed ports are proposals and the native outcome suite remains red
without its real driver; this specification does not change the implementation; the account section above fixes first-public retention.

## Bulk library operations

One private durable operation prepares the admitted explicit or filtered selection, enumerates it, captures exact
native intentions, seals a complete preview, awaits explicit confirmation and executes independently receipted
targets from the same immutable `bulk_target` manifest. This covers curated and built-in/state sources and permitted
mounted use through shared Source/filter admission. Browser layout and page contents/cursors cannot redefine all
matches; admitted source/filter/order and accepted profile meanings remain bound. See the owning
[native bulk contract](bulk-contract.md) and its [research evidence](../../../../docs/research/library-bulk-bound-selection.md).

All relevant population, meaning, original/terminal identity AND captured target expectation drift before the defined
confirmation cut stales confirmation with no dispatch. Strictly later drift yields exact target conflicts or
appropriate source-wide authority stops, retaining earlier effects. Confirmation never re-queries the selection or
promises rollback across independent effects. The cut includes exclusion/NOT/order/foreign/privacy dependencies and
behind-frontier changes, not just returned positives. Discovery-time matching alone is superseded.

Native confirmation is unavailable pending shared producer agreement and a complete validation-to-confirm binding
across the participating homes. Sequential checks plus root CAS, hashes, RR snapshots or positive-ID sets do not
supply it. Bulk factories still throw; target/effect DDL and the native outcome pager exist, but operation-header
DDL, finite preparation attachment, seal/confirm ABI, default bulk registration/routes and the complete journey do
not. The temporal choice is an owning contract, not installed support or proven feasibility. Existing stopped
Source/Kind/identity producers and custody obligations retain their authority.

Bulk add atomically skips active subject presence and appends at most one occurrence per missing subject; ordinary
intentional duplicates and existing capacity/respacing remain. Subject-based removal captures every matching real
occurrence before seal and removes only those lifecycle-bound IDs; later additions survive. Entry removal uses
exact incarnation/revision and deletes only the entry. Progress sessions/history, copies, follows and Collection
members remain; confirmation names that scope. Full erasure is a separate explicit action.

Preview and outcomes are private and currently disclosure-safe; public candidate totals are not preview counts.
Incomplete/unknown is never zero, and no terminal summary is valid while selection or outcomes remain unresolved.
Current source/mount, original AND terminal disclosure, foreign authority and account lifecycle remain independent
of retained freshness evidence. Reads/attempts/replays use current gates/scopes/permissions and the authentic durable
initiator; authorization precedes receipt access and exact replay precedes fresh profile validation. Cancellation
and expiry stop new dispatch, reconcile exact receipts and retain prior effects. Missing native producers, absolute
24-hour execution/48-hour results, byte admission and bounded shared/native cleanup are detailed in the contract.

### Type filter identity

Shelf facets return `{types: [{type: fullCURIE, count}], next}` and shelf list/summary requests accept
`type=fullCURIE`. Web retains the exact CURIE/IRI in its URL and saved per-type preference; no extra resolution request
or public UUID key is needed. Unknown, foreign-account or stale values return `400 invalid_argument`, so web drops the
filter and rereads. A retained known value with zero entries remains valid: the list is empty and shown counts are zero.
Read lookup never allocates an identity.

Exact ASCII source values have no per-identifier character or byte cap. The release-wide size bound is not a type limit.
Full values live in unindexed private dictionary storage in the owner's partition. SQL predicates, counters and opaque
cursor bindings use a stable account-scoped UUID `typeId` resolved by exact equality. This internal identity is immutable,
one-to-one and never reused, including after its count becomes zero; it grants no authority and is never a public filter.
Digest hits require full-value equality; collisions use bounded exact chunk-trie edges, never digest aliases or an
unbounded collision scan. Facets seek by that private UUID and return every byte of each emitted CURIE, within both row
and response-byte budgets. See [the shelf contract](shelf-contract.md) for the resolver, continuation and erasure plan.

## Curated occurrence ordering

Ordering uses the installed pinned `fractional-indexing` package with its default alphabet, ASCII case-sensitive
`COLLATE "C"` order and the original occurrence store. Commands prefer keys within 32 bytes; storage admits 48.
The deferrable unique key covers **all** raw rows on `(route, collection_id, ordinal_key)`, including tombstones.
Duplicate subjects retain separate occurrence IDs, notes, revisions and added times. Collections support millions
of occurrences; member counts retain their physical PostgreSQL integer bound, without a 5,000-member admission cap.

Point reads use the exact route/Collection/member key and conceal retained deletions. Placement seeks at most two
indexed live neighbours, excluding the selected moving occurrence. If direct allocation cannot fit preferred keys,
two directional seeks examine at most 128 resting occurrences, including untouched boundary rows. At most 100
selected occurrences join that bounded window. Only this window is rekeyed in the command, with the unique constraint
deferred until commit. Local rekeying advances revision, source generation and order epoch; direct moves advance
revision/source generation. No command enumerates an owner to find one member or repair a gap.

If that window cannot fit, the original command rolls back, including its receipt. A separate Collection-partition
`library.collection.order.repair.begin` command reauthorizes `collection:update` at its own authoritative T and
commits an immutable native capture and an outbox work intent. Its receipt namespace includes the failed native
fence and cannot consume the original edit's key. The membership response is retryable `dependency_unavailable`
(`503`), with no claimed insertion or move. The caller retries the original intent after repair; revisioned transfer
also reacquires both current parent revisions. Competing structural writes use a bounded native barrier and retry.

The default Library worker consumes this intent on the shared DBOS `maintenance` queue, with stable repair/step IDs.
The capture freezes member count, revision, source generation, order epoch, original raw minimum and package-legal
lower/upper boundaries strictly below that minimum. A deterministic balanced midpoint tree computes only the ranks
needed for a page, using stored-width headroom where necessary. Each native transaction examines at most 128 original
raw occurrences by indexed strict frontier, including deleted rows, and moves only active rows into that reserved
prefix. Already moved rows lie behind the original minimum and cannot be enumerated again. Prefix ranks and original
suffix keep the same visible occurrence order after every commit. Tombstone locators and saved Undo ordinals/payload
are untouched; source holds are not dropped. Raw Source ordering remains the actual native order, with source-generation
fences invalidating prior observations on every committed page.

A page atomically compares/advances the captured native parent fences and original frontier, updates the parent
revision/source generation/order epoch and emits invalidation plus its durable continuation intent. Work stores no
Actor, JWT, cached authorization or old T. The native account share fence prevents work after terminal account time;
deletion, erasure or cancellation terminalizes the capture and stale workers cannot change members. A final bounded
continuation removes the single terminal capture row. Restart resumes at committed progress, without an owner scan,
a whole-owner key array, a second runtime or a restart loop. New Collections start at epoch 0. Public member cursors
seal `orderEpoch + 1`; a changed epoch returns `stale_cursor`, so pages cannot mix old and new key spaces.

## Shelf reads

Native shelf maintenance is exported by `shelf-maintenance-ops-contract.ts` and installed by the existing
Library WorkModule. Its default initialization, operator request, page/CAS, complete-generation swap and bounded
recovery are implemented in `shelf-maintenance-runtime.ts`. The default HTTP shelf factory now binds that same
maintenance factory, configured pool/Access/lazy WorkClient/clock and a same-client native RR generation reader.
An admitted indexed gate probe requests guarded initialization only when needed, before final RR checkout; warm
reads create no initialization effects. Complete active-generation counters and exact private dictionary identities
serve summaries/facets, including nonnil native generations. Nonempty owners use the original bounded native
backfill and identity-only source preparation, never a request-time scan or a second producer. The derived allocator guard accepts only that runner's
same live transaction/run/epoch/build capability. Nonempty type repair remains pending when the real allocator or
scoped identity-only source adapters are absent. Shelf purge verifies native tombstone envelopes and observes the
existing Library erasure participant's local disposition; it does not add a participant or acknowledge shared custody.
See [the operational contract](shelf-maintenance-ops-contract.md).

These entry/shelf requirements are a compatibility surface, not the Everything or Continue implementation. State
filters are not mandatory navigation tabs. The shared Collection page replaces this surface only at an explicit
consumer cutover; profile consumers own retirement of the private type dictionary/trie/preparation machinery.

The [shelf UI study](../../../../docs/research/library-shelves.md) and
[backend activity report](../../../../docs/research/library-shelf-activity.md) support these module requirements.
[UI Shelves](../../../../packages/ui/README.md#shelves) owns controls and layouts. Adoption here establishes the
kernel contract; implementation completion and growth evidence remain separate work.

`GET /v1/libraryEntries` must serve a private, account-local page with progress for 48 cards in one read. Embed a
nullable active session using exactly the existing BASIC session DTO in [progress-routes.ts](./progress-routes.ts):
`id`, `subjectId`, `versionSubjectId`, `mode`, `unit`, `total`, `amount`, `locator`, `position`, `completedUnitCount`,
`state`, `revision`, `startedAt`, `completedAt`. Storage routing, account and transaction IDs are excluded. Preserve
decimal strings and nulls: `scalar_amount` retains amount and optional total; `cursor_position` retains its locator
and position without an invented total; `completed_units` uses the maintained sparse `completedUnitCount`, without
enumerating units or treating their largest identifier as a denominator. No mode requires history enumeration.
No active session means null, never a terminal session or fabricated zero progress.

Maintain `lastActivityAt` as the maximum of the entry change and that subject's progress change in the account
partition. A retained account/subject progress head survives entry deletion. Accepted start, record, complete and
abandon revisions advance activity, including accepted records with no net value change; receipt replay, rejected
CAS and rolled-back writes do not. Progress updates the head and at most an existing entry's activity atomically;
it never recreates deleted membership or changes entry state, revision or update time. Entry creation/recreation
combines its own change time with the retained head. Entry and progress commands share a head-first lock order and
monotonic maximum rule, so concurrent creation and progress cannot lose the later activity time.

Select the displayed session separately: among active sessions for the exact account and subject, choose the greatest
session change time, then session ID ascending. Multiple active sessions remain legal, and the winner need not be
the newest-started session. Terminal changes still contribute to `lastActivityAt` even when another active session
is displayed. Use an active-session index and bounded top-one probes for the page, rather than searching session
history. Historic abandonment times absent from storage remain unknown; migration time cannot stand in for them.

Last-activity, date-finished and date-added keyset reads need indexes matching the account, applicable status/type
filters and ordering. Status/type-filtered tab counts and facets use maintained private counters. Do not sort or
recount a growing library or progress history to serve a page. The shelf interface contract owns exact query names,
defaults, finish-date/null semantics and type projection details. The personal Library selects those native date
shapes in grid/list/table and the phone fallback, with URL-bound sort/direction, exact profile state filters and
cursor restart notices. The current 100-entry personal-page request stays within the API's 20 default/100 maximum;
shared Collection list query defaults remain unchanged. Label shelves keep assignment order. Unavailable/denied
chronological reads display their actual state instead of a successful empty shelf. Requests without shelf additions retain the
existing list envelope and fields. A source's primary type can change: its maintained type key follows anchored
source re-reads and source revision ordering, rather than a permanent snapshot. Raw `readItemTypes` grants no Access
permission; displayed subject summaries still use authorized summary reads. An unavailable summary does not justify
an unbounded search for replacement cards or deletion of private membership/progress.

Activity timestamps and ordering reveal progress even without embedded values. Shelf mode therefore requires both
`library_entry:list` and `progress_session:list`, and both `personal_library` and `reading_progress` gates, with live
own-account authorization. Existing entry-only reads retain their independent capability. Personal state stays out
of public full text, public counts and the subject membership projection, and shelf responses use private caching.

Read entry activity and active-session selection in one request snapshot. Preserve the exact stored timestamp
precision and stable subject ID in cursor positions; converting seek keys through JavaScript `Date` loses finer
precision. Pagination across requests is live, without a retained historical snapshot: moving keys may cause missed
or repeated subjects until refresh. Use the accounts-owned `src/tokens/list-cursor.ts` async
`encodeListCursor`/`decodeListCursor` API with the existing kernel token key ring and required kernel-clock `Date`.
Bind route, viewer and the entire effective query, including page size, as associated data, and retain partition
epoch validation. Library owns no cursor cryptography.

## Sitemap feeds

The [partitioned-sitemap research](../../../../docs/research/partitioned-sitemap-feeds.md) supplies the adopted
partition-major immutable seek design. `GET /v1/sitemap/collections` accepts `cursor` and `limit` from 1 to 1000,
defaulting to 1000, and returns `{items: [{id, lastModified}], next}` as defined by the shared content schemas.
This is a bounded JSON discovery feed; downstream sitemap generation consumes it until `next` is null.
The public route uses the shared public read rate limit. Omitting `cursor` starts a walk; an empty string is invalid,
as in the content feeds. Malformed, foreign or unauthentic continuations answer `invalid_cursor`.
Before discovering candidates, the shared collections-group admission checks the anonymous reader. A closed group
returns `{items: [], next: null}` without candidate discovery or a checkpoint, including for bearer callers.
Dependency and deadline failures propagate as unavailable responses rather than empty pages or candidate denials.

Walk partitions in numeric order and seek ascending `(route, collection_id)` within each partition's sixteen-route
interval, using the active/public partial index. IDs and routes are immutable seek keys; mutable timestamps, titles
and curator fields are not traversal keys. Public candidate discovery is only a hint. Before emitting each item,
require current active/public Collection flags and affirmative live anonymous Access, including its platform gate,
even when the caller supplies a bearer. Unlisted, private, deleted and closed Collections never qualify. Profile
Collections-view settings add no veto to an otherwise anonymously readable public Collection. Do not enumerate
personal library state or members.

For requested limit `L`, fetch at most `4L` candidate identities and visit at most four discovery partition intervals
per page. These are separate budgets; fetched lookahead and any unprocessed suffix consume the candidate budget.
Process candidates in seek order, advancing the checkpoint after each processed candidate, including rejections,
and stop at `L` emitted items or a budget. Resume after that processed prefix, never after an unprocessed prefetched
suffix. A short discovery batch proves exhaustion only when every fetched candidate has been processed; a full batch
does not prove exhaustion. Retain an explicit exhausted-partition marker so empty partitions still advance without
an unbounded per-address loop or a request scanning all empty partitions. Short or empty pages can carry `next`;
only established exhaustion of the final partition returns null. Preserve the checkpoint partition's epoch,
including on exhausted markers, and validate it on resume. Partition moves and unavailable authority retain normal
availability/stale-cursor behavior rather than being treated as empty partitions.
Revalidating a resumed exhausted marker counts toward the four visited partitions. An otherwise empty catalogue
therefore makes bounded progress over several requests; a non-null cursor does not promise a remaining item.

Return `lastModified` from the current `collection.updated_at` observed with disclosure. Existing Collection and
member write paths maintain it; this contract adds neither a new write update nor a synthetic generation timestamp.
It does not claim to cover every external subject-rendering change. Traversal is live across requests: insertion or
publication behind the checkpoint may wait for a fresh walk, and cursor replay can observe different current state.

Keep the complete seek position confidential through `src/tokens/list-cursor.ts` WebCrypto AES-GCM, using the shared
async API and required kernel-clock `Date`. Associated data binds `route: 'GET /v1/sitemap/collections'`,
`viewer: null` and the effective query including limit. Use the existing `KERNEL_SESSION_KEYS` rotation: the current
key issues cursors, retained keys decrypt them, and retirement invalidates cursors under that key. Anonymous
continuations are deterministic and timeless under the shared helper's `viewer: null` policy, including when
the request carries a bearer. The account-viewer lifetime does not apply to this feed. The trusted server decoder
recovers the checkpoint; confidentiality protects its representation on the wire and its associated-data binding.
Signed-only cursors and Library-local AES/HMAC wrappers do not satisfy this contract. `sitemap-position.ts` only validates and
maps the typed checkpoint through the shared helper; it implements no cryptography. This shared helper supersedes
the research's open token representation question. See [Opaque list cursors](../../README.md#opaque-list-cursors).

## FULL Collection member facts

`http/kernel.ts` supplies the trusted route key to `collectionRoutes`; the members route passes its admitted
request deadline to `fullMembers`. BASIC keeps its existing wire shape. FULL adds optional `facts` beside `subject`
using the existing Search Fact schema and the actual member Type, independently of a Collection presentation override.
Both views use private, no-store responses. Requested Semantic readiness failure is the standard 503 problem.

`collection-list-facts.ts` exports `attachCollectionListFacts(deps, rawMembers, { languages?, revalidate })` for the
common members caller and the future independent preview caller. It accepts at most 100 raw original member rows,
including duplicate occurrences. A preview caller must pass its entire globally bounded prefix once, with all homes
released, and supply a final native source/membership reauthorization and fence comparison. It must not add another
row-fact producer. There is no preview caller in this checkout yet.

The helper consumes exactly one actual Semantic `readListPresentationFacts` batch. That owner decides current Type
configuration, native public values, original/terminal/related-item disclosure, release and source-tuple fences.
Shared `readSubjectSummaries` preserves summary language and cover handling under its independent legacy 256-ID bound;
no subject details or browser per-row requests supply facts. Commerce rechecks its native Collection/page after foreign
reads, then checks current original-to-terminal identity/epoch equality against both the returned native facts and
summary. Changed identity or source fails closed. Denied/missing entries expose neither a subject nor sibling facts;
only a complete visible no-facts result becomes `{}`. Neither permission nor source authority is cached.

The existing `CollectionSource` work-context branch admits the native Members or Kind episode on the same live
Core work-step client before Source I/O and rereads native admission and current Source/canonical keys before
returning. Its local metadata, complete-generation seeks, structural membership probes and raw stored/ordinal
pages share the caller's Source reservation. Mechanical handles bind the exact native episode and cannot enter
the ordinary reader branch. Structural evidence grants no Subject readability: the ordinary reader still checks
current original and terminal Subjects, Source, scoped identity and the full private owner formula. Work performs
no foreign lookup while holding the home transaction. Public and frozen output remain unavailable in this branch
because private native capture cannot establish public capture authority. Members remains curated-only; Kind uses
its distinct native locator and audience/custody admission. The current Members and Kind admission implementations
still report unavailable; this Source integration supplies neither a replacement producer nor proof of readiness.

## Cost

These are derivations from the library commands, SQL, `db/library/schema.sql` and `db/library/migrations/`, not measurements or guaranteed PostgreSQL plans.
`N` is total rows of the relevant relation kind; `P` is rows of that kind in an anchor's partition.
`L(N) = O(log(2+N))` shared blocks for a B-tree probe, with constant rows examined for a unique key; `k` indexed changes cost `O(k L(N))` blocks.
Bounds distinguish rows examined (`R`), shared blocks (`B`) and SQL statements (`S`). A subsection excludes the command envelope and authorization unless it adds them.
Library primary keys are B-trees beginning with `route`.
`M` is the finite original raw occurrence population of one Collection, designed for at least one million members. Mounted pages use `s` at most 100. One progress record names at most 100 unit ids. A session's completed-unit count is at most 20000. History length is not capped by that number.
`listing-counts.sql` is the search reader. One statement probes `subject_listing` by primary key, `LIMIT 1`, once per supplied id in one partition. No library growth test measures that reader, so this Cost section does not cite it.
Where a named test does not call the operation, or does not grow the rows that operation can touch, the subsection says so. A bound the indexes do not support is stated as not derivable.

### Private saved-query member evaluation

- Operation/touches: `readMembers -> readDynamicMembers`, stored rule/release, both saved-rule authority brackets,
  native Source and complete original/fact closure, scoped currentness and repeated Collection revision/generation.
- Bound/test: [the composed derivation](cost-saved-query-evaluation.md) identifies finite expansion and ordered
  seeks, but the unidentified-label negative probe lacks an indexed history-independent row bound. Dedicated
  64/512/4096 first/deep/terminal/refusal growth remains unmeasured; ad-hoc and command suites do not cover it.

### Native entry incarnation cutover page

- Touches: one partition metadata point and at most 100 materialized raw live entry keys through the route-leading
  primary key; each legacy candidate separately pays Core's native gate/time/partition/account fences, an exact
  row lock and the existing NULL-incarnation CAS. Native fact-version hooks stay installed. Nonlegacy rows, failed
  CAS and fenced/terminal candidates remain charged; no history, catalogue, NULL count or payload scan is admitted.
- Bound: at most 100 raw keys, cursor at most 512 encoded bytes, complete page output below 4,096 bytes; fixed SQL and
  control work per candidate plus indexed depth. A segment runs at most 100 page steps, including empty or pending
  routing probes, before deterministic continuation. Transient source stamps never cross the durable boundary.
- Growth check: `entry-incarnation-cutover-growth.test.ts` independently grows unrelated live entries, native
  receipts and real SDK histories at 64/512/4,096. It captures rows, blocks, statements, request/response bytes,
  controls, background work and statement occurrences for dense raw100, sparse after-page and nonlegacy inputs,
  actual default maintenance-queue segments and a native serialization retry, under unchanged shared growth rules.
  Worker cases also exercise source/commit crash replay, concurrent replacement/CAS loss, account T and moved/fenced
  fresh-sweep recovery. This scope proves neither global absence/readiness nor complete shared-history erasure.

### Built-in membership and indexed filtering (required; runtime incomplete)

- Touches: private owner-partition candidate/native fact indexes, effective label parents, admitted catalogue indexes,
  current disclosure anchors, prepared results and canonical identity-epoch maintenance in bounded durable steps.
- Bound: derive each admitted plan's row, statement, buffer and byte allowances, including native authority, metadata,
  duplicate histories, stale labels, rejected candidates and background work. No account/history scan, free witness
  work, universal candidate multiplier or universal raw-key budget. Direct page-bounded execution, prepared indexed
  results or rejection before enumeration must preserve filled/final pages or preparing.
- Growth check: actual first/deep pages under
  [the shared three-scale checks](../../../../docs/filtered-lists.md#three-scale-checks), with duplicate histories, stale label parents
  and sparse filters are required. Native helpers and existing curated measurements below do not supply these
  results. Complete built-in/filter runtime and these measurements are missing; no native check ran for adoption.

### Common member filter admission

- Touches: the shared bounded AST/release expansion, one current viewer account point and existing private-family
  exposure gates after Collection read authorization. Presence admits all three native family list actions;
  state/label use `library_entry:list`, session uses `progress_session:list`, holding uses `copy:list`.
- Bound: shared AST bounds, at most one owner account point and three existing family gate decisions. No native
  fact, candidate, history, identity or preparation enumeration occurs while execution producers are unavailable.
- Growth check: `test/library/owner-filter-growth.test.ts` requires useful first/deep native pages and the existing
  direct-plan physical bounds under retained-session growth. It is unrun and remains a runtime requirement.

### Terminal whole-graph cleanup (required; runtime incomplete)

- Touches: every indexed participant-owned child namespace in the retention inventory, exact cross-store private
  payload locators and fixed coordinator acknowledgements, including all old/building private generations.
- Bound: bounded child-before-parent pages/checkpoints and finite workflow segments through existing durable work;
  no cascade, broad principal/JSON/history scan or completion before all phases/store owners acknowledge. Remove
  `fact_source_head` last after delete hooks can no longer recreate it. The ordinary purge page bounds above remain
  requirements, not measured terminal execution.
- Growth check: native whole-graph exhaustion, immediate private/unlisted read/export/count concealment, crash/replay,
  public COMPLETE A versus pending B, producer races and no resurrection are required. Full graph/coordinator and
  exact shared-payload cleanup coverage are absent; entry/copy/follow-only evidence cannot establish them.

### Owner state-write order (required; runtime incomplete)

- Touches: one owner-partition counter primary-key update/lock plus the addressed entry/archive and existing account
  authorization, receipt, source hooks and outbox transaction; no global counter or owner-history scan.
- Bound: constant native counter rows/statements per actual state write plus indexed depth, including initialization,
  bigint fields, rollback and contention. Serializes only that owner's state writes; no free ordering metadata or
  hidden `noEffect` mutation. The [delivered allocator's cost and primitive captures](owner-write-sequence.md#cost)
  remain separate from whole-command evidence. Entry put, retained clear and Undo integrate the allocator;
  their whole-command measurements below include it.
  Every changed fact row also pays [automatic invalidation work](owner-fact-version.md#cost), including a separate
  sequence-stamp UPDATE. One allocator increment is not a bound of one head increment.
- Growth check: require native same-kernel-time writes across two merged originals, concurrent same/different owners,
  clear/Undo fresh order, denied/CAS/replay/overflow rollback and terminal no-resurrection, with three-scale
  owner/entry/history captures. The entry lifecycle checks below cover clear/Undo fresh order, rejected/replayed
  envelopes and live-slot contention. They do not establish every state writer or the terminal graph obligation.
  [Filtered lists](../../../../docs/filtered-lists.md) retains ownership of filter-plan numeric budgets.

### Command envelope

- Touches: Every library `runCommand`. An attempt starts a serializable transaction, sets the lock timeout and the statement timeout, reads time with `transaction_timestamp()` and no relation, runs authorization, and probes at most one `core.receipt` by `(partition_no, principal_kind, principal_id, command_kind, idempotency_key)`. The fence is one statement. It updates one `core.partition` primary key, inserts one `core.outbox` row per event, zero or one `editorial.write_basis`, and zero or one `core.receipt`. Library bodies emit one event, or two when a public Collection also emits `listing.changed` or an in-progress entry also follows. A matching receipt commits and skips the body and the fence. Listing sync supplies no receipt, write basis or authorization callback; source versions provide its replay ordering. Own-account, trusted-account and Collection commands set a 5 second deadline. Listing sync shares one 2 second deadline across command and operational attempts. Contention retries are deadline-dependent, not a fixed count.
- Bound: Here `k` is 1 or 2. Per attempt `R` is `O(1+k)`, `B` is `O((1+k) L(N))`, and `S` is `O(1)`. Replay omits the body and the fence writes.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. That check classifies the whole command, envelope included, as logarithmic rows and blocks and constant statements while unrelated Collections grow at 1, 8 and 64. It does not vary `k` or the deadline.

### Authorization

- Touches: `ownAccount` reads one `access.account` primary key and checks kind, active state, fence, authentication epoch and the request scope in memory. `trustedAccount` reads the same account row for `library:account-command` and does not consult a caller scope list. Collection create adds `parentCreationAuthorization` for `collection:create` on the curator account. That validation reads the account again, and one initialization statement writes access rows. The standing-grant list is empty. The statement inserts one `access.resource_initialization` row and one owner grant `library.collection.owner`. Collection update, delete and member commands use `resourceAuthorization` for `collection:update` or `collection:delete`. Prepare reads the Collection primary key through `visibleCollection` on another connection and runs the Access check. The command transaction then authorizes in memory. A private Collection is hidden from anyone who is not its curator. Entry, copy, follow, progress and published-log commands authorize by the account row and scope, not by a per-row grant. Several also call `readAccount` once before the command. Subject, Collection and Space reads use `subject:read`, `collection:read` and `space:read`. Listing sync passes no authorization callback. The permission-check shape is the Access cost in `src/access/README.md`. A subject resolve also uses the semantic read in `src/semantic/README.md`. This section does not re-derive those probes.
- Bound: Each account or Collection anchor point is `R` `O(1)`, `B` `O(L(N))` and `S` `O(1)`, plus the Access preparation and permission-check bounds for that invocation. Initialization is one statement and two result rows. The temporal owner-grant exclusion check is not a B-tree `L(N)` probe.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. The whole command includes own-account authorization and does not isolate Access probes. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`. Resolve rows and statements stay constant and blocks stay logarithmic. Page cost grows with the input id count.

### Create Collection

- Touches: The curator's partition. Inside the command, parent-creation prepare runs on the writer pool, then one Collection insert, one creation-proof primary-key read that includes `xmin`, and one initialization statement. A public Collection emits `collection.updated` and `listing.changed`. Any other visibility emits only `collection.updated`. Both events use the Collection id as `subject`.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus parent-creation Access checks, own-account authorization and the envelope. The GiST exclusion check on the owner grant is not included in that block bound.
- Growth check: `test/library/collections.test.ts`: `create cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant as unrelated Collections grow. The check does not separate the body from the envelope.

### Update Collection

- Touches: One active Collection primary-key read and one compare-and-swap primary-key update of title, description or visibility. `listing.changed` is emitted only when active-and-public listed-ness changes. The event subject is the Collection id. Members are not rewritten.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus Collection authorization and the envelope. Independent of `M`.
- Growth check: `test/library/collections.test.ts`: `update cost stays constant as unrelated collections grow`. Whole-command rows and blocks are logarithmic and statements are constant at unrelated scales 1, 8 and 64.

### Delete Collection

- Touches: One active Collection primary-key read and one tombstone primary-key update. Members remain. `listing.changed` is emitted only when the Collection was actively public. The event subject is the Collection id. This command does not delete pair rows.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus `collection:delete` authorization and the envelope. No member fanout in this command.
- Growth check: `test/library/growth-collections.test.ts`: `Delete Collection has constant rows and statements as collections and its members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization and the command envelope. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe and idempotency key.

### Add member

- Touches: Subject resolution, the exact Collection/member points, at most two indexed live neighbours, a local
  window of at most 128 resting occurrences and the original partition/receipt/outbox fences. The insert changes
  count/revision/source generation; local respacing additionally changes order epoch. A failed window commits only
  a separately authorized repair-begin intent and returns `503` for the unapplied add.
- Bound: O((selected + 128) log N) rows/index blocks with fixed data widths and bounded key memory, independent of
  total membership; one selected occurrence for ordinary add/move and at most 100 for transfer. Refusal uses the
  same finite points/window, never owner enumeration. Physical integer count/epoch/revision checks remain.
- Growth check: Existing fitting-key growth, CAS/privacy/Undo and subject-anchor tests remain relevant. The maintained
  `test/library/collection-order.test.ts` outcome adds a native HTTP attempt beyond 5,000, interrupted dense-gap repair,
  default worker continuation, preserved order/identity/Undo evidence and a successful retry of the original edit.
  This source and derivation do not establish native or growth proof; integration owns their execution.

### Move member

- Touches: Exact live occurrence read, indexed neighbours and the same bounded local placement window as add.
  The moved row is updated by its full point key after any resting-window rekey; it is never found by listing members.
  The parent source generation/revision advance with the move, and local rekeying advances order epoch.
- Bound: O((1 + 128) log N), bounded rows, statements and memory independent of Collection size. A captured repair
  rejects structural writes by one exact owner barrier; the original move remains unapplied until retried.
- Growth check: Retain the existing fitting-key move cost, privacy, CAS, duplicate occurrence and Undo tests. The new
  Collection order outcome includes a move of an occurrence beyond the former admission boundary. Native proof is deferred.

### Durable Collection order repair and cleanup

- Touches: One immutable repair capture/progress row, one exact parent/account fence and at most 128 examined original
  raw occurrences per transaction. Output updates are point CAS operations. Parent order/source fences, invalidation
  and the next stable work intent commit atomically. Terminal cleanup deletes one capture; parent erasure cascades
  only that fixed-size control row.
- Bound: O(128 log N + log M) work and bounded keys/memory per step; O(M log N) total maintenance and O(M/128) durable
  pages, plus one finite terminal cleanup page. Deleted rows pay the same examined-frontier budget and retain identity.
  Structural barriers prevent an unbounded invalidate/restart loop. No `generateNKeysBetween` call receives `M`.
- Growth check: Existing work/Source staleness and privacy assertions remain required for controller proof, including
  interruption, account terminal fencing and held sources. The maintained outcome is not a native performance proof.

### Note member

- Touches: One active Collection read, one member primary-key note update, and one Collection touch. The note is at most 1000 characters. The event subject is the Collection id. Listing rows are unchanged.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus authorization and the envelope.
- Growth check: `test/library/growth-collections.test.ts`: `Note member has constant rows and statements as collections and its Collection's members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization and the command envelope. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe and idempotency key.

### Remove member

- Touches: One active Collection read and one statement that deletes the member primary key and decrements `member_count`. The event subject is the Collection id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus authorization and the envelope.
- Growth check: `test/library/growth-collections.test.ts`: `Remove member has constant rows and statements as collections and its Collection's members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization and the command envelope. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe and idempotency key.

### Collection read

- Touches: `collection:read`, with public eligibility. Eligibility reads the Collection primary key once into a sink, and the load does not read it again when that sink has seen the row. A repeatable-read transaction may also read the viewer account. Public and unlisted rows are returned. A private row is returned only to a live grant-capable curator.
- Bound: The Collection point is `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the account read when the viewer is an account, the Access check, and begin and commit.
- Growth check: `test/library/growth-collections.test.ts`: `Collection read has constant rows and statements as collections and its members grow`. Whole-operation rows and statements are constant and blocks logarithmic at scales 1, 4 and 16, including authorization. Other accounts' and the curator's own other Collections and members, Access rows, receipts, outbox and write-basis rows grow by 500 x scale per partition; each probe Collection has 250 x scale members (250, 1000 and 4000). Every run uses a fresh probe.

### Public Collection discovery summaries

`readPublicCollectionDiscoverySummaries(dependencies, ids, context)` is the native hydration producer for Search
candidates, exported with owner-local request/context/dependency/summary/result types from
[`collection-discovery-summaries.ts`](collection-discovery-summaries.ts). Content and Web must obtain a ready
native card before displaying a Collection. It has no candidate-source import or dependency. See the precise
[consumer union and omission contract](../../../../docs/dynamic-collections.md#native-public-discovery-card-hydration).

- Input: at most 100 full routed Collection keys in one explicit partition, explicit actor and deadline;
  optional borrowed native time. Validation precedes I/O; duplicate-inclusive limit, deduplicated work and
  first-requested output order preserve full identity. Bad requests throw `RangeError`.
- Native reads: two fresh snapshots each read one partition point, one full-key Collection/curator batch,
  one bounded Access decision batch and one selected-output authority batch. The output batch reuses the
  exact native `collection-source-output-head.sql` formula through correlated full-key probes. Header revisions,
  source generations, incarnation, lifecycle evidence, presentation and publication/member fences are compared.
  Access preparation is repeated outside owner checkout; native media reads run between the snapshots.
- Disclosure: only active public, currently authorized rows. Missing, denied, private, unlisted and removed
  candidates are omitted. Final withdrawal wins. A changed still-eligible observation withholds the batch;
  output, retention or lifecycle uncertainty returns explicit unavailable rather than a successful empty list.
  Access/partition/deadline failures have discriminated unavailable reasons; unrelated errors propagate.
- Public metadata: ordinary curated presentation and occurrence count; dynamic presentation only with the actual
  selected completed output A, including while B builds. No saved rule, private count, working population,
  private curator identity or custody data. De-identified curated retention is native; dynamic terminal output
  without native retention proof stays unavailable. Full IDs link to `/collections/<id>`.
- Ownership and bound: all owned connections and minted read times are released on every path; caller times
  are borrowed. Rows and bytes are `O(K)` and blocks `O(K log N)` for `K <= 100`; the number of Library batch
  statements is constant. Optional cover work is bounded by the supplied keys and the existing Content producer.
  No catalogue scan, ordinary full-read fanout, rule evaluation, preparation or publication occurs.
- Focused native scenarios: `test/library/collection-discovery-summaries.test.ts` covers current metadata,
  full-key validation, duplicate handling, hidden/missing/removed candidates, completed A with pending B,
  absent native output, Access denial, terminal lifecycle change, withdrawal and final revision changes.

### Curator list

- Touches: One `readPublicViews` account probe outside the page transaction hides the list when Collections are off, except for the existing live curator identity check. A hidden list skips the page read. Otherwise, the partition epoch read and `collection-reads-curator-public.sql` on `collection_curator_public_page`, or, for a live grant-capable curator with `collection:read`, the account read and `collection-reads-curator.sql` on `collection_curator_page`. Both statements page active Collections by `updated_at DESC, collection_id DESC`; the public statement also requires public visibility. Their literal predicates match the partial indexes under a generic plan. Each of the two `LIMIT` branches is one index range scan, at most `s + 1` rows, `s` at most 100. The final timestamp order allows a lazy merge of the branches; the exact UTC text remains the cursor key. The repeatable-read transaction still reads the partition epoch. `collection_curator_listing` remains for the store helper ordered by `collection_id`.
- Bound: `R` `O(s)`, `B` `O(L(N) + s)`, `S` constant, including the partition read, begin and commit, and the account read when a full view is considered. For `N` Collections in the partition, the bound is independent of how many Collections the curator has in any visibility or state.
- Growth check: `test/library/growth-curator-list.test.ts`: `a curator's public Collection page examines a constant number of rows as the curator's private, unlisted and deleted Collections grow`; `test/library/growth-curator-list.test.ts`: `a curator's own full Collection page examines a constant number of rows as the curator's deleted Collections grow`. Set-based seeding grows one curator's Collections at scales `[64, 256, 1024]`, one quarter each public, unlisted, private and deleted. `checkGrowth` measures the public first and cursor pages as another account and the curator's full first page, all at limit 20 with the default warm-up, constant rows and statements, and logarithmic blocks.

### Account public Collections

- Touches: One `readPublicViews` statement (one account primary-key probe) outside the page transaction, then, when the view is public, the partition epoch read and `collection-reads-curator-public.sql` on `collection_curator_public_page`: two `LIMIT` branches, each one index range scan of at most `s + 1` rows, `s` at most 100. Every viewer, including the curator, uses this public page directly, without a full-view account read. When the view is off, the existing curator identity check allows the curator's public page and everyone else gets an empty page without a page read. `view=FULL` adds the curator's public summary read, as on `GET /v1/collections`.
- Bound: Rows `O(s)`, blocks `O(L(N) + s)`, statements constant. Independent of the account's private, unlisted and deleted Collections and of other curators.
- Growth check: `test/library/growth-curator-list.test.ts`: `a curator's public Collection page examines a constant number of rows as the curator's private, unlisted and deleted Collections grow` measures this public first and cursor page statement at limit 20 and scales `[64, 256, 1024]`, with constant rows and statements and logarithmic blocks. The added account probe is covered by `test/access/growth-account-public-views.test.ts`: `public view flags for 20 accounts across 4 partitions stay bounded as accounts grow`, at scales `[256, 1024, 4096]` with constant rows and statements and logarithmic blocks.

### Members page

- Touches: The Collection load, then one ordinal keyset on `collection_member` ordered by `ordinal_key`, `member_id`, fetching `s + 1` rows. The unique key is `(route, collection_id, ordinal_key)`. The cursor carries `orderEpoch + 1`. `readableSubjects` then filters at most `s` ids, with concurrency 4. Unreadable subjects are omitted from the page. The extra row only decides the next cursor. FULL display resolves each distinct returned subject id, deduplicated by `ViewReader`: each live resolve includes a pre-wait identity/authorization snapshot, projection freshness probes, fresh Access preparation outside Source RR, and a fresh final authorized Source recheck. An authorized redirect adds one original preflight before the survivor is independently resolved. These points occur per distinct resolved id, not once per page; all SQL, control and catalog statements remain counted.
- Bound: The member statement is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1, plus the Collection load and up to `s` subject resolves. Those resolves cost linear rows, blocks and statements in the id count.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow` uses limit 1 and compares statements. `test/library/collection-store.test.ts`: `member page, insert and neighbour read have constant row and statement cost at three scales` keeps a limit-1 member page, one insert and one neighbour read at constant rows and statements and logarithmic blocks, against unrelated Collections. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Subject page

- Touches: One subject resolve, one exact public-count probe from `subject_listing`, one partition-epoch read, one `subject_collection` keyset on `(route, subject_id, collection_id)` with limit `s + 1`, then one Collection primary-key read per pair on the page. Pairs whose Collection is not active and public are dropped. The mounted page uses `s` at most 100. The pair helper itself accepts a limit through 5000 and is called here with `s + 1`.
- Bound: The count probe reads at most one row. The pair keyset is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1. The projection adds `S` of `O(s)` Collection primary-key reads, each `R` `O(1)` and `B` `O(L(N))`, plus one subject resolve. A limit-1 sample does not show the `O(s)` term.
- Growth check: `test/library/collection-reads.test.ts`: `reads keep the same statement count as unrelated Collections, members and pairs grow` calls the subject page at limit 1 and compares statements. `test/library/subject-anchor.test.ts`: `subject anchoring has constant resolve cost and input-bounded page cost as unrelated subjects grow`.

### Entry put

- Touches: One subject resolve, then own-account `library_entry:update`. A missing revision inserts one `entry` primary key. A supplied revision compare-and-swaps that primary key. State `in_progress` also runs one follow upsert in the same command and may emit a second event. The event subject is the account id.
- Bound: Constant exact-key rows and statements, logarithmic index blocks, including the native profile,
  owner sequence, fact hooks and command envelope. Revisioned writes add one locked current entry point before
  their existing state CAS. In-progress writes retain their existing follow upsert/event envelope.
- Growth check: `test/library/entry-incarnation-precondition-growth.test.ts` measures complete success, missing/wrong
  guard rejection, replacement ABA and exact historical replay at 64/512/4096 unrelated live/retained/receipt histories,
  including native physical/control work. `entries.test.ts` keeps the existing statement-count regression.

### Retained entry clear

- Touches: Native actor admission and personal-library gate before owner checkout, current owner share/authorization
  before receipt, one exact live PK/CAS, optional legacy NULL-incarnation stamp, one retained snapshot/due-index
  insert, one owner sequence allocation, native fact hooks and one deletion event/envelope. Exact replay skips the body.
- Bound: Constant keyed rows/statements; logarithmic live, archive, counter and receipt index blocks. Clearing needs
  no source or active-definition lookup. Copies, sessions, labels and follows remain independent.
- Growth check: `test/library/entry-retained-delete-growth.test.ts` captures whole admitted commands, rejection and
  replay at 256/1024/4096 native live/archive, account/counter/source and immutable-definition populations.

### Original entry restore preparation

- Touches: Native admission/gate, one addressed archive in a short owner read-only RR, then immutable original pin
  and original/terminal source authorization after owner release. Fresh errors are deferred past current-authorized
  exact receipt lookup; owner admission failures are immediate. Historical unmapped legacy facts carry no reference.
- Bound: Constant indexed archive and immutable-meaning points plus the bounded Semantic source resolver. No history,
  active-profile lookup or nested owner checkout. Native T and the caller's finite deadline bind each attempt.
- Growth check: `test/library/entry-restore-preparation-growth.test.ts` charges all pools for ready, rejected, denied
  and replayed preparations at 256/1024/4096 native populations, including denial before private archive reads.

### Exact entry Undo and HTTP

- Touches: Preparation and normal owner/receipt boundary, one locked exact archive witness with native SQL expiry,
  empty-live-PK insertion and addressed consumption, one new owner sequence/stamp, existing fact hooks and one update
  event/envelope. Original fields remain in native INSERT SELECT; no old meaning is revalidated against active definitions.
- Bound: Constant keyed rows/statements, logarithmic live/archive/counter/receipt blocks; strict original 720-hour
  retention. HTTP formats safe entry DTOs and receipt-bound deletion headers without database work.
- Growth check: `test/library/entry-restore-growth.test.ts` charges successful, occupied/stale/expired/missing/foreign,
  owner-denied and replayed commands at 256/1024/4096 native populations; it also covers concurrent arbitration and
  sequence commit/replay/rollback. `entry-undo-http.test.ts` proves the real caller and published contract. Automatic
  due delivery and complete library deletion-driver coverage remain separate.

### Entry read

- Touches: A repeatable-read snapshot, one account admit, and one `entry` primary key. A missing or foreign row is not found. There is no write.
- Bound: The entry point is `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the account read and begin and commit.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Entry read has constant rows and statements as entries grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's entries, other accounts' entries in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

### Entry page

- Touches: A snapshot, an account admit, a partition-epoch read, and one keyset. The unfiltered order uses `entry_account_updated` on `(route, account_id, updated_at, subject_id)`. A state filter uses `entry_account_state`. Two `LIMIT` branches fetch at most `s + 1` rows, `s` at most 100. The cursor is bound to the account and the selected state.
- Bound: `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 for the page, plus the admit and the partition read.
- Growth check: `test/library/entries.test.ts`: `put, delete and list statement counts stay equal at three scales of unrelated account entries` lists with limit 20 and compares statements at 1, 8 and 64. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` pages entries with limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan. `test/library/page-growth.test.ts` measures the HTTP page at a fixed limit and deep cursor through native Access at 1, 8 and 64 across the documented history axes.
- Measurement choice: Grow the same owner's entries, sessions and follows separately, then grow entries, sessions and follows for other owners together.

### Bulk preparation, confirmation, summary and outcomes

- Touches: admitted Source/filter/identity/foreign dependencies, complete selection/occurrence capture, exact target
  commands/receipts/ACKs and native/shared retention. Summary reads one fixed header, never counts the manifest;
  outcomes use immutable operation ordinals. All child, duplicate, rejected, lookahead, empty, failed, repeated and
  rollback work is charged. See [the detailed bulk Cost contract](bulk-contract.md#cost).
- Bound: existing shared read/preparation allowances and the stronger applicable 100 raw native keys/step remain;
  manifest writes spend the same remaining ledger, with one connection/backend. Whole confirmation includes the
  complete missing validation-to-confirm primitive, with no O(1) claim. Stable total work targets
  `O(N + M + D + T + E)` over raw source/target-member/repair keys, targets and attempts; bytes include dependencies,
  targets/receipts and replay. These are obligations, not measurements or a new population cap/budget. Proposed
  summary work is `R O(1)`, `S O(1)` plus logarithmic blocks/current authority; its runtime is absent.
  Real `pageBulkOutcomes` uses the independently authorized caller's source RR client and exact operation-owner
  proof: one `bulk_target_pkey` or exact-state `bulk_target_state` seek, route/operation/account predicates, at most
  21 fetched/20 emitted rows and last-emitted continuation only with lookahead. State is current at that snapshot;
  the outer reader owns encrypted bound cursors/private not-found. Receipt reconciliation uses exact keys and
  counters change once per unique transition. Respacing retains its ordinary admitted cost. Cleanup is indexed,
  at most 100 charged child keys/page; outstanding-operation/byte admission and unknown receipt disposition remain
  prerequisites. A TTL/preparation quota is no aggregate manifest-byte bound.
- Growth check: existing `test/library/growth-bulk-outcome-page.test.ts`,
  `outcome pages have bounded rows and statements as operation targets grow`, covers first/deep pages in both pager
  branches as targets/nonmatching states/other operations/owners grow, with bounded rows/statements, logarithmic
  blocks and no sequential scan/planner settings. The original `specs/library-bulk-outcomes.test.ts` titles
  `progress is bounded truthful and outcome pagination does not repeat or expose the manifest on summary` and
  `growth axes retain indexed admission replay summary and fixed outcome pages without manifest recounts` remain
  deferred acceptance obligations. Whole preview/confirmation, shared/native costs and custody acceptance are
  deferred/unimplemented. Existing test source is not measured full-product evidence.

### Session start

- Touches: Per-attempt trusted preparation calls `readLibraryProfileSource` for the original and optional version
  subject at native T, releasing each source/Global connection before owner checkout. It charges account admission,
  subject resolution, native Access, anchored source/partition reads, primary type and active immutable release
  lookup. Owner authorization and exact receipt lookup precede fresh capability validation. The body ensures the
  exact owner/subject `progress_head`, inserts one pinned session, touches that head and raises an existing entry's
  activity. Entry absence does not create an entry. The event subject is the account id.
- Bound: Body `S` 4, `R` `O(1)`, `B` `O(L(N))`, plus preparation, authorization and the envelope. Session insertion
  and a changed entry each pay their own `fact_source_head` trigger upsert (one fixed owner point per changed row).
  All helper and nested trigger statements are charged; there is no owner/history walk or free metadata work.
- Growth check: `test/library/session-shelf-activity.test.ts` measures the actual prepared start/record/complete/
  start/abandon journey with `checkGrowth`, explicit `rule: series`, at 64/512/4096 unrelated same-owner sessions,
  heads and history rows. The capture includes Core, Access, source/profile, helpers and nested trigger SQL.

### Session record

The exclusive `{revision, clear: true}` record intent clears amount, locator, position and sparse units in the
existing owner-authorized, locked CAS transaction, appending `{clear:true}` to history. It retains the session,
pin, captured total, lifecycle dates/state and other personal facts; it needs no current profile or source.
Clearing a finished session preserves its lifecycle. Sparse clearing deletes only this exact session's keys,
bounded by the native 20000-key cap, with no history scan; this adds one indexed DELETE to the record body.

- Touches: Trusted preparation reads one owned session/pin in an owner snapshot, releases it, resolves the original
  immutable release and observes current subject/profile admission at the attempt's T. The body point-reads the
  immutable subject, ensures its head before the typed `(route, session_id)` `FOR UPDATE`, then rereads/CASes the
  session. It validates only incoming values against both original meaning and current admission. Stored total,
  start, units and history are never reinterpreted or repinned. NULL-pin rows retain the temporary explicit legacy
  parser. Optional unit remove/add statements each name at most 100 exact keys combined. Every accepted intent,
  including equal scalar/sparse no-net values, increments revision and appends one exact change row. Head/entry
  activity follows the successful write/history in the same transaction. Errors roll it all back; replay skips it.
- Bound: Scalar/cursor body `S` 8, `R` `O(1)`, `B` `O(L(N))`, plus preparation, authorization, envelope and one
  `fact_source_head` upsert per changed session/entry. Unit writes add at most two statements, `R` `O(u)` and
  `B` `O(u L(N))` for `u <= 100`. Neither sparse cardinality nor history is scanned. The 20000-key cap remains.
- Growth check: the native journey above measures all actual statements at 64/512/4096 background rows, with
  constant rows/statements and logarithmic indexed blocks. Existing legacy growth fixtures are not profile proof.

### Independent scalar measures

`POST /v1/progressSessions` retains its existing `mode`, `unit` and optional `total` primary fields and accepts up to
seven `additionalMeasures` only for `scalar_amount`. Each extra unit is admitted by the same subject's current
released profile, pinned with the session's accepting release/type, and checked for native structure `none` and
identity `none`. No unit conversion or alternate profile store is involved.

`GET /v1/progressSessions/:sessionId` projects the primary value and, for multi-measure sessions, a `measures` array
with separate `unit`, nullable decimal-string `amount` and `total` fields. The row's bounded `additional_measures`
JSON array is limited to seven entries; the primary continues to use the existing scalar columns. `presentation=FULL`
uses the accepted release for each label and current profile for each recording hint. It retains unknown/unavailable
meaning when required release evidence cannot be read.

The existing `:record` operation accepts `{revision,measureId,amount}` for an addressed unit. The same parent row CAS
serializes all measure edits; every accepted write appends one change intent and replays through the original command
receipt. `{revision,measureId,clear:true}` clears only that amount and retains its total and sibling values. The
existing `{revision,clear:true}` clears every recorded value and retains all totals and lifecycle facts. Unknown
measure IDs are invalid input; unsupported active profile meanings return `unsupported_library_profile`; stale parent
revisions return `conflict`.

Because every measure remains on its existing private session row, owner authorization, keyset pages, source-fence
triggers, profile migration ownership and terminal deletion remain on the current session path. The eight-value cap
bounds each returned projection. `test/library/progress-http.test.ts` covers create/read, independent correction,
clear, private isolation, stale revision and replay. No separate measure-store growth result is claimed.

### Session complete

- Touches: One subject point read, head ensure, typed session lock, reread and CAS, then head touch and existing
  entry raise. Completion alone sets `completed_at` and completion evidence. No new profile value is supplied,
  so current profile absence does not prevent this lifecycle operation. No unit or history write occurs.
- Bound: Body `S` 7, `R` `O(1)`, `B` `O(L(N))`, plus authorization, envelope and the changed session/entry's
  fixed owner-head trigger upserts. Stored profile pin and user entry identity/revision/timestamps remain unchanged.
- Growth check: the same actual native three-scale journey includes completion, with every trigger charged.

### Session abandon

- Touches: The same ordered point/head/lock/reread/CAS and activity work as completion, without adding completion
  evidence. It preserves immutable session meaning and needs no current profile. No unit or history write occurs.
- Bound: Body `S` 7, `R` `O(1)`, `B` `O(L(N))`, plus authorization, envelope and changed-row owner-head triggers.
- Growth check: the same actual native three-scale journey includes abandonment, with every trigger charged.

### Session read

- Touches: A repeatable-read snapshot, one account admit, and one session primary key. A missing or foreign session is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit and begin and commit.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Session read has constant rows and statements as sessions grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's sessions, other accounts' sessions in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

The owner detail additionally accepts `presentation=FULL`, independently of summary `view=FULL`. The
[profile consumer contract](../../../../docs/library-profile-consumers.md#owner-session-display-and-current-recording)
owns the exact display/advisory DTO and preservation rules. `progress-presentation.ts` uses the stored pin's exact
immutable release for historic English labels/count forms and the existing current source/profile and native
validators for recording hints. It never relabels from the active head, exposes pins, or changes old values.
Missing original release means unavailable; unknown old pair means raw unknown; only actual readable current
profile/pair absence or incompatible meaning proves unsupported. Source uncertainty remains unavailable.

Opt-in cost: two owner snapshots with exact session/pin, partition epoch and native owner Access; one exact release
lookup, one current source/profile lookup, and fixed original/terminal identity/type/component checks before/final.
An explicit version adds independent fixed source disclosure checks. FULL summary work retains its independent
existing authorization and bounded projection. All homes are released between reads under one fixed deadline.
There is no history walk, unit scan, structure resolution or GET write. Statements/rows are fixed and indexed block
work is logarithmic, plus bounded immutable release bytes and existing Access/summary costs. The BASIC bound and
its measured growth result above are unchanged; this opt-in path's native/full privacy and inclusive growth proof
remain deferred. `test/library/progress-presentation.test.ts` and additional native cases in
`test/library/profile-session-command.test.ts` describe its outcomes; compiler success alone is not native proof.

### Session page

- Touches: A snapshot, an admit, a partition-epoch read, and one keyset on `progress_session_account_subject` `(route, account_id, subject_id, started_at, session_id)`. Two `LIMIT` branches fetch at most `min(100, s + 1)` rows. When `s` is 100 and the page is non-empty, a second limit-1 probe runs, because the first fetch is capped at 100. The cursor binds the operation, the account and the subject.
- Bound: `R` `O(s+1)`, or `O(s+2)` when the extra probe runs. `B` `O(L(N)+s)`. `S` is 1 or 2, plus the admit and the partition read.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Session page at a fixed limit has constant rows and statements as sessions grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's sessions, other accounts' sessions in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale. The first session page keeps its limit of 20 and its first 21 neighbours fixed.

### Unit page

- Touches: The same snapshot, admit and session primary key, a partition read, and one `progress_unit` keyset on `(route, session_id, unit_id)`. The first fetch is `min(100, s + 1)`. A non-empty page at `s` = 100 issues a second limit-1 probe.
- Bound: The page is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 or 2, plus the session read, the admit and the partition read.
- Growth check: `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` pages units at limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` lists units at limit 1 and compares statements at 1, 8 and 64. `test/library/page-growth.test.ts` measures the production unit page with native owner authorization at a fixed limit while same-owner and other-owner histories grow independently.

### Change page

- Touches: The same session load and snapshot as the unit page, then one `progress_change` keyset on `(route, session_id, change_no)`. The first fetch is `min(100, s + 1)`, with the same extra probe when `s` is 100 and the page is non-empty. A cursor seeks to `change_no`. It does not walk from change 1.
- Bound: The page is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 or 2, plus the session read, the admit and the partition read.
- Growth check: `test/library/progress-store.test.ts`: `unit add, unit page and change page touch the same rows and statements at three scales` pages changes at limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan. `test/library/sessions.test.ts`: `statement counts stay equal at three scales of unrelated sessions and units` lists changes at limit 1 and compares statements.

### Copy create

- Touches: An account admit, one subject resolve, and one `copy` insert in the owner partition. The event subject is the account id. The payload carries the copy id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit, the resolve, authorization and the envelope.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies`. Create keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Copy update

- Touches: An account admit, then a body of three statements: `FOR UPDATE` on the owned copy primary key, one primary-key read, and one compare-and-swap update. A foreign or missing row is not found. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the admit, authorization and the envelope.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies`. Update keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Copy delete

- Touches: The same admit, lock, primary-key read and revision check as update, then one primary-key delete. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 3, plus the admit, authorization and the envelope. The same shape as update, with a delete in place of the update.
- Growth check: `test/library/growth-personal-writes.test.ts`: `Copy delete has constant rows and statements as copies grow` checks the whole command at scales 1, 4 and 16 while the owner's copies, other accounts' copies in the same and another partition, Access accounts, receipts, outbox events and write-basis rows grow by 500 × scale per relation.

### Copy read

- Touches: A repeatable-read snapshot, one account admit, and one `copy` primary key. A missing or foreign row is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus the admit and begin and commit.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Copy read has constant rows and statements as copies grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's copies, other accounts' copies in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

Owner detail alone additionally accepts `presentation=FULL`, independent of summary `view=FULL`.
[Profile consumers](../../../../docs/library-profile-consumers.md#owner-copy-detail-and-current-status-advice)
owns the exact DTO, qualified current status advice and adopted kind/status provenance split.
`copy-presentation.ts` resolves each actual kind/status accepting release by exact digest; no current source labels enter
historic display. `copy-store-read.sql` selects one live row and its private pins by full copy key and actual owner.
`readPresentedCopy` has a typed default caller and a rendering callback held inside its before/final owner,
principal/denial, partition, copy/pin and source-version checks. Snapshots are released between owner and foreign
homes. Unknown raw and legacy-unspecified kinds stay unknown. Current release failures do not decide retirement
or prevent independently readable subject summaries. No read writes or returns accepting metadata.

The detail adds two exact owner copy reads plus fixed account/Access/partition observations, at most two deduplicated
exact accepted release lookups, one current profile lookup and bounded current source/final probes. Work is constant in unrelated facts
and historical releases; it never walks history or adds per-row release reads to lists. Existing default wire
assertions remain unchanged. Focused pure presentation and additive actual native fixture cases cover accepted
labels versus current rename/retirement, unknown versus unavailable, disclosure and final fences. Native and
promoted-main proof remain pending; local typing is not that proof. Metadata update/delete/Undo contracts and the
720-hour restoration window remain unchanged. Fresh creation captures `kind_profile_pin` and `status_profile_pin`
from actual native acceptance. Explicit status updates replace only the latter; metadata-only edits preserve both,
and the compatibility `library_profile_pin` stays original. Existing mutable pins are not creation proof: the new
migration deliberately leaves old rows unknown, with no current-profile backfill. The native fixed-contract migration
and pre-profile retained Undo capture only their explicit legacy destination. Restore resolves accepted status and
kind separately, so a newer status cannot relabel the original kind. Both columns remain private whole-row data:
`copy-retention-purge.sql` and `account-fact-purge-copy.sql` already erase them with their owning row, with no orphan
store or additional participant. Local compiler validation is separate from all pending native and promoted-main proof.

### Copy page

- Touches: A snapshot, an admit, a partition-epoch read, and one keyset on `copy_account_created` `(route, account_id, created_at, copy_id)`. The first fetch is `min(100, s + 1)`. When `s` is 100 and that fetch does not already show a further row, a second limit-1 probe runs. The cursor is bound to the account.
- Bound: `R` `O(s+1)`, or `O(s+2)` with the probe. `B` `O(L(N)+s)`. `S` is 1 or 2, plus the admit and the partition read.
- Growth check: `test/library/copies.test.ts`: `statement counts stay equal at three scales of unrelated copies` lists with limit 1 and classifies statements and rows as constant and blocks as logarithmic. `test/library/entry-store.test.ts`: `entry write, entry page and copy page touch the same rows and statements at three scales` pages copies at limit 1 at scales 1, 4 and 16 with 500 x scale seeded rows per relation (500, 2,000 and 8,000), with no planner setting: one statement, constant rows, logarithmic blocks and no sequential scan.

### Copy list by subject

- Touches: A snapshot, an admit, a partition-epoch read, and one range of `copy_account_subject_created` for `(route, account_id, subject_id)`. The page fetches at most `limit + 1` rows. At the maximum limit, it uses the same one-row probe as the unfiltered page when the first fetch has no extra row. The stored subject id is matched directly, and the cursor is bound to it.
- Bound: `O(limit)` rows and statements per page, independent of the account's copies of other subjects and other accounts' copies of the same subject. `B` is `O(L(N)+limit)`. The page uses one statement or two with the maximum-limit probe, plus the admit and the partition read.
- Growth check: `test/library/copies.test.ts`: `subject-filtered copy page keeps statement counts equal at three scales of unrelated copies` keeps statements and rows constant and blocks logarithmic at 1, 8 and 64, with no sequential scan on `library.copy`.

### Follow

The retained native inputs are `test/library/follow-counts-outcomes.test.ts`,
`test/library/follow-count-bootstrap.test.ts`, `test/library/follow-count-bootstrap-growth.test.ts` and
`test/library/follow-counts-growth.test.ts`. The outcome entry point installs the file URL of
`test/library/support/follow-counts-driver.ts` and imports the authoritative seventeen-outcome suite once.
That factory uses the existing `createLibraryDriver` world, original kernel Responses, native source reconciliation
and target delivery, and the shared growth capture/classifier. The additive native fixture ports expose existing
Auth provisioning/consent, bearer transport and observation of actual Access calls; they confer no authority.

These restored inputs do not establish native completion. The current world lacks an Auth account-operation host
for operated-account creation and terminal deletion. Whole Library page observations must include raw examined
work, including owned-graph pages; missing observations fail explicitly. Count-role exhaustion never establishes
whole-participant completion. Shared work-payload observation and minimizer custody remain unresolved. The original
bootstrap contract file is absent, and newly provisioned accounts are
already bootstrap-complete under the runtime migration; they cannot stand in for pre-hook legacy coverage.
The retained first-page inputs require that native legacy population boundary rather than a SQL reset.

The suspension/reactivation and terminal-purge outcomes capture genuinely pending native work before its first
target application, deliver that same handle and observe count 1 before their lifecycle commands. Later deliveries
replay the original handle after acknowledgement, as the duplicate-projection outcome also requires. Every replay
still reconciles current native source eligibility; capture never manufactures pending work.

Create/refollow requires real current target authority at native command T through prepared command support.
Stored source originals never change when Semantic identity moves. Exact authorized receipt replay precedes deferred
target failure; replay/no-op emits no new invalidation or replacement. Explicit removal remains negative across
later Library/membership intent. The [Accounts follow research](../../../../docs/research/accounts-design-follows.md)
is evidence for this split; this contract and the private-count owner document retain authority.

- Touches: An account admit, then a target resolve. A subject uses `subject:read`. A Collection is one primary-key read and must be active and public, unlisted, or curated by the actor. A Space uses `space:read` and one Space read. The command then upserts one `follow` primary key and reads it back. An unchanged row aborts before the receipt. The event subject is the account id. Follows are not counted in public.
- Bound: The follow body is `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus the admit, the target resolve, authorization and the envelope. The Space and subject resolves add their own Access and semantic bounds.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow`. Explicit Collection follows keep statement counts equal as unrelated follows grow. Blocks are not classified. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` applies intent `follow` as unrelated follows grow: one statement, one `library.follow` row, no sequential scan, constant rows and logarithmic blocks. `test/library/page-growth.test.ts` measures the Library Follow HTTP command and the in-progress entry follow branch, including native authorization and subject resolution, across the documented history axes.

### Unfollow

- Touches: Current own-account `follow:delete` uses the native scope/principal/grant/denial formula before receipt replay. An existing own edge supplies its immutable original target identity/type; removal never resolves that target or reads its private payload, including after hiding, deletion or unavailability. An absent own edge conveys no target-type authority and still requires the ordinary current target resolution. An explicit unfollow is not overridden by a later implied follow. The event subject is the account id.
- Bound: `R` `O(1)`, `B` `O(L(N))`; one own-edge read before preparation, one recheck, one upsert and one read-back, plus current own-account admission and the envelope. A stored removal has no target-home read. Only absence adds target resolution.
- Growth check: `test/library/growth-personal-writes.test.ts`: `Unfollow has constant rows and statements as follows grow` checks the whole command at scales 1, 4 and 16 while the owner's follows, other accounts' follows in the same and another partition, Collection targets, Access accounts, receipts, outbox events and write-basis rows grow by 500 × scale per relation.

### Membership follow

- Touches: `trustedAccount` for `library.follow.membership`, then the same follow upsert and read-back, with implied intent and reason `membership`. The library command does not resolve the Space. Community's join step is the caller. An explicit unfollow is preserved by the upsert predicate. The event subject is the account id.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus trusted-account authorization and the envelope. No subject, Collection or Space read inside this command.
- Growth check: `test/library/growth-personal-writes.test.ts`: `Membership follow has constant rows and statements as follows grow` checks the whole command at scales 1, 4 and 16 while the owner's follows, other accounts' follows in the same and another partition, Access accounts, receipts, outbox events and write-basis rows grow by 500 × scale per relation. `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow` still checks membership statement counts at 1, 8 and 64.

### Maintain source follow replacement metadata

The forward `follow_count_source` migration installs `follow_count_source_change` on `library.follow` itself.
Explicit follow/unfollow, entry-implied follow and the trusted membership owner command keep their existing
SQL, DTOs, receipts and private `{targetId}` event. Previously prepared SQL also fires the storage hook. There is
no Access trigger or write in an Access transaction. Ordinary writers retain their native `shareAccount` barrier;
the hook reads only the keyed current `access.account` state/fence as eligibility data, never grant/role authority.

`library.follow_count_source` has primary key `(route, account_id, target_type, target_id)`, positive native bigint
`revision`, `source_following`, `desired_eligible` and nullable `pending_since`. This is one current replacement
per original, including negatives after physical DELETE; raw `follow` remains truth. Original identity and owner
route cannot be updated. Every actual changed row increments its revision, including reason-only changes; an
identical row UPDATE, implied conflict, explicit no-op or receipt replay does not. Reinsert advances the retained
revision. `desired_eligible` is raw following AND current account active AND not fenced; a missing account is
ineligible. This saved value is never delivery authority. Every future delivery must reread native account/follow
under the account barrier before applying, including a positive first application.

`library.follow_count_owner`, keyed `(route, account_id)`, holds native bigint `observed_live_count` and explicit
`bootstrap_complete=false`. Missing owner/pair metadata is unbuilt, never ready zero or revision zero. The count
is the sum of raw following states **already represented** by source rows, independent of incoming eligibility.
It becomes the outgoing live total only after a separate bounded bootstrap proves complete coverage. The hook
never declares any owner complete, even one first seen after migration. It locks this owner point before reading
the pair's previous `source_following`; its delta is current raw following minus previously represented following
(absent means unrepresented, not absent raw truth). Thus first-touch legacy UPDATE incorporates current live state,
first-touch legacy DELETE records a negative without subtracting unknown coverage, and concurrent first/last
changes cannot lose or double-count a represented edge. Native bigint overflow aborts source, metadata, counter,
receipt and outbox together; it never wraps or resets.

Cutover is transactional DDL plus a `SHARE ROW EXCLUSIVE` lock on `follow`: pre-existing source mutations finish
before installation, and later mutations, including old prepared statements, cannot bypass the hook. This proves
all-writer coverage after cutover, not legacy population coverage. Existing follows are deliberately unseeded.
A reader snapshot predating installation proves no baseline, and an absent head is not version zero. Future
bootstrap must start in a fresh native transaction after observing installed coverage, take the same account
writer barrier and owner counter lock, then page original follow keys, arbitrating each pair under its primary-key
lock. Insert a missing pair at revision 1 from current native truth and add its raw live state exactly once;
already represented pairs retain their revision unless current truth changes. Hooks behind the cursor represent
their own changes. Only complete exhaustion under this arbitration may establish coverage. No chronology is
inferred from `updated_at`, UUIDs or a global stamp; bootstrap and acknowledgement code are not delivered here.

`pending_since` uses database statement time, retains the minimum uncompleted age across coalescing and starts
again only after a future acknowledgement clears the current revision. The partial index
`follow_count_source_pending(route, account_id, pending_since, target_type, target_id)` supports owner-local oldest
work. Partition/global health reduction and discovery remain separate required producers; this owner-leading
index alone is not a global health sampler. Retain negative rows/revisions while the account is active; no GC,
TTL or revision reuse. Terminal erasure must fence writers and acknowledge target withdrawals before deleting
source payload/head. This migration supplies no terminal withdrawal, cleanup completion or identity participant ACK.

Source runtime reconciliation, bounded bootstrap, account maintenance/effect admission ports, current-source
delivery, target replacement/support/total, canonical identity/rekey, terminal fences/erasure, maintenance readiness,
count HTTP and the frozen full outcome driver remain unbuilt. Account effect work must preserve event time and
unprocessed age through queued/pending/ERROR/lost work; readiness must include effects consumerReady and consumer
lag, never heartbeat freshness. Suspension must change incoming eligibility through that later maintenance,
not raw outgoing intent or this counter. No count becomes publicly exposed by this storage slice.

- Touches: One original follow and fixed owner-local source/counter/index points in its same native transaction;
  one keyed account data read. The hook executes five SQL statements on a live delta, four otherwise. The outer
  statement and command envelope remain as above; nested trigger statements are additional work.
- Bound: Constant changed rows/statements per edge and indexed depth `O(log N)`, with one-owner counter contention.
  No follower/target/history scan, global clock ordering, fanout, full backfill or owner/global COUNT. Count reads,
  maintained canonical support and full native API costs require their own evidence.
- Growth check: `test/library/follow-count-source-storage.test.ts` uses the shared `checkGrowth` series rule at
  scales 256, 1,024 and 4,096, with five warm-ups and five measured repetitions per scale. Each warm-up and
  measured run consumes its own released subject and fresh idempotency keys; all 30 negative follows are prepared
  through ordinary native commands before capture. The selected owner and hot partition stay fixed while unrelated
  source owners/targets, own negative source history and same-partition Semantic revision history grow at the three
  scales. Before the first scale, the fixture creates an unrelated native subject and seeds 8,192 additional
  production-shaped `semantic.revision` rows for its route, subject, release and kind. The ordinary shared lifecycle
  settles and analyzes these rows before every capture. Every run records whole-command rows, statements, blocks,
  nested `auto_explain` documents and backend ids. The measured exact `core.receipt` lookup is attributed with the
  shared statement-occurrence records; raw warm-up plans retain its normalized statement, backend and plan
  shape. These plan observations do not establish execution counts or a custom-to-generic transition. Every
  measured `semantic.revision` node must use the same bounded primary-key point plan at the smallest and largest
  scales, with no sequential scan or unrelated revision filtering. The source and counter relations also require
  positive work and zero sequential scans. Synthetic negative cardinality and isolated rollback/overflow/DDL
  invariants remain primitive-only; every positive measured follow/unfollow uses the native fixture and production
  commands. `growth.json` retains populations, per-occurrence accounting and the actual series verdict; `plans.json`
  retains raw nested plans with rows/removals, loops and buffers.
  **Calibrated result: incomplete.** The current shared `GrowthCheck`/`ReportSample` API exposes statement
  occurrences only for accepted measured runs. In `test/support/growth.ts`, `checkGrowth` captures each warm-up
  locally, retains its backend IDs for pool warming, and discards its statement occurrences, errors and inputs;
  cold-backend discarded invocations likewise have no occurrence report. Calling the exported `capture` inside
  a `warmup` hook instead fails with `A growth capture is already active for this database`. Consequently this
  probe cannot prove the required exact per-backend receipt execution sequence, including warm-ups, through
  the current shared API. Shared occurrence reporting for those invocations is a prerequisite; raw plan counts
  must not stand in for executions. The authored steady-plan assertions and storage/correctness cases remain
  unchanged, and no new calibrated pass is claimed.
  The probe uses the same checked native-property narrowing for `processID` as the shared harness; that repair
  still has no new native receipt. The latest local kernel workspace type check failed on the unchanged source
  head with `TS2769` at `specs/viewer-actions-surfaces-outcomes.test.ts:139`: spreading `refs[index]` makes the
  required resource identity optional under unchecked-index protection. This pre-existing frozen acceptance
  assertion remains unchanged. Native acceptance is deferred under the current minimal verification instruction;
  neither local typing nor shared occurrence-custody delivery establishes a calibrated native pass.

### Maintain and read private follow counts

The [private-count authority](../../../../docs/private-follow-counts.md) owns disclosure, canonical totals,
readiness and terminal custody. The default Library worker installs bounded source/target bootstrap, current-source
delivery, account admission and the partition health tree. `GET /v1/followCounts/:targetType/:targetId` and
`GET /v1/followCounts/outgoing` consume those maintained rows through native bearer, scope, platform admission and
management checks. No count or follower identity is added to a public DTO.

Cost: source/target work touches indexed original, support, total and exact receiving locator keys; bootstrap and
account pages examine at most 100 immutable keys. Terminal work withdraws at most 100 exact locators or source rows
per phase and retains source evidence until receiving commit. A count reads constant root metadata at both ends and
one indexed total (or own counter), with O(log N) index depth independent of followers/history/group size. Health
sampling probes indexed oldest work and reduces at most 16 children on each of three levels. Native all-outcome,
identity/custody and cost proof is pending; source typing does not certify these bounds or open the platform gate.

### Follow read

- Touches: One `follow` primary key for the caller and the target. The read is a single autocommit statement. Another account receives no row. There is no public count.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1. No envelope, because this read is not a command.
- Growth check: `test/library/growth-personal-reads.test.ts`: `Follow read has constant rows and statements as follows grow`. Whole-read rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the reading account's follows, other accounts' follows in its partition and another partition, Access accounts, receipts, outbox and write-basis rows grow by 500 rows per population times scale.

### Follow page

- Touches: One keyset on `follow_account_page` `(route, account_id, state, updated_at, target_id)` for `state = following`. The command page is one statement. The HTTP page also reads the partition epoch. Its first fetch is `min(100, s + 1)`. When `s` is 100 and that fetch does not already show a further row, a second limit-1 call runs. The cursor is bound to the account.
- Bound: The page statement is `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1. HTTP at `s` = 100 adds the probe, so `S` is 1 or 2, plus the partition read. No command envelope.
- Growth check: `test/library/follows.test.ts`: `statements per follow, membership step and page stay equal as unrelated follows grow` lists with limit 20 and keeps statement counts equal as unrelated follows grow. `test/library/follow-store.test.ts`: `apply and page statement counts and examined rows stay constant as unrelated follows grow` pages with limit 1 as unrelated follows grow: one statement, one examined follow row, no sequential scan, constant rows and logarithmic blocks.

### Publish

- Touches: Own-account `published_log:create`. The body reads the owner's session primary key and inserts one immutable `published_log` in the owner partition. The event subject is the account id. Nothing is written on the subject partition.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 2, plus authorization and the envelope.
- Growth check: `test/library/growth-published-logs.test.ts`: `Publish has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions.

### Retract

- Touches: Own-account `published_log:delete` and one primary-key delete matched to the owner account. The event subject is the account id. The session is left in place.
- Bound: Library body `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus authorization and the envelope.
- Growth check: `test/library/growth-published-logs.test.ts`: `Retract has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions. Each run, including warm-up, retracts a fresh snapshot.

### Published log read

- Touches: A repeatable-read transaction and one `published_log` primary key. The read is public, including anonymous. There is no account admit. A missing row is not found.
- Bound: `R` `O(1)`, `B` `O(L(N))`, `S` 1, plus begin and commit. No authorization read.
- Growth check: `test/library/growth-published-logs.test.ts`: `Published log read has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions.

### Published log page

- Touches: A repeatable-read transaction, one partition-epoch read, and one keyset on `published_log_account_page` `(route, account_id, published_at, log_id)`. Two `LIMIT` branches fetch `s + 1` rows, `s` at most 100. There is no second probe. The cursor is bound to the account. The page is public.
- Bound: `R` `O(s+1)`, `B` `O(L(N)+s)`, `S` 1 for the page, plus the partition read and begin and commit.
- Growth check: `test/library/growth-published-logs.test.ts`: `Published log page at a fixed limit has constant rows and statements as published logs grow`. Whole-operation rows and statements stay constant and blocks stay logarithmic at scales 1, 4 and 16 as the account's own and other accounts' published logs, progress sessions, receipts, outbox, write-basis and Access account rows grow by 500 x scale per population in the owner and other partitions. The first page has a fixed limit of 20.

### Member listing effect

`library_member_listing` consumes actual member events. It observes the source partition epoch/position and
Collection/public-history/member truth on the same repeatable-read client, then releases that client before a
single subject-home command. Unavailable/moved/fenced source ownership fails instead of supplying zero.
`listing-apply.sql` replaces one version and positive pair using monotonic bigint source stamps. Old observations
are ignored; an equal-stamp payload conflict aborts. Public-history zero versions survive withdrawal and deletion,
including a withdrawal delivered before the first positive. Never-public private/unlisted zero observations retain
no target record, receipt or event. Duplicate occurrences contribute one Collection, independently of multiplicity.

Pair/count changes and the existing `{subjectId}` listed event commit together. A newer source stamp with unchanged
multiplicity rolls back the command attempt, then updates only derived ordering metadata through the existing fenced
operational transaction. It changes no count, public revision or event, and never conceals writes in `noEffect`.
Registered work reuses its native WorkClient; direct callers own a short-lived client on the supplied pool.
There is no receipt: the retained source version supplies replay ordering, including public/private/public
cycles. It reads neither personal Library facts nor curator labels.

The source examines only occurrences of this subject in this Collection through `collection_member_subject`
(a finite original occurrence population, paged by the registered worker); apply uses point keys on version, fence, pair and subject aggregate.
Statements and examined rows are constant plus this bounded multiplicity, with B-tree depth in storage size.

### Listing-change workflow and publication visibility

Visibility changes/deletions keep the existing source-local command and atomic `collection.listing.changed` event.
The registered default Library effect enqueues `library.collectionListing` using the event ID. Each
`library.syncCollectionPage` uses at most 100 indexed successor seeks to distinct subject IDs; duplicates are skipped
by seeking strictly after the previous subject, rather than scanning a DISTINCT population. It releases its source
connection before syncing each affected subject home. A segment executes at most two pages, then persists a
continuation in the existing DBOS workflows queue with only Collection ID, last subject ID and root workflow ID.
Retry/recovery repeat against current source truth. No additional worker, queue or domain write in GET exists.

The maintained exact count becomes visible after publication finishes, not synchronously in the Collection command.
A page that encounters a withdrawn positive returns dependency-unavailable readiness instead of certifying its stale
count. Subject reads retain one maintained subject-key count and a fixed candidate page; they do not count Collections
or enumerate all subject pairs. Current active-unfenced account public-view discovery filters public list candidates;
known-ID public/unlisted readability remains separate native Access authority.

One page costs one indexed subject-keyset statement plus two source statements and one apply statement per subject,
with the native transaction envelopes. A stamp-only advance pays a rolled-back apply plus one operational apply;
a concurrent public change retries in the command envelope within the original deadline.
Total finite work follows only the changed Collection's distinct subjects
and their occurrences, never unrelated Collections, subjects, member history or partitions.
`collection-publication-growth.test.ts` exercises actual commands, default work-module effects, retained observations,
zero-first/reverse delivery, retries, duplicate occurrences, deletion, finite continuation, native rows/blocks/statements
and three-scale growth. `collection-reads.test.ts` retains the fixed-statement subject-read regression and awaits
actual effect/workflow completion before asserting the new published count. `collection-http.test.ts` uses native
Auth registration/suspension to prove old bearer401, no-session sign-in refusal, anonymous known-ID readability and
current curator discovery. This slice makes no terminal erasure or legacy rollout-completion claim.

### Public Collection discovery source

`collection-discovery-source.ts` exports `publicCollectionDiscoverySource({pool}): CollectionDiscoverySource`
and the local types `CollectionDiscoveryKey`, `CollectionDiscoveryPosition`,
`CollectionDiscoveryIndexableValue`, `CollectionDiscoveryItem`, `CollectionDiscoverySnapshot`,
`CollectionDiscoveryPage` and `CollectionDiscoveryCensus`. Search imports these directly without treating a
Collection as a Subject. Content consumes the resulting Collection variant through Search's eventual union.
No Search registration, index, Home engine or hydration authorization is implemented here.

- `read(partition, ids)` accepts 0..100 full `{route,id}` keys in one partition, deduplicates and sorts `(route,id)`.
  It returns `status:'available'`, a native `stamp:{partition,epoch,position}` and one item per distinct key.
- `page(partition, after, limit)` accepts a full key or null and 1..100; it reads at most that many raw active-public
  keys from `collection_sitemap_public_page`, in `(route,collection_id)` order. Every raw key consumes the bound,
  even without an indexable witness. Decision: full pages continue after the last examined key; short pages end,
  allowing one final empty page at an exact multiple. Rebuilding starts again at null using current native truth.
- Available items are `status:'indexable'` plus `value:{kind:'collection',key,revision,title,description,
  presentationKind,coverMediaId,membershipKind,output}`. Curated output is null. Saved dynamic output is only
  `{route,collectionId,generation}`, verified by the installed `collection-source-output-head.sql` Publication
  witness, its Core commit and current source fence. No rule, personal population, private totals or members cross.
- Hidden/deleted/absent keys return `status:'withdrawn'` with the key alone. Public dynamic rows without a current
  witness return `status:'unavailable',reason:'selected_publication_witness_unavailable'`, also without metadata.
  Built-ins without a saved output witness and de-identified retained dynamics remain unavailable: the installed
  head reader does not supply their needed retained-output discovery witness. Pending B leaves verified A selected.
- Missing/fenced/moved native partitions return `status:'unavailable',reason:'native_partition_unavailable'`;
  page `next` is null in that case and must not be interpreted as successful exhaustion.
- `count(partition)` returns `status:'unavailable',reason:'native_collection_population_evidence_unavailable'`.
  There is no installed maintained native census producer. This performs no scan and certifies neither zero nor
  a query count.

One repeatable-read native transaction supplies the existing public-listing stamp and values; the position is
Core's actual partition position serialized as decimal text, never a timestamp/revision substitute. Work is
bounded by one partition read, one key/page statement and at most 100 installed Publication point probes.
Collection updated/deleted/listing-changed events already carry Collection IDs; use their routable keys to reread
current truth on delivery. Search must apply snapshots by `(epoch,BigInt(position))`, withhold unavailable values,
and never let an older positive overwrite newer withdrawal. There is no transport authority flag/store/clock.
The existing terminal public-output custody and de-identification inventory remains unchanged.

The following **constructed examples** document response shapes for Search and Content; they are not runtime
proof. For a curated public key `K`, a read can return:

```ts
{status:'available', stamp:{partition:2,epoch:1,position:'42'}, items:[
  {key:K,status:'indexable',value:{kind:'collection',key:K,revision:3,title:'Books',description:null,
    presentationKind:null,coverMediaId:null,membershipKind:'curated',output:null}}
]}
```

After withdrawal the current read can return `{status:'available',stamp:{partition:2,epoch:1,position:'43'},
items:[{key:K,status:'withdrawn'}]}`. A public saved dynamic uses the same value shape with
`membershipKind:'dynamic',output:{route:K.route,collectionId:K.id,generation:G}` only after native verification.
No member count accompanies it. Current viewer hydration belongs to the separate Commerce
`readPublicCollectionDiscoverySummaries(dependencies, ids, context)` delivery; no summary placeholder is exposed.
`test/library/collection-discovery-source.test.ts` exercises native product-created curated/saved output,
exclusions, selected A/pending B, replay/rebuild paging, bounds and delayed delivery after withdrawal.

### Collection sitemap candidate discovery

- Touches: one partition-local route/id partial B-tree range, at most `B` active/public candidates, `B <= 4000`; no member or private-state relation and no all-partition enumeration.
- Bound: `O(B)` rows, one statement, `O(log N + B)` blocks independent of private/unlisted/deleted population. This is candidate discovery; the eventual feed separately budgets partitions and live anonymous authority checks.
- Growth check: `test/library/growth-sitemap-discovery.test.ts`: `Collection sitemap discovery cost stays bounded as public and hidden Collections grow`, `[256, 1024, 4096]`, first and continuation pages, no planner pins.

### Collection sitemap page

- Touches: At most four partition-interval partial-index seeks yielding at most `4L` candidates, bounded partition epoch reads and existing anonymous disclosure/gate probes per candidate. No member, subject, progress, copy or private-state population scan.
- Bound: `O(Q + L)` rows and statements and `O((Q + L) log N)` blocks, with `Q <= 4` and `L <= 1000`, independent of the total Collection, member or curator population. Sparse traversal work carries across pages.
- Growth check: `test/library/growth-sitemap.test.ts`: `Collection sitemap page cost stays bounded as Collections and hidden candidates grow`, first and continuation pages with listed, filtered and denied candidates grown separately, including empty partitions and routes. Rows and statements stay constant; blocks stay logarithmic. The shared growth classifier counts catalog probes.

### Private Collection pins

[Library pins](../../../../docs/library-pins.md) owns the wire and preference rules. `pin-routes.ts` mounts
`library_pin.list`, `library_pin.put` and `library_pin.delete` under `personal_library`; scopes are
`library_pin:list` and `library_pin:update`. `pins.ts` uses the native prepared own-account runner and common
Collection point reader. A new target's read is prepared before owner checkout; exact receipts precede fresh
business failures. Existing pins remain reorderable/removable without target permission. No Collection grants,
materialization, owner fact sequence or Everything source version is written.

`library.collection_pins` has one `(route, account_id)` row containing at most 100 UUIDs and a retained list
revision. GET never initializes it and resolves only the returned IDs after releasing the owner snapshot.
The cursor uses the shared codec, owner/limit binding and revision/ordinal position. Work is one bounded owner
record plus O(returned limit) native Collection and Access points and their output bytes; off-page targets and
personal histories are never read. This is a bounded point-read implementation, not a three-scale growth proof.

Retention inventory/handoff: erase the entire `library.collection_pins` row by its exact `(route, account_id)`
primary key during terminal Library account erasure, including an empty retained revision. Unpin has no archive
or restore period: it is preference state. The native owner share fence holds through commit and prevents late
writes. Shared receipt locators are `(partition_no, principal_kind='account', principal_id=account_id,
command_kind IN ('library.pin.put','library.pin.delete'), idempotency_key)` in `core.receipt`; response is only
`{revision}`, but request digests and keys are private evidence. Each effective change emits exactly one
`com.rezics.library.pin.updated.v1` event, `subject=account_id`, `{collectionId}`. Its native exact locator is
`(partition_no, position, event_seq)` in `core.outbox`, recorded by the ordinary command envelope.
These private IDs/evidence follow shared history minimization and delivery custody; this module adds no
participant acknowledgement and does not claim complete account erasure. Built-in pin integration remains
separately required through the common Collection reader and its frozen native suite.

### Owner-selected Collection presentation

Collection lists opt into an ordered preview with `view=FULL&preview=3` and a limit of at most 20.
The default list remains 20 and the ordinary maximum remains 100. Only opted-in entries add
`previewMembers: {subjectId, subject}[]` and `previewStatus: 'ready' | 'pending'`. Occurrence notes and
personal facts are excluded. Repeated occurrences remain editable, but a canonical subject occupies one slot.

`collection-preview.ts` uses one same-home native parent/member prefix statement. Each selected curated
parent receives an equal share of the global 100 raw-key budget, with indexed ordinal seeks. Retained/deleted occurrences consume that same allowance and never
contribute members. Exact-budget prefixes remain pending without an additional raw lookahead. One current
Semantic summary batch accepts at most 100 original IDs and independently checks original and terminal
disclosure and revisions. Collection authorization, revision and source generation are checked before the
prefix and after projection. The native writer generation also fences the batch after projection,
including member retention/purge changes that need not advance the metadata revision. A changed observation returns typed unavailable. Ready means three actual
visible canonical members were found or the addressed native prefix was exhausted; pending returns no partial
members. Dynamic sources and unfinished sparse prefixes remain pending. A three-member preview proves no
dominant Type, whole-Source readiness or complete absence of cover images.

Anonymous previews use the existing current public read eligibility and the actual anonymous Actor. The
direct preview executes no writes, operational transaction or retained preparation, and never substitutes a
curator. Metadata-only list/detail requests do not invoke a preparation producer. Collection list previews remain
read-only for every viewer; only the common Members GET may reserve preparation because it carries the exact
current Source and filter binding.

The exact producer declarations include `id | ordinal`. Native reservation, touch and step admission persist
private episodes and locator-only intents. `readRetainedDefinition` recovers their exact canonical meaning and
immutable accepted release only on the same live, fenced client; it does not establish current Source authority.
Default `library.membersPreparation` work remains explicitly unavailable and produces no ready result or custody
acknowledgment. Retained runtime and ordered-result bodies are installed below; useful prepared consumption and finite sparse-source completion require the full funded Source/physical binding.
Native metadata reservations retain route-leading owner controls, exact-basis live uniqueness and indexed
LRU/idle retirement. `createMembersPreparation` uses Core request admission and current `collection:read`;
duplicate admission neither touches nor enqueues. An explicitly funded History child registers the actual
reservation original and locator-only intent on the same transaction. The returned private transfers retain their
original deadline and Pool and can be consumed only after successful COMMIT; a locator grants no transfer authority.
Runtime admission (`runtime: true`) separately requires the complete C3 parent before first I/O. The native runtime
association, selected apply/completion and bounded cleanup bodies are retained for that integration. Metadata-only
reservation does not install an original association or capture current Source/physical authority.

The default `library.membersPreparation` consumer registers through `SelectedRuntime.registerMembersStep`.
Each selected invocation obtains a fresh executor-issued original with one absolute deadline. Selection commits and
releases its client before Source; apply and reached failure use the producer's held native association and the same
balance/deadline. Committed replay returns its stored outcome without dispatching Source or renewing admission.
Actual SDK workflow/step coordinates are private indexed lookup data, never authority. Members binds those coordinates
to the producer's exact selected native tuple inside apply/failure and retains them on its own header.

The installed Search `members-preparation` work context uses `sourcePrefix`/`evaluate` for id order and
`ordinalPrefix` for curated order. The Source body opens a genuine new operational transaction under the selected
invocation's unchanged deadline; no closed transaction or expired request transfer crosses the handoff. It retains
at most a 4096-byte frontier and advances at most 100 raw keys per step. Later native getters use the actual client's
immutable captured release and Source/Scope metadata. Apply rechecks the current owner, episode, incarnation,
generation and complete observation. A generation repair drains at most 100 results, advances the exact version and
retains a private repair checkpoint until child-first removal finishes; its next step has the native version's
deterministic continuation ID. Every successful continuation is enqueued on the apply transaction.

Prepared-result reads independently require a committed native selected completion with the exact header version,
original digest, restore generation and reserved tuple, then current Source/Scope and disclosure. Missing native
completion is unavailable, never ready empty. Index rows, raw exhaustion and SDK workflow success confer no access.
The retained-result reader is installed for integration. Mounted filtered reads retain the existing direct reader
and its cursor format until the complete C3 parent and prepared/direct dispatch are installed. The page retains
canonical subjects without inventing occurrence IDs, notes or times.
Its session query retries preparing pages only while the same viewer/navigation lifetime remains current.
A failed Members read preserves the authorized Collection shell and original cursor/filter address; recovery is an
explicit read. HTTP 202 alone means preparing, 503 means unavailable, other read failures mean failed, and only a
successful native page means ready. Status recovery cannot run during editing, move/removal work or frozen drafts. Existing
Collection note reading, Dynamic recovery, locale, mutation and uncertain-intent behavior remain in place.

### Members costs and unavailable authority

- Touches: [named local SQL ceilings](members-preparation-cost.ts) cover owner lock/insert, bounded definition and LRU
  reads, native reservation/association, step/header/result/original reads, touch/apply/reset/failure and idle/drain
  operations. Every ceiling names all eight axes. Empty, failed and rolled-back dispatches retain their price;
  repeated attempts add it again. Core/Access, immutable releases and Source/Search work are separate producer costs.
- Bound: existing filtered-list budgets and the stronger 100-raw-key Members bound remain authoritative. Named-field
  composition avoids Accounts/Source tuple-order differences. [Approved C3](members-preparation-contract.md#approved-c3-composition)
  keeps 16 statements for the Members body and separately charges constant History registration (464), receiving/readback
  (429), every transfer, Core/Access, executor controls, retries and cleanup to one finite parent before first I/O.
  Production Source and native authority declarations remain absent; unbound runtime reservations refuse with `whole-members-reservation-cost-unavailable`
  before native creation/registration. Metadata reservations, duplicate and actual-read touch paths remain independent. A complete whole-call
  Source/Library quote is also required for native product acceptance.
- Growth check: the focused reservation/concurrency/rollback, real-default-consumer, stale/terminal and mounted
  recovery cases are authored but unrun. Compiler status establishes no native budget, finite useful page or erasure
  acceptance. The controller owns those deferred checks.

The selected producer now supplies lifetime-safe later selection, apply, reached failure and committed replay.
`MEMBERS_SELECTED_CHILDREN` declares each owned native SQL dispatch by literal text, bound and named cost. Its
complete Source child declaration remains absent: the inner Search receipts do not price the whole released
Source transaction, currentness, owner checks and closure. Therefore `SelectedInvocation.source` refuses with
`selected-runtime-source-declaration-unavailable` before invoking that body; the authentic reached-failure phase
can record the failed episode without advancing its version. No guessed zero, renewed allowance or second payer
replaces that missing operand.

Final completion independently remains refused by the installed producer with
`selected-runtime-final-source-physical-authority-unavailable`. Members preserves that exact operand and never
sets a successful complete header from exhaustion. Required foreign authority must cover the actual current Source,
SDK inventory restoration/retirement and independent physical closure, under the selected original's real funding
and lifetime. Local association and native version progress prove none of those facts. The missing-parent runtime-admission
refusal remains in place even though the selected interface is installed; its local subtotal is not a whole-parent
quote or permission to dispatch the runtime.
Library A5's existing participant probes and drains added results, headers (including bases/frontiers/original
associations and selected lookup coordinates) and owner controls in child-first order. This local inventory is not shared-history minimization,
all-copy absence or a blanket erasure/restore acknowledgement.

`members-preparation-budget.ts` supplies the finite parent accounting seam: Members, History registration,
receiving/readback, Core, Access, Source resolve/verify, executor, retry, rollback and cleanup must all have
disjoint declarations before any child receives its allocation. The same parent refuses a second allocation
for an exact preparation key. Each child retains its own finite balance; group completion records actual
charges and closes every child, including cleanup. Missing declarations and insufficient funding return
typed unavailable. Durable cross-request registration, the released Source declaration and final current
physical Source authority remain required producer dependencies; this seam does not enable the adapters.

Decision: execute the complete Members declaration against the caller's existing C3 parent; a local subtotal
cannot create or authorize that parent, and missing Source declarations keep the producer unavailable.
`runFundedMembersPreparation` validates the owner declarations and transfers every child before invoking
the body. History's registration/readback prices come from its exports, not callback inputs. Its awaited
cleanup uses only the original rollback/cleanup children, also on body failure or expiry, before closing
the group. Failed work remains charged and errors expose the original parent's receipt. Native registration,
Source authority, result production and mounted dispatch remain separate required runtime work.

Decision: mixed reservation batches preserve their exact reused episodes while evicting the least recently read
other live headers; reuse never touches LRU time. Unbound `readWorkDefinition` returns null until Source supplies
its complete native binding, independently of successful reservation and exact step admission.

The existing Collection POST/PATCH accept optional `presentationKind` and `coverMediaId`; PATCH keeps its numeric
revision CAS. Omission preserves a choice, null clears it. `collection-presentation.ts` validates a new exact TypeId
against the active definitions release, without changing members or accepted personal profile pins. Stored choices
survive a later release that lacks that Type; clients apply their explicit rendering fallback. Selection preparation
releases every foreign home before the native Collection command checks current authorization and its receipt.
Business validation failures are deferred to the fresh command body, so an authorized exact replay retains the native
receipt, while current authorization, curator fencing and digest-conflict behavior still apply before replay.

The sole transport composition is `http/kernel.ts` → `collectionRoutes`, which supplies the trusted route key.
Existing imported cover facts come from Content's `checkMediaObject(..., 'cover')`. Authority comes separately from
`decideDownload` with the installed actor/Access, trusted route key/deadline and an actual AVIF/WebP variant. The
original imported subject/container, tuple/source and variant remain authoritative. No Collection container, claim,
upload, grant or retention reservation is created. Every list/detail viewer, including anonymous viewers, receives
only a currently authorized existing `CoverSummary`; the storage key and source URL are never a Collection URL.
The curator with update scope may also receive the configured ID. After foreign waits, reads recheck native
Collection authorization, revision and source generation; a changed source returns unavailable rather than a stale
positive. Metadata GET starts no work and creates no header, grant, receipt or event.

The read seam is `collectionPresentation` plus `collection-reads.ts`'s `present`. `collectionKind` projects stored
metadata directly: an unset choice returns null/`mixed` and every member uses its own Type's hints immediately;
a stored explicit choice returns `owner`, including a Type retired from the current release. Empty and logical
dynamic Collections also return `mixed`. Neither path selects an audience, reads kind observations, prepares Kind
work or checks kind currentness. Collection metadata authorization remains with the native reader; current cover
checks after foreign waits remain independent. The default work module no longer registers the automatic Kind
workflow or its mutation effects.

The former automatic reduction, preparation, admission and evidence modules are retained only where shared native
contracts or retained-data cleanup still reference them. They are not prerequisites for Collection presentation.
Explicit Type/catalogue publication remains independent. Ordered member-cover derivation keeps its existing Source
and disclosure contract. The bounded FULL fact integration at `views.ts`'s `fullMembers` consumes Semantic's admitted
batch through `attachCollectionListFacts`, as described below. Logical dynamic readers share the same presentation
fields without another metadata table or writes on GET.

Retention inventory under the existing Library A5 and Accounts shared-history ownership:

- `library.collection.presentation_kind` and `cover_media_id` are nullable values on the existing routed row. Ordinary
  deletion retains them for the same exact 720-hour episode; restore updates the same row and preserves them. Terminal
  removal of that row removes both values. There is no private backup, new participant or independent cleanup ACK.
- Native `library.collection.create`/`library.collection.update` receipts in `core.receipt.response` contain the returned
  Collection, hence both fields, including cleared nulls. Their exact existing receipt locator and account identity
  belong to Accounts' `command-receipt/v1` custody and Library's account-erasure inventory.
- Existing `com.rezics.library.collection.updated.v1`/listing events contain locators/publication state only; no selected
  Type or cover value is added to outbox data. Existing Collection listing work consumes that event; no new DBOS input,
  workflow output, object-store copy, worker or cache is introduced. This inventory is not universal cleanup proof.

Cost for owner metadata:

- Touches: native current Collection/curator/resource authorization, one active release and immutable Type lookup for a
  new nonnull selection, exact row CAS/receipt/event and the existing keyset list. No membership scan or history walk.
- Bound: fixed point operations per command/read, indexed logarithmic block growth; lists retain their 100-row cap.
- Growth check: `collection-presentation-growth.test.ts` exercises successful/stale/denied/replayed commands and exact
  detail plus genuine first/deep keyset cursors at 64/512/4096 unrelated same-owner/foreign rows and receipts.

Cost for existing owner cover:

- Touches: one configured imported reference and actual native variant/source/subject/Access points, a repeated reference
  fact check and the final native Collection/source check after released foreign anchors. Each selected row on a list
  pays its own current cover checks; rows without a configured cover need none of that work.
- Bound: fixed exact reference/variant costs per selected row; no per-member metadata requests, image bytes, full curated
  scan or worker runtime. Unproved member fallback remains pending and is not a cost waiver for its separate producer.
- Growth check: the same native suite grows unrelated media variants/source tuples/history/grants, captures actual
  statements/plans/rows/blocks/wire bytes across registered pools, and covers current source-hidden/tuple/media loss,
  viewer scope reduction and a real late Collection visibility change. Shared capture rules and allowances are unchanged.

### Selected occurrence removal and transfer

`POST /v1/collections/{collectionId}/members:batchRemove` accepts `{revision,memberIds}` and returns
`{collection,removed:[{memberId,deletionId,revision}]}`. `members:move` accepts the same selection plus
`destinationCollectionId`, `destinationRevision` and required `after` (null means first), returning
`{source,destination,members}`. Both use the existing Collections gate, update scope/grants, closed noncoercing JSON,
Idempotency-Key, owning partition command envelope and existing member-changed events. IDs are distinct routable
occurrence identities, with 1–100 selected occurrences. The previous per-member move remains an intra-Collection reorder.

Removal checks current original and terminal disclosure, including retained addressed rows on replay. It locks the current parent and exact selected live keys, validates the whole selection, and calls the same
retained-deletion statement as single removal. Every episode keeps its own ID, note, added time, original ordinal
and exact 720-hour cutoff. All episodes share the one resulting parent revision; existing exact episode Undo
remains independent of unrelated sibling writes. The parent count, revision and source generation advance once.

Transfer requires two distinct live curated Collections with the same immutable curator and exact route. Mixed
curators/routes return 409; a same-Collection request returns 400. Native `resourceAuthorizationPage` prepares one
immutable two-resource page and applies the actual Access formula before receipt lookup. The live curator share
fence remains held through commit. Current original/terminal subject disclosure is prepared after parent authority,
releasing owning reads before subject-home visits; the transaction checks those exact immutable subject IDs.
Replay rechecks both current parent grants and any selected occurrences now in the destination before returning
stored member data. Destination anchors require the same subject readability.

One transaction locks both parents, compares both supplied revisions, checks destination capacity and all selected
source rows, and transfers the actual rows in source ordinal order. IDs, subject IDs, notes and added times survive.
There is no source deletion episode. Independent previously retained occurrences remain independent. Ordinal gap
exhaustion uses the shared bounded local ordinal planner, defers the existing unique constraint for
that transaction, then window rekeying/transfer and both parent updates commit atomically. An exhausted window instead
admits the separately authorized destination repair and returns `503` with no transfer success receipt. Source survivor order is unchanged.
Each parent advances count/revision/source generation once; destination order epoch advances once when respaced.
Per-occurrence existing events feed the native monotonic listing producer, including duplicate survivors and all
public/private combinations. No public count is written by the command.

Cost: parent and occurrence validation uses exact route/Collection/member point keys, O(selected log N), with at
most 100 selected changes and two parent keys. Subject preparation visits at most 101 distinct originals, in the
existing raw-100 helper pages. Destination placement examines at most 128 resting occurrences and allocates at most 100 selected keys; retained repair follows the bounded order-work contract above.
Retained history is never searched. `collection-batch-growth.test.ts` adds API rollback/privacy/lifecycle coverage
and native 64/512/4096 live/retained/unrelated growth at fixed batches 1 and 100, including fixed full destinations; captures use the existing inclusive
Access, receipt, custody, outbox and listing accounting with unchanged bounds and raw plans/bytes.

### FULL member facts cost

See the [FULL Collection member facts runtime contract](#full-collection-member-facts) for API, authority and
native work-context requirements.

Cost: one <=100 raw-original fact batch plus the bounded shared summary batch, exact identity reads and repeated native
Collection/keyset page. Each member returns <=4 configured properties with <=3 actual values each. Raw IDs, source work,
rows, statements, blocks and bytes remain independent inclusive bounds; no native allowance changes or hydration waiver.
`collection-list-facts.test.ts` supplies native API/persona, configuration, concealment, tuple/identity/source-race and
raw-width cases. `collection-list-facts-growth.test.ts` measures the whole fixed native page and its actual helpers at
64/512/4096 unrelated fact/history populations, including failed and private/source-change work.

### Native identity scope planning and current seals

`createLibraryIdentityNativePlanner` in `module.ts` exposes the default native `advance`, `readPage` and
same-command `verifySeal` ports. The exact key is `{job, sourceIdentity, scope: 'collection-source'}`.
This is an explicitly funded native maintenance entry point; ordinary Source capture does not gain an
unfunded mapping-discovery pass. The admitted saved `IdentityJob` and Library's bounded native
`pageLibraryIdentityEpochChanges` projection transform immutable input-generation originals on the same snapshot.
Ordinary `identityEpochStore.pageChanges` and `readJob` remain unchanged. Ordinary pending mappings never supply a guessed destination. Metadata, raw capture and raw
planning are independent of ordinary Source readiness. Supported placement is a genuine same-home account,
Source and admitted job: curated members, private built-in entry/label/session/copy, and committed active
account-backed explicit output. Private built-in Sources traverse the independent four-family owner ranges, including
excluded originals and unreserved label keys. Public-output, frozen and foreign-home authority stays unavailable.

The native `identity_scope_plan` IS the expected manifest. It retains capture, writer/prearm fences,
source/owner incarnation and OLD head/ready/working references. OLD withdrawal traverses retained derived
references even when the original native fact was removed. The distinct working generation stores structural
canonical references; original values, pins, occurrence IDs/order/notes/duplicates and immutable output are
untouched. Original owner state and its conflicts remain with the existing owner-index writer and
`currentOwnerState`'s highest live `owner_write_seq`; planning creates no timestamp-based winner. Raw work
enrolls deterministic collision-checked OLD, NEW and first-apply operations, plus handoff when retained old
state exists, in the same transaction as derived writes/frontier advancement. Invalidation retains its separate
meaning. Neither this generation nor its seal publishes a ready query, applies receiving work, or acknowledges
ALL-Library/follow work.

Every applicable driver must exhaust before the final locked source/capture/current-job/prearm comparison.
The seal retains the executor-native commit receipt for that exact generation/version/frontier. The page API
uses the effect-key/disposition tuple, limits 1..100 and returns pending for an unfinished or changed plan.
A sealed full page is not caller exhaustion; callers continue until `exhausted` and verify the same current seal
on their genuine Source-home Core client. Zero follows exactly the same complete raw capture/traversal,
committed receipt and current fence path. Native collection/account writer triggers serialize with these
locks: births, rekeys, changes and late writes invalidate prior currentness before commit. Admission input,
claim, prearm bridge/directory, cancellation/release and owner/capture changes also fail current verification.

Plan/effect/seal evidence keeps native custody. Foreign keys retain the raw capture and derived generations;
immutable effects/seals cannot be silently pruned. Native capture retirement checks the indexed plan hold
before deleting any child receipt. Missing real control handoff stays a retained Source in the existing terminal
inventory/minimizer, never `nativeNoData` or erasure success. The native implementation does not release old
physical custody or infer destination erasure.

#### Cost

- Touches: exact route/collection/plan primary keys; one bounded effect or retained OLD range; the existing
  native raw driver and custody SQL; admitted saved job/input-generation pages; native local mapping claims;
  current account/Collection/Core owner, capture and commit receipt; prearm input/group/bridge/directory locks;
  derived references; and the actual command event/native receipt/COMMIT or ROLLBACK. No receiving SQL is
  dispatched by this producer; the receiving owner must price its own reached bodies.
- Bound: `identity-native-planner-statements.ts` lists literal SQL identities and per-operation bounds;
  `libraryIdentityFootprint` in `identity-native-planner-work.ts` recognizes only those exact statements and
  the imported literal framework/job/mapping statements. Every declaration contains `candidateKeys`,
  `nativeRows`, `identityMetadataRows`, `nativePoints`, `witnessKeys`, `statements`, `bytes`, `emptySeeks`.
  A range admits LIMIT plus one indexed EOF slot, not result count. Effects page: `n` candidate keys,
  `n+1` native rows, zero identity metadata, one native point, zero witnesses, one statement,
  SQL+serialized binds+`512n` bytes, one empty seek. The native page projects only the producer's
  `library-native:SHA256(operation)` effect key; malformed retained keys refuse without truncation.
  Locked plan: one native row/point, zero identity metadata, one statement,
  SQL+binds+`LIBRARY_IDENTITY_PLAN_RESULT_BYTES`, one empty seek. That result bound is derived from
  four schema-bounded JSON values, UUID/decimal widths, scope and the four native retained-state fields.
  SQL validates the SHA256 scope digest and retained UUID/<=256-byte basis shape before projecting it;
  invalid state returns a bounded rejection marker. Actual original bind bytes are bounded before dispatch. Current capture: seven joined native
  rows/points, one identity metadata row, one statement, SQL+binds+64 bytes, one empty seek. Current
  admitted job: admission/owner, at most two inputs plus EOF, group/bridge/directory and bounded CTE
  revisits plus the actual claim admit 16 native/identity rows, 13 points, one statement, SQL+binds+2048 bytes, four possible
  empty seeks. Seal receipt: five native rows/points, two identity metadata rows, one statement,
  SQL+binds+256 bytes, one empty seek. Generation insertion charges its Collection FK point;
  insert-plan additionally charges all three possible FK points. Native mutations reserve an indexed
  miss slot too, including failed foreign-key probes; an empty or failed dispatch never refunds it.
  Known transaction controls have zero rows/points/metadata/candidates/witnesses/seeks but one statement
  and their actual SQL bytes; native checkout charges one point. No witnesses are constructed anywhere.
  Unknown statements remain unknown. Library's native transform reads only closed kind and four
  UUID-or-null fields through `identity-epoch-store-library-transform.sql`: three native rows/points,
  two identity metadata rows, one statement, SQL+binds+256 result bytes, three possible misses. It
  validates the native job/epoch/pending-or-published state and current admission owner before use.
  The input query pays for a third rejection sentinel and refuses more than two generations before
  original seeks. One input reads <=100 originals; two read <=50 each. The minimum full-page cutoff,
  ordering, deduplication, original-generation filter and immutable transform remain intact. No whole
  intent/release/undoJob/verificationReceipt is projected, capped or truncated, and no saved-job size
  query is needed by this Library helper. Its ordinary store counterpart is unaffected. Native metadata
  now reads only partition state/epoch/position, paying its fixed point rather than projecting unused
  node or move addresses. Native metadata,
  raw and custody descendants now execute on the exact supplied ledger, including their own checkouts,
  explicit native statement reservations and terminal controls. Their SQL/projection bounds remain in
  `collection-source-native.ts` and `native-source-custody.ts`, including capture/receipt/retention. Custody reserves point-miss slots even for a positive outer result;
  native Core ownership/publication/proof controls also declare their identity-metadata row.
- Growth check: `test/library/identity-scope-effects.test.ts` supplies focused native outcome cases for all
  six drivers, bounded positive pages, omitted enrollment/rollback, genuine exhaustive zero, late first apply,
  writer/rekey/prearm changes, repeat and failure accounting. These tests are authored, not executed in this
  source delivery. No new growth harness or measured native bound is claimed; integrated native/growth
  acceptance remains required.

The real `NativeCollectionWork` reservation is cumulative. Its original ID, Pool, deadline and command resources
are retained; dispatched misses, SQL failures, repeated calls, rollbacks and settlement cannot refill native rows.
Command cleanup is reserved before BEGIN. Custody holds distinct COMMIT and ROLLBACK slots; a failed COMMIT
still dispatches the separately paid ROLLBACK. `advancePrepaid`,
`advanceLibraryIdentityNativePlanWithWork`, `readLibraryScopeEffectsPageWithWork` and
`nextLibraryIdentityNativePlanWithWork` use the existing live Source Library partition in place. The prepaid page
input omits allowance and retains the source-discriminant generic seal/page union. Library rechecks the exact
owner ledger, Pool, unchanged owner deadline and live callback before dispatch and after awaited work; a copied
ledger, changed deadline or escaped callback cannot become independent funding. Planner metadata/raw/capture
and finish descendants no longer construct a second ledger or transfer a fresh allowance. A historical capture
allowance cannot fund a continuation. Verification resolves the already-live allocation before any SQL, meters
its exact command query surface on that same ledger and performs no checkout or foreign IO. Positive and genuine
sealed-zero verification both retain the native current/receipt/job checks, including a repeated final recheck. Normal Semantic
receiving can recognize the concrete exported `libraryIdentityFootprint` declaration; its strict unknown refusal
must remain until its actual SQL owner adopts the reached bodies. The local 512-row/32-point/16-statement/
262144-byte cap is not additional Source funding. Accounts' selected current original admission/position/control
is local and fully spent. Its installed Library term now resolves, while the complete Source/History term remains absent. The whole authentic parent must reserve the
disjoint Accounts local, all reached Source/History, all reached Library and transfer-control terms before first
IO, preserving original/position/Pool/WorkClient/SDK/registry/deadline and live callback. That complete parent
price remains unknown; this native declaration supplies no guessed zero or replacement foreign producer.

### Members preparation funding

`members-preparation-budget.ts` retains the existing complete parent declaration and child-transfer protocol.
Members, Core, Access, Source, executor controls, retries, rollback and cleanup must all have explicit declarations
before any child receives funding. Missing Source prices remain unavailable. Engine execution still needs its
own owner's declaration; this native composition grants no engine allowance.

Decision: prepay the complete operational History child once and bind its single-use original to the parent's
Pool, WorkClient and absolute deadline; retries and committed transfers share that allocation.

Fund that original from an existing `NativeCollectionWork` allocation with the complete History declaration.
Disjoint cleanup and other children retain their original reservations; no replacement parent is constructed.

The trusted `reserve` option `history` passes that original to Core. Only new native reservations register their
exact canonical bytes and locator-only intent through the positioned History producer, replacing their existing
enqueue in the same transaction. Resolve, verify, receive, replay and retirement transfers activate only after
Core's actual COMMIT. Duplicate admission produces no new registration. Calls without this option retain the
reservation protocol and its existing statement schedule.

This is an integration seam, not a mounted funded worker. It supplies neither current Source observations nor
physical execution authority. Receiving remains pending Source currentness, results remain preparing, and
retirement cannot claim Source completion. Source capture, native completion, result reads and deletion cleanup
must be connected before prepared/direct dispatch is mounted.

`MembersPreparation.readRetainedDefinition` now recovers the exact owner/Collection-bound canonical definition
after same-client native episode admission and immutable-release validation. It supplies data only. Obsolete
episodes return null; valid live episodes still make `readWorkDefinition` unavailable until current Source
binding is implemented. A retained complete flag supplies no authority.

### Retained Kind controls

Collection presentation no longer invokes automatic Kind admission, consent, raw input, Type evidence or
currentness. The former derivation worker and its mutation effects have been removed. Retained native contracts
remain available to their shared callers; they are not release prerequisites for mixed or explicit presentation.
`collection-kind-consent.ts` retains its enrollment, locked adoption, invalidation and receipt checks. Account erasure
still pages existing references through Library's owned graph, cascading original controls, raw intervals and
transition receipts. `collection-kind-work.ts` retains the retirement helpers for exact native custody and bounded
child cleanup. Existing Type/catalogue publication, Members preparation and ordinary authorization remain independent.

### Native foreign listing copies

The default `library/work.ts` Collection/member handlers call `listing.ts:syncSubjectListing`. Its finite positive
foreign-copy entrypoint is `listing-source-observer.ts:admitListingSource` followed by `recoverSubjectListing`;
Commerce's sibling entrypoint is `creator-sales-work.ts:prepareCreatorSaleDelivery` / `recoverCreatorSale`.
The exported `applySubjectListing` compatibility entrypoint re-reads actual native truth and enters that same
factory; it cannot replay an observation as permission. Native projection triggers seek the unique open gate for
the current PostgreSQL transaction and compare the exact immutable payload, so old prepared writers cannot bypass
the migration barrier. Local personal copy create/update/restore remains in its own
account home with `ownAccountPrepared`, current local fence and original copy/profile/session semantics.

The Collection adapter reads current native multiplicity/public history, curator, actual Collection revision and
transaction/write basis, and original native outbox role basis in one owning operational transaction. Collection
IDs are never cast to account IDs. It stages the separate [Access live-copy transition](../access/README.md#native-live-business-copies)
and local-role holds, then releases the Collection home before visiting any other role or Subject home. Exact
original commit position/epoch orders the immutable positive effect; fresh same-home business generation/truth is
rechecked after all admissions and released again. The Subject transaction acquires the exact native receiver gate
and commits the original listing CAS/count/event body, every personal-role inverse and terminal result atomically.
Equal/stale deliveries cannot repeat public count deltas. Ordering-only work stays operational; real public change
retains `subject.listed`. Negative work creates no transition, gate payload, missing pair or missing version.
An existing nonterminal version advances only its monotone same-source zero cut; a never-public zero with no
retained receiver identity performs bounded negative seeks without an inserted identity. Genuine terminal curator cleanup deletes only already retained identities up to its native
source cut, with the original public count/event envelope; it never creates a new zero marker after T. Original
source-fence and equal-stamp conflict semantics remain intact.
The gate supplies terminal exclusion, not Source visibility/currentness permission.

Accounts' default recovery finds maintained native pending transitions, including a dead enqueuer and a crash after
receiving commit. Apply and first cancel arbitrate the same key; only the authentic committed result releases holds.
A cancelled effect cannot become positive on replay, including after account T. The migration's separate fixed-home
old-pair/version frontier reenrolls one actual existing identity per step through two raw1 primary-key seeks through this same adapter, with unknown old evidence
remaining incomplete. New writers enroll independently of the frontier. Restore activation, byte/role ceilings and
exact statement/guard bounds are owned by Access's native contract; unsupported lineage remains fenced, while a
fresh migration-admitted default path performs real positive copies. Source/native/physical/privacy/main acceptance
has not been established by source presence or typing.

### Identity retirement dependency retained

This live-business protocol does not implement `identity-scope-effects.ts`. Its actual `readLibraryScopeEffectsPage`
currently returns unavailable and `verifyLibraryScopeEffectsSeal` returns false: that is pending, never an empty
successful page, replacement receiving receipt, effect seal or discharged Source. The original owner must first
complete supported custody reconciliation and receive a separate admitted continuation. Its unchanged obligation
is the actual native admitted original job/source/scope, exhaustive six-driver expected effects and a current seal;
verification must use the SAME Source home with no foreign IO, with actual receiving/custody placement and every
intermediate-page and final sealed-zero verification plus durable writer/replay/restore fences.

The positive retirement chain still requires the installed original SDK/Work same-configured-pool writer locks
through Source commit, original durable Source custody/terminal transfer and current source/writer/restore fences,
actual receiving commit/copy guards, current Account reversal settlement and every repeated same-home native
verification, exhaustive Library pages/current same-home seal, then History recording and independent final
maintenance/root/all-copy closure. Existing adapters and receiving bodies cover their own branches only. Missing
Library effects/seal, historical SDK recording/coverage, original Source terminal-transfer or external restore
proof retain their own exact pending branch; neither this transition nor provisional helper types discharge them.

The original Library owner still owes final exact page/verifier/nested-current-plan SQL, native receiving/fence
placement and per-axis rows/points/statements/bytes/engine bounds, including failed dispatches, repeated native
verification and its local ledger interaction. The held Semantic consumer may reconcile its exact footprint/final
SAME frame only after that original producer and its required live Source continuation are actually integrated.
That Source continuation is stopped with a paid interface/cost body awaiting Accounts review; it is not an
installed dependency. Accounts' complete positive History preflight waits for those actual bodies. The interrupted
Library producer and Members remain stopped under operations recovery, without a supported custody reconciliation
release or product retry authority. Semantic's stopped Source producer and held consumer are unchanged.
The old History aggregate funds only its documented body; directory envelope,
all child caps and verification remain independent. No new aggregate total, funding or runtime pass follows from a
local ledger, ACK or this live-copy result. Foreign SDK/History/Source retirement is not implemented here.

### Cost: foreign listing copy and negative cleanup

- Touches: one exact Collection/truth/write-basis/outbox-role source and released native role homes, then the
  exact Subject pair/version and listing aggregate through the live-copy gate. Local personal copies retain
  their existing local transaction. Negative cleanup seeks only the retained pair/version and aggregate;
  terminal cleanup may delete those identities, while nonterminal cleanup updates an existing exclusion cut.
- Bound: original live occurrences <=5,000; original events <=100 with 101 lookahead and <=65 original roles
  per event before the final <=64-account distinct roster refusal. Key/payload/roster bounds are 1/8/8 KiB.
  Source and Subject acquisition never overlap. All eight axes (`candidateKeys`, `identityMetadataRows`,
  `nativeRows`, `nativePoints`, `witnessKeys`, `statements`, `bytes`, `emptySeeks`) include the actual source,
  role holds, guard/inventory children and original command/event costs described in Access. Negative seeks,
  equal/stale results, failed admission and operational rollback followed by a public-change command are charged,
  including repeated/refused dispatch. No fully spent local Accounts admission or Semantic/History allowance
  funds those children; the complete composed native total remains unknown until actual child terms arrive.
- Growth check: `test/access/live-copy.test.ts` authors the actual foreign positive, immutable guard, repeated
  negative/no-new-payload and deletion/recovery outcomes. Existing listing and History acceptance remains intact;
  execution and measured physical/failure/repeat/rollback work are deferred to controller integration.

### Members reservation expiry frontier

The reservation/result schema and native reservation bodies already exist. `members_preparation_expiry` adds a
route-leading live-header frontier ordered by idle read time; maintenance can retire a bounded page without
scanning owners or retained results. No second reservation schema or allocation API is introduced.

Decision: preserve the native reservation and shared child-transfer allocator; extend its complete declarations
with own-property validation and pre-funded rollback/cleanup after expiry, keeping Source authority independent.

The budget tests retain existing admission, concurrency, completion, failure and expiry assertions and add
inherited-declaration refusal and terminal-control settlement after expiry. Numerical accounting does not prove
native Source currentness. The producer, current physical Source binding, prepared readback and cleanup remain
required before the funded journey can return useful results.
`identity-original-work.ts` exports strict owner-literal component declarations and
`assembleLibraryIdentityOriginalComponents`. Each component contains all eight axes and zero engine requests;
composition rejects foreign components, nonintegral/unbounded multiplicities and overflow. Literal bytes include
SQL and original serialized binds; dynamically admitted result projections remain required operands for unrestricted planning. Checkout
is exactly one native point and zero on the other seven axes. Component assembly grants no funding. The installed selected Library data declaration is derived from the guarded
composition below. `collection-source-work.ts` re-exports this additive declaration region.

`assembleLibraryIdentitySelectedBodies()` composes the actual native selected body components using the
adopted Source schedule `discovery=0, plannerSteps=0, effectPages=1, currentVerifications=1,
exhaustedPageRechecks=1, finalFences=0`, with page LIMIT1. There is one locked plan/current capture/admitted
job/seal path inside the page and two more in receiving verification, including genuine sealed zero. Every
path includes all seven current-basis statements for the possible active explicit-output branch: partition,
account, Collection, committed publication, two native fences, capture and current receipt. Native capture
cursor projection bytes include maximum JSON escaping of the schema's <=512-byte after key and <=64-byte
tie. Each current-basis statement prices its actual closed projection. Shared queries use the genuine transaction's deadline/query
surface and perform no checkout. Independent custody retains its own bounded timeout.

The composed Library SQL term has candidateKeys=1, nativeRows=785, identityMetadataRows=66,
nativePoints=127, witnessKeys=0, statements=34 and emptySeeks=70. Bytes are the sum of the literal SQL,
owner-derived maximum original serialized binds and each bounded native projection; the callable assembly
returns the exact value. No configured allowance or population estimate enters this derivation. Core controls
are returned separately by reference to the installed `COMMAND_DISPATCH_ALLOWANCE`, with total
`0/2/0/1/0/8/169/1` and zero engine requests; they are not included in this Library SQL term. Core's enforced
`single-no-effect` profile prevents the unbounded ordinary partition error read from being reached. Its
same-client, already-spent cleanup survives failed COMMIT/revocation and must remain disjoint. Ordinary
Library command instrumentation cannot substitute for the authentic Accounts/Core owner adapter.

The installed `withPrepaidIdentitySourceConsumerMaintenance(deps, parent, body)` authenticates the actual
Accounts private grant and constrains its exact Library object. Source's irreversible before-IO schedule is bound
to that original and selected History position; Library consumes each already-spent Source operation claim once.
`LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS` is empty. Changing page limit1, using the independent page API,
discovery or planner steps on that selected frame refuses before IO. A later original is required for pending or
unbuilt plans. Failure, rollback, callback reentry and restart cannot reopen a claim.

`IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION` is an own frozen data export with exactly `{work,
engineRequests: 0}`. Its eight-axis work is the selected Library SQL term above. Static selected pricing imports
only literals/schema-derived bounds; the executable planner and native custody use those same declarations.
This avoids making installed data depend on the initialization order of executable owner modules. The unrestricted
ordinary discovery/planner diagnostics remain separate; their full job/error projections and future workflow
invocations are excluded from this selected declaration.

The selected page's real command uses Source's genuine private adapter to Core `single-no-effect`. Library
observes only the transaction's body SQL. Core controls are charged atomically to the disjoint Source partition,
including its separately held failed-COMMIT rollback. A delegated body observer never becomes checkout custody
that could invalidate the later Core fence/COMMIT. Exact literal recognition remains installed for the page,
verifier and manually reserved native basis statements; unfamiliar SQL refuses before dispatch.

Exhausted Source receiving uses the delivered `single-source-fence` executor through its genuine original adapter.
Both Library verifications stay in the same genuine Source-home command, including sealed zero. Source native
summary/receipt/conflict/component/obligation statements debit Source with their actual binds and closed
projections before IO. The genuine progress event remains intact. This preserves the disjoint Library price;
Source's event, command controls, receiving SQL and cleanup are not smuggled into it. Preparation/checkpoint/finish
with other associations and positive receiving-selection native hold declarations remain separately owned gaps.
The complete `IDENTITY_HISTORY_ORIGINAL_SOURCE_DECLARATION` is absent, so Accounts still refuses whole-parent
child admission. Neither a bounded Library declaration nor an EOF establishes physical retirement closure.

- Touches: the installed Source/History private receiver, before-IO one-shot scheduler, same Library ledger,
  native page/current basis, and genuine Core command profiles. Independent Library planning APIs retain their
  ordinary contracts.
- Bound: selected schedule `0/0/1/1/1/0`, page limit1, three inclusive native current paths, and the exact 34-statement
  Library component sum. Source controls/body terms remain independently reserved; no second ledger or allowance.
- Growth check: authored selected-original positive/zero page/current cases and strict literal/data/observer
  accounting cases. Native/full/growth acceptance remains UNRUN; compiler typing is not private grant or native proof.

`test/library/identity-original-work.test.ts` verifies that the installed selected declaration is present as frozen
own data with the exact eight-axis Library term, while the unrestricted declaration still reports its genuine
missing invocation schedule and projection operands. Selected admission's receiving operands are delivered and its
missing list is empty. This bounded Library term does not make the whole Source/History original available: the
Source declaration, binding-consumer coverage and positive receiving-hold operands remain absent, so authentic
transfer continues to refuse before I/O.

The additional focused `test/library/identity-original-work.test.ts` cases cover strict literal/component assembly,
cumulative repeat/terminal prices and live owner/Pool/deadline/copy/escape refusal before IO, selected
three-path component arithmetic, serialized bind refusal, fixed-width transform/cutoff and malformed/third-input
refusal. The pure projection fixtures do not claim private admission or native snapshot/owner proof. These cases and the
retained native positive/zero/driver/rollback outcomes are UNRUN in this source delivery; typing is not native
private-grant, physical closure or whole-original acceptance evidence.

### Funded Members request admission

`members-preparation-request.ts` connects one exact definition to native reservation and positioned History
registration. `declareMembersPreparationRequest` uses History's complete released three-attempt original once;
all other owner declarations remain explicit. `runMembersPreparationRequest` transfers that whole declaration
from the existing request parent before checkout, commits the native reservation, then invokes the Source
callback with disjoint held children. Duplicate requests reuse the live episode without a new intent or original.
The callback and terminal cleanup settle before unused capacity returns; failed dispatched work stays charged.
The native journey covers missing declarations, insufficient funding, actual COMMIT visibility, duplicate admission
and failure after reservation. Its finite test declarations do not release production Source prices.

Decision: group native History registration, transfers and retries in its existing complete original; keep all
non-History owner prices explicit and retain the request's original payer and deadline.

This is the request composition seam. The default Members reader and selected-runtime worker still require
current Source/physical binding, bounded execution, final publication and prepared-page readback before they can
return a useful retained page. The callback, locator and allocation declaration confer none of those authorities.

Decision: preserve native metadata reservation and immutable-definition recovery; only explicit runtime admission requires the complete C3 parent, and list previews remain read-only.

## Canonical episode completion

[Canonical episode progress](../../../../docs/library-episode-progress.md) owns the exact native checklist contract,
limits, lifecycle and Web integration. Decision: canonical episode completions are a separate per-session fact set,
independent of scalar/manual progress; exact canonical IDs and direct `schema:isPartOf` membership admit additions,
while correction and clear survive catalogue removal. `episode-progress.ts` and `episode-source.ts` mount through
`progress-routes.ts`. They use persisted Semantic Subjects, current selected/disclosed relationships and released
profiles; the Semantic producer interface is requested and the current adapter uses `readSubject`.

`progress_episode` retains only owner-session/episode identity and completion time; `episode_completed_count` is
an internal bounded counter, never generic progress or catalogue size. Both stay in the owner's native session
transaction. Existing scalar, cursor, manual sparse units, generic history and published snapshots retain their
meaning. Canonical IDs are exposed only by the bounded owner reader under current source disclosure. The existing
100-child session erasure page now shares its budget between manual and canonical children, and session deletion
checks both. The focused mounted journey is `test/library/episode-progress.test.ts`.

Canonical episode owner admission follows generic session scope, current-account and terminal fences; catalogue disclosure independently uses native Subject Access, without installing an account ACL.
