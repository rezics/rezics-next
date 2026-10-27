# Semantic deletion contract

This is an audit and executable specification of required work for the first public scope in
[scope](../../../../docs/scope.md) and [deletion](../../../../docs/deletion.md). It adds no production lifecycle.
The native outcome tests intentionally fail on missing behavior. Zones have a separate lifecycle contract;
Content owns authored document bodies and media, Access owns account deletion, and Content owns source fences (imports consumes that authority).
Do not implement their stores here. The policy in docs/deletion.md applies in full, including automatic purge,
minimal payload removal, legal holds, and reversible takedown without a destructive deadline.

## Records and authority

| Actual record                                                                     | Ownership evidence and required disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `semantic.subject`, identity facts, definition releases and activation identities | Communal catalogue authority, not private property of the creating account. Do not grant subject/release deletion from creation attribution alone. Preserve types, IDs, nonpersonal relations and release meanings. Personal fields still require targeted minimization under legal order or applicable erasure.                                                                                                                                                                                       |
| `semantic.candidate`, compact statement facts, proposals and their revisions      | A contribution can be account-owned. Resolve `revision.recorded_transaction_id` to `editorial.write_basis` by partition and transaction; `principal_kind/principal_id` identifies the actor. `revision.source` is provenance, not universally an owner: `accountSource` is null unless the derived account agent participates. Provider contributions have provider provenance and must retain source-fence authority. Do not infer ownership from subject creator, adopter, target, or a null source. |
| Acceptances, adoptions, retractions, hidden-candidate and moderation decisions    | Editorial decision identities survive. Delete suppresses a candidate independently of these decisions. Restore re-evaluates the current acceptance/adoption, Context state, target consent, source fence and moderation. It never rewinds an adoption head or creates an old decision under a reused revision ID.                                                                                                                                                                                      |
| Community Context                                                                 | `createContext` calls `initializeResourceGrants` with type `semantic.context` and the creator. The resource owner role is authoritative; creator history alone does not supersede a later grant/transfer. Current owner actions are accept/adopt/access:grant; lifecycle actions are missing. Global is seeded communal authority and cannot be deleted as a personal Context.                                                                                                                         |
| Account-agent names and links                                                     | `account_agent_subject` maps account, derived agent and verified survivor. `ensureAccountAgent(name:null)` already erases all derived labels in place and emits an ID-only identity event. This is an explicit field clear, not a new whole-record delete. Verification preserves the survivor's communal labels. Account erasure must clear personal labels and de-identify retained public attribution without erasing catalogue survivor identity.                                                  |
| Private `sourceOrConsent` assertions                                              | `statement_disclosure.account_id` and the current target account link establish consent authority. Only the target owner can disclose/retract; sourced third-party claims are not owned by their target. Private assertions and personal linkage require automatic payload cleanup, not indefinite immutable history.                                                                                                                                                                                  |
| Authored documents/media                                                          | Semantic holds IDs/digests/language, Content holds body/licence/acting account. Submit exact locators and obtain cleanup custody through Content's existing surface. Never duplicate or SQL-delete Content's store.                                                                                                                                                                                                                                                                                    |

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

## Executable surfaces and native adapter

The two test files use the migrated database, native HTTP creation/proposal/editorial commands, `createRealAccess`,
the injected domain clock, existing projection and shared `checkGrowth` capture. They do not prefill lifecycle truth
with SQL, skip scenarios, import nonexistent files, or substitute a fake job. SQL reads inspect evidence; the
existing receipt-fault trigger tests rollback and is removed in `finally`. It installs no lifecycle state.
The existing semantic index is imported. The state/locator reader is resolved reflectively only after native
create/proposal setup; retention is resolved only after a real DELETE or native account tombstone succeeds. Missing routes therefore fail as API outcomes, rather than module-load errors; the account-erasure case reaches the absent native adapter after successfully committing its real account barrier.

| Required route                                               | Action and anchor                                                                                          | Result                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DELETE /v1/subjects/:id/candidates/:candidate`              | `statement:delete`, candidate resource, existing Access grants plus native contribution ownership evidence | 200 tombstone; stranger 403; never deletes subject                                                                           |
| `POST /v1/subjects/:id/candidates/:candidate:restoreDeleted` | `statement:restore`, same candidate resource and current owner authority                                   | 200 availability restored or 409 expired; separate from moderation restore                                                   |
| `DELETE /v1/contexts/:id` / `POST /v1/contexts/:id:restore`  | `context:delete` / `context:restore`, current resource owner, community only                               | 200; reads 404 during deletion; Global 403                                                                                   |
| Existing candidate `:takedown` / `:restore`                  | Existing `moderation:takedown`, Global anchor                                                              | Machine-addressed `/value` scope retains references; moderation restore uses its existing reason body                        |
| Candidate `:purge`                                           | `semantic:purge`, platform resource grant via existing Access anchoring                                    | Explicit `reason: early` (409 for taken-down data) or `reason: legal_order` with order reference; holds remain authoritative |
| Candidate `:hold`                                            | `semantic:hold`, platform authority                                                                        | `{held,reason}` persists/revokes hold; never ordinary owner deletion                                                         |

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

The closed shapes are declared in `deletion-contract.test.ts`: target is either
`{kind:'candidate',subject,candidate}` or `{kind:'context',context}`; a known result contains exactly
`{target,owner,state,deletedAt,purgeAfter,held}`. State is `active | deleted | purged`; timestamps are canonical
ISO strings or null. New records are active with null timestamps and `held:false`. Owner is null unless the
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

Community owner evidence comes from the current `semantic.context.owner` resource-role grant for the queried
account at native T, through existing Access evidence semantics, not historical `resource_initialization.creator_id`
or an accept/adopt action grant. Global has active state and null owner. Author evidence itself grants no role:
later lifecycle commands must still perform current Access authorization, with dedicated lifecycle actions as
needed; preserve frozen editorial role catalogues. This reader and creation metadata share the existing native
writer; do not create a parallel permission or provenance engine.

Three separately named native tests exercise proposal authors versus adopter/stranger and wrong subject,
compact contribution identity, and Context owner evidence after real role revocation. They require no missing
HTTP DELETE/restore/retention route and can pass independently when this first slice lands. The separate locator
growth test captures only this reader after native setup across 64/512/4096 unrelated proposal history.
Later route tests prove actual transitions; fresh-state tests alone do not certify those transitions.

## Small production briefs and dependencies

Each brief is independently reviewable, at most 400 production lines and eight production files. Tests/schema
changes are included in that estimate; split again before exceeding it. These are required work, not dispatched
changes to another owner. Acceptance files here are frozen outcomes for implementation.

| Brief                                 | Production surface, dependency and native acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned attribution and lifecycle state | Add keyed contribution/Context lifecycle payload metadata and exact native author locator, preserving existing write basis. Minimal migration plus candidate/Context creation hooks and the read-only reader above; no grant or role changes in this slice. Preserve existing frozen role catalogue assertions. Current ownership is still revalidated after transfers/revocation. No foreign store writes. Native separately named locator/state tests and locator growth; dependency: existing write basis and Access resource owner grants, not missing lifecycle HTTP routes. |
| Contribution delete and restore       | New routes/actions above and current Access command authorization; attribution grants no role. Dedicated lifecycle action grants do not expand frozen editorial roles. Current slot suppression, stable revision/decision identities, original expiry and event identities. Depends only on lifecycle state. Native first two tests and history growth.                                                                                                                                                                                                                           |
| Context availability                  | Owner lifecycle actions and current Context anchor/selection/disclosure checks. Depends on lifecycle state, not Zone implementation. Native community deletion/restore and paused-overlay fixture; add Context settings/extension visibility cases before claiming full coverage.                                                                                                                                                                                                                                                                                                 |
| Scoped takedown                       | Typed field mask applied at candidate rendering/disclosure/search source, retaining uncovered references. Existing moderation state/events remain authority. Independent of personal deletion scheduling. Native takedown test; add passage/image tests in owning body/media adapters.                                                                                                                                                                                                                                                                                            |
| Retention page                        | Native adapter above, eligible-key/fragment indexes, hold/replay receipts and maintenance registration. Depends on lifecycle state and payload/identity split. Native minimum purge, hold/restart tests and 64/512/4096 history growth; native injected precommit receipt failure must roll back payload and progress.                                                                                                                                                                                                                                                            |
| Payload and custody minimization      | Narrow authorized fragment erasure under immutable guards; revision/source/notice payloads and exact shared receipt/outbox custody locators. Depends on retention page; shared owners expose cleanup hooks. Native payload absence across semantic/core stores. Content adapter must prove body cleanup separately.                                                                                                                                                                                                                                                               |
| Account erasure adapter               | Existing account-tombstone consumer and bounded owner-key lookup; retain/de-identify public, purge private and clear derived labels, including unknown/current types. Depends on locator and retention page. Native account test plus existing account-agent-erasure tests; native software-agent name clear after its type leaves the active release; add account-event replay coverage.                                                                                                                                                                                         |
| Disclosure and foreign projections    | Current availability checks at source/read/search/link boundaries, per bounded returned page, no degree scans. Depends on lifecycle visibility; reuse existing source fence mechanisms. Paused-consumer inverse fixture below and lifecycle growth. Exact foreign live totals need the decision below before implementation claims them.                                                                                                                                                                                                                                          |

## Foreign-count counterexample and manager decision

The last native regression creates a person target and a book with one adopted `schema:author` link, drains the
link projection, takes down the book, then reads the person's inverse page without running a consumer again.
The source summary is withheld, but `read-inbound-link-count.sql` obtains only the target-local stored count:
`COALESCE(inbound_link_count.value,0) + COALESCE(inbound_link_context_count.value,0)` for the fixed target,
Global Context, property and nil filter key. It has no current source availability predicate. The README explicitly
states summary filtering leaves counts unchanged. The test demands zero publicly live items; the focused check returned
`{"links":[],"count":{"value":1,"exact":true},"freshness":{"consistency":"eventual","target_seconds":10,"caught_up":true},"next":null}`.
The actual [count query](read-inbound-link-count.sql) probes only target-local aggregates, as described above. This is an existing native route counterexample independent of missing DELETE.

An exact immediate total for arbitrarily many foreign sources cannot be established by checking only the
returned page, nor by waiting for paused relays. The current fixed-budget read has no shared revocation aggregate.
A shared ABI decision requested from the manager is pending. The manager must resolve an exact count
authority/dependency contract before this can be claimed solved. This specification does not choose nullable
counts, approximations or a new cross-home aggregate. Do not
silently label the stale integer a live count, scan the full degree, introduce a cross-home transaction, or relax
the policy. Retained stored counters remain permissible skeleton. Bounded disclosure of returned items is a
separate deliverable and does not prove an exact total.

## Validation limits

The suite makes required behavior executable and intentionally red; it does not certify the absent implementation.
First failure in a scenario prevents later assertions executing. In particular job receipts/holds and account work
are specified, not measured on this base. Growth uses native fixture commands and shared rows/blocks/statements
capture, with 64/512/4096 history and unrelated population axes. It has no wall-time substitute or fabricated
checkpoint. Additional Context settings/extension, account-event replay, passage/image and search-index
paused-worker tests remain required native acceptance for the respective implementation briefs;
existing unavailable sitemap behavior is evidence only. No external product research was needed for this audit. The reference index was read; the contract and cited READMEs name no external reference implementation for this lifecycle surface.

Root TC0 (`bun scripts/typecheck.ts`) passed for this reconciliation, including the final executable tests.
Focused lint, formatting and `git diff --check` passed. The corrected specification was committed before waiting
for the native check host. The exact focused acceptance command was attempted twice. The first acquired host
`a` after 3983 seconds, then failed during workspace upload: SSH closed and rsync exited 255. The retry acquired
host `b` after 166 seconds, then failed at the same pre-execution upload stage: SSH closed and rsync exited 12;
the runner also reported that it could not remove its remote run directory. No native test results were returned
on either attempt. No unrelated process, database or container was stopped or removed.

The prior attempt's two passing account-agent invariants and native inverse-count counterexample are retained;
its results do not certify the corrected account timing or the independent state/locator acceptance added here.
Missing lifecycle routes, scoped withholding, the state/retention adapters and the unchanged exact-live count
assertion remain expected native reds, **not observed outcomes of this reconciliation**. Neither 512/4096 growth
measurements nor account-at-confirmation cleanup, legal holds or replay results are claimed. Native validation
is blocked by the check-host workspace-upload transport failures, not by a test-slot wait or a product-code change.

Continuation validation preserved all existing acceptance assertions and rechecked the reconciliation against the
latest deletion policy. Root TC0 completed successfully again across every workspace; focused lint, formatting
and diff checks also passed. The exact focused acceptance command was retried with the unchanged native tests.
It waited for a slot for 276.133 seconds on host `b`, then SSH closed during workspace upload and rsync exited 12. The runner raised `RemoteTransportError` for `workspace upload` and exited 1 before returning any native
test result. This independently reproduces the supplied evidence's transport failure; it supplies no new
lifecycle, account-erasure or growth outcome. No production files or acceptance tests were changed in this
continuation, and no file outside the declared specification paths was changed.
