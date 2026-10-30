# Search index-copy erasure and late-write custody

## Status and authority

This is the complete Search implementation proposal for the known index-copy erasure boundary.
Cross-owner choices below are **proposed, pending owner adoption**; they amend no foreign contract.
It supplies a bounded design, implementation briefs and frozen future native scenarios.
It supplies **no runtime implementation, public outcome, native pass or Cost certification**.
Missing producers are implementation dependencies, not evidence that the population is empty.

[Deletion](deletion.md#account-erasure) owns terminal erasure and permitted retention.
[Search](../services/kernel/src/search/README.md) owns disposable subject projections and generations.
[Identity publication](../services/kernel/src/semantic/identity-epoch-contract.md) owns structural jobs,
the fixed participant version, native receipt custody and publication.
[Public-filter Source](../services/kernel/src/semantic/public-filter-source-contract.md) owns complete
selected input, source epochs, reductions and native scope truth.
[Consumer](../services/kernel/src/search/public-filter-consumer-contract.md) and
[custody](../services/kernel/src/search/public-filter-custody.md) own retained queried observations.
[Filtered lists](filtered-lists.md#cost) owns page/preparation budgets and current disclosure.
[Kernel bounded steps](../services/kernel/README.md#bounded-job-steps) own durable continuation limits.
Those authorities remain single sources; this document binds their Search implementation boundary.

The existing terminal-erasure SPEC in
[terminal-erasure-outcomes.test.ts](../specs/terminal-erasure-outcomes.test.ts) is a test obligation.
Its Search store inspection and late-ingress cases are not an erasure producer.
A marker disappearing from the active alias cannot satisfy its complete-copy obligation.
The existing Search WorkModule currently starts indexing; it supplies no Search erasure ACK.
The old lifecycle prose describing asynchronous engine deletes does not attest to participant completion.

The selected design uses existing PostgreSQL owner state, OpenSearch and DBOS.
It extends Search's native lineage/attempt and public-filter custody stores with bounded progress/indexes.
It consumes source-owner inventory; it does not copy an owner's SQL, facts or private payload.
It adds neither a second engine nor a parallel ownership/certificate registry.
It uses the existing account tombstone as the permanent terminal authority.
It adds no permanent per-subject tombstone to compensate for engine delete-version pruning.

## Exact callable surface

The following declarations exist. Their presence has the stated limits.

| Declaration                                                                                                     | Reuse and limit                                                                                                      |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `access/erasure.ts:acknowledgeErasure`                                                                          | Separate platform command after the final purge commits; immutable `erased` or `none`, optional typed retention.     |
| `recordLateErasureItem`, `resolveLateErasureItem`                                                               | Account-home late-copy obligation and later resolution; recording requires a live command holding the locator fence. |
| `advanceErasureCompletion`, `readErasureStatus`                                                                 | Accounts' independent global completion and diagnostic read; Search must not replace them.                           |
| `ERASURE_PARTICIPANTS`, `ERASURE_LOCATOR_EFFECTS`                                                               | Version 1 already includes `search`; locator effects must be registered in the existing set.                         |
| `access/erasure-progress.ts:discoverErasurePage`                                                                | Access allowlisted scalar-role discovery only; it is not a generic Search/semantic inventory port.                   |
| `search/work.ts:searchWorkModule`                                                                               | Existing default Search service registration; erasure registration belongs here even when indexing is disabled.      |
| `runner.ts:startSearchIndexing`, `subjectConsumer`                                                              | Actual per-generation relays and lifecycle drain; process-local pause is not a durable global fence.                 |
| `indexer.ts:createSubjectIndexer`                                                                               | Actual 256-ID chunk pipeline; `aroundApply` invokes apply exactly once but does not persist custody.                 |
| `document.ts:documentActions`, `bulkLines`                                                                      | Complete source-derived replacement/delete actions and safe external versions; no account discovery.                 |
| `write-actions.ts:writeIndexActions`                                                                            | Positional keyed bulk validation and conflict refresh; a conflict is not an erasure/identity winner proof.           |
| `indices.ts:subjectIndexName`, `subjectAlias`, `subjectGenerations`                                             | Native bounded namespace spelling/metadata; names and generation numbers are not UUID identity.                      |
| `generations.ts:rebuildSubjects`                                                                                | Existing replay/reconcile/activation path; counts alone cannot close copy coverage.                                  |
| `coverage-store.ts:createCoverageStore`                                                                         | Native prefix allocation, lineage CAS and one current attempt per home/incarnation.                                  |
| `coverage.ts:createSubjectProjectionCoordinator`                                                                | Actual declaration; population/certification are unavailable on this base, not callable successful producers.        |
| `initializeSubjectIncarnation`, `activateSubjectIncarnation`, `retireSubjectIncarnation`, `readSubjectCoverage` | Existing unavailable lifecycle declarations to implement, rather than invent competing lifecycle exports.            |
| `public-filter-custody.ts:createPublicFilterCustody`, `readPublicFilterConsumerCustody`                         | Actual retained registration/observation/execution/reference producer and keyed read.                                |
| `semantic/identity-epoch-store.ts:identityEpochStore`                                                           | Actual STORE; use its `pageChanges`, `admitHomeEffect`, `reconcileStepReceipt` and `publish` contracts.              |
| `semantic/identity-epoch-contract.ts:IdentityEpochStep`                                                         | Existing participant ABI `(pool, {jobId, epoch}) -> IdentityStepProgress`.                                           |
| `command/operational.ts:runOperationalTransaction`, `enqueueIntent`                                             | Actual event-free fenced operational transaction and atomic durable enqueue; not `noEffect` with hidden writes.      |

`semantic/search-source.ts:subjectSource` and `library/listing-counts.ts:subjectListingSource`
are the actual ordinary source composition. `SubjectSource.read/count` is not all-role account inventory.
`PublicFilterSource` is a type contract; its selected `publicFilterSource` and
`recordPrivacyReduction` producer module remains missing.
`public-filter-consumer.ts:createPublicFilterConsumerOperations` is likewise selected but missing.
Do not import a test helper as either producer.

Names introduced in this proposal are **proposed names, not current exports**:

- `search/erasure.ts:stepSearchErasure` and `searchErasureEffect` for obligation-driven Search work.
- `search/identity-participant.ts:stepSearchCanonicalIndex` for the existing fixed identity participant.
- `search/copy-custody.ts:stepSearchCopyCustody` for internal bounded enumeration/drain work.
- `search/write-custody.ts:withSearchWriteCustody` for the shared actual writer enrollment.

These names are implementation destinations, not executable ports or alternate participant ABIs.
Source-owner inventory has **no proposed callable spelling** here: the owner must adopt and deliver its
native input/receipt layout. The required semantics below are complete without guessing that export.
Search consumes the delivered declarations directly and records the final binding in its README.

## Identity and copy model

An erasure job is anchored by the committed `access.erasure` account, version and T.
Its stable workflow ID identifies that obligation; replay does not create another erasure generation.
Workflow arguments carry only account/obligation locators within the existing 4096-byte JSON limit.
A payload marker, bearer, name, full owner vector or prepared row array is never a workflow argument.

A physical index identity is the complete existing `IndexIncarnation`:
`{prefix,generation,index,uuid,protocol,consumer}`.
Keep the native lineage revision and actual current home/ownership epoch beside every use.
The UUID is read from native settings, never generated locally or inferred from a name.
Consumer/projection generations and accepted meaning/read-definition further identify public-filter copies.
An observation additionally binds its own immutable PIT or prepared build/generation and covered cut.
An execution binds its own start and actual original/terminal row set, even for zero returned rows.

A source locator binds all of:

- Deleted account and native role, artifact type and actual source raw key.
- Original subject, previous terminal and current terminal when the copied effect changes identity.
- Native source home, ownership epoch, source partition position and current identity epoch/job if pending.
- Accepted release/meaning, exact candidate/slot/tuple or aggregate dependency where applicable.
- Actual source minimization/replacement receipt and receiving-owner custody reference.

A repair effect binds that source locator to an exact physical UUID and copy class.
The retained effect manifest names old removal, new addition/replacement and reference withdrawal separately.
A missing half is unfinished work; an endpoint vector is not an effect manifest.
Source facts and public bodies remain in their native owners/index, not in this manifest.

Source partition positions and identity epochs are different domains.
A foreign reduction position never becomes the external version of an unrelated subject home.
Obtain an actual own-home source advancement for a foreign dependency's replacement.
Accept an external version only in `1..9007199254740991`, preserving bigint until serialization.
The source observation must cover the captured envelope obligation and current home ownership epoch.
A native bigint beyond the safe external range remains unavailable; do not clamp, wrap or reserve MAX_SAFE_INTEGER.
A new target does not repair an invalid source version by assigning an invented version.

`PENDING`, `ERASED` and `NONE` below describe Search's durable decision, not a new Access wire enum.
The existing coordinator still stores lowercase `pending`, `erased` and `none`.
Search persists `everApplied` before removing a discovered copy; retry cannot change it back to false.
A source-owner inventory that proves an applicable historical copy sets it even if the engine copy is absent now.
`NONE` requires sealed complete source-role AND copy-population coverage with no applicable copy ever applied.
Unknown applicability, unregistered deployment, incomplete first apply or uncertain dispatch stays `PENDING`.
`ERASED` requires every applicable copy minimized/removed and every relevant late writer closed.
Eligible de-identified public contribution text can remain; private payload and identifying attribution cannot.
The source owner decides that disposition; Search neither erases a survivor's unrelated work nor restores old text.

## Complete population and native custody

### Deployment enrollment

Enrollment is a native lifecycle obligation before Search can attest to erasure absence.
Use `search.index_prefix_control` and `search.index_incarnation` as the authoritative Search lifecycle ledger.
Use the existing public-filter registration, observation, execution, reference, PIT and prepared relations.
Add access paths and state to these stores rather than an independent deployment registry.

Under a durable prefix admission barrier, reconcile native `subjects*` resolution with retained lineage.
At most three physical incarnations are retained per prefix, including quarantined/retiring copies.
Read exact settings for each native name and bind its UUID; compare the lineage revision again on commit.
Include active, rebuilding, paused, alias-free and retained old generations.
An empty alias is not a complete empty namespace; a missing lineage row is not created-empty provenance.
Closed/frozen/data-stream/foreign or oversized namespace observations remain unavailable under current admission.
Never skip a malformed member to manufacture the at-most-three result.

A deployed but unregistered incarnation is quarantined and cannot publish an ACK.
Adopt it only through the existing complete native audit/replay lineage protocol, or retire it completely.
A known unknown population may be destroyed through exact whole-index retirement; it cannot be certified by count.
For a pre-enrollment deployment, close old writer/capture admission before choosing audit or destruction.
Old writer versions must be rejected at their actual native write boundary, including CLI/rebuild writers.
An installation flag or fresh database row alone proves neither the engine population nor old-client drain.

No per-account search scans historical JSON, names, source receipts or engine `_source` to discover ownership.
Source owners supply their indexed role-complete inventory and exact Search invalidation/dependency locators.
Search maintains reverse structural dependencies using the existing Source/custody registration work.
Do not duplicate Semantic's membership/mapping store or maintain a private-fact SQL mirror.
A preexisting population without that producer closure is unknown until its native cutover/replay finishes.

### Retained copies

Enumerate observation rows by registered physical incarnation and stable observation key.
Enumerate executions, references and PIT variants by their existing observation-leading native keys.
Enumerate prepared builds by registration/build/generation, including retained prior generations.
Add a registration-to-observation index and a physical-UUID-to-registration index with native scalar columns.
Do not discover UUID/source/role membership by decoding every registration's serialized consumer/definition.
Use incremental migration/backfill under the same enrollment barrier for existing encoded rows.

PITs are whole-index snapshots: returned-row sets cannot prove an excluded subject is absent from a PIT.
For account reduction, conservatively close each older PIT on an affected physical incarnation.
An index receiving that reduction is affected even if its current eligible hit set is empty.
After the source cut is repaired and refresh-visible, a new observation may be captured under a new locator.
Old observations never acquire the new cut merely because the live target is repaired.

Prepared copies include `public_filter_prepared.rows`, observation `prepared_rows`, execution `ownRows`,
retained definitions containing user-provided literals and any actual prepared payload store owned by the producer.
The current custody tables can duplicate row vectors; charge and erase every physical copy.
A registration or build is not enough to find personal literals: producers record typed account/source roles
with the actual copy, using owner inventory or exact native locators.
No name matching or speculative deletion of another person's query is allowed.
A reusable public definition survives only when its copied fields are nonpersonal under the source disposition.

Closing an observation installs its existing durable close barrier and drains active references.
Its at-most-five-minute lease deadline closes admission, not proof that every external request has finished.
Renewal CAS losers and winners both retain their native PIT locators until release.
Do not drop a losing locator because it was never returned to the caller.
Delete children before parents and verify indexed absence under the same registration/observation lock.
Current `closeObservation` releases engine references but does not constitute payload-row reclamation.
Add the latter as bounded native cleanup, preserving only necessary nonpersonal completion state.

A native PIT open/renew response can be lost before its locator is saved.
Extend existing observation custody with a committed dispatch intent before issuing that I/O.
An intent is not a fabricated PIT locator; unresolved intent means unknown retained native copy.
Resolve a known locator by actual close/loss evidence; never turn a timeout into successful close.
For an unknown locator, select complete retirement of its exact physical UUID, including native context teardown.
Do not call global `DELETE .../_all` or list every tenant's PITs as account cleanup.
The retired UUID cannot be reopened or adopted under its old coverage.
If native context teardown cannot be established, retain the obligation as pending.

### Concurrent enrollment and finite closure

Registration/capture and close share the native lifecycle lock/revision.
A copy born before the seal enters the sealed manifest or durable dirty work before the frontier advances.
A copy born after the seal must use the current repaired cut and current source epoch, or reject.
No source command can commit a copy-producing intent without durable receiving/delivery custody.
A source commit whose first positive projection has not occurred is part of that custody.

Page each finite source-role and copy set by raw native key, recording a bounded frontier.
At EOF, compare the captured dirty head, installation version and current source/copy revisions.
EOF for an older saved head is not closure for a newer head.
Revisit dirty work only; never reset to page one after unrelated source activity.
Native receiving receipts and aggregate closure summaries are updated from exact committed pages.
A summary counter cannot substitute for the underlying per-page custody invariant.

## Late-write rule

Every writer enrolls before the first source read, normalization request or mutating engine request.
Use the existing one-current-attempt-per-home/incarnation CoverageStore slot, retaining exact batch bounds.
Extend that slot with source/identity basis, lifecycle revision, dispatch state and effect receipt references.
One attempt may have bounded in-unit progress; it cannot overwrite an unresolved prior slot.
No append-only attempt log or permanent per-deleted-subject sink tombstone is selected.

Enrollment and account/source/identity barrier installation serialize in the relevant native home.
For an engine effect, PostgreSQL commits enrollment then releases its connection before I/O.
Erasure/identity closure waits for the enrolled effect's actual resolution; it cannot race past the gap.
No transaction or row lock is held across an engine request.
A later source or identity change either dirties this exact effect or blocks its closure.
The writer rechecks its saved basis before dispatch and again before settling visible progress.
These checks plus retained enrollment supply custody; the checks alone are not an atomic engine fence.

A process delayed after enrollment remains outstanding even if it has never sent its first bulk.
If it commits first, its copied data and OLD/NEW dependencies belong to the retained work.
If barrier installation wins, stale enrollment/apply is refused and retries from current source/mapping/account.
If old I/O may already have been sent, do not label it aborted or simply reread a newer source body.
It remains ambiguous until a real terminal receipt resolves it or the physical target is retired.

Ordinary bulk success settles only exact operation/id/index/version/shard receipts.
A keyed native version-conflict plus refresh proves ordinary visibility under the existing writer contract.
It does not prove the winner contains the required erasure or canonical state.
The stronger effect receipt must bind actual current source basis and the known winning action/custody.
If a competing effect is unowned or its body/basis cannot be established, quarantine instead of inferring success.
Wrong UUID, wrong item, partial shards, source epoch movement and lost receipts block closure.
A checkpoint CAS loss records the actual loss; it never rewinds a competing checkpoint.
Visible effects can survive that loss and must remain in the next attempt's custody.

Safe no-write settlement uses the existing `settleNoWrite` contract:
`aborted` requires positive proof no mutating request started;
`skipped` requires zero selected actions plus actual checkpoint `advanced|lost|stopped`.
Neither is deletion evidence or permission to promote unknown population.
After a crash, dispatch state that cannot prove no send becomes ambiguous.

Native delete versions expire; external-version ordering alone is insufficient after pruning.
Closure therefore drains every older enrolled write, including first apply and deferred normalization,
and makes every new enrollment read current terminal/source/account truth.
No delayed old body is allowed to enter a completed generation after the delete-version window.
If drain cannot establish this, quarantine and retire that UUID without reopening it.
Use a never-issued generation for replacement; the existing prefix allocation fence prevents name reuse.
Replacement population is a separately charged full replay, never a zero-cost per-account repair.

For retirement use native add-write-block, not a settings acknowledgment standing in for shard drain.
Persist intent, validate complete native block receipts, then delete and observe exact native absence.
Native block completion drains already admitted engine writes; later writes remain blocked.
A lost block response needs actual bounded native resolution or a fresh verified block operation.
A lost delete response is resolved by native absence with retained lifecycle intent and unchanged nonreuse fence.
Do not automatically retry a name-addressed destructive write across a UUID change.

Same-name/new-UUID recreation invalidates every former registration, observation and closure candidate.
The replacement is unknown and quarantined; it inherits no coverage, erasure status or privacy ACK.
The allocator must never adopt a generation at or below its issued fence as a fresh target.
Disable native auto-create for controlled subject targets through the already required node policy.
Only the existing lifecycle creator may explicitly allocate a fresh higher name.
If an out-of-band creator recreates a retired name, admission remains closed and that new copy is inventoried.
Old requests aimed at it cannot contaminate an admitted target because that name is never served again.
Unknown external writers/deployments remain a custody finding, never an assumed cooperating participant.

## Nine operation budgets

Each Cost below is an inclusive implementation obligation, not a new allowance or a measured pass.
`u` counts raw selected inputs, rejects, duplicates, lookahead and rereads.
`m` is the actual native fixed metadata work; `k` is the actual work per elementary payload unit.
For a kernel durable page, select at most `floor((100-m)/k)` units after proving `m+k <= 100`.
Otherwise split metadata/custody phases before payload work; never spin on an indivisible oversized unit.
All commands include their real executor, authorization/fence, receipt/outbox or operational enqueue work.
Actual Core operational execution has its own framework cost; it is not a command with free body writes.
No page-fit formula asserts an uncaptured `m`, statement count or native physical plan.

### 1. Seal obligation and receive source inventory

Resolve the committed account-home obligation, seal Search's locator admission and receive owner page custody.

#### Cost

- Touches: one obligation, one Search progress/fence row, exact owner role-page receipt and its indexed source locators; source payload remains in the owner.
- Bound: account-home step, at most 100 raw rows, 5000 ms or shorter caller deadline, frontier at most 8 scalars/2048 bytes and workflow input/result at most 4096 bytes each. The actual Access discovery helper separately uses at most 8 statements, 101 selected keys including lookahead, 100 returned keys/64 KiB and 1 KiB per locator; it is not callable for Search roles. Search uses the stricter 100-raw-row kernel step including lookahead/metadata, with real command cost additive and no borrowed 64-KiB workflow allowance.
- Growth check: unrelated source/role/history populations 500, 4000, 32000; fixed account records then 64, 512, 4096 applicable locators; capture native examined rows, removed rows, blocks, statements, returned/request bytes, fence and receiving receipts on first/deep/empty/replayed pages.

### 2. Reconcile deployed physical incarnations

Reconcile the owned namespace, allocation fence and all retained native lifecycle states under sealed admission.

#### Cost

- Touches: existing prefix control, at most three native physical indices, their settings/mapping identities and lineage rows, plus bounded deployment-cut progress.
- Bound: existing discovery costs one resolve plus at most one active mapping request; UUID binding adds one exact settings observation for each of at most three physical names, charged to maintenance rather than a public-page allowance. No subject scan or SQL population count. Per native home command the 100-row/5000-ms/2048-byte frontier/4096-byte workflow limits apply. Overflow or foreign namespace is unavailable, not a larger accepted generation cap.
- Growth check: 1, 4, 16 unrelated native indices and 1, 2, 3 retained owned incarnations; record all metadata HTTP requests/bytes, SQL plans, lifecycle revisions, rejected fourth generation and same-name UUID replacement. Empty alias with nonempty physical namespace must stay nonempty.

### 3. Page source originals, terminals and copy effects

Build retained exact OLD/NEW effect work from native owner inventory and identity changes.

#### Cost

- Touches: owner source-role indexes, native identity `pageChanges`, structural reverse dependencies and Search per-copy work; no owner-body SQL mirror or engine population scan.
- Bound: `pageChanges` has at most 100 raw inputs including overlap/lookahead/retry, not 100 successful originals plus metadata. One-home kernel units fit `m+k*u <= 100`; derived fanout has in-unit keysets. Identity group admission remains at most 4096 originals including terminal. Continuations/workflows keep 8 scalars/2048 bytes and 4096 bytes; no full group vector or universal 256-key allowance.
- Growth check: originals 64, 512, 4096 and raw boundaries 99, 100, 101 with fixed relevant support; independently grow unrelated owner/source/dependency/history rows 500, 4000, 32000. Record actual native input, half-effect, receipt, statement, row/block and byte counters, including rejected/empty inputs.

### 4. Enroll and apply an ordinary writer

Extend the existing projection pipeline without moving checkpoint ownership or changing its ordinary batch units.

#### Cost

- Touches: native one-current-attempt slot, one partition's outbox/source chunks, listing count points, normalized sort keys and exact physical bulk receipts/checkpoint CAS.
- Bound: relay captures at most 64 envelopes, command logs at most 1000 events/envelope, so at most 64000 affected anchors and 250 source calls of at most 256 IDs. At most one listing read and one bulk per nonempty source chunk, at most 2b NDJSON lines and one conflict refresh per chunk. Existing nonempty relay snapshot/CAS is six statements; durable enrollment/settlement are separately charged native calls, not free additions. No document-byte cap exists: fix payload size for population growth and measure bytes separately. Identity/erasure maintenance pages remain at most 100 raw rows even when calling this writer with a smaller chunk.
- Growth check: envelope history 64, 512, 4096 and unrelated subjects 500, 4000, 32000 with fixed chunk payloads; record source/listing/normalization/bulk/refresh calls, parsed bytes, actual SQL rows/blocks/statements, attempt transitions and checkpoint outcomes. Include 256/257 anchors, CAS loss, delayed first dispatch and response loss.

### 5. Repair canonical or erasure effects

Consume one retained native work unit and settle exact source/engine receipts before its local frontier.

#### Cost

- Touches: original and terminal source evidence, same-home identity gate, current account/source fences, exact old/new physical actions and durable effect/frontier receipt.
- Bound: kernel maintenance at most 100 raw rows inclusive, one actual home at a time and no checkout across engine I/O. If the operation also prepares a filtered result, intersect that bound with preparation: at most 1000 inputs, 1000 result writes, one frontier, 8 Access/dependency points per input, `64+16*input` examined rows, six blocks per budgeted row, 16 statements/backend, four engine searches, one connection/backend and 4 MiB response bytes. The 1000-input ceiling never widens the 100-row identity unit. Bulk/refresh requests and bytes are charged independently; the four-search ceiling is not permission for free writes.
- Growth check: support/original sizes 64, 512, 4096; unrelated dependency/receipt/history 500, 4000, 32000. Capture all pools, engine writes/searches/refreshes, OLD/NEW receipts and native plans through first apply, foreign home movement, 409 winner uncertainty and partial cross-home progress.

### 6. Drain and erase retained PIT/prepared copies

Close observation admission, drain references, release every PIT variant and erase copied payload children.

#### Cost

- Touches: existing registration/observation/reference/PIT/execution/prepared native keys, typed copy roles and exact close/drain intent; registration and prepared row-vector duplicates count separately.
- Bound: at most 100 raw rows per one-home kernel step, byte-fit against actual serialized payloads and 4096-byte workflow results, with one retained frontier. A custody keyed joined read is one SQL statement, not one whole erasure step. References expire at the actual request deadline, at most five minutes; waiting is outside a step/connection and is not native completion. Definitions may be 1 MiB, observation locators 64 KiB, covered cuts 4096 bytes, execution/prepared copies 1 MiB each under current schema: do not return them through workflow JSON. Page identifiers and erase payload in place. No new PIT/retention count allowance is introduced.
- Growth check: 1, 8, 64 relevant retained observations/PIT variants/executions plus unrelated custody rows 500, 4000, 32000; record all physical retained bytes/rows, close calls, failed releases, live lease probes and native plans. Test zero-result PITs, renewal CAS losers, prepared duplicate vectors and lost-open intents.

### 7. Quarantine, replace and retire

Resolve genuinely ambiguous external work by closing the contaminated physical incarnation and using existing replay.

#### Cost

- Touches: lineage/attempt barriers, native write-block and whole-index deletion, PIT teardown, bounded home/checkpoint/reference cleanup and fresh native population.
- Bound: at most three retained physical incarnations, including old/quarantined/building copies; each cleanup transaction fits 100 raw rows and existing continuation/deadline limits. Existing retirement's single at-most-4096-checkpoint delete is not a 100-row durable page: retain it only where its owning maintenance bound applies, or implement continued erasure cleanup without raising either bound. Whole-index deletion charges actual roots plus nested Lucene documents and pinned segments, not one unit because one HTTP request was sent. Replacement replay costs the full finite native population across 4096 homes in bounded units; no extra generation or hidden uncharged background build.
- Growth check: native documents 500, 4000, 32000 with fixed per-document facts, then increase facts/pinned segments separately; retain 1, 2, 3 generations. Capture total replay input, engine bytes/operations, physical retained storage, checkpoint SQL plans and failed block/delete/activation observations; verify no fourth copy on retry.

### 8. Reconcile receipts and publish participant completion

Deliver local completion to the existing receiving/control owner before either kind of final publication.

#### Cost

- Touches: exact local completion/half-effect receipts, bounded receiving custody, Search completion skeleton, separate account-home acknowledgement or identity control publication.
- Bound: fixed indexed receipt points and bounded continued manifests, never a full-history poll. Each native home unit remains at most 100 raw rows/5000 ms with 2048-byte frontier and 4096-byte arguments/results. Access ACK allows at most 16 retained exceptions with at most 32 fields each, but Search selects none: `retained: []`. Identity keeps version 1 and the two fixed participants; Search emits no Boolean ACK or third participant. Pay real command/OP/DBOS/receipt work and release local clients before control/account checkout.
- Growth check: completed jobs/receipts/open-late history 500, 4000, 32000 and 1, 8, 64 retained effect units; capture exact transaction ID plus component, rows/blocks/statements, bytes and all lost-reply/replay/publication boundaries. Search complete with Library missing must leave identity pending; Search ACK alone must leave global erasure pending.

### 9. Revalidate public reads and reclaim custody

Use the existing complete observation protocol for disclosure, then retire only references no longer required by consumers.

#### Cost

- Touches: actual retained observation/execution, current Source/Access and original/terminal own rows, scoped privacy start/final, native ref locks and bounded child-first cleanup.
- Bound: direct read `s<=100`, `ell<=32`, `c<=min(600,6s+3)`, at most six engine searches/three rounds, `16+8c` points, `64+16c` examined rows, six blocks/row, responses `16 KiB+4 KiB*c`, requests `64 KiB+1 KiB*c`, at most 12 statements/backend and one connection/backend. Ready reads use `c<=2s+2` and at most two index reads. Composed pages have at most 16 distinct reads/128 total slots, 816 candidates, 6784 points, 14080 rows, 72 statements/backend and 96 engine searches. Privacy start+final together fit two statements and `64+2*(behind homes+changed homes)` rows, not 8192 heads. Custody and mapping ride those same budgets. Reclaim itself uses separate at-most-100-raw-row native units and no page-read allowance.
- Growth check: relevant source support 64, 512, 4096 and unrelated source/custody/history 500, 4000, 32000; include first/deep/sparse/zero-hit/NOT/order and composed 16-read/128-slot pages. Capture inclusive query plus final status, role-tagged coverage SQL, own-row SQL, all engine iterator steps/bytes and reclaim storage. Fixed candidate counts cannot excuse population-linear engine iteration.

## Implementation briefs

The following two briefs are whole native implementations, not runtime stubs or small helper assignments.
Together they close Search participation, physical-copy custody and the shared writer boundary.
They are independently reviewable; overlapping writers are sequenced by file ownership during integration.
Neither requires the unrelated final default/API promotion to land before its native implementation can land.
Final runtime acceptance still needs the actual integrated producers listed below.
No artificial after edge is added merely because a foreign producer is currently missing.
Adopt cross-owner contracts before activation; keep production entry points unavailable until native invariants hold.

### Brief: actual account-erasure participation and all-copy closure

#### Outcome and scope

Implement Search's existing version-1 `search` account-erasure participant.
A deleted account's applicable Search copies are minimized or erased across every retained copy class.
A resumed workflow reaches the same durable decision after native response loss or worker crash.
The participant refuses `none` for unknown deployment/source coverage or historical applicability.
The participant never restores a deleted initiator to obtain cleanup authority.
The source disposition preserves unrelated public contributions and survivors.
Current disclosure and physical cleanup remain separate observable obligations.

Expected implementation surfaces are:
`services/kernel/src/search/erasure.ts`, existing `work.ts`, copy custody and SQL under Search,
Search schema migration/snapshot and native Search tests.
Change `access/erasure.ts` only to register the actual Search locator effect in the existing set.
Do not change its version-1 participants, ACK semantics, completion predicate or frozen tests.
Source inventory producers and their SQL remain in their actual owners.
Additive generated SQL/client declarations follow the owning generator, never handwritten shadows.
No public Search route or erasure status shape is introduced.

#### Native inputs

The effect receives the actual `com.rezics.access.account-tombstoned.v1` envelope.
Validate its account ID and native envelope identity before using it as a wakeup.
Re-read the exact committed `access.erasure` row in the account home.
The row supplies account, recorded participant version and immutable T.
The event carries no completion authority and no list of Search documents.
Refuse a missing obligation or version without `search` membership.
Duplicate event delivery looks up the same native progress and stable workflow ID.

Source-owner inventory must supply role-complete bounded raw-key pages.
Each page identifies its owner, current ownership epoch and frozen inventory/dirty head.
It names exact original/terminal/source/dependency locators and source disposition receipts.
It supplies receiving custody for source commits that can still create their first Search copy.
It distinguishes sealed-empty, more, changed, unavailable and pending producer coverage.
It persists initial applicability before source deletion can erase that evidence.
An empty result without sealed coverage is not a terminal result.

Semantic owns account-agent, contribution attribution, consent and canonical source relations.
Content owns moderation/source fences and public rating source changes.
Library owns public Collection-count dependencies and its canonical records.
Imports owns import source custody; shared history owns workflow/receipt/event personal copies.
Search consumes only inventory relevant to bodies/dependencies it actually copied.
It neither independently verifies foreign implementation receipts nor fabricates their layout.
Native acceptance composes their delivered producers and tests end-to-end receiving custody.

#### Outputs

`stepSearchErasure` returns bounded diagnostic progress after native progress commits.
The proposed diagnostic is `{state:'more'|'pending'|'complete', obligation, phase, work}`.
`obligation` is a small locator, never a serialized source or copy vector.
`work` reports actual rows, statements, points, bytes and engine requests including failure paths.
`pending` carries a closed reason such as source-unavailable, population-unknown or native-ambiguous.
Diagnostic `complete` does not itself write the Access ACK.
The final separate durable step reads persisted Search completion and calls `acknowledgeErasure`.
Its only terminal input is `{accountId,participant:'search',outcome,retained:[]}`.
The immutable recorded applicability selects `erased` versus `none`.
No caller or test may select an allow/completed flag.

#### Durable state

Keep one obligation progress header in Search's native account-home state.
Bind it to the actual erasure version/T and Search inventory protocol version.
Use phases `sealing`, `source`, `copies`, `repair`, `drain`, `finalize`, `done`.
Persist the current raw key/subphase and captured native revisions, not source payload.
Persist monotonic `everApplied`; it is not recomputed from remaining copies.
Persist exact expected effect references and receiving receipts in bounded native child ranges.
Persist local completion outside DBOS journal/history and ordinary command receipt retention.
Persist an ACK-needed/done locator so a crash after final purge can still send the ACK.

Extend existing native Search stores where they already own lifecycle or observation state.
Use the prefix lineage for deployment readiness, not a second prefix table.
Use existing observations/references for close admission, not a parallel PIT registry.
Use existing prepared generations for their payload, not an erasure-owned row copy.
The obligation header is progress for this participant, not an ownership index for all personal data.
An account-leading lookup on that progress is not permission to mirror the owner's inventory.
Retain only the minimal completion/replay skeleton permitted by Deletion after custody transfers.
Do not retain old names, query bodies, account source facts or whole effect vectors forever.

#### Schema and indexes

Create forward-only native migrations with explicit down behavior preserving refusal fences.
Add scalar physical UUID/registration/source-reference columns needed for indexed custody enumeration.
Backfill existing serialized metadata with bounded keyset work under the enrollment cut.
Do not make public request-time SQL parse every encoded definition.
Add `(partition_no,physical UUID,registration key)` access for exact physical registration discovery.
Add `(partition_no,registration,observation)` access for observation discovery.
Use existing observation-leading execution/reference/PIT keys for child cleanup.
Use existing registration/build/generation keys for prepared cleanup.
Add typed role-first access only where a real copied account role lacks native owner inventory.
Keep such locators in the actual copy home and record them atomically with copy creation.

Capture migration/index/trigger and FK work as real maintenance work.
A new FK cascade cannot replace bounded child-first cleanup.
A surviving reusable registration cannot be deleted just because one observation was affected.
An execution referencing an erased original may be minimized/removed independently of another execution.
Do not put account identity into a traversal cursor that survives its minimization.
Use independent ordinal/raw-key traversal where the owner contract requires it.
The owner must adopt that cursor layout; hashing an account ID does not erase it.

#### Seal and source phase

Start from the account-home obligation under narrow platform authority.
Seal Search locator admission before taking the source/copy frontier.
Commit the fence/progress together and release the connection.
A source effect racing the seal either enters normal inventory before it or takes late-item responsibility.
Preserve source delivery custody through either branch.
Do not hold an account-home lock while asking Semantic, Library, Content or OpenSearch for work.

Process one owner-role/home unit at a time.
Read its bounded page and native basis through the delivered owner API.
Record the page receipt and exact Search effect references in the receiving native home.
Only after that commits may the source page be acknowledged/reclaimed by its owner.
On lost receipt delivery, redeliver the same page/receipt rather than allocate another page copy.
A new dirty head revisits only affected keys, not unrelated history.
Final source closure names every role and every pending first-apply delivery obligation.

A role can be absent only by the owner's sealed native proof.
A missing owner endpoint, source table, partition or source epoch is unavailable.
Account-agent deterministic IDs are useful anchors, not the complete inventory.
Account-authored statements can refer to other subjects and other terminal homes.
Withheld/private/archived candidates and foreign dependency effects still need cleanup custody.
Visible output-only discovery misses exactly the copies this phase must close.

#### Physical population phase

Read the durable installation/prefix basis.
Reconcile all native physical names against lineage under the sealed lifecycle revision.
Capture each exact UUID and its active/building/quarantined/retiring state.
An active-only alias query is insufficient.
An index absent from the native response but present in lineage needs exact retirement/absence resolution.
A native index without lineage is unknown, even if its search count is zero.
Do not mark the installation covered from a native generation number or mapping format alone.

For a genuine created-empty target, require durable creation provenance before any writer starts.
For an existing target, require complete audit/replay coverage or exact retirement.
Native equal counts cannot establish matching IDs, source roles or canonical support.
A target with unknown pending HTTP cannot become audited by reading a current empty result.
Quarantine it and use the shared retirement path if the uncertainty cannot be resolved.
Charge every retained old target against the existing max-three limit throughout recovery.

Capture the current registration set for each exact physical UUID.
Preserve a lifecycle dirty head for later registrations/captures.
A new registration for an affected unrepaired cut cannot publish.
A registration for a different native UUID never completes the captured old UUID's work.
Recheck the native/lineage revisions before recording population closure.
If the namespace changes, retain prior receipts and continue with the new dirty member.
Do not discard a retired-but-not-reclaimed copy from the erasure manifest.

#### Repair phase

For each retained effect, read current source and original/terminal identity through actual owner producers.
Respect current account terminal fences and source consent/moderation/tuple fences.
Choose delete or a full de-identified replacement from that current public projection.
Do not patch an old `_source` body or erase every document sharing a survivor terminal.
Retain all surviving eligible original support under the canonical participant contract.
If the last eligible original disappears, delete the public terminal document and prepared membership.
A hidden/excluded original remains relevant to inventory even when it supplies no public body.

The write uses shared enrolled custody from the second brief.
The source-home position must genuinely advance for an own-home replacement after a foreign change.
Keep source ownership epoch and identity epoch separately in the effect basis.
A source observation older than the captured obligation rejects before writing.
A source observation at a newer valid position can settle the captured unit while newer work remains dirty.
A missing requested record is absence only inside a valid exact observation.
Malformed Source response never becomes a successful delete.

Commit the exact engine effect receipt reference and local frontier only after visibility is established.
For multi-home old removal/new addition, commit each home's progress separately.
Retain the complete expected manifest until both homes have receiving custody.
A crash between halves resumes the same unfinished half and preserves the completed half's receipt.
No local `complete` return may hide a retained earlier half-effect.
A newer known competing winner may settle the effect only through its exact native custody.
Otherwise leave pending or retire, preserving unknown outcome honestly.

#### Retained PIT cleanup

Close old observation admission before requesting any native close.
Acquire the existing observation revision lock for its barrier transition.
Drain live use references in bounded native probes; wait outside transactions and durable steps.
Use the real reference deadlines, never change caller time to accelerate cleanup.
New renew/acquire calls on closing observations reject.
A renewal already executing retains both its prior and resulting locator through CAS recovery.

Release every owned native PIT locator by exact ID, in bounded batches.
A success receipt must name the exact locator and native result.
A generic HTTP 404 is not a PIT close receipt.
Native confirmed loss can settle only that exact locator/revision.
Failed shard/node close or connection loss leaves unresolved custody.
After success, mark only that PIT row released; retries remain idempotent.
Delete/minimize PIT locator payload after no consumer needs it for further release.

A lost open/renew result leaves a committed unresolved dispatch intent.
It cannot be resolved by assuming current `openPit` saved no row, therefore no PIT exists.
Retire the exact contaminated physical UUID through native teardown.
Actual native tests must prove no old context can be used after retirement, including zero-hit contexts.
Do not renew an unknown PIT, synthesize its ID or list the entire cluster to find it.
Native resource disappearance and SQL intent resolution remain separate committed observations.
If either is missing, keep the account pending.

#### Prepared and execution cleanup

Prepared snapshots are immutable; never rewrite one in place and keep its old observation identity.
Close affected observations, then erase their copied row sets and dependent executions.
If the public result must survive, build a new immutable generation after the repaired cut is accepted.
Use current one-current/one-building public prepared generation policy.
A rebuild cannot secretly keep another abandoned full generation.
The actual source or owner inventory must cover definitions containing personal query literals.

Delete execution payload children before the observation header.
Delete exact reference rows only after their consumers have drained.
Delete registration/build/generation prepared payload when no retained observation can acquire it.
The same native lock protects final empty-reference proof and reclamation.
A saved empty page cannot close a newer registration revision.
A new reference cannot sneak in after the last zero-reference probe.
Do not let a factory `close()` delete another factory's live resources.

Retain minimal nonpersonal idempotency/closure state only while another consumer needs it.
Hand off remaining exact responsibilities before minimizing its source locator.
Shared history receives actual durable copy locators for erasure workflow arguments/results and receipts.
The Search workflow does not wait for shared-history's global ACK, preventing a cycle.
It waits for durable handoff of its own produced copies, not enqueue intent alone.
The global Accounts coordinator separately waits for every participant.

#### Late copy phase

A foreign-home copy producer cannot call `recordLateErasureItem` in that foreign transaction.
The current function requires the erased account home and its live locator fence.
Use a durable source-home intent committed with the copy or pre-dispatch enrollment.
Deliver that intent to an account-home command holding the Search locator fence.
That command records the late item and its receiving custody.
Only after account-home custody commits can the source delivery frontier advance.
Register the actual effect name in `ERASURE_LOCATOR_EFFECTS` so Accounts' existing frontier covers it.

The late-item locator is 1..255 printable ASCII characters, IDs only.
It identifies one actual finite work item, not a payload or account-wide Boolean.
Use a new nonreused native item identity for a genuinely new copy.
Reusing an already resolved late-item key cannot represent a new unresolved copy.
Exact replay of the same copy uses the same identity.
The source producer remains responsible until this transfer is durable.

A closed Search fence makes the late producer handle its own cleanup.
It minimizes/purges every copied artifact through the registered native owner path.
After cleanup commits, resolve its exact item through `resolveLateErasureItem`.
A crash before resolution retries the same item after confirming the committed cleanup.
A failed or cancelled workflow leaves the registered locator-work row open.
Only actual success or the explicit existing platform resolution clears that work.
Deleting DBOS history is never a completion action.

No post-completion producer can create personal Search bytes under an erased account.
New ordinary work reads the permanent terminal account/source truth before application.
A queued pre-T intent remains owned through the effects frontier and enrolled copy manifest.
An illegal/untracked copy discovered after a claimed completion is a producer defect, not a reason to mutate ACKs.
Deployment activation requires complete producer closure so that state is unreachable.
Native negative tests intentionally exercise these boundaries before accepting activation.

#### Finalization and acknowledgment

Use indexed existence/minimal-field probes over the sealed work ranges.
Require source inventory closure, copy population closure and no unowned first-apply delivery.
Require every effect receipt, every PIT/prepared cleanup and every late responsibility transferred or resolved.
Require shared-copy producer handoff for the participant's own new artifacts.
Require unchanged native lifecycle/source basis or a retained dirty continuation for every change.
Do not run full counts over account history or engine documents as the final predicate.

Commit local completion and its actual receipt in Search's native home.
Release that transaction and connection.
In a separate durable step, re-read that completion and call the existing Access ACK command.
`everApplied=true` selects `erased`; sealed never-applied selects `none`.
Search has no adopted payload-retention exception, so the selected ACK names `retained: []`.
A failed purge cannot be relabeled as retention with a guessed deadline.
A quarantined physical copy still containing payload blocks the ACK until retired/cleared.

Crash after local completion and before ACK replays the same outcome.
Crash after ACK commit and before DBOS result retries the identical ACK.
The immutable ACK is the permanent idempotency record even after workflow history disappears.
Do not use stable workflow ID alone as permanent replay refusal after history deletion.
Accounts still checks all participants, no open late items and its effects/locator frontier.
Search does not call `advanceErasureCompletion` to pretend it owns the final global result.
Its participant success is neither identity publication nor backup-expiry proof.

#### Failure, rollback and replay

Before a native transaction commits, roll back its progress and payload mutations together.
Never commit a frontier separately from the corresponding local effect/receipt state.
After commit, reread and redeliver that exact saved receipt.
After uncertain engine dispatch, preserve ambiguous state and exact target identity.
Never replay a saved personal body to a fresh target as recovery input.
Always obtain current native public source disposition again under fresh basis.

Transient owner unavailability keeps the saved key/subphase and returns pending.
Ownership movement requires routed native re-resolution, preserving the original receipt reference.
A source basis change invalidates the affected closure candidate, not unrelated completed ranges.
A malformed receipt cannot advance any frontier.
A wrong transaction ID with the same position/component cannot settle a unit.
A correct transaction from the wrong native component/home likewise cannot settle it.
No attempt discards an earlier unresolved effect to free a new slot.

Abort/cancel is not a rollback of already visible erasure effects.
Completed removals stay removed; recovery continues from retained native responsibility.
A local process stop seals admission and drains its own work only.
It never closes supplied pools, another fixture's node or foreign-owner workers.
Retry scheduling uses existing DBOS durable work and real backoff/deadlines outside connections.
There is no second cleanup daemon, polling request or independent process launch.

#### Frozen native acceptance scenarios

The following fenced cases freeze expected behavior without importing nonexistent modules.
Implement them in `services/kernel/test/search/erasure-participant.test.ts` and its real native fixture.
They supplement unchanged terminal-erasure SPEC and existing source/sink/lifecycle tests.
Each case records real native SQL/engine effects and requires zero skipped/todo cases.
Missing producers fail explicit assertions; fixture promises cannot manufacture ACKs.

```text
Case: all roles and all physical copies are erased
Given ordinary owner APIs created an account-agent name, private/archived contribution,
      public de-identified-surviving contribution and foreign dependency effects,
      with three actual UUIDs: active, rebuilding and retained old,
      and actual old PIT, prepared rows and executions including an empty result,
When terminal deletion commits and actual default erasure work runs,
Then Search records everApplied before cleanup,
     removes every prohibited marker from all three UUIDs and retained SQL copies,
     releases every old PIT variant and preserves unrelated/surviving public content,
     and sends exactly the same durable erased ACK on replay.

Case: unknown population cannot become none
Given native same-name recreation or an unregistered alias-free physical index,
When inventory returns no currently visible account document,
Then Search remains pending and supplies no ACK,
     until native full enrollment/audit or complete retirement closes that copy.

Case: complete sealed empty inventory produces none
Given a genuinely enrolled created-empty deployment and all source roles sealed empty,
      no old first-apply delivery and no applicable retained definition/execution,
When final indexed closure commits,
Then Search acknowledges none; event and DBOS replay preserve that exact outcome.

Case: an erased last copy does not become none on retry
Given an applicable account copy was discovered and everApplied persisted,
When purge commits and the worker dies before ACK,
Then recovery acknowledges erased despite every current lookup now being empty.

Case: old PIT cannot borrow a repaired live cut
Given a PIT excludes a row using pre-erasure facts and returns zero candidates,
When live repair becomes refresh-visible and live pending reductions reach zero,
Then the old PIT is still closed/restarted and supplies no public absence/order evidence.

Case: retained prepared and execution payloads are physical copies
Given the same original/terminal vector occurs in observation, prepared and execution rows,
      plus a typed personal literal in a retained definition,
When cleanup closes the relevant observations,
Then every prohibited physical copy is erased/minimized independently,
     unrelated definitions remain, and a new prepared generation gets a new observation.

Case: first apply races source erasure
Given a source command committed before its first Search registration/application,
When the Search locator fence seals on either side of receiving custody,
Then the copy is included normally or is an exact late item with receiving custody,
     and no interval permits a premature Search ACK or unowned dispatch.

Case: late copy cleanup precedes resolution
Given a closed fence and a genuine late copy in a foreign home,
When account-home receipt or cleanup or late resolution is interrupted separately,
Then the same item stays open until actual minimization commits and is resolved once;
     the source delivery frontier never outruns account-home custody.

Case: renewal CAS loser remains owned
Given two real native PIT renewals race and one loses the SQL CAS,
When erasure closes the observation,
Then both actual locators remain owned until released and neither is omitted from closure.

Case: lost PIT open result requires physical closure
Given native open completes but its response is lost before locator persistence,
When the worker crashes and recovers,
Then the committed dispatch intent remains unknown,
     Search cannot ACK from an absent observation row,
     and exact UUID retirement/context teardown is required to close it.

Case: local completion and coordinator publication are distinct
Given Search local purge completion but missing Access ACK, then missing another owner ACK,
When each boundary is held independently,
Then participant status first stays pending, later records Search's outcome,
     and overall completion remains pending until Accounts' existing predicate holds.

Case: real process recovery preserves custody
Given a worker killed before/after each source receipt, engine effect, frontier,
      local completion, account ACK commit and DBOS result journal,
When the same obligation resumes through the default WorkModule,
Then no source role, physical copy, prior half-effect or late item is lost,
     no body is restored and duplicate delivery never changes the persisted outcome.
```

#### Full call-site and generated closure

Register the erasure effect through `searchWorkModule.register(context)`.
Place that registration before the optional indexing-config early return.
An installation without a configured live engine still owes enrollment/absence proof for retained deployment.
Do not auto-ACK `none` merely because `OPENSEARCH_URL` is absent.
Use existing `context.addEffects`, registered DBOS steps/workflow and maintenance queue.
Register names before the single `composeWork` launch through existing default module composition.
Do not add a new DBOS SDK owner or omit Semantic from the default worker to make the fixture run.

Connect lifecycle registration, PIT/prepared capture and Source copy recorders to the same native custody.
Ensure account-agent name clearing, source contribution minimization, consent retraction,
public rating changes and public Collection-count changes feed their actual existing invalidation paths.
The native scenario fixture uses the actual released owner producers, not direct replacement bodies.
Controlled source tests remain useful for isolated custody errors but cannot pass all-role acceptance.
Retain the exact original marker and late-ingress SPEC assertions unchanged.

Generate SQL bindings from the new native SQL using the repository's owning generator command.
Regenerate Search schema snapshots through the migration workflow, not hand-maintained schema duplicates.
If exports become public client surface, regenerate `packages/client/src/kernel/search/**` declarations;
prefer internal-only worker exports so no client endpoint or capability appears accidentally.
Update Search README to link this adopted design and actual callable declarations after owner adoption.
Keep the document's proposal status until those owners adopt the cross-owner boundaries.

#### Acceptance commands for later integration

These commands are obligations for the implementation; none is run by this specification change.
Use the existing runner so native PostgreSQL/OpenSearch provisioning, ownership and capacity are preserved.
Do not manually start another engine, replace default worker registrations or weaken check selection.

```sh
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/erasure-participant.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/access/erasure-coordinator.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/outcomes.test.ts test/search/real-source-composition.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/growth-index-erasure.test.ts
bun run --cwd services/kernel typecheck
```

The actual terminal-erasure native binding belongs to Accounts; consume its delivered driver and command.
Do not create a fake binding merely to import `specs/terminal-erasure-outcomes.test.ts`.
Its unchanged Search-copy and non-resurrection assertions remain required at final integrated acceptance.
Add missing native erasure/growth suites before implementation acceptance, using the fenced cases above.
Retain each actual case count, all raw counters and the checked integration revision.
A pass of the documentation formatter proves none of these outcomes.

### Brief: non-resurrection, identity participation and complete late-writer closure

#### Outcome and scope

Implement the shared actual Search writer custody used by ordinary indexing and maintenance.
Implement the real fixed version-1 `search-canonical-index` identity participant.
Preserve existing identity participant ownership, job ABI and coordinator publication.
Close delayed-first-apply, source movement, native pruning and same-name recreation schedules.
The participant's completion covers all deployed physical incarnations and retained prepared copies.
An ordinary projection checkpoint or privacy ACK cannot substitute for that completion.

Expected surfaces are existing indexer/write-actions/runner/generations/coverage implementation,
Search copy/write custody and the proposed Search identity adapter, native migrations and tests.
Semantic continues to own STORE/mapping/bootstrap/admission and its final coordinator.
Library continues to own the other fixed participant and all private canonical records.
Search imports their actual public types/primitives; it does not implement them again.
Cross-owner missing decisions remain adoption prerequisites, not excuses for a no-data adapter.

#### Native participant input and output

Export proposed `stepSearchCanonicalIndex` with the exact existing `IdentityEpochStep` type.
Its arguments are `(pool, {jobId,epoch})`; caller-supplied changes/frontiers/completion are forbidden.
Read the actual native job and immutable input references through `identityEpochStore`.
Obtain bounded originals/previous terminals/new terminals using its existing `pageChanges`.
Read Search's own saved native phase/frontier and exact source/physical basis.
Do not decode a caller vector or infer identity change from returned Search hits.

Return actual `IdentityStepProgress` only after its native effects/frontier receipt commits.
The fields remain `{job,frontier,state,work,receipt}`.
`frontier` is `{after,segment}` with at most 8 scalar keys and 2048 JSON bytes.
`work` uses actual `rows,points,statements,bytes,engineRequests`.
`receipt` is the existing `IdentityStepReceipt`, not a new certificate type.
It names exact job, step `search-canonical-index`, version 1 and native receipt.
Native receipt retains partition, ownership epoch, position and transaction ID.
The component and transaction identity jointly identify the actual native commit.
The returned `state:'complete'` alone cannot publish.

Only the final Semantic coordinator composes the two actual producers and calls reconciliation/publication.
Search releases its local connection before `reconcileStepReceipt` takes receiving/control custody.
The producer can redeliver its same receipt after response loss.
The native completion record binds the complete expected Search scope, not just the last page.
A receipt for the right job but wrong version/scope/component is refused.
A local ACK can be present while the identity job remains pending for mapping or Library.
No participant waits for the final coordinator to publish before handing off its own completion.

#### Reusable identity primitives

Use `identityEpochStore.pageChanges` for the same immutable affected-original stream as Library.
Use `identityEpochStore.readMappings` for bounded shared current mapping observations where required.
Use `admitHomeEffect` in the SAME native effect transaction when its effect kind/home is applicable.
A global epoch preread is not a substitute for its native compare/lock.
Use its native pending state to block stale first apply or transfer actual retry responsibility.
Do not add another identity epoch counter, canonical group table or own-home mapping cache authority.

Use existing original/terminal Source dependencies and Search structural reverse registration.
Include hidden, excluded, negative and never-positive originals in affected scope discovery.
Retain original support even when multiple originals map to one terminal.
The canonical engine key is the terminal subject under that exact incarnation/projection generation.
Prepared canonical rows are unique by actual generation plus canonical ID.
A terminal's public existence follows eligible original support, including removal of the last eligible original.
Do not resolve a group to one arbitrary representative and drop the rest of its support.

The current `IdentityEffect` union has structural and follow-count variants.
Search uses the actual structural job/original gate for identity work in its native home.
An ordinary Search/source-account gate not expressible through that union needs owner adoption.
Do not cast a Search write to `follow-count`, forge a structural job or invent a generic allow token.
The owner must supply same-effect first-apply registration/custody for Search's native effect boundary.
This document selects those semantics; the existing owner alone selects any additive callable ABI.
Native tests stay red for the missing binding until delivered.

#### Writer enrollment state machine

Extend the existing CoverageStore current slot rather than keeping one SQL row for every past attempt.
The stable key remains exact incarnation and source home.
Keep one unresolved batch with captured envelope bounds and a bounded in-unit chunk frontier.
Use phases `enrolled`, `prepared`, `dispatching`, `visible`, `ambiguous`, `completed`.
Preserve existing safe `aborted`/`skipped` outcomes and checkpoint-state enum.
A dispatch intent commits before the first mutation can be issued.
A process-local Promise is never the only record of outstanding I/O.

`enrolled` captures lifecycle revision and exact source/identity admission basis.
`prepared` records current source observation identities and action keys/versions by retained native references.
It does not serialize personal bodies into workflow progress.
`dispatching` means I/O may have started; crash recovery cannot assume no send.
`visible` requires actual keyed native receipt and current effect basis.
`ambiguous` holds both unknown outcome and physical target until actual resolution/retirement.
`completed` records actual checkpoint outcome and releases the slot only under the lifecycle CAS.

The source read must happen after enrollment.
The snapshot home must equal the requested/envelope partition.
Its position must be a valid safe external version and cover the captured final envelope.
Every returned ID is unique and requested in that home.
Preserve existing subject visibility/redirect/security/payload validation.
Current listing-count source runs only for visible nonredirect subjects actually indexed.
Sort normalization belongs inside the same enrolled work and deadline.
A delayed normalization response is not an independent permission to dispatch the old action.

After preparation, revalidate native source/identity/copy barrier state before dispatch.
If a barrier changed with positive no-send knowledge, abort and retain dirty retry responsibility.
If dispatch may have begun, keep the attempt ambiguous or resolve its actual receipt.
If a source change commits during I/O, the later repair cannot ACK until this attempt has custody.
The barrier waits on native outstanding work, not a per-process drain counter.
No cross-owner or engine request occurs while holding the SQL transaction/checkout.

#### Native receipt strength

Keep existing `writeIndexActions` positional receipt validation intact.
Every success binds operation, ID, exact physical name and safe external version.
Require coherent result/status, native sequence/primary term and complete successful shards.
Do not require optional `forced_refresh` on ordinary `refresh=wait_for` success.
Reject reordered/duplicated/missing items, wrong keys, contradictory errors and partial shards.
Retain all actually returned native errors for failure diagnosis and replay.

Before/after native UUID observations bind the action to its enrolled incarnation.
They detect recreation but do not by themselves atomically pin a name-addressed write.
The stronger protection is nonreuse, enrolled outstanding custody and quarantine on uncertainty.
Do not advertise settings-before/settings-after as an atomic engine UUID conditional-write API.
The native engine accepts the name, while SQL closure protects whether that effect may be trusted.
An unknown competing native writer makes the target untrusted until audited/retired.

A native external-version conflict does not return the winning body/version success receipt.
The existing conflict refresh makes its current winner search-visible for ordinary checkpoint semantics.
Identity/erasure closure additionally requires a known current effect receipt for that winner.
Use an actual owned winning action whose basis and native custody are retained.
If an equal/newer but unowned write won, do not parse its error text into winner evidence.
Retire/quarantine when current native effect cannot be safely resolved with bounded existing evidence.
No per-key response fabrication or general Boolean verifier is selected.

#### Source and identity movement

A home ownership epoch change invalidates the old owner's authority even if position numbers coincide.
A pending structural identity job invalidates a stale terminal route even before final publication.
The source original remains the durable personal reference; only derived canonical keys rekey.
Reanchoring reads must preserve current source access and accepted meaning.
A moved/unknown owner returns unavailable, never guessed self/empty.
A batch shares bounded native mapping observation rather than issuing per-ID control queries.

OLD removal and NEW addition can be at different homes/physical consumers.
Persist the expected manifest before performing either half.
Retain each actual receipt through receiving/control custody.
A resumed page does not reapply the finished half from old personal bytes.
It reads current source/mapping for the unfinished effect and preserves its causal obligation.
If another structural job changes the terminal again, the native owner decides ordered admission.
Search does not create a competing local epoch to force its preferred result.

Privacy reductions have separate local/foreign repair dependencies.
A foreign source reduction needs actual source-home invalidation/version advancement.
Stamping the foreign privacy position into a destination bulk is forbidden.
An unchanged-version conflict cannot establish foreign repair completion.
Current mapping, current source projection, sink visibility and privacy ACK are separate records.
One successful observation cannot be relabeled to supply all four.

#### First apply

A source command with no previously indexed support still registers delivery responsibility.
That registration and barrier installation must serialize in the actual native destination home.
If first apply wins, its support/directory/dirty work is included in the sealed manifest.
If barrier wins, stale application rejects and rereads current truth or transfers durable retry custody.
The directory is structural dependency existence, not one copied row for every statement/fact.
A million repeated inputs in the same scope must not produce a million registration rows.
Actual supporting payload can still require finite continued work inside that scope.

A source command committed before directory registration cannot disappear between those phases.
Its durable delivery intent belongs to closure until receiving registration commits.
On deletion, the permanent account fence makes future stale positive effects refuse application.
On identity change, the native gate makes stale terminal effects refuse or reanchor.
Neither relies on finding an old positive engine document.
Negative/tombstone support and never-positive intent are inputs to the same custody protocol.

Use no per-account engine tombstone to remember these negatives forever.
Keep current source authority, exact finite pending intent and existing permanent erasure identity only.
After consumer/control custody is safe, minimize completed source-intent payload.
Do not erase the source fence witness while an old producer can still use it.
The owning producer decides when its current witness can be reclaimed.
Search cannot certify that by exhausting only its own reference table.

#### Pruning and ambiguity

Freeze an old source body before send using a real process/native gate.
Apply the newer delete/replacement and progress the relevant source/identity barrier.
Keep the old enrollment outstanding; participant publication must remain pending.
Exercise actual native delete-version pruning, not just elapsed test time or a mocked 409.
After pruning, an unsafe old external write could recreate data if allowed to send.
The implementation must refuse its send or retire that physical UUID before closure.
An advanced checkpoint alone cannot pass this case.

For dispatch uncertainty, never write a blind retry to a reused name.
An actual returned current action receipt can settle the retained attempt idempotently.
Otherwise set lineage quarantined and deny new public captures/certification.
Keep admitted old observations blocked by their own retained cut checks.
Build a new never-issued generation only when capacity permits.
Complete native population/coverage and activation through the existing lifecycle functions.
Retire the contaminated UUID and resolve its old attempts only after teardown custody.

The selected native write block is `PUT /<physical>/_block/write`.
Require the native action's actual complete index/shard result, not only `acknowledged`.
Its shard verification drains in-flight writes; a settings PUT cannot replace it.
Do not remove the write block from a quarantined old incarnation after replacement.
Delete by the exact name only while retained lifecycle revision/UUID observations agree.
If the name now resolves to another UUID, stop treating it as deletion of the enrolled UUID.
Inventory the recreated UUID separately and preserve the old unresolved finding.

Deleting an index also owns Search's native context teardown obligation.
The inspected native SearchService frees index contexts on deletion/closure and rejects racing registration.
Native tests must exercise this behavior and delayed requests on the pinned deployed version.
A delete cluster-state acknowledgment alone is not proof of segment/backups byte reclamation.
Do not promise forensic storage overwrite or backup expiry from this protocol.
Payload inaccessible through all retained native Search copies is distinct from physical storage accounting.
Record both native custody closure and retained storage in the acceptance evidence.

#### Physical replacement and capacity

Use the existing prefix generation allocation fence and max-three retention rule.
Reserve capacity before index creation; a lost create response does not allocate another hidden copy.
Resolve its actual native UUID and retain the creation intent under that same reservation.
An `already_exists` response cannot establish created-empty provenance.
Never adopt a retired generation name merely because it is currently absent.
Read fresh source, not a snapshot export of unsafe old index bodies, for population.

At three retained generations, reclaim/retire a safe old one or remain pending.
Do not allocate a fourth to get around an unresolved index.
Quarantine consumes a slot until complete native retirement and retained-copy custody permit reclaim.
An existing rebuilding generation is included, not an excuse for a second maintenance namespace.
Repeated crashes must not grow generations, attempt histories or full prepared copies without bound.
All replacement replay and old-copy teardown costs belong to the job's evidence.

Fresh activation needs full native coverage and current source/identity basis.
Do not use partition counts as copy completeness or permission evidence.
The alias publication operation revalidates all relevant lifecycle/source bases after population.
A late old activation attempt loses the native lifecycle CAS and publishes nothing.
A lost alias response is resolved through actual fresh metadata and retained publication intent.
A same-name UUID replacement cannot inherit a read cursor, preparation or erasure certificate.

#### Identity completion and receiving/control publication

The Search completion manifest covers every physical index, prepared generation and pending first apply.
It includes every old removal, new addition, directory replacement and pending/published fence.
It includes effects from all prior pages, not merely the page that returned EOF.
It includes observation closure where a retained old snapshot cannot safely serve the new mapping.
A follow-only or active-index-only local completion cannot be reconciled as complete Search scope.

Persist native effect/frontier/completion in the actual producer transaction.
Release its home and hand the exact `IdentityStepReceipt` to STORE reconciliation.
STORE reads its real native persisted record and takes durable control custody.
Do not pass a callback that returns true or ask the coordinator to trust the adapter's return value.
After control custody, local full payload can be minimized under existing owner reclamation rules.
Keep sufficient exact references for remaining consumers and replay until their handoff is complete.

Only existing Semantic `publish` can publish the identity epoch.
It requires mapping plus BOTH fixed version-1 participants and prior effect custody.
Search never edits Library receipt state or synthesizes `library-private-follow-counts` completion.
The current Library owner remains responsible for its directory, six drivers, follows/support/totals and first apply.
Search's receipt is distinct from ordinary relay checkpoint and public-filter reduction ACK.
Accounts verify/unverify retains its existing same-workflow publication wait and DTO semantics.
This implementation does not add an HTTP pending protocol or second identity scheduler.

#### Public consumer integration

Use the canonical `PublicFilterQueriedObservation` and existing custody methods unchanged in meaning.
Capture actual physical incarnation and native registered Source/read definition.
Keep the admitted expanded filter/text/order and dependency keys with its immutable definition.
Capture all NOT/OR/saved/qualifier branches and functional rating/count/order inputs.
Returned own rows are an additional check, never the complete population dependency set.
Keep original and terminal for each returned row, including redirected support.

Before public disclosure, join exact retained execution/start and current Source observation.
An observation-only diagnostic read cannot invent an execution or grant permission.
A live target with no pending reductions cannot make an older PIT safe.
A zero-hit query still needs relevant negative/order population coverage.
Unknown identity/source/copy coverage yields preparing/unavailable, never a successful empty page.
An irrelevant excluded-subject reduction may serve only under actual scoped native routing proof.
Own-row reductions block independently of filter/order narrowing.

Keep complete privacy start/final work within the existing two-statement subset and whole page budgets.
No request reads a 4096-head vector, polls all jobs or repairs the entire index before returning.
No control/coverage/custody metadata becomes public cursor fields or totals.
Ordinary current hit checks continue to protect labels/facts/suggestions.
General totals and facet counts remain omitted until their separate safe aggregate authority exists.
This brief does not authorize a count fallback, extra page budget or private Library predicate.

#### Full writer call-site closure

Trace the actual production chain `searchWorkModule -> startSearchIndexing -> createSubjectIndexer`.
Enroll before its first Source chunk or sort-key normalization request.
Route every live generation through the same guard, including retained old and rebuilding relays.
Keep the original relay snapshot/CAS, source validation and bulk writer as the actual executor.
Do not add another outbox reader, separate erasure indexer or alternate checkpoint convention.
The `aroundApply` callback remains exactly-once; it is a seam, not the custody store.

Bind explicit `rebuildSubjects`, runner refresh/bootstrap and Search CLI to the same lifecycle coordinator.
Inspect `services/kernel/scripts/search.ts` for every creation/rebuild/retire path at implementation time.
No CLI raw writer can bypass prefix reservation, native UUID registration or stale-version refusal.
Bind privacy repair and the identity adapter to the same `withSearchWriteCustody` execution.
Bind prepared creation/replacement and PIT open/renew/close to the same copy lifecycle revision.
The actual Source owner remains responsible for public-only projection and current permission.

Inventory every production import of `writeIndexActions`, `bulkLines`, `createSubjectIndex` and `OpenSearch.bulk`.
A direct write lacking enrollment either moves into the shared path or remains explicitly test-only.
Do not infer complete closure merely from changing the one caller visible in indexer.ts.
Close old deployed writer versions through the existing native installation policy.
Unknown old writers keep deployment/erasure coverage pending until drained or retired.
There is no permanent grandfathered bypass for rebuild, manual repair or a trusted platform action.

Keep `startWorker`, `KERNEL_WORK_MODULES` and `composeWork` as the sole worker composition.
Only final Semantic coordinator composition imports concrete Search and Library participant implementations.
Search implementation imports STORE/types, never that coordinator, avoiding dependency cycles.
Search erasure reuses the shared writer/copy lifecycle but does not wait for identity's global publication to ACK itself.
Its native obligations can wait for required local effect/control custody without creating cross-ACK cycles.
Actual cyclic foreign requirements must be resolved by the owning contract before activation.

#### Generated and schema closure

Add native migration state only for the shared attempt/dispatch/copy/effect custody that this design needs.
Reuse current Search schemas and maintain lifecycle/observation FK ownership.
Generate typed SQL declarations through the repository generator.
Regenerate the schema snapshot and any affected generated client declarations through their owners' tools.
Avoid client exports for worker-only steps; no new public API is needed.
Update exact callable declaration links and adoption status when final producer names exist.

Existing frozen source-chunk, bulk-visibility, lifecycle, generation and identity tests remain untouched.
New acceptance adds discriminatory cases for missing custody, not weaker copies of existing tests.
A test that imports a missing new producer must fail explicitly at native binding time.
Do not check in broken static imports or fake executable ports as this specification artifact.
Native implementation fixtures can expose hold/release and kill/restart controls at real commit/I/O boundaries.
Those controls delay actual work and inspect actual records; none writes successful ACK rows for the producer.

#### Frozen native acceptance scenarios

Implement these in `services/kernel/test/search/identity-participant.test.ts`,
`write-custody.test.ts`, `index-copy-lifecycle.test.ts` and `growth-index-erasure.test.ts`.
Use the existing real-worker harness and default registrations for final composed cases.
Controlled Source cases isolate writer mechanics; real Source/owner cases prove participation.
Freeze all missing cases before accepting the native implementation.

```text
Case: canonical participant includes every original and physical incarnation
Given A and B support C across three real physical UUIDs and prepared generations,
      with hidden/excluded support and distinct original stored references,
When the actual native merge/repoint/unmerge job is resumed,
Then Search keeps one canonical terminal document and unique prepared canonical rows,
     preserves eligible support and stored originals,
     and publishes no local completion until every OLD/NEW effect is in native custody.

Case: last eligible original removes canonical membership
Given multiple originals support one terminal but only one is publicly eligible,
When that original is erased or loses eligibility,
Then all affected physical/prepared copies remove membership,
     without reviving hidden support or deleting unrelated public source content.

Case: first apply before native gate
Given a real source commit with no previous positive projection,
When its registration/application wins immediately before identity gate installation,
Then its source delivery and structural support are included in the retained manifest.

Case: first apply after native gate
Given that same source delivery held before first registration,
When gate installation wins,
Then stale apply rejects or transfers durable current retry custody,
     and publication remains pending until that responsibility is settled.

Case: delayed first send cannot resurrect after pruning
Given a stale body held after enrolled Source read and before native send,
When newer source deletion commits and native delete-version pruning is observed,
Then the stale action never reaches a trusted live incarnation,
     or its UUID is quarantined and retired before any completion/activation;
     a successful checkpoint or expired timer alone cannot pass.

Case: source ownership epoch changes with same numeric position
Given a captured Source observation and real owner movement,
When the old observation is delivered with the same position number,
Then enrollment/settlement refuses its old ownership epoch and rereads the actual owner.

Case: foreign repair has genuine own-home advancement
Given an excluded/foreign dependency reduction,
When its original privacy position differs from the subject home's position,
Then Search uses a real subject-home advancement and actual refreshed effect,
     never the foreign position or unchanged-version conflict as repair proof.

Case: ordinary keyed conflict is insufficient for structural completion
Given a real native conflict against an unowned or stale competing winner,
When ordinary refresh succeeds,
Then the stronger identity/erasure completion remains pending or retires the UUID.

Case: known winning receipt can settle without blind rewrite
Given a competing current enrolled action with its real source basis and native receipt,
When the older action conflicts and native visibility is established,
Then exact known winner custody can settle the old obligation without inventing receipt data.

Case: same-name UUID recreation is unknown
Given a retained physical name is deleted/recreated outside its allocator,
When old writes, captures, activation and final closure resume,
Then no old registration/cut/receipt authorizes the new UUID,
     the name is never served as a fresh trusted generation,
     and new native custody must account for the recreated copy.

Case: ambiguous write response forces exact resolution or retirement
Given native bulk completes but the response is lost,
When the worker crashes before receipt settlement,
Then recovery retains the same ambiguous slot and no ACK,
     resolving actual owned receipt or exact blocked/deleted UUID before closing it.

Case: retirement drains native writes and contexts
Given a real in-flight bulk and an old PIT on the contaminated index,
When native add-write-block and delete run through held/lost responses,
Then block receipt does not precede native write drain,
     no late bulk recreates an admitted target,
     and old PIT use fails after actual context teardown.

Case: no-write recovery never guesses
Given one attempt definitely has no dispatched mutation and another has uncertain send,
When each worker crashes,
Then only the first can settle aborted with positive no-send evidence;
     the uncertain attempt stays ambiguous even if current document lookup is empty.

Case: checkpoint CAS loss retains visible effects
Given two actual projectors compete and the losing CAS follows visible native writes,
When the loser resumes,
Then it records lost, retains native effect custody and never rewinds the winner;
     local identity/erasure completion still accounts for its visible prefix.

Case: every prior half-effect belongs to completion
Given multiple pages and different OLD/NEW homes,
When all final-page effects finish but an earlier removal/addition/fence is held,
Then real STORE reconciliation/publication refuses incomplete scope.

Case: wrong receipt identity cannot publish
Given correct job/epoch but wrong native transaction, component, version or scope,
When receipt reconciliation is attempted through the actual STORE,
Then it rejects, changes no complete frontier and retains the real unfinished work.

Case: Search complete is not identity published
Given real Search receipt in control custody and Library or mapping held,
When the final coordinator attempts publication,
Then the job remains pending; only actual fixed receipts permit published state.

Case: crash recovery at every custody boundary
Given process death before/after enrollment, dispatch intent, native apply/refresh,
      local receipt/frontier, receiving/control receipt and publication commit,
When the same native job resumes,
Then no lost result creates another job, forgets a prior effect or publishes early.

Case: capacity includes all physical copies
Given three retained active/building/quarantined UUIDs and abandoned prepared state,
When recovery asks for a replacement repeatedly,
Then no fourth generation or hidden full copy is allocated;
     bounded reclamation or explicit pending precedes any new reservation.

Case: continuous unrelated work does not reset finite erasure
Given finite affected inputs and continuing disjoint source/identity changes,
When cleanup/repair takes bounded steps,
Then only relevant dirty work repeats, progress is retained and the finite job finishes;
     no global scan, sleep loop with a connection or page-one restart is allowed.
```

#### Growth and physical retention acceptance

Use existing native `checkGrowth` with series rules and actual EXPLAIN capture.
The 1/8/64 factors mean production-shaped 500/4000/32000 unrelated rows, not toy row counts.
Hold relevant raw work, payload sizes, generation count and native index shape fixed on that axis.
Grow relevant originals/support independently at 64/512/4096.
Exercise raw 99/100/101 boundaries and chunk 256/257 boundaries separately.
Exercise first, next/deep, empty, replay and failed units at every scale.
Do not substitute returned row counts for examined rows or shared blocks.

Capture every participating pool, backend, actual statement and failed/retried request.
Record request/response bytes, native points, raw input/output/frontier rows and engine operations.
Engine search profiles report `next_doc_count + advance_count` across all nodes/tree branches/shards.
Bulk/refresh and write-block/delete costs remain separate from iterator counts.
Report full query plus final status, privacy coverage subset and original/terminal own-row checks.
A count-free API does not excuse unsafe exclusion/order or hidden population work.

Track all retained physical copies through success, crash, replay, cancellation and partial reclaim.
Engine storage includes roots, nested facts, deleted-but-unmerged segments and PIT-pinned segments.
SQL storage includes definitions, observation prepared rows, prepared rows, execution vectors and indexes.
Intent/effect/reference metadata and DBOS/shared-history copies also count.
A logical deletion row count is not physical byte reclamation.
Measure native table/index sizes and engine segment/store deltas with actual retention context.
Do not claim an immediate disk bound while old transactions/PITs still retain storage.

At most three physical index incarnations exist under the existing lifecycle cap.
Per admitted public read definition, at most one current and one building prepared generation are allowed.
Old observed generations awaiting drain/reclaim are physical retained copies charged before replacement.
If the current two-generation policy cannot fit retained snapshots, close/drain them before allocating anew.
No new numerical retained-observation allowance is invented here.
The current custody schema imposes per-row bytes, not a global storage cap.
Record retained observation/reference cardinality and actual payload bytes as all-copy costs.
Performance/owner adoption must certify full retention fit; formatting cannot certify it.

Normal repair total follows relevant owner inventory, dependencies, copies and actual retained effects.
Deployment enrollment pays the fixed 4096-home routing universe once per required cutover/version.
Each step visits one home and releases it before another backend or native engine call.
Unknown/ambiguous target retirement can pay whole-index teardown and full source replay.
Charge that exceptional total explicitly; never describe it as constant account-local work.
Background discovery, dirty routing, wakeup, minimization and reclaim remain measured work.
No component can hide a second full member/body copy inside workflow JSON or a receipt.

#### Acceptance commands for later integration

Create the named missing test files from the frozen cases before claiming implementation acceptance.
Keep existing acceptance and frozen files unchanged.
Run focused native suites through the current kernel runner; actual infrastructure waits are queued work.
The following commands are future handoff obligations, not this document's evidence.

```sh
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/write-custody.test.ts test/search/identity-participant.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/index-copy-lifecycle.test.ts test/search/growth-index-erasure.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/indexer.test.ts test/search/bulk-visibility.test.ts test/search/source-snapshot-custody.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/runner-discovery-lifecycle.test.ts test/search/generations.test.ts test/search/query-generation.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/semantic/identity-epoch-publication.test.ts test/semantic/identity-epoch-cutover.test.ts
bun scripts/worker-check.ts --local -- bun run --cwd services/kernel check -- test/search/outcomes.test.ts test/search/real-source-composition.test.ts
bun run --cwd services/kernel typecheck
```

The existing identity publication suite may isolate STORE; retain that claim boundary.
The new participant suite must bind actual Search and the delivered fixed Library producer for final publication.
Search cannot replace Library with a Boolean completion adapter to turn that case green.
Final default-worker/API and unchanged terminal-erasure acceptance remain separate integration evidence.
Record the checked revision, actual test/case counts and zero skip/todo status.
No successful local suite alone establishes promotion onto the main branch.

## Adoption decisions and handoff

Search selects exact native enumeration from existing lineage/custody plus delivered owner inventory.
Unknown deployment or applicability stays pending; it is neither a no-data finding nor successful erasure.
Search selects conservative closure of old PITs on affected physical targets, including zero-hit snapshots.
Search selects immutable prepared replacement, with actual payload erasure and all physical duplicate costs.
Search selects enrolled first-apply/dispatch custody and retirement for unresolved native outcomes.
These choices are proposals pending adoption by the owners of the touched cross-owner boundaries.

Accounts must adopt the concrete Search locator-fence/account-home receiving command binding.
The actual `recordLateErasureItem` signature cannot be used inside a foreign-home transaction.
Use existing effects-frontier/locator-work semantics; no new coordinator Boolean is requested.
Source owners must adopt their role-complete inventory, source minimization receipts and dirty/first-apply handoff.
Search does not name a nonexistent inventory callable or copy owner SQL to bypass that responsibility.
Semantic must adopt the precise Search source/structural gate binding and effect receipt scope.
Its current fixed participants, STORE and publication ownership remain intact.
Performance must certify actual elementary unit/metadata fit and all-copy retention against current ceilings.
No owner is asked to approve a raised budget, permanent extra tombstone or second engine.

Implementation can proceed on Search-native stores/custody and the real adapter while these producers land.
Activation and native acceptance require their actual adopted bindings.
Missing producers remain named required native reds; an unavailable runtime is not a product completion claim.
Neither the old SPEC nor this plan is a runtime substitute.

## Inspected source basis

Repository source inspected for this design includes the actual Access erasure/progress implementations,
ACK/late/completion SQL and Access README; Search work, indexer, source, document, write-actions,
indices/generations, coverage declarations/store/projection and both Search migrations;
public-filter custody implementation/types and consumer contract;
Semantic identity STORE declarations/contract, semantic source contract and account-agent/lifecycle README;
Core operational declarations; the terminal-erasure SPEC and real-worker harness contract.
The existing Search protocol audit is historical context, not a current runtime receipt.
No foreign receipt hash was recomputed and no native probe was run.

Reference source was read only from the repository's named reference directory through pinned git objects:

- OpenSearch `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`, Apache-2.0,
  `server/src/main/java/org/opensearch/index/engine/InternalEngine.java`:
  native delete-tombstone pruning prevents external versions alone from proving non-resurrection.
- The same revision, `action/admin/indices/readonly/TransportAddIndexBlockAction.java`:
  verified write-block completion drains in-flight writes; a settings acknowledgment is weaker.
- The same revision, `action/search/CreatePitController.java` and `TransportDeletePitAction.java`:
  PIT creation is multi-phase, cleanup can fail and explicit locator deletion differs from cluster-wide `_all`.
- The same revision, `search/SearchService.java:afterIndexRemoved/putReaderContext`:
  native index removal frees its contexts and closes the racing context-registration path.

These paths are under the reference OpenSearch checkout's `server/src/main/java/org/opensearch/` directory.
The reference index is `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md`;
the inspected clone is its `search-rating-populations/opensearch` entry.
No reference checkout was written, built or executed and no implementation was copied.
This reuses existing pinned protocol evidence rather than opening a new product research round.

This specification's deferred artifact acceptance is:

```sh
bun scripts/worker-check.ts --local -- node_modules/.bin/oxfmt --check docs/search-index-erasure-plan.md
```

Current minimal verification executes no acceptance, native, database, browser, host or remote checks.
This is documentation only, so no changed workspace requires a compiler.
Its future formatting pass establishes the artifact's formatting only.
Runtime erasure, native Cost and product/default publication remain the implementation briefs' obligations.
