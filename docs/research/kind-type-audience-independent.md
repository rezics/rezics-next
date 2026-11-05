# Native Kind Type and audience evidence boundary

This is independent source analysis, not native proof, runtime readiness, permission approval or an adopted authority contract.
Inspected 2026-10-31 at REZICS revision `5b47f356a55f472f5f4debde53e9f22c34f340fa`.
Only this report is changed. No other investigation was consulted; no runtime or acceptance checks were run.

## Finding and recommendation

There is no truthful drop-in actorless Type/audience callable on this revision. Missing boundaries are an
Accounts-native request-origin audience evidence producer, complete native invalidation of its Type/disclosure/
permission dependency closure, and native per-home producer admission beyond the live Source-local context.
The admitted Kind work context supplies technical maintenance input; it supplies neither an audience principal
nor subject permission. SAME T and accounting do not bridge those gaps.

Recommend a narrow evidence extension in the ORIGINAL owners, conditional on manager adoption of its authority
and invalidation semantics below. Keep ordinary final viewer authorization in Accounts. Do not restore an Actor,
copy a JWT/client principal into a job, interpret an audience hash as authority, or turn a retained allow into permission.
Until those producers exist, the current refusal is correct failure behavior, but it does not complete the product.

## Primary evidence and exact inventory

All repository paths below are relative to the root. The pinned [source tree](https://github.com/rezics/rezics-next/tree/5b47f356a55f472f5f4debde53e9f22c34f340fa)
is covered by the root [GNU AGPL v3 licence](../../LICENSE). Line numbers refer to that inspected revision.
No external project clone was needed or created; consequently no reference-clone index entry changed.

| Actual owner/module and location                                                               | Callable/data and the authority it actually provides                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core: `services/kernel/src/command/operational.ts:21-67,87-225`                                | `runOperationalTransaction` has distinct `request` and `work-step` modes; work rejects principal/basis/authorization. Core mints one live `AuthoritativeTime`, fences partition and named accounts, commits/rolls back, and releases T. `currentOperationalResources` and `hasLiveOperationalTransaction` check the live instance, not its shape.                                                                                                  |
| Accounts: `access/account-share.ts:7-26` under the same source root                            | `fenceOperationalAccount` holds an active, unfenced account against terminal deletion. This is not subject read authority, audience admission, client scope or a policy fence.                                                                                                                                                                                                                                                                     |
| Library: `library/collection-kind-work-admission.ts:8-38`                                      | ORIGINAL `CollectionKindPreparationLocator = {route,ownerAccountId,collectionId,preparationId}` and `CollectionKindWorkDefinition = {releaseDigest,audience,sourceIdentity,observation,identityObservation,repairReceipt,custody}`. Both `admitCollectionKindPreparationStep(tx,locator)` and `readCollectionKindWorkDefinition(tx,locator)` currently throw `dependency_unavailable`; declarations are not a delivered native episode.            |
| Search: `search/scope-work-context.ts:31-127`                                                  | DISTINCT `CollectionKindPreparationWorkContext = {kind:'collection-kind-preparation',tx,locator}`. `readCollectionKindPreparationWorkDefinition(work,{pool,access,deadline})` checks Core resources, calls Library admission/getter, compares native Source/custody/identity/release/repair bindings. `admitScopeWork` returns SAME `commandTime(work.tx)` only after that admission. Neither function produces permission.                        |
| Library: `library/collection-source.ts:22-57,90-107,159-166`                                   | `WorkAllowance`/`WorkReceipt` share a reservation and eight finite dimensions. Source context is an exclusive union: actual `actor,at` OR `work`, never both. Prepared handles and structural work membership do not assert viewer readability.                                                                                                                                                                                                    |
| Library: `library/collection-source-work-native.ts:52-155,162-243`                             | `readCollectionSourceWorkState`, `seekCollectionSourceWorkGroup`, `readCollectionSourceWorkGroup` reread the admitted native definition and local canonical generation. Exact references retain stored original, canonical terminal, driver and fact. Structural membership is not subject Type/disclosure evidence.                                                                                                                               |
| Library: `library/collection-kind.ts:69-135,307-325,414-423`                                   | Current `CollectionKindSourceStep` explicitly extracts the Actor branch; `readType({subjectId,at,actor,deadline,allowance})` returns only Type/status/work. It does not return original/terminal disclosure dependencies or a native evidence locator.                                                                                                                                                                                             |
| Library: `library/collection-kind-preparation.ts:59-66,204-244,301-359`                        | `select` uses a real Actor and hashes its request tuple for a reader-specific lookup namespace. `prepare/resume` admit anonymous only; `resolve` refuses nonzero native population. `readSubjectSummaries` is inside instrumentation with an undefined footprint, so required native dispatch is refused before execution. No private/nonempty proof is supplied.                                                                                  |
| Semantic: `semantic/subject.ts:833-866`, `semantic/read-item-types.sql`                        | `readItemTypes(client,ids<=256)` delegates to structural item details, selecting visible subject Type and optional account-agent data. There is no Actor, permission, admitted Kind work, original/terminal closure or returned work receipt. Visibility alone is insufficient.                                                                                                                                                                    |
| Semantic: `semantic/summaries.ts:51-57,80-125,163`; `semantic/list-presentation.ts:29,351-478` | Ordinary readers require actual Actor. Summaries call `accessCheck` and hydrate display data. List facts collect original/terminal/author/source-tuple observations twice and current Access; neither API accepts Kind work or returns a native `WorkReceipt`. They are behavioral references, not worker adapters.                                                                                                                                |
| Semantic: `semantic/scope-leaf-evidence.ts:75-84,147-166,264-278,451-455`                      | Work has a distinct Actor-free type branch, but execution explicitly refuses it before I/O. The ordinary Type leaf uses current Access and a live source header. A TypeScript union is not an implementation of worker permission.                                                                                                                                                                                                                 |
| Accounts: `request/access.ts:178-186,199-232,236-307`; `access/eligibility.ts:14-52,93-139`    | `prepareReadDecisions`, `accessCheck`, and eligibility prepare/verify require Actor. `PreparedAccessCheck.work` meters the SAME prepared check, native T, accounting and invocation. Its factory binds Actor/action/resource/evidence; it is not an audience/worker grant.                                                                                                                                                                         |
| Accounts: `access/index.ts:344-378`; `access/permission.ts:405-451,872-927,1045-1148`          | The real implementation is `permission.ts`; `access/decisions.ts` does not exist on this revision. The outer adapter requires native authenticated-object provenance. The inner reader retains an Actor and invokes the original `permission-check.sql` formula. No actorless overload was found.                                                                                                                                                  |
| Accounts: `access/authenticate.ts:159-205,278-332`; `access/durable-initiator.ts:57-125`       | Authentication identity is factory-local WeakMap provenance. Refresh needs that same identity and live T. Durable initiator explicitly stores Actor and uses `restoreDurable`; that mechanism is disallowed for this Kind boundary. Account IDs or reconstructed objects cannot substitute.                                                                                                                                                        |
| Native tests, read only                                                                        | `test/search/scope-kind-work-context.test.ts:25-43,66-173` distinguishes Kind/Members and rejects forged/missing episodes. `test/access/prepared-work.test.ts:340-377` rejects changed accounting/T, released T and missing owner bounds. `test/library/collection-kind-native-preparation.test.ts:15-58` requires eventual nonempty/authenticated-reader results and current hiding/source invalidation; its existence is not evidence it passes. |

The shortened `access/`, `library/`, `semantic/`, `search/`, `request/` and `test/` paths above mean
`services/kernel/src/` and `services/kernel/test/` respectively.

### Existing native rows, receipts and fences

Library's `collection-kind-preparation-scope.sql` joins exact `library.canonical_source_scope`,
`library.native_source_capture` and `library.native_source_receipt`. It checks matching capture/receipt row versions,
committed native xid provenance and completion. `native-source-custody-proof.sql` additionally checks the actual
Core partition epoch/position, active placement and a receipt from a different native transaction.
`native-source-custody.ts:358-427,530-552,814-874` binds owner/incarnation/generation/namespace, native collection/account
writer controls and the SAME live command or admitted operational client/T. Holds are retention, not current reads.
`revalidateHold` intentionally tolerates later writer generations for an old obligation; it cannot certify a new winner.

`canonical-source-store.ts:227-235` hashes incarnation, partition epoch, authority, source generation, fact fence and
output generation. `collection-source-work-native.ts:95-145` verifies native scope capture/revision, canonical head,
COMPLETE/exhausted generation and basis. These are exact Source dependencies, not grant/ban/authn dependencies.
`semantic/identity-scope-types.ts:49-54,96-108` and `identity-scoped-observations.ts:1450-1469` verify the actual
`semantic.identity_scope_summary` head's ready state, zero active claims, capture and committed revision on a local snapshot.
`IdentityNativeReceipt` (`identity-epoch-contract.ts:42-48`) is a partition/epoch/position/transaction locator, not permission.

Semantic's `scope-leaf-selection-anchor.sql` reads exact subject visibility, security revision, Type, current release,
latest native revision and redirect. `list-presentation-subjects.sql` also reads that revision's recorded transaction
and `editorial.write_basis` epoch/position. These identify native observations; they do not create Access evidence.
`subject-public-evidence.sql`/`scope-leaf-evidence-eligibility.sql` supply visibility/security only.
`content/source-fences.ts:6-18,27-36,88-96` reads exact source/external-id/field-group tuples, including absence as
`securityRevision:null`. It is an internal fact read with a supplied anchored client, not a permission check.

Accounts' actual formula owns `access.resource_grant`, `resource_role_grant`, resource denials, principal assignment,
membership/roles and Global reach; see `permission-check.sql:23-127`, `permission.ts:872-1027` and its native work
declarations in `access/work.ts`. Temporal intervals, negative probes and next transitions matter as well as positives.
Account state/floor/fence alone cannot certify this closure. The inspected modules expose no complete Source-local
audience permission-reduction fence. The required seam in `docs/collection-source.md` (“Admitted access and publication”)
and `semantic/README.md` (“Projection safety and freshness obligations”) is explicitly abstract, not a native producer.

### Admission cycle and namespace mismatch

If Library requires a finished Type/audience observation to admit Kind work, while Semantic requires admitted Kind
work to create that observation, neither can start. Admit a committed _input/maintenance intent_ first; completion
and disclosure must separately require its finished evidence. Existing Source identity capture, identity repair
receipt and custody are input prerequisites, not the missing Type evidence. Never mark incomplete evidence COMPLETE.

There is also a concrete mismatch: current anonymous Kind prepare admits curated only (`preparation.ts:241`), while
Search's Kind validator rejects curated (`scope-work-context.ts:79`) and the technical work reader repeats that
restriction (`collection-source-work-native.ts:73`). That reader also refuses `public_output`; the Search validator's
nonpublic authority check only recognizes `private_builtin`. These branches do not compose for all Kind sources.
Library must align ORIGINAL Kind admission with its exact real namespace, including curated Kind maintenance where
required, and real selected-output provenance where applicable. Do not route Kind through a Members locator or borrow
public catalogue evidence. An active/frozen public Collection output must have its own native output producer.

## Proposed minimal owner contract, requiring adoption

The following names/literals are PROPOSED exports, not existing callable APIs or native evidence. They specify the
smallest missing seam. No new evaluator, permission engine, Source engine, ledger or worker principal is proposed.
Accounts extends its original evaluator's evidence production; Core and the existing work ledgers remain sole producers.

```ts
// Accounts, ORIGINAL request/access.ts; implementation in access/index.ts + permission.ts.
// Reference only: Accounts must resolve a committed native record; possession grants nothing.
type KindAudienceOriginRef = Readonly<{
  kind: 'collection-kind-audience-origin';
  route: number;
  id: string;
}>;
// New request-time producer: requires actual native authenticated Actor provenance (or real anonymous).
declare function captureKindAudienceOrigin(
  input: Readonly<{
    actor: Actor;
    locator: CollectionKindPreparationLocator;
    context: AccessContext &
      Readonly<{
        time: AuthoritativeTime;
        work: AccessWorkAccounting;
      }>; // SAME original request admission/time and existing accounting
  }>,
): Promise<KindAudienceOriginRef>;

// Library, ORIGINAL collection-kind-work-admission.ts, additive immutable definition field.
type KindEvidenceDefinition = CollectionKindWorkDefinition &
  Readonly<{
    audienceOrigin: KindAudienceOriginRef;
  }>;
// Semantic, ORIGINAL scope-leaf-evidence.ts; retained native evidence at the Source route.
type KindTypeEvidenceRef = Readonly<{
  kind: 'collection-kind-type-evidence';
  route: number;
  id: string;
}>;
// Library, ORIGINAL collection-kind-work-admission.ts: locator in the existing native episode.
type KindTypeAttemptRef = Readonly<{
  kind: 'collection-kind-type-attempt';
  route: number;
  id: string;
}>;
declare function beginKindTypeEvidence(
  input: Readonly<{
    work: CollectionKindPreparationWorkContext;
    after: string | null;
    allowance: WorkAllowance;
    deadline: number;
  }>,
): Promise<
  Readonly<{ work: WorkReceipt }> &
    (Readonly<{ status: 'prepared'; attempt: KindTypeAttemptRef }> | Readonly<{ status: 'unavailable' }>)
>;
// Semantic orchestration OUTSIDE the Source transaction; each native invocation gets live Core T.
type KindTypeStepInput = Readonly<{
  attempt: KindTypeAttemptRef; // resolves committed native input, not caller-supplied subject keys
  allowance: WorkAllowance;
  deadline: number;
}>;
type KindTypeStepResult = Readonly<{ work: WorkReceipt }> &
  (
    | Readonly<{ status: 'progress'; after: string; evidence: KindTypeEvidenceRef }>
    | Readonly<{ status: 'complete'; evidence: KindTypeEvidenceRef }>
    | Readonly<{ status: 'unavailable' }>
  );
declare function prepareKindTypeEvidence(input: KindTypeStepInput): Promise<KindTypeStepResult>;
// Library, ORIGINAL collection-kind-preparation.ts: final SAME-home adoption, no foreign callback.
type KindTypeContribution = Readonly<{ originalId: string; terminalId: string; typeId: string }>;
declare function verifyKindTypeEvidence(
  input: Readonly<{
    work: CollectionKindPreparationWorkContext;
    evidence: KindTypeEvidenceRef;
    allowance: WorkAllowance;
    deadline: number;
  }>,
): Promise<
  Readonly<{ work: WorkReceipt }> &
    (
      | Readonly<{ status: 'current'; contributions: readonly KindTypeContribution[] }>
      | Readonly<{ status: 'stale' | 'unavailable' }>
    )
>;
```

All existing names in that sketch retain their ORIGINAL module definitions/imports. Search owns the work context;
Library owns locator, definition, Source identity/observation/custody/frontier and adoption; Accounts owns origin,
audience formula dependencies and native provenance; Semantic owns Type/visibility/identity-dependent evidence.
`at` and Actor are deliberately absent from worker input: reread admission and derive `commandTime(work.tx)`.
Do not pass that live Library transaction to a foreign home; finish its local phase before foreign preparation.
`begin` is Source-local. Commit its bounded original/group frontier, expected native homes, episode version,
origin/input binding, reservation and deadline in the existing Library episode; the reference alone grants nothing.
`prepare` cannot reuse the ended `work.tx` or its T. Accounts/Semantic must verify the real committed attempt and
establish fresh native per-home invocation provenance BEFORE I/O, with the same reservation and that invocation's T.
The present Search validator accepts only the Source home; it is not foreign-home admission. This off-home producer
binding is another necessary owner contract change, not an implemented hidden overload or a portable work-context cast.
If original producers cannot supply it, Option A cannot run. `verify` is strictly Source-local under fresh admission.
Contributions are internal, eligible-original/terminal pairs only, bounded by the raw100/4096-byte page envelope;
deduplicate terminals in Library's existing insertion path. Exclusions retain coverage evidence but return no Type.
Before adoption, a separate Source-local phase commits the native producer references and bounded contribution
chunk into the existing capture. This reduction needs the maintained owner invalidation closure below; a copied
remote observation/allow alone cannot become current Source-local evidence. Incomplete aggregate counts stay private.

**Origin is the unavoidable new contract.** Current `select` selects a hash-namespaced capture; `prepare` has no Actor.
Capture must happen while the original verified Actor exists, before it disappears. Accounts must bind an actual
native request/authentication/consent origin to the exact Library intent and original client-scope/authn/delegation
basis through native provenance, not serialize the Actor or its claims into a row under a different name.
No such durable provenance record/producer is exposed here. A reference to one must not be invented.
Anonymous needs a real native public-floor observation and applicable denials, not a fabricated account origin.

That record can authorize only production/verification of evidence for this exact intent's Source population.
It cannot authorize arbitrary subject reads, be accepted by ordinary `Access.authorize`, or become a transferable
client/worker principal. Accounts must define how current native origin facts remain verifiable without Actor
restoration; if that cannot be supplied, the background option below is unavailable and needs the request-bound option.
An origin's committed provenance alone is never a cached allowed result. Current formula/dependencies still apply.

### Native evidence contents and provenance, never caller assertions

| Stored evidence component                 | ORIGINAL producer and required production/verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Episode/input and attempt binding         | Library resolves its committed intent and namespace by the exact locator, using the same native prepare/repair receipt, release pin, `NativeSourceIdentity`, `CollectionSourceObservation`, `IdentityScopeObservation` and `NativeSourceCustody`. Persist the origin reference before traversal. Each bounded attempt has real native commit provenance and exact predecessor/frontier/reservation/deadline; no serialized live T. Final adoption rereads these bindings. No pseudo receipt or revision inferred from time. |
| Complete population, including exclusions | Library's native canonical references/capture establish every raw occurrence/original and canonical group, including empty ranges, rejected originals and duplicates. Evidence retains native frontiers and committed predecessor/CAS linkage under the existing capture; a selected list of successful votes is not coverage. New dependencies extend coverage before seal.                                                                                                                                                |
| ORIGINAL + TERMINAL header evidence       | Semantic reads each exact original and terminal in separately anchored native home snapshots using its existing header/identity SQL ownership. Retain actual Type, visibility/security revision, current release, redirect/mapping, native revision/write basis and relevant account-agent lifecycle observation. A missing row is an observed exclusion only with its exact negative range/currentness proof; an unavailable home is unknown. Hidden Type stays owner-internal.                                            |
| Audience formula evidence                 | Accounts evaluates original AND terminal eligibility/read/disclosure with its original formula and native origin. Retain the complete native dependency closure: authenticated origin validity, account/principal/operator lifecycle and authn floor, consent/client scopes, assignments, role membership, grants, denials and policy/catalogue bindings, with temporal boundaries and negative ranges. A copied formula input object or allowed boolean is insufficient. This producer does not exist today.               |
| Source fences and identity                | Library retains exact collection/account writer controls and canonical basis; Semantic retains ready/no-active-claim identity observation and every applicable native tuple fence, including observed absence. Type headers have no invented imported-field tuple: include tuple/consent/target dependencies only when the actual source/selection/disclosure derives from them. Final verification compares native producer records.                                                                                       |
| Durable evidence/currentness binding      | Extend ORIGINAL retained owner records with exact evidence references and native commit provenance; do not create a parallel certificate service. A Semantic evidence reference must resolve its actual committed owner row and native write basis, cross-bound to Library's input/capture and Accounts' native origin. These added records/fields are a contract change, not present tables being asserted here.                                                                                                           |

Proposed technical authority permits bounded internal observation of that admitted Source's dependency keys, including
hidden or excluded anchors needed to prove noninterference. It requires live Core + verified native Library attempt/
custody and Semantic's original producer admission; this extension is absent, NOT a fake `subject:read` grant.
The audience decision is separate: only
current Accounts formula plus actual Semantic disclosure/visibility evidence determines whether an original supports
its terminal. One eligible original plus eligible terminal contributes ONE terminal Type vote; all other originals
remain dependencies. No hidden/excluded Type may affect vote totals, lexicographic tie resolution or fallback.

## Currentness, bounded work and lifetime

1. Capture origin/input under actual request authority; commit the Library maintenance intent before admitting a worker.
   On each bounded step, reread ORIGINAL Library admission and Search's distinct context. Core alone supplies native T.
2. Spend ONE existing caller reservation on admission, Source enumeration, both headers, Accounts/eligibility,
   identity, tuple fences, evidence persistence, final guards, cleanup and errors. Reuse `WorkAllowance.reservationId`;
   map existing `AccessWorkAccounting` producer receipts to the existing Source dimensions once, without double charge.
   `access/work.ts:23-39,109-160` and `collection-source-work.ts:115-160` reserve before dispatch and reject unknown bounds.
3. Preserve raw100 and 4096-byte Kind pages (`collection-kind.ts:62-63,346-365`); raw rejected/duplicate keys count too.
   The existing prefix divides candidate capacity by three; additional original/terminal work must reduce dispatch to
   remaining capacity, never assume 100 returned votes fit. Definition/body/header lengths require native guards.
   Accounts supplies finite per-formula bounds; no constant guessed from returned rows, million-row blanket as proof,
   or free hydration. Unknown declaration refuses BEFORE I/O; dispatched failure charges its native bound/receipt.
4. One partition/home snapshot at a time; release connection/transaction before visiting a foreign home. Retain only
   bounded opaque progress plus existing owner records, not an unbounded Actor/dependency/home vector in a job/cursor.
   A live Source work transaction cannot surround foreign reads. Use the committed attempt, not the ended context,
   for separately admitted native phases. Reenter Core for adoption with a fresh T and SAME reservation; its local
   verification must bind current maintained evidence at that T, never relabel earlier handles or serialize a live T.
5. Before seal/adoption, native owners must revalidate the COMPLETE dependency closure, including excluded ranges.
   Source-local final verification must consume actual current owner-backed invalidation/repair state while holding
   the local Source/episode/control locks. No foreign checkout, permission callback, rebuilt Actor or public-catalogue
   capture is allowed there. Source writer/account fences and identity readiness are necessary but not sufficient.
6. The missing foreign invalidation contract must make a relevant change invalidate Source-local use before that
   change can authorize stale disclosure; asynchronous notification/relay lag alone is insufficient. Enrollment needs
   gap-free start/registration/final native observations, and repair acknowledgement must bind actual repaired evidence.
   This includes permission additions and negative-range insertions, not just revocations. No guessed global epoch,
   new safety-token engine or blanket “ACK means current.” Existing identity pre-arm/custody patterns show the discipline,
   but they currently cover identity, not Accounts' complete audience dependencies. Owner adoption must close this gap.
7. Final GET uses the actual current viewer: reauthorize Collection, resolve the exact audience origin/namespace,
   check current native aggregate evidence and reread after waits. No worker origin authorizes that viewer. Fixed-size
   metadata reads can use only an actually maintained native closure; rescanning a population is not a fixed point read.
   Never borrow anonymous evidence for an authenticated audience. Return pending/unavailable on missing/stale/unknown;
   `empty` requires complete current zero eligible votes. Owner override remains its existing independent behavior.
8. Prepared capabilities expire with their live attempt/T and the minimum request/producer deadline. Existing Access
   evidence TTL is 1000 ms (`access/evidence-deadline.ts`); durable native records are revalidation inputs, not extended
   handles. Retention follows exact capture holds and retired-observation cleanup; old custody grants no new reads.
   Temporal grant/role/credential expiry invalidates use even without a writer. Resume uses new admission, T and bounds.

## Adversarial native revalidation cases to bind before implementation

| Mutation/interruption                                                                                                                     | Required observable result and native evidence obligation                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revoke grant, insert ban/denial, suspend, delete/account-T or fence, revoke assignment/operator membership                                | Original audience evidence becomes unusable before stale winner disclosure. Current active owner alone is insufficient; verify actor/principal/operator, denial precedence, original assignment and native policy dependencies. No anonymous fallback for invalid credentials.                                      |
| Authn floor/epoch, client consent/scope, credential expiry/revocation or requested-by changes                                             | Reject/replace the origin through Accounts' native provenance. A new token/scope/client cannot inherit the old namespace proof. Never reconstruct or renew worker identity from stored account/client/scopes.                                                                                                       |
| Type changes at original or terminal; visibility hide/restore; merge, unmerge, repoint or pending claim                                   | Invalidate both successful votes and excluded-original dependencies; require current header/security/release/mapping and ready scoped identity. Same terminal ID or same winner does not preserve evidence. Restore needs current admission, not a cleared boolean.                                                 |
| Source generation/incarnation, native child/ordinal writer fence, release/profile pin, output activation/frozen head or owner epoch drift | Native Source/canonical/custody proof must match exact selected authority. Same metadata/count or retained old hold cannot certify currentness. Repair/recapture affected finite input; no synthetic complete Source.                                                                                               |
| Private owner versus unrelated reader, anonymous versus authenticated, hidden Type tied with visible Type                                 | Keep distinct actual viewer formulas and namespaces. Hidden Type changes cannot change winner, tie, count, empty status or public fallback. No type-count DTO. Private working facts never become another viewer's published output.                                                                                |
| Excluded original later readable; hidden original targeting a visible terminal; many canonical duplicates                                 | Cover negative/excluded originals and their Type/disclosure dependencies. Only eligible originals support the terminal, counted once. A changed denied original can invalidate completeness even when no returned candidate changes.                                                                                |
| Missing/legacy evidence, collected receipt, altered origin/locator or wrong Kind/Members branch                                           | Unavailable before Type/permission I/O or disclosure; recapture with the genuine original request when needed. Missing evidence is neither empty nor an implicit public audience.                                                                                                                                   |
| Replay, double delivery, rollback, crash between evidence/hold/ACK/count/checkpoint, retired-generation replay                            | Require committed native receipts, exact predecessor/generation/version CAS and existing per-terminal uniqueness. Rolled-back evidence cannot adopt; crash resumes durable frontier without duplicate votes. Retired/released/collected proof cannot resurrect a winner; retry never renews provenance or native T. |

Existing `collection-kind-work.ts:172-229`, `collection-kind-apply.sql` and `collection-kind-checkpoint.sql` provide
local generation/version CAS, per-terminal insertion and vote-then-TypeId ordering. Extend their proof inputs;
these mechanisms alone do not prove audience safety. Native custody tests at `test/library/native-source-custody.test.ts`
cover altered provenance, intervening writers and retained-versus-fresh custody; they do not prove Type audiences.

## Bounded alternatives and indispensable owner changes

**Option A, recommended if fixed-size metadata GET and autonomous maintenance are retained:** adopt the narrow
native origin/evidence seam above, including concrete Accounts origin, per-home native attempt admission and gap-free
Source-local invalidation. These are indispensable contract additions; no complete callable exists under current inputs.
This is a new _contract in the existing evaluator_, not permission already supplied by Core or accounting. No writer
dispatch should proceed on placeholder origin records or on an unimplemented foreign reduction/repair seam.

**Option B, if native origin cannot be represented without restoring identity:** require actual fresh Actor requests
for every bounded audience-evidence preparation/revalidation step; workers only reduce already produced native facts.
Use the same dedicated Semantic producer and original Accounts evaluator, not a summaries/ordinary-reader wrapper.
Without Option A's maintained invalidation closure, final disclosure must freshly revalidate every dependency in a
bounded finite preparation, restarting after relevant drift. This changes the fixed-size automatic-read/lifetime
contract and cannot promise autonomous completion after the Actor disappears. The manager must explicitly adopt that
cost/interaction change; it is not an equivalent implementation or a permanent-unavailable completion strategy.

Semantic must supply the narrow original+terminal Type/header evidence producer, full exclusions/identity/disclosure
dependencies and bounded native work declarations, replacing only the unsupported Kind branch, without Access SQL.
Library must supply real admission/getter/immutable input and committed bounded attempts, reconcile namespace checks, retain evidence under its
existing capture/custody, adopt/retire atomically and guard the in-row winner/getter against current native closure.
Accounts must own actual origin capture/currentness and audience-formula evidence in its existing native evaluator,
including authentication/client/consent provenance, negative/temporal policy dependencies and reduction fencing.
Search must consume the ORIGINAL distinct Kind input and per-phase admission, native T and existing ledger; it must not mint permission,
restore Actor, reinterpret Members or accept a complete definition as a completed audience proof.

Shared source patterns are exact native provenance, exclusive request/work contexts, pre-dispatch finite accounting,
local final verification and separation of retained custody from current authority. Official [PostgreSQL isolation
documentation](https://www.postgresql.org/docs/18/transaction-iso.html) supports transaction-local snapshot guarantees;
it does not supply an application-wide current cut across released transactions (documentation: [PostgreSQL licence](https://www.postgresql.org/about/licence/)).
[RFC 7662 §4](https://www.rfc-editor.org/rfc/rfc7662.html#section-4) explains the revocation window introduced by cached
authorization information and expiry limits (IETF Trust/BCP 78; extracted code uses Simplified BSD). These primary
references support the currentness distinction; neither specifies a REZICS authority or licenses token replay here.
The recommendation is an inference from these sources and the inspected implementation, awaiting owner adoption.
