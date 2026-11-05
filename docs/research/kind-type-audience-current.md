# Native Collection Kind: the missing Type and audience boundary

Research against `5b47f356a55f472f5f4debde53e9f22c34f340fa`, 2026-10-31.
This is source analysis, not native proof, runtime readiness, permission approval or an adopted design.
The other investigation was not consulted. No implementation, test or owner document was changed.

## Finding and recommendation

There is no existing actorless Type-audience permission callable to connect to Kind.
The missing input is **native evidence of the exact original and terminal disclosure decision,
its audience binding, complete changing dependencies and validity at the consuming attempt's T**.
A live work transaction, Source custody, identity observation and audience namespace provide different facts.
Their conjunction does not produce that missing evidence. Changing `readType` to accept a locator cannot fix it.

Recommend request-assisted production of native evidence while the actual Actor exists, followed by
actorless consumption limited to the admitted Library episode. Reuse the installed Accounts formula inside
the original native producer; never invoke an ordinary summary reader as the worker's authorization adapter.
Expired or changed audience evidence requires fresh production with an actual request Actor. This is an
explicit lifecycle contract change, not an existing capability. Fully autonomous private-audience repair
after that request ends instead requires a separately adopted Accounts authority contract; see the options below.
Neither option can call the present implementation complete or make pending its permanent product outcome.

## Exact existing inventory

Paths below are relative to `services/kernel/src/`; links pin the inspected source revision.

| Owner and source                                                                                          | Actual callable/data and boundary                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core, [command/operational.ts][operational], `runOperationalTransaction`, lines 87–215                    | Work-step rejects principal/basis/authorization; mints one T, takes the partition fence and account terminal fences, and exposes a live transaction only inside its body. `enqueueIntent` requires exactly the fenced accounts. It does not authorize Subject reads.                                                                                                                                        |
| Core, [command/command.ts][command], lines 266–317                                                        | `authoritativeTimeValue`, `commandTime`, `withOperationalAttempt`, `releaseOperationalTime`: T is registered object identity, removed when the attempt ends. A timestamp, deserialized object or T retained after completion cannot replace it.                                                                                                                                                             |
| Library, [collection-kind.ts][kind], lines 321–430                                                        | `CollectionKindSourceStep` explicitly extracts the **Actor** Source branch. `readType({subjectId,at,actor,deadline,allowance})` returns a Type plus `WorkReceipt`, or unavailable. It is called only after positive canonical membership; that alone cannot retain excluded-original Type/disclosure dependencies.                                                                                          |
| Library, [collection-kind-preparation.ts][preparation], `current`, `retained`, `resolve`, `resume`        | Actual metadata authorization uses Actor; retained scope lookup joins native capture/receipt. Only anonymous preparation and genuinely zero scanned population proceed. `resume.readType` calls `readSubjectSummaries` behind an undefined footprint, which refuses native dispatch. Private/nonempty proof is absent.                                                                                      |
| Library, [collection-kind-work-admission.ts][admission]                                                   | `CollectionKindPreparationLocator={route,ownerAccountId,collectionId,preparationId}`. `CollectionKindWorkDefinition={releaseDigest,audience,sourceIdentity,observation,identityObservation,repairReceipt,custody}`. BOTH `admitCollectionKindPreparationStep(tx,locator)` and `readCollectionKindWorkDefinition(tx,locator)` throw `dependency_unavailable`. These are declarations, not working admission. |
| Search, [scope-work-context.ts][context], lines 31–112, 125–131                                           | Distinct `CollectionKindPreparationWorkContext={kind:'collection-kind-preparation',tx,locator}`. `readCollectionKindPreparationWorkDefinition` checks live Core work-step/pool/partition/owner/deadline, calls ORIGINAL Library admission/getter, validates their entire result, then `admitScopeWork` returns `commandTime(tx)`. It supplies technical work input, not permission.                         |
| Library, [collection-source-work-native.ts][sourcework], lines 53–145                                     | `readCollectionSourceWorkState` rereads admission and local metadata, canonical scope/head/generation, identity digest and exact Source basis. Kind rejects curated input here; public output is explicitly unsupported here. Do not substitute Members or a public catalogue capture.                                                                                                                      |
| Accounts, [request/access.ts][access], lines 135–239, 272–307                                             | `PrepareReadDecisionsInput.actor`, `accessCheck(access,actor,action,resource,context)` and native prepared-check factory all require Actor. `PreparedAccessCheckInvocation={client,time,work}` accounts for the SAME prepared invocation; it cannot change its actor binding.                                                                                                                               |
| Accounts, [access/permission.ts][permission], lines 140–205, 231–378, 872 onward                          | Actual implementation of preparation, decision and prepared-work binding. `prepared`/`readEvidence` are process-local WeakMaps; copied/serialized values are not proof. `prepareReadDecisions` requires SAME native T when metered. The contract's `access/decisions.ts` does not exist at this revision; implementation is here, not a hidden overload.                                                    |
| Accounts, [access/eligibility.ts][eligibility]                                                            | Prepare/verify contexts both require Actor. Capability/evidence registries bind action/resource/actor/deadline. Verification runs at the formula's T; missing required disclosure must fail the whole check, not merely disable the public floor.                                                                                                                                                           |
| Semantic, [subject.ts][subject], `readItemTypes`, lines 863–867; `read-item-types.sql`                    | Structural visible-row projection, <=256 IDs; no Access or WorkReceipt. SQL also reads the account-agent link. It is not a subject Type grant or the proposed narrow evidence producer.                                                                                                                                                                                                                     |
| Semantic, [summaries.ts][summaries], lines 93–148; [list-presentation.ts][presentation], lines 352 onward | Summaries use actual Actor/current `subject:read` plus eligibility, then hydrate labels/images/editions. List facts use actual Actor, original/terminal reads, identities, provenance, Accounts and tuple fences, with released homes and final comparisons. Neither exports admitted Kind Type evidence or a Source WorkReceipt.                                                                           |
| Semantic, [scope-leaf-evidence.ts][leaf], lines 147–165, 451–454                                          | `LeafOptions` has a distinct actorless work union, but its work branch refuses before IO. `LeafNativeWork` in `scope-leaf-selection.ts` has real finite accounting; its existence does not implement the missing work audience.                                                                                                                                                                             |

`collection-kind.ts:createCollectionKindReads` performs audience selection, one exact observation lookup,
completeness/source-generation checks, then `native.revalidate({actor,...})` before returning the winner.
It neither enqueues preparation nor enumerates members. `collection-kind-work.ts:stepCollectionKind` currently
calls prepare/page/revalidate **outside** its operational adoption transaction; local CAS/adopt follows.
Consequently simply passing that transaction into the existing foreign Type reader would change sequencing
and hold the Source home during foreign IO. The selected Search context alone does not bridge this gap.

Native provenance that is present:

- `library.collection_kind_observation` is keyed by `(route,collection_id,audience)` and retains generation,
  source_generation, capture, frontier, version, completion and winner. `collection_kind_subject` retains
  `(route,collection_id,audience,generation,subject_id,type_id)`; `collection_kind_count` retains per-Type votes.
  These rows contain neither original/terminal disclosure proofs nor their permission dependencies. A proposed
  evidence page needs an owner-native retained binding; none of these existing rows is that receipt today.
- `library.canonical_source_scope` contains identity/frontier/capture/committed revision; the preparation
  SQL joins `library.native_source_capture` and `library.native_source_receipt`, checks receipt/capture xmin
  equality and excludes the current native xid. This proves that specific committed capture, not Type visibility.
- `native-source-custody.ts` exports `capturePage`, `finishCapture`, `readAndHold`, `revalidateHold`,
  `releaseHold`. Capture carries identity/captureId/transactionId/position/scanned; custody carries exact
  identity/captureId/holdId/transactionId under private brands. `native-source-custody-proof.sql` additionally
  checks active native partition epoch/position and receipt binding. `readAndHold` accepts an actual admitted
  operational client through its native runtime check; do not cast a transaction to fabricate admission.
- `nativeSourceFence` hashes actual incarnation, owner epoch, authority, source generation, fact fence and
  output generation. `library.native_source_fence` has native writer triggers for collection/account facts.
  Its `account` fence is not a general permission-policy revision. Custody's account probe checks active,
  authn-fenced and minimum-authn-epoch state; `fenceOperationalAccount` checks active/fenced under `FOR SHARE`.
  Neither proves all grant, ban, delegation, client scope or Subject disclosure dependencies.
- `IdentityScopeObservation={key,captureId,committedRevision}` and native `IdentityNativeReceipt` belong to
  Semantic identity repair. `identity-scoped-observations.ts:revalidate` verifies that enrolled identity scope.
  Identity coverage does not imply enrollment of Type/visibility/permission writers.
- Semantic `scope-leaf-selection-anchor.sql` reads visibility/security_revision/type/current_release/latest
  revision/redirect. `scope-leaf-selection-privacy.sql` probes exact hidden/retraction/disclosure rows.
  `semantic/eligibility.ts:subjectReadEligibility` compares current visibility/security revision.
  Content `readFences` returns exact tuple takenDown/securityRevision; `semantic/fences.ts:readAnchoredFences`
  verifies the tuple's native home in a released read transaction. A source tuple fence is not a viewer grant.

The native tests inspected are `test/library/collection-kind-native-preparation.test.ts` (nonempty anonymous
AND authenticated completion, hidden-Type invalidation), and `test/search/scope-kind-work-context.test.ts`
(distinct Kind locator, forged/expired contexts, real Core transaction insufficient without committed episode).
They require successful supported completion and preservation of refusals; neither permits synthetic Source success.

## Admission cycle and authority distinction

No TypeScript import cycle inherently requires completed Kind evidence before admission. A native implementation
would create a cycle if Library admits only a **completed Type observation**, while Semantic first needs that
admission to create Type evidence. Admit the immutable committed _prepare/repair intent and exact Source custody_
before Type production; completion/adoption is a later state. Never admit a missing Source capture to break it.
The repair receipt in the definition must remain the actual identity repair receipt, not a fabricated Type receipt.

Internal authority must mean: the original Library module admitted this exact maintenance episode to consume
these exact native evidence rows for this Source, under current owner/account fences. Its work context is not
ordinary `subject:read`. Final disclosure must still mean: the current actual viewer passes the installed
ordinary formula and exact audience match, with the original AND terminal dependencies current.
Neither meaning currently supplies the other's missing producer. An audience hash only separates namespaces.

## Recommended minimum contract, conditional on owner adoption

These are **proposed** literals/exports, not existing functions, evidence brands or authority grants.
Keep all additions in the original modules. A locator's fields are lookup keys; possession authorizes nothing.
Do not add any field to the existing WorkDefinition as a guessed structural substitute.

```ts
// Library: collection-kind-work-admission.ts; same native preparation namespace.
type KindTypePageRef = Readonly<{
  kind: 'collection-kind-type-page';
  version: 1;
  locator: CollectionKindPreparationLocator;
  pageId: string;
}>;
// Accounts: access/permission.ts; private native registry/retained-record brand.
declare const kindAudienceEvidence: unique symbol;
type KindAudienceEvidence = Readonly<{ [kindAudienceEvidence]: true }>;
// Semantic: scope-leaf-selection.ts; the row is internal, not a response/debug DTO.
type KindTypeDisposition =
  | Readonly<{ original: string; terminal: string; state: 'vote'; typeId: string }>
  | Readonly<{ original: string; terminal: string | null; state: 'excluded' | 'duplicate' }>;
type KindTypePageResult =
  | Readonly<{ status: 'current'; page: KindTypePageRef; rows: readonly KindTypeDisposition[]; work: WorkReceipt }>
  | Readonly<{ status: 'unavailable'; work: WorkReceipt }>;
// Semantic: scope-leaf-evidence.ts; consumes original native selection plans.
declare function prepareCollectionKindTypeEvidence(
  input: Readonly<{
    actor: Actor;
    work: CollectionKindPreparationWorkContext;
    allowance: WorkAllowance;
    deadline: number;
  }>,
): Promise<KindTypePageResult>;
// Library: collection-kind-preparation.ts; source-local consumption only.
declare function readCollectionKindTypeEvidence(
  input: Readonly<{
    work: CollectionKindPreparationWorkContext;
    page: KindTypePageRef;
    allowance: WorkAllowance;
    deadline: number;
  }>,
): Promise<KindTypePageResult>;
```

`work` selects the attempt; its native `commandTime(work.tx)` supplies T, never an additional caller time.
The preparation signature intentionally makes the missing real Actor explicit; the consumer has none.
Accounts must produce its private `KindAudienceEvidence` only while verifying that actual request Actor,
using original native formula/eligibility preparation and actual-work declarations, never by deserializing one.
It must expose bounded producer/verifier hooks to Semantic, **not** a public `allow` flag or stored client principal.
This brand is a required new contract; no current Accounts function can manufacture the proposed retained evidence.

| Field or evidence                         | Original owner, actual provenance and verification point                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locator`, `pageId`, version/tag          | Library creates under the committed Kind preparation, binds one immutable Source capture, release, audience namespace and original input interval. Reread native row plus committed receipt; strings/JSON do not establish provenance.                                                                                                                                                                                        |
| Source binding                            | Reuse the exact definition's `sourceIdentity`, `observation`, `custody`, `identityObservation`, `repairReceipt`, `releaseDigest`; verify current native scope/head/generation/hold and owner epoch on every admitted use. Preserve private_builtin versus output versus curated authority distinctions.                                                                                                                       |
| `KindAudienceEvidence`                    | Accounts owns origin authentication provenance, exact request-to-audience binding, formula/policy version, native account/operator/delegation/membership/client-scope/grant/denial observations, temporal validity and currentness verification. AuthnEpoch in Actor is not the whole authentication proof; Actor contains no bearer-expiry field. Require the native producer's lifetime, never invent one from this struct. |
| `original`, `terminal`, `state`, `typeId` | Semantic owns independently anchored original and terminal selection, identity version/mapping, visibility/security/release/revision, required disclosure and exact provenance tuple observations. Persist denied/absent/duplicate dispositions without disclosing their Type. Only eligible terminal contributes its exact Type once.                                                                                        |
| Completeness/currentness                  | Library owns sealed raw interval/EOF and progress/CAS. Semantic owns original/terminal positive AND negative dependency coverage. Accounts owns permission/time dependencies. Type values alone and existing identity observations are insufficient.                                                                                                                                                                          |
| `work`                                    | Existing native Source/Access producers alone return actual receipts. Library translates through its existing ledger. The SAME reservation includes request evidence production, rejected originals, duplicate/alias/lookahead work, verification, final local adoption and cleanup.                                                                                                                                          |

Produce a disposition for every examined original, including excluded originals and aliases of an already counted
terminal. Denied original cannot be rescued by readable terminal; denied terminal cannot contribute via readable
original. Missing evidence is unknown, not exclusion or EOF. Retain the dependencies of negative decisions so
a later disclosure/grant/identity change extends or invalidates the observation. Do not read hidden original Type
merely to populate the record. If Type is needed by a selector, its own disclosure must first be established.
Audience-specific raw Type rows, counts and tie candidates remain private. A public observation is separately
produced against its own native Source/audience; no fallback from a missing private observation to public.

## Exact sequencing, bounds and the remaining unavoidable change

1. Real request/select commits an immutable native Kind prepare intent with Source binding. Origin Actor lives
   only in the request's memory. Queue data names only the native locator, not JWT, Actor or authority claims.
2. Core admits a bounded attempt and mints its sole T. Fresh request evidence production must run before foreign
   checkouts while retaining no Source connection. Each foreign home gets its own anchored repeatable-read
   snapshot, then releases before another home, Accounts preparation, or final Source checkout. After a wait,
   reprepare expired evidence; native T is never silently reminted inside one attempt.
3. Reserve the complete finite plan before IO through existing accounting. Keep raw100 and 4096 vote/progress
   bytes; charge every excluded/duplicate/alias/lookahead key. Account all eight Source axes; Access keys/points/
   witnesses/rows/bytes/emptySeeks map to them through the original bridge, with statements and metadata charged
   separately. Subject Type byte length, dependencies and provenance fanout require explicit finite bounds.
   Use the original anchor/eligibility point declarations; do not inherit the summary hydration footprint.
   Unknown footprint refuses before dispatch; a dispatched failure burns its reserved bound and poisons the
   attempt if its actual receipt is missing. Per-attempt reservation identity never carries authority across retries.
4. Split oversized groups/dependency sets into retained pages; keep canonical settled floor before unfinished
   groups. Total work may follow the finite input, but no step, final GET or final adoption rescans the population.
   Existing identity basis sweeps retain their separate native allowance; raw100 does not pay them implicitly.
5. After foreign work, reacquire only Source home. Verify exact intent/version, committed evidence receipt,
   Source/identity/custody/release/audience/current owner fences at this attempt's T, then atomically apply page,
   count delta, progress and next intent by existing CAS. Retry gets new native T, new receipts and revalidation.
6. Only complete canonical EOF plus complete current evidence permits a winner or genuine empty. Getter repeats
   current viewer formula/audience and Source-local evidence checks; metadata GET remains fixed-point work.
   Unknown footprint, missing producer, exhausted allowance, expired evidence or verification failure is unavailable.

Current `access/evidence-deadline.ts:ACCESS_EVIDENCE_TTL_MS` is 1000 ms, capped by request deadline;
native temporal membership/grant boundaries can shorten validity further. Retaining a Kind page must not extend
that permission lifetime. Historical provenance may survive for repair, but current-use evidence needs native
reverification at each new T and fresh Actor production when it changes/expires. Prior page work is not a receipt
for a later attempt, and an opaque evidence reference is never a cached allow.

**Two gaps prevent these steps being an implementable contract today.** First, the existing live work context
exists only inside the Source transaction body. Work-step has no pre-checkout preparation hook, and current
Kind page work occurs before that transaction. Passing a live tx into foreign preparation violates release order;
closing it invalidates its T. Core must remain the sole producer, but its original execution lifecycle needs an
explicit admitted pre-checkout preparation phase if production and final verification must share SAME work T.
This is an owner contract change, not permission that Search may infer from `admitScopeWork`.

Second, a released foreign snapshot is not currentness at a later Source-local commit. A foreign revoke or
Type change can commit after the last foreign read. One more reread merely moves that race. Existing identity
enrollment and Library fact fences do not cover all Accounts/Type/disclosure writers. Adoption needs explicit
native writer-before-visibility fencing/enrollment for those dependencies, with reductions blocking affected
Source adoption/disclosure before becoming effective and repair extending coverage before release. Negative
keys, new grants and time transitions need coverage too. No such general native permission fence was identified.
Do not invent a global permission epoch or claim a custody hold supplies it. If that guarantee cannot be added
within existing owner protocols, the manager must explicitly change the required consistency boundary.

## Two bounded options for the manager

- **A, recommended: request-assisted native evidence.** Adopt the preparation-phase change above, bounded native
  evidence production with the real Actor and explicit writer-fence coverage. Detached work only consumes sealed
  current pages; it cannot extend audience permission. New authenticated requests prepare/refresh bounded pages;
  an explicit preparation path must be wired because current GET does not enqueue. Multi-page completion and
  invalidation must actually converge under stable inputs. This preserves the prohibition on restoring identity
  and introduces no independent evaluator, grant or worker principal. It changes when private repair can advance.
- **B: autonomous maintenance.** Explicitly authorize an original Accounts actorless, purpose-limited native
  evidence producer under the committed Kind/Source episode, including its exact private-read authority,
  audience operands, expiry/revocation semantics and writer fencing. This is a new authority contract, even if
  implemented inside the existing evaluator. A locator, stored request principal or a fake `subject:read` grant
  cannot supply it. Bound it to raw100, SAME ledger/T and exact Source dependencies; exclude ordinary viewer
  permission. Choose this only if actor-independent private repair is mandatory; it cannot be silently adopted.

Option A is the smallest authority change. Option B is not derivable from current source. Both need the timing
and foreign-currentness contracts above; neither a new brand nor a finite TTL solves those by itself.

## Adversarial native cases to freeze before implementation

| Change or attack                                                                                   | Required outcome                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revoke, explicit deny/ban, suspension, account terminal T, operator/delegation/membership change   | Pause between preparation, Type production, local adoption and getter. Current native Accounts dependencies invalidate/deny before disclosure; old identity/custody success cannot override them. No serialized initiator restoration.                                                           |
| Authn floor, renewed credentials, changed client scopes/client/requestedBy                         | Fresh actual request binds its own audience; mismatch never selects another namespace. Permission receipt cannot renew authentication or lift a floor. Preserve ordinary public-floor semantics where the actual formula permits them, without a cached-winner fallback.                         |
| Type, visibility, disclosure/consent, retraction, merge/repoint, release/profile change            | Original AND terminal evidence changes invalidate before count/tie/empty disclosure. Repair restarts or extends exact dependencies; identity equality alone never certifies Type.                                                                                                                |
| Source mutation/generation/incarnation, private/public output, owner epoch/move, tuple fence drift | Reject mixed captures and old receipts. Native Source authority and tuple currentness are independent. Retain activation generation distinctions; no private capture proves public output.                                                                                                       |
| Private owner, anonymous, unrelated reader                                                         | Owner working Source requires its own native authority. Anonymous may see only its independently admitted view. Hidden Type cannot affect winning count, lexical tie or apparent emptiness. Do not expose count deltas, excluded identifiers or diagnostics.                                     |
| Excluded original, readable canonical terminal, many originals sharing terminal                    | Withheld original stays excluded; negative evidence remains enrolled. Count one eligible canonical terminal once; charge every raw support and duplicate. Newly eligible original invalidates/extends prior coverage.                                                                            |
| Missing/legacy/unbranded evidence, zero memberCount, raw EOF                                       | Unavailable; only complete native zero population is vacuous. Do not upgrade an old summary, partial scope or legacy version into current evidence.                                                                                                                                              |
| Replay, rollback, crash after receipt/page/count/intent, delayed cleanup                           | Uncommitted native xid cannot prove success. Existing generation/version CAS prevents double counting; progress/count/intent commit together. Retire only exact old hold after replacement commit; rollback leaves no adopted evidence. Closed tx/T and a receipt from another reservation fail. |
| Foreign mutation after last reread; expiry during local wait                                       | Writer fence/currentness validation must reject it before adoption/disclosure. A successful test without this interleaving would not prove the protocol. Unknown coverage remains unavailable, not permanently accepted pending.                                                                 |

## Indispensable owner changes and source patterns

Semantic must add the narrow native original/terminal Type/disclosure producer and actual finite footprint,
negative dependency enrollment and verification; adapt the existing leaf selection rather than copy summary/Access SQL.
Library must implement ORIGINAL admission/getters and committed episode/page binding, custody/currentness,
request-assisted preparation, atomic count/CAS adoption and retirement. Its Source rows remain sole population authority.
Accounts must specify/produce the exact native audience evidence and invalidation/time coverage using its existing
evaluator; prove revoked/negative dependencies as well as successful decisions. It must explicitly reject actorless
permission until any alternative authority is adopted. Search must thread the DISTINCT Kind context, shared
reservation and admitted T through preparation/consumption, without introducing admission, identity or permission.
The execution-phase extension belongs to the original Core executor and requires its owner's adoption too.

The native sources share object-identity provenance, exact full-key plans, independent home release, current
native fences and fail-closed missing evidence. PostgreSQL [snapshot isolation][pgiso] explains why released
snapshots cannot alone validate later foreign state; [row locking][pglock] protects held local rows, not released
foreign homes. OAuth [RFC 8693 §§1.1, 2.1.1][oauth] makes delegation/impersonation explicit authorization semantics;
an audience label does not itself define such authority. These support the boundary analysis, not REZICS approval.

REZICS source licence: [AGPL-3.0 licence text][license]. PostgreSQL documentation: [PostgreSQL Licence][pglicense].
RFC: IETF Trust/BCP 78 terms, with Simplified BSD terms for extracted code; no code extracted here.
Only primary repository source/tests and official documentation/standard were used; no reference clone was needed.
No checks were run: only this Markdown report changed, so no workspace typecheck applies.

[operational]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/command/operational.ts
[command]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/command/command.ts
[kind]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/library/collection-kind.ts
[preparation]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/library/collection-kind-preparation.ts
[admission]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/library/collection-kind-work-admission.ts
[context]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/search/scope-work-context.ts
[sourcework]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/library/collection-source-work-native.ts
[access]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/request/access.ts
[permission]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/access/permission.ts
[eligibility]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/access/eligibility.ts
[subject]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/semantic/subject.ts
[summaries]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/semantic/summaries.ts
[presentation]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/semantic/list-presentation.ts
[leaf]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/services/kernel/src/semantic/scope-leaf-evidence.ts
[license]: https://github.com/rezics/rezics-next/blob/5b47f356a55f472f5f4debde53e9f22c34f340fa/LICENSE
[pgiso]: https://www.postgresql.org/docs/18/transaction-iso.html
[pglock]: https://www.postgresql.org/docs/18/explicit-locking.html
[pglicense]: https://www.postgresql.org/about/licence/
[oauth]: https://www.rfc-editor.org/rfc/rfc8693.html
