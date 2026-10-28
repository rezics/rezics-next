# Semantic deletion contract

This is an audit and executable specification of required work for the first public scope in
[scope](../../../../docs/scope.md) and [deletion](../../../../docs/deletion.md). The first production slice reads native identity and attribution only; it adds no lifecycle transitions.
The native outcome tests intentionally fail on missing behavior. Zones have a separate lifecycle contract;
Content owns authored document bodies and media, Access owns account deletion, and Content owns source fences (imports consumes that authority).
Do not implement their stores here. The policy in docs/deletion.md applies in full, including automatic purge,
minimal payload removal, legal holds, and reversible takedown without a destructive deadline.

## Records and authority

| Actual record                                                                     | Ownership evidence and required disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `semantic.subject`, identity facts, definition releases and activation identities | Communal catalogue authority, not private property of the creating account. Do not grant subject/release deletion from creation attribution alone. Preserve types, IDs, nonpersonal relations and release meanings. Personal fields still require targeted minimization under legal order or applicable erasure.                                                                                                                                                                                                   |
| `semantic.candidate`, compact statement facts, proposals and their revisions      | A contribution can be account-owned. Resolve `revision.recorded_transaction_id` to `editorial.write_basis` by partition and transaction; `principal_kind/principal_id` identifies the actor. `revision.source` is provenance, not universally an owner: `accountSource` is null unless the derived account agent participates. Provider contributions have provider provenance and must retain source-fence authority. Do not infer ownership from subject creator, adopter, target, or a null source.             |
| Acceptances, adoptions, retractions, hidden-candidate and moderation decisions    | Editorial decision identities survive. Delete suppresses a candidate independently of these decisions. Restore re-evaluates the current acceptance/adoption, Context state, target consent, source fence and moderation. It never rewinds an adoption head or creates an old decision under a reused revision ID.                                                                                                                                                                                                  |
| Community Context                                                                 | `createContext` calls `initializeResourceGrants` with type `semantic.context` and the creator. The resource owner role is authoritative; creator history alone does not supersede a later grant/transfer. The existing `semantic.context.owner` role must also include `context:delete` and `context:restore`; no creator-only lifecycle role is introduced. This integration is required, not implemented by this specification. Global is seeded communal authority and cannot be deleted as a personal Context. |
| Account-agent names and links                                                     | `account_agent_subject` maps account, derived agent and verified survivor. `ensureAccountAgent(name:null)` already erases all derived labels in place and emits an ID-only identity event. This is an explicit field clear, not a new whole-record delete. Verification preserves the survivor's communal labels. Account erasure must clear personal labels and de-identify retained public attribution without erasing catalogue survivor identity.                                                              |
| Private `sourceOrConsent` assertions                                              | `statement_disclosure.account_id` and the current target account link establish consent authority. Only the target owner can disclose/retract; sourced third-party claims are not owned by their target. Private assertions and personal linkage require automatic payload cleanup, not indefinite immutable history.                                                                                                                                                                                              |
| Authored documents/media                                                          | Semantic holds IDs/digests/language, Content holds body/licence/acting account. Submit exact locators and obtain cleanup custody through Content's existing surface. Never duplicate or SQL-delete Content's store.                                                                                                                                                                                                                                                                                                |

Stable deleted account IDs may remain in de-identified attribution as Access explicitly permits. Names, handles,
profile snapshots and private target relationships may not. Unknown/current release types require classification
by stored payload and real ownership, not a whitelist of currently bundled type names. Existing software-agent
kind rejection and the special name-erasure trigger must remain unchanged.

## Evidence already implemented

Read surfaces audited: `subject.ts`, `read.ts`, `slots.ts`, `page.ts`, `graph.ts`, `links.ts`,
`search-source.ts`, `disclosure.ts`, their point/range SQL and HTTP subjects/contexts/subject-pages routes.
Write surfaces audited: `candidates.ts`, `bulk.ts`, `context.ts`, `moderation.ts`, `statement-disclosure.ts`,
`account-agents.ts`, `agents.ts`, definition publication, and the semantic schema mutation guards.
Shared custody evidence: `command/fence.sql`, Access's account deletion policy and committed deletion runner,
`work/modules.ts`, `work/registry.ts`, `work/retention.ts`, and Content's authored-field contract.

- Subject hide/takedown/restore changes visibility/security revision, retains data and decisions, and hides
  ordinary reads. Candidate hide/takedown/restore uses `hidden_candidate` and slot recomputation. Native tests
  `visibility.test.ts` and `statement-visibility.test.ts` establish that narrower behavior, not deletion coverage.
- `validateModerationBody` accepts a free-text notice scope but does not apply a machine-addressed field mask.
  Hiding an entire candidate is insufficient when only its value is covered and its references remain publishable.
- Disclosure retraction is terminal, applies to the special consent assertion and emits a revision; it is not
  an ordinary owner's 30-day deletion/restore route. Bulk source retraction preserves provenance/references and
  removes a current source claim; it is not proof that personal payload has been purged.
- Source-fence reads already withhold imported subject/candidate/search entries at source read. Native imported
  field tests establish this; retain those guards. A projection event alone does not establish immediate revocation.
- `readCandidateDisclosure` checks subject visibility and hidden candidate state for Content. It needs the new
  lifecycle/field availability state without becoming a second authorizer.
- `subjectSource.read` filters private/retracted/hidden statements but has no deleted-candidate state to consult.
  Search's indexed copies require current source disclosure checks while consumers pause, not merely eventual reindex.
- `GET /v1/subject-pages` is a 503 stub. It proves no sitemap leak today, but no implemented listing guarantee.
  Its eventual owner must apply lifecycle availability before returning labels/metadata.
- Immutable fact/revision/moderation guards preserve history, with a narrow derived-agent-label delete exception.
  They currently also obstruct required personal-payload removal. Split immutable identity/decision from erasable
  payload; do not remove guards wholesale or preserve a deleted body in revision/provenance/notice/receipt/outbox.
- There is no semantic retention registration in `KERNEL_WORK_MODULES`. Workflow retention deletes terminal DBOS
  history by age; it is not semantic payload retention, a legal-hold service, or proof of account erasure.

## Required observable lifecycle

Ordinary owner deletion marks the contribution or community Context deleted at domain command time T. Store
its origin and original deletion time, 30-day expiry, stable tombstone and a monotonically increasing security
state. An idempotent retry cannot restart that window. Every reader, disclosure reference, search hydration,
link page, graph, summary and live count must suppress the payload immediately, even with consumers paused.
Tombstones expose identifiers/types and permitted nonpersonal structure, never the old body or author profile.
Stored historical/aggregate counters may survive; a public count of live items must exclude unavailable items.

Within T + 30 days the current owner may restore payload availability. At exactly the deadline restoration
fails with conflict. Restore is a new operation, not reuse of the original revision. Current adoption remains
untouched; a replaced old candidate stays unselected. Current takedown, source fence, rejected acceptance,
private disclosure and deleted Context continue to withhold it. Context deletion must suppress its overlay at
selection/visibility points without scanning every subject that has ever used that Context.

Automatic work removes only personal/private fragments at expiry without platform authorization. A held key
is examined and checkpointed, never counted as purged; releasing the hold makes it eligible again. Held keys
must not disappear forever behind a forward-only checkpoint. Takedown alone creates no purge eligibility;
its retained payload can be restored after 60 days or longer. A legal order uses the separate platform purge
route, identifies its order, and records the decision without copying the covered material into the notice.
Early privacy purge also requires the platform action, and cannot destroy a taken-down field.
Only `reason: legal_order` through the platform route can remove retained takedown evidence; an active legal hold
still suspends removal, including legal-order work. An ordinary DELETE never accepts destructive semantics.

Each retention step caps source keys **before** eligibility/hold filters, then caps fragments for large histories.
Commit progress and removal atomically in one authoritative partition. Persist original deletion window,
fragment position, hold recheck state and a page receipt. Crash before commit changes nothing; replay after commit
returns the same receipt and cannot increment counts twice. A restarted adapter continues without an account-sized
transaction. Keep candidate/revision/decision identities and nonpersonal skeleton unless that skeleton is itself
private (for example an unsourced private pen-name linkage). Account tombstoning is terminal under Access;
only owned record deletion has the restoration window. Retained public contributions are de-identified; private
ones enter bounded durable purge at the injected account confirmation time, with no account grace period. No new privacy permission engine or account deletion barrier is introduced.

Terminal account confirmation immediately fences owner reads and writes; account erasure is final. This fence
does not wait for payload cleanup and cannot be reversed through an individual record's thirty-day restore.
A valid suspended bearer receives `403 account_suspended`, including on otherwise public reads. Only missing,
invalid or revoked credentials receive 401 where authentication is required; suspension never falls back to
anonymous authority. These outcomes follow the existing Access and account owner contracts.

## Executable surfaces and native adapter

The independent native test files use the migrated database, native HTTP creation/proposal/editorial commands, `createRealAccess`,
the injected domain clock, existing projection and shared `checkGrowth` capture. They do not prefill lifecycle truth
with SQL, skip scenarios, import nonexistent files, or substitute a fake job. SQL reads inspect evidence; the
existing receipt-fault trigger tests rollback and is removed in `finally`. It installs no lifecycle state.
The existing semantic index is imported. The state/locator reader is resolved reflectively only after native
create/proposal setup; retention is resolved only after a real DELETE or native account tombstone succeeds. Missing routes therefore fail as API outcomes, rather than module-load errors; the account-erasure case reaches the absent native adapter after successfully committing its real account barrier.

| Required route                                               | Action and anchor                                                                                                    | Result                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /v1/subjects/:id/candidates/:candidate`              | `statement:delete`, original write-revision resource and native author evidence                                      | 200 tombstone; stranger 403; never deletes subject                                                                           |
| `POST /v1/subjects/:id/candidates/:candidate:restoreDeleted` | `statement:restore`, original write-revision resource, native author evidence and current Global `statement:propose` | 200 availability restored or 409 expired; separate from moderation restore                                                   |
| `DELETE /v1/contexts/:id` / `POST /v1/contexts/:id:restore`  | `context:delete` / `context:restore`, current resource owner, community only                                         | 200; reads 404 during deletion; Global 403                                                                                   |
| Existing candidate `:takedown` / `:restore`                  | Existing `moderation:takedown`, Global anchor                                                                        | Machine-addressed `/value` scope retains references; moderation restore uses its existing reason body                        |
| Candidate `:purge`                                           | `semantic:purge`, platform resource grant via existing Access anchoring                                              | Explicit `reason: early` (409 for taken-down data) or `reason: legal_order` with order reference; holds remain authoritative |
| Candidate `:hold`                                            | `semantic:hold`, platform authority                                                                                  | `{held,reason}` persists/revokes hold; never ordinary owner deletion                                                         |

`semanticRetention(pool,{clock}).step({partition,limit,key})` is the required small native adapter surface for tests
and the maintenance scheduler, not a public HTTP worker route. It returns `{examined,purged,checkpoint,done}` from
committed evidence; counts are source keys, not total fragments or invented progress. Limit bounds examined keys;
a fragment continuation may leave a key unfinished. Repeating the key after recreating the adapter must return
the committed result. Production registration calls this adapter through existing Work maintenance facilities.
If shared retention adapters arrive before implementation, bind to them instead of creating another engine,
while keeping these native outcomes. Account work consumes the existing `com.rezics.access.account-tombstoned.v1`
identity/receipt, with exact account-to-owned-key locators; the adapter also advances that work by partition.

Use existing `SUBJECT_REVISED`, security/link events and Context-created authority where applicable; add
`com.rezics.semantic.record.deleted.v1`, `.restored.v1`, `.purged.v1` and `.hold-changed.v1` only for lifecycle
identities, times and decisions. No body in their payloads. Search and Content disclosure must consult current
availability regardless of delivery. Shared receipt/outbox cleanup needs exact native custody locators and
owner retention hooks, not broad JSON scans in production. Test-wide JSON evidence scans are not a job design.

## First independent state and attribution slice

Add exactly one read-only semantic export, resolved from existing `semantic/index.ts`:

```ts
readSemanticLifecycle(
  client: Pick<PoolClient, 'query'>,
  input: { target: LifecycleTarget; accountId: string; nativeT: AuthoritativeTime },
): Promise<LifecycleEvidence | null>
```

The closed shapes are declared in `lifecycle-state.test.ts`: target is either
`{kind:'candidate',subject,candidate}` or `{kind:'context',context}`; a known result contains exactly
`{target,owner,state,deletedAt,purgeAfter,held}`. State is `active | deleted | purged`; timestamps are canonical
ISO strings or null. Genuine existing native records are active with null timestamps and `held:false`, derived from known identity.
No deletion transition exists in this slice. Unknown records remain null. Owner is null unless the
queried account has exact current evidence, otherwise `{kind:'write_basis'|'owner_grant',accountId}`.
Unknown/mismatched locators return null. No body, provenance, role assignment or authorization boolean is returned.
This internal evidence includes tombstones and is never exposed without the caller's real Access check.

The caller supplies its existing RR snapshot (or native command transaction) and native authoritative T, minted
by `mintReadTime` for a read or the command executor. The reader opens no connection, transaction or writer,
uses no wall clock and evaluates current grant validity at that T. It must join proposal revision/compact fact
transaction to `editorial.write_basis` in the source partition, not use latest subject revision/adopter/creator.
A compact statement's fact transaction identifies its author even before expansion; candidate ID remains the
statement ID after expansion. Native personal proposals with null `revision.source` are a concrete reason not
to treat provenance as ownership. Provider provenance alone likewise never establishes personal ownership.
Missing or ambiguous account author evidence yields null owner, never a guessed author; report that exact
native locator before extending the contract. No indistinguishable author counterexample was found in the
native personal proposal/create paths audited here.

Access must export `resourceRoleHeld(client,{resource:{route,id},role,accountId,at})` from `access/index.ts`.
This read-only port is a production dependency of the state reader, not a prerequisite for loading the native
specification. It executes one temporal `SELECT EXISTS` on the exact same caller client: direct identity grants
only, `subject_role=''`, exact resource and role, and `valid @> at`. It adds no group or active-account
inheritance, account-state check or Access allow decision. The semantic reader validates `nativeT` with `authoritativeTimeValue` before any SQL, then supplies the
original branded `nativeT` as `at`. Access extracts the exact timestamp text itself, preserving microseconds;
neither port accepts a string, Date or forged time capability or opens a connection or transaction. The native tests
continue resolving the exact reader signature above after legal setup, without a stub or direct Access SQL
substitute for the production port.

Community owner evidence comes from the current `semantic.context.owner` resource-role grant for the queried
account at native T, through existing Access evidence semantics, not historical `resource_initialization.creator_id`
or an accept/adopt action grant. Global has active state and null owner. Author evidence itself grants no role:
lifecycle commands must still perform current Access authorization. Context lifecycle extends the existing
`semantic.context.owner` role with the two actions above. The Context command implementation owns that catalogue
edit and the sole frozen Context owner expectation update; all moderator and other role assertions remain unchanged.
This reader uses existing native records without new creation hooks, a lifecycle table or a migration.
The later owned-command slice adds a keyed mutable lifecycle overlay and extends this same reader for real
deleted/purged/held state. Do not create a second reader or a parallel permission or provenance engine.

`lifecycle-state.test.ts` owns three separately named native tests exercising proposal authors versus adopter/stranger and wrong subject,
compact contribution identity, and Context owner evidence after real role revocation. They require no missing
HTTP DELETE/restore/retention route and can pass independently when this first slice lands. `growth-lifecycle-state.test.ts` owns the separate locator
growth test, which captures only this reader after native setup across 64/512/4096 unrelated proposal history.
Later route tests prove actual transitions; fresh-state tests alone do not certify those transitions.

Structural input is closed: only the three input keys and the exact target variant keys are accepted.
Missing/extra keys (including symbols), arrays, unknown kinds and IDs that are not lowercase canonical routed
UUIDs throw `TypeError("Invalid semantic lifecycle read input")` before IO. Unminted times throw the command
port's `TypeError("Authoritative time is not from a live command attempt")` before IO, even for a route mismatch.
A structurally valid candidate whose route differs from its subject returns null after time validation without
SQL. Same-route unknown or wrong-subject candidates and unknown Contexts return null from exact keyed reads.
No visibility, source fence, redirect or body lookup suppresses this trusted identity evidence.

Proposal attribution uses its candidate revision's transaction. Virtual and expanded compact attribution uses
only the original assertion fact, never a later retraction or expansion transaction. The exact indexed assertion
probe reads at most two rows: more than one assertion is ambiguous evidence and produces null owner; a persisted
compact identity remains known even if its author fact is missing. Only an exact account principal matching the
queried account establishes owner evidence; provider/null provenance neither establishes nor negates it.

## Independent lifecycle command authority

Both fresh commands and receipt replays authorize with real Access at the genuine command T before reading a
receipt. JWT scope, creation metadata and attribution are insufficient. A stranger with scope and no current
role gets 403. Revoking the actual author or Context owner role denies fresh delete/restore and their replays.
Transferring the existing Context owner role permits the current owner to restore within the original window;
creator equality never substitutes for authority. Global DELETE is 403 even with its context:create parent grant.
The Context implementation adds only context:delete and context:restore to semantic.context.owner; it introduces
no creator-only role and leaves semantic.context.moderator unchanged.

Contribution authority is one resource per WRITE REVISION, using
`derivedId(REVISION_NS, subject + '\n' + originalRevision, route)` and the `semantic.revision.author` template
with statement:delete and statement:restore. It grants no candidate/fact ownership and no private whole-Subject
ownership. The original compact assertion's revision remains its anchor after another editor expands its slot;
the expansion editor receives no role on that original anchor. Candidate IDs and the read-only candidate locator
remain unchanged. The command anchor in the route table above is deliberately the revision, not the locator.
Delete checks that revision anchor. Restore checks it AND current statement:propose on Global, so losing proposal
authority prevents republishing while removal remains possible. There is no Access hierarchy or implicit Subject denial.

Native subject creation declares subject plus revision 1 (two manifest entries); proposal declares only its exact
next revision (one entry). Keep MAX_CREATION_RESOURCES at 16. Pre-read the actual indexed latest revision,
declare the exact expected next one before entering the command, and recheck in the body. Concurrent stale
revision retries re-run the whole command within the original deadline. The revision row must be newly recorded
THIS transaction and its actual editorial.write_basis creator must be the same account actor. Use existing
parentCreationAuthorization, the bounded creation manifest and initializeResourceGrants; no Access SQL writer,
row premint, fake creator, candidate/fact grant or backfill. Unsupported/provider principals receive no author
role; old ungranted rows stay ungranted. Core Global anchoring remains unchanged: subject:create creates and
statement:propose proposes.

The native producer additionally depends on compatible custody binding. Accounts provides
`creationDeclares(tx, resource)` as the declaration proof; CommandAuthorization.target is not custody evidence.
Content imported/cover installation accepts the real Global action plus the same-partition binding. Authored
installation on the subject route accepts `input.anchor?: UUID`, requires creationDeclares and stores that anchor.
Only after these Content changes may the producer retire authored.ts/bulk.ts authorization-resource overwrites.
These are actual pending production dependencies, not an alternative Access formula or live behavior supplied
by this specification.

Context deletion withholds its settings/defaults point, active extension and every Context-sensitive subject,
candidate, relation and link read, including already warmed extension/composed-release caches. Authorized points
return 404, never a current-release fallback. Extension publish and activation also return 404 while deleted.
Restoration preserves the same Context identity, snapshotted defaults, extension head and prior editorial decisions;
current adoption, subject visibility and candidate moderation remain authoritative. At exactly thirty days restore
returns 409 and all those reads/writes remain withheld. Context availability is checked at the current point;
commands never enumerate dependent subjects or run a relay to hide overlays.

The new compact limit fixture uses one label, one URL statement and 510 aliases across sixteen legal language
slots: 512 native compact facts without exceeding the existing 32 selections per slot or 32 aliases per language.
Its native create must initialize exactly two resources and only one author role. Evidence queries inspect the
real initialization/grant rows; they never install author grants. The two lifecycle growth files use native legal
64/512/4096 history and unrelated-population fixtures, one warmup and one repetition, shared rows/statements/blocks
capture, constant row/statement and logarithmic block bounds. Context population grows other independent
Contexts; history grows unrelated proposals on the same subject. Captures include raw lifecycle commands and
current authorized read/disclosure checks without an affected-subject scan.

## Small production briefs and dependencies

Each brief is independently reviewable, at most 400 production lines and eight production files. Tests/schema
changes are included in that estimate; split again before exceeding it. These are required work, not dispatched
changes to another owner. Acceptance files here are frozen outcomes for implementation.

| Brief                                 | Production surface, dependency and native acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned attribution and lifecycle state | Read native contribution/Context identity and exact original author evidence through the reader above, preserving existing write basis. No lifecycle table, migration, creation hooks, grant or role changes in this first slice; the later owned-command slice adds keyed mutable state and extends this reader. Preserve existing frozen role catalogue assertions. Current ownership is still revalidated after transfers/revocation. No foreign store writes. Native separately named locator/state tests and locator growth; dependency: existing write basis and Access resource owner grants, not missing lifecycle HTTP routes.                        |
| Contribution delete and restore       | New routes/actions above and current Access command authorization; attribution grants no role. One author role on the original write-revision anchor authorizes both lifecycle actions; restore additionally checks current Global proposal authority. Current slot suppression, stable revision/decision identities, original expiry and event identities. Depends on lifecycle state and the native revision-grant producer, including its compatible Content custody dependencies. Independent contribution lifecycle files retain the original two tests and history/population growth and add compact-author, grant-count and revocation/replay outcomes. |
| Context availability                  | Add delete/restore to the existing Context owner role and use current Context anchor/selection/disclosure checks. Depends on lifecycle state, not Zone implementation. Independent Context lifecycle files retain both original outcomes and add native owner transfer/revocation/replay, settings/extension availability, current withholding and Context history/population growth.                                                                                                                                                                                                                                                                          |
| Scoped takedown                       | Typed field mask applied at candidate rendering/disclosure/search source, retaining uncovered references. Existing moderation state/events remain authority. Independent of personal deletion scheduling. Native takedown test; add passage/image tests in owning body/media adapters.                                                                                                                                                                                                                                                                                                                                                                         |
| Retention page                        | Native adapter above, eligible-key/fragment indexes, hold/replay receipts and maintenance registration. Depends on lifecycle state and payload/identity split. Native minimum purge, hold/restart tests and 64/512/4096 history growth; native injected precommit receipt failure must roll back payload and progress.                                                                                                                                                                                                                                                                                                                                         |
| Payload and custody minimization      | Narrow authorized fragment erasure under immutable guards; revision/source/notice payloads and exact shared receipt/outbox custody locators. Depends on retention page; shared owners expose cleanup hooks. Native payload absence across semantic/core stores. Content adapter must prove body cleanup separately.                                                                                                                                                                                                                                                                                                                                            |
| Account erasure adapter               | Existing account-tombstone consumer and bounded owner-key lookup; retain/de-identify public, purge private and clear derived labels, including unknown/current types. Depends on locator and retention page. Native account test plus existing account-agent-erasure tests; native software-agent name clear after its type leaves the active release; add account-event replay coverage.                                                                                                                                                                                                                                                                      |
| Disclosure and foreign projections    | Current availability checks at source/read/search/link boundaries, per bounded returned page, no degree scans. Depends on lifecycle visibility; reuse existing source fence mechanisms. Paused-consumer inverse fixture below and lifecycle growth. Public numbers follow the owning aggregate-disclosure contract and its separately owned backend; no separate count authority is required here.                                                                                                                                                                                                                                                             |

## Foreign-count counterexample and aggregate authority

The native regression creates a person target and a book with one adopted `schema:author` link, drains the
link projection, takes down the book, then reads the person's inverse page without running a consumer again.
The retained internal Global counter remains 1. The current public response must contain `links:[]` and no
own `count` property. Returning exact zero, null, an approximation or the stored 1 would violate the owning
[aggregate disclosure contract](aggregate-disclosure.md). The separately owned backend must apply that
contract in the actual `links.ts`, `subject.ts` and `graph.ts` producers; this deletion audit adds no aggregate
authority or count engine. The current base still publishes the stored inverse count, so this native omission
assertion remains an honest backend regression until that implementation lands.

The initial visible complete-set count may be absent until an actual bounded complete-set proof exists.
When returned it must remain exact 1, and the visible row is still required. Omission never permits a stale
returned row. Internal counter storage, replay and projection effects remain unchanged. An exact immediate
total for arbitrarily many foreign sources cannot be established from the returned page or a caught-up relay;
never scan the full degree or add a cross-home transaction to manufacture completeness.

## Validation limits

The suite makes required behavior executable and intentionally red; it does not certify the absent implementation.
First failure in a scenario prevents later assertions executing. In particular job receipts/holds and account work
are specified, not measured on this base. Growth uses native fixture commands and shared rows/blocks/statements
capture, with 64/512/4096 history and unrelated population axes. It has no wall-time substitute or fabricated
checkpoint. Additional account-event replay, passage/image and search-index paused-worker tests remain required native
acceptance for the respective implementation briefs;
existing unavailable sitemap behavior is evidence only. No external product research was needed for this audit. The reference index was read; the contract and cited READMEs name no external reference implementation for this lifecycle surface.

The native acceptance is split by production dependency:

| File                                                  | Required evidence                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/semantic/lifecycle-state.test.ts`               | Three unchanged proposal-author, compact-author and current Context-owner state/locator tests, independent of lifecycle HTTP routes.                                                                                                                   |
| `test/semantic/growth-lifecycle-state.test.ts`        | Unchanged locator-only growth and shared capture at 64/512/4096.                                                                                                                                                                                       |
| `test/semantic/contribution-lifecycle.test.ts`        | The two unchanged original owner suppression/superseded-adoption and strict-thirty-day/current-moderation tests; compact original-author authorization, 512-fact grant cardinality, real role revocation/replay and current Global proposal authority. |
| `test/semantic/context-lifecycle.test.ts`             | The two unchanged original same-identity/Global-forbidden and paused-overlay tests; current owner transfer/revocation/replay, settings/defaults and extension read/publish/activate availability, strict expiry and current withholding.               |
| `test/semantic/growth-contribution-lifecycle.test.ts` | Unchanged delete/restore history AND population growth, original scales, warmups, repetitions and shared capture.                                                                                                                                      |
| `test/semantic/growth-context-lifecycle.test.ts`      | Native Context lifecycle and overlay reads across independent other Contexts and same-subject unrelated proposal history, at 64/512/4096 with the same bounds and capture.                                                                             |
| `test/semantic/deletion-contract.test.ts`             | Unchanged scoped takedown, minimal purge, hold/restart, account-terminal/unknown-stored-type and paused-consumer aggregate outcomes.                                                                                                                   |
| `test/semantic/growth-deletion.test.ts`               | Unchanged retention/replay growth at its original scales and capture settings.                                                                                                                                                                         |

Each file owns real setup and cleanup through the same actual `support/deletion-fixture.ts`; no file imports a
registering test module. All original nineteen tests remain registered, with their original bodies preserved
across the lifecycle moves. Independent command writers can run their exact lifecycle files without unrelated
retention/account/purge routes. A missing route remains a failed outcome. Missing producer/runtime behavior is
intentionally red until the real dependencies and command implementations land; first failure prevents claiming
later assertions or larger growth scales were exercised. This specification changes no production code, frozen
acceptance file, role catalogue, planner, deadline or growth slack. Aggregate disclosure remains owned by
aggregate-disclosure.md. Attributed reads pass the original native AuthoritativeTime object unchanged, never a
Date or string substitute.

This independent lifecycle acceptance preserves the [filtered-list contract](../../../../docs/filtered-lists.md):
complete indexed observations, current disclosure and the pending identity epoch remain separate obligations.
Individual delete/restore and the ordinary subject-publication component checks do not certify query-level
privacy acknowledgement, filtered-list execution or durable identity publication. Existing native Source chunk
limits retain their own scope. These tests require neither universal raw-leaf replay nor whole-slot list proofs,
per-page identity sweeps or a copied personal-fact witness store. Those engines and their native acceptance remain
with their existing owners; no README serialization or unrelated publication-store implementation is a dependency
of this specification.
