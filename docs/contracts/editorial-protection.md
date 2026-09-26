# Editorial protection and reviewed corrections

Status: adopted target design, 2026-09-26. This contract does not declare new
endpoints, owner schemas or command-module checks implemented. Existing Work
head CAS, title-only source application and fixed releases are foundations;
the generic protocol below still requires implementation and qualification.

## Independent state and authority

Protect the currently adopted value or exact selection while continuing to accept
eligible contributions, source observations, evidence and correction proposals.
Access decides who may perform an operation; the target owner checks whether that
operation may change its current state in the same transaction as the effect.
Do not introduce a separate authoritative lock database or put business protection
solely in a cache, distributed lease, client flag or Access grant.

| Dimension | Meaning and owner |
| --- | --- |
| Editorial control | `source-managed` or `human-controlled`, with a monotonic control epoch and exact source binding when applicable. The target owner prevents automatic source takeover. |
| Modification protection | `open`, `review-required` or profile-specific `sealed`, with an immutable protection revision and current head in the target owner. |
| Acceptance | Which exact value/revision is selected in a declared context, with its decision and basis. Reuse existing selection/decision owners. |
| Evidence quality | Source reliability, support, review, dispute and value uncertainty under [information verification](information-verification.md). Protection is not a truth or quality flag. |
| Assessment freshness | Whether the assessment still matches its exact dependencies and declared owner positions; stale or pending is distinct from false. |

`open` still requires normal edit authority. `review-required` permits replacement
only through an admitted correction decision. `sealed` is available only for a
profile whose identity fixes meaning or a release's exact selection; it has no
generic unseal operation. Change a sealed definition/release through its own
successor identity and attributable supersession decision. Ordinary factual edits
normally use `review-required`, preserving a correction path.

Historical revisions are immutable in every mode. A new current revision is
different from rewriting an old revision. Protection cannot defeat authorized
erasure; exact references then resolve as erased/unavailable under the owning
[erasure contract](../operations/erasure.md), never as replacement bytes.

## Targets, contexts and effective scope

A target identifies its owner, stable component or selection slot, admitted field
definition/occurrence where needed, and explicit adoption context. Do not identify
a protected field by its present literal, array index or arbitrary JSON path.
Language/name occurrences retain their own identity. The first implementation
slice targets the existing Work metadata/title operation; other component kinds
need their own complete write-footprint profile before admission.

Global and Realm protection constrain their respective adopted heads. A Realm can
protect a local selection but cannot rewrite or unlock the Global selection or
the original contributor's draft. Context fallback remains explicit. Protecting
a selection that follows a changing upstream head must first pin the intended
exact revision, or use a qualified dependency protocol that preserves the same
adopted value. Locking an unchanged `follow` pointer alone does not protect it.

Resource-wide protection is an explicit owner-local scope rule, not a loop copying
flags to current children. If supported, the operation profile declares a bounded
applicable root set and guards its heads, membership and absence conditions;
new children cannot escape it. All applicable restrictions must be satisfied;
an enum maximum alone cannot combine different approval requirements. The first
Work profile is single-target and does not enable inherited root protection.
Cross-owner scope changes are a durable workflow with per-owner outcomes and
pending state, never an asserted atomic resource-wide switch.

## Record contracts

These are logical records, not a requirement to allocate one RDF class or SQL
table per row. Use versioned model IR, existing RevisionAnchor manifests and
owner-specific bindings. Public Agent attribution and opaque admission references
may accompany decisions; private principal/control identities remain in Access.

| Record | Required binding |
| --- | --- |
| EditorialControlRevision | Target/context, predecessor, mode, control epoch, source observation/mapping/binding basis when source-managed, reason and originating operation. |
| ProtectionRevision | Target/context, predecessor, mode, exact rule revision, content head observed at activation, reason/evidence and originating decision/operation. |
| CorrectionProposal | Target/context, proposal revision, base content head, base protection head including explicit absence, control epoch, rule revision, candidate manifest/digest and exact evidence-set revision. |
| CorrectionDecision | Exact proposal revision and candidate digest, expected decision head, approve/reject outcome, rule/evidence revisions, independence proof reference and operation. |
| AcceptanceDecision | Context/target, exact adopted revision, predecessor and supporting decision/assessment. Existing publication or classification selections retain their own identity. |
| CorrectionApplication | Unique binding of a proposal revision to its one applied target effect, successor content revision and receipt. A new request key cannot apply the same proposal twice. |

The target's current state references its content/selection, protection, control
and acceptance heads where those records exist. Protection's activation-time
content head is historical evidence, not a requirement that the content remain
forever equal to it: a valid correction advances content while keeping protection.
Setting/relaxing protection appends a revision; never delete its history to make
the target appear never protected.

Unprotected untouched targets may use a profile-defined absent protection head;
do not preallocate empty records for the whole corpus. Absence is an explicit CAS
expectation, not a fallback for unknown, corrupt or partially restored state.
Unknown editorial-control provenance never implies source-managed eligibility.
Source application needs a proven binding even when no control record exists yet.
Reads preserve unestablished/unavailable control basis explicitly instead of
inventing a historical human confirmation. Only a declared profile default can
supply an initial epoch; an arbitrary missing record cannot.

## Operations and state transitions

The [API blueprint](../implementation/api-and-events.md#editorial-protection-operations)
defines the planned transport. All mutations bind canonical input, exact target,
expected heads/epochs and rule revision to an idempotency key and Access admission.
Omitted expected fields are invalid; explicit null means asserted absence only
where the profile permits it. Empty text/list, unknown and missing retain their
own profile meaning. The client cannot submit a trusted actor kind or permission.

| Operation | Preconditions and atomic owner effect |
| --- | --- |
| Ordinary human edit | Current edit admission, matching content/protection/control basis and effective `open` mode. Create the content revision and explicit human takeover, including for same-value confirmation. |
| Source apply | Trusted source operation, eligible exact source binding/observation, matching content/protection/control basis, source-managed control and effective `open` mode. Advance the applied source basis without claiming human review. Otherwise retain the observation/proposal without replacing the adopted value. |
| Tighten protection | Current protection authority and matching content/protection/rule basis. Append protection state. A vandalism restriction makes no new claim about evidence quality. |
| Confirm and protect | Current confirm/review authority, eligible exact evidence/acceptance basis and matching heads. Atomically record acceptance, human control and `review-required` protection; unchanged value bytes do not make it a no-op. |
| Propose correction | Current proposal authority and bounded, retained candidate/evidence. Record a proposal without changing adopted content, protection or an official quality verdict. |
| Review and apply | Current reviewer admission and independent-review proof; exact proposal, rule, evidence and target basis still eligible. In one target-owner transaction create approval/application, new content/acceptance, human control and receipt/outbox; preserve effective protection, including for a source-proposed candidate. |
| Reject correction | Current reviewer authority and exact proposal/decision basis. Append a rejection without changing adopted content. An already applied proposal cannot be turned into an unapplied rejection. |
| Relax protection or return source control | Separately admitted operation under the existing rule, with its required approval and exact state. Append the new state and advance the control epoch when control changes; ordinary edit permission is insufficient and sealed profiles cannot use generic relaxation. |

The initial review policy requires an authorized human reviewer independent of
the proposer. Access checks the applicable private principal/control identities;
switching public Agents is not independence. Missing independence evidence keeps
the effect pending/denied. Do not publish that private relationship in the graph.
Collective governance can later supply the same exact effect-bound decision under
[governance rules](governance-rules.md); a vote outcome is not executable authority.

For the first bounded correction, approval and application are one local commit.
Each proposal revision has one terminal approve/apply or reject decision; changing
a rejected proposal requires a new proposal revision and review basis. A reversal
of an applied correction is a new authorized correction, not a change to its old
decision. There is no temporary unlock-edit-relock window. A stale target,
changed proposal, changed required rule/evidence or conflicting terminal decision requires a new
review basis. Keep the old proposal/decision inspectable. Later multi-approval or
cross-owner profiles must expose approved-but-unapplied/pending states explicitly
and revalidate/consume their exact approvals at activation.

Human takeover/confirmation and reviewed application advance control even when
the value or prior control mode is unchanged. Returning control to a named source
requires a separate decision bound to that source's exact observation/mapping and
target basis; it neither changes the adopted value nor relaxes modification
protection. A subsequent source application must still satisfy both dimensions.

No automatic timed unlock is enabled by the initial profile. A future expiry
policy must define a clock and eligibility contract and use an attributable,
guarded transition; a cleanup job cannot silently delete the protection record.

## Transaction and admission protocol

1. Main verifies Account and Access authority for the exact operation and target.
   Human edit, source application, protection changes and correction review have
   distinct admitted actions. The digest binds the candidate and expected state;
   a command-family name alone never proves approval.
2. Prepare and retain immutable candidate/evidence references outside the writer.
   A PostgreSQL Content candidate uses its existing publication pin protocol.
   Remote observations require exact retained owner evidence and the applicable
   withdrawal/erasure fence; no HTTP, model inference or PostgreSQL lookup occurs
   while Jena holds the write transaction.
3. The owner captures actual pre-state, including content, protection and control
   heads, rule/decision dependencies and applicable root scopes. Check explicit
   absence as well as presence. Derive affected protected targets from the trusted
   profile and actual mutation footprint, not only a caller-supplied target list.
4. Enforce the operation's permitted transitions against pre-state and candidate
   post-state. Check approval digest, target/context, eligibility and one-use
   application identity. An existing normal edit admission cannot bypass a newly
   committed restriction. Validate all removed/replaced projections as well as
   new heads; unrelated data cannot ride inside an authorized correction.
5. Commit revisions/decisions, current heads/projections, the local receipt and
   outbox together. Failure leaves the adopted state unchanged. Resolve lost
   responses, cancellation races and terminal rejections through the existing
   [command receipt protocol](commands.md), including current disclosure on replay.

For an edit prepared at content `r17` and protection `p3`, a protection change to
`p4` first makes the edit stale. If the edit wins and creates `r18` first, an
attempt to confirm `r17` is stale instead. Single-writer execution alone is not
the business rule; the exact preconditions establish this ordering.

Access remains authoritative for grants and revocation. A Fuseki caller credential
or syntactically valid receipt is not an independent grant proof. Ordinary and
strong revocation preserve the existing
[cross-store admission protocol](../implementation/authorization-bridge.md#cross-store-admission-and-revocation-protocol).
Local protection can reject previously admitted edits at its own commit boundary
without pretending to transactionally lock PostgreSQL authority.

## Capacity, introduction and recovery

The first scalar profile has one target, the existing Work-edit payload limit,
at most 32 exact evidence references and at most 32 source-rating dependencies.
History/proposal pages return at most 50 entries using an owner-bound cursor.
These are initial admission ceilings to qualify, not measured throughput.
Reject unsupported/oversized requests before activation; never silently truncate
evidence and call the result complete. Larger candidates need a separately
admitted staged manifest and complete-generation activation.

For K affected targets, E bounded evidence/approval dependencies and B candidate
bytes, derive local validation work from K + E + B and a fixed number of owner
round trips. Index point reads still have physical engine cost; no O(1) latency or
unchanged write-volume claim follows. Verify writer occupancy, rejection work,
outbox amplification and skew without scanning unrelated entities or recomputing
an entire source/Realm on an ordinary edit. List queries use indexed target/context
and status with stable ordering; a result LIMIT is not an execution bound.

Enable only qualified operation profiles after owner schemas, guards and all
applicable writer paths are updated. Old request profiles cannot bypass newly
active protection. Existing data is not automatically confirmed or assigned a
quality level; preserve provable source control and treat ambiguous provenance
conservatively. See [schema evolution](../storage/schema-evolution.md#editorial-protection-activation).

Backups/replay retain protection and control history, correction/application
identities, exact evidence/rules, receipts and their coverage. A new data epoch
fences old workers but does not reconstruct a protection decision lost by rollback.
Keep the restored owner held until its accepted recovery frontier covers those
decisions and later authority/erasure restrictions. Missing coverage is unavailable,
not absent/open. Rebuild quality projections only from reconciled dependencies.
[Recovery](../operations/recovery.md#editorial-protection-recovery) and
[prospective acceptance](../testing/editorial-protection.md) own the checks.

## Evidence and alternatives

Primary sources reviewed 2026-09-26; their mechanisms do not prove this combined
REZICS protocol or its 500M-entity capacity.

| Basis | Selected lesson and limit |
| --- | --- |
| [Jena transactions](https://jena.apache.org/documentation/tdb/tdb_transactions.html) and [remote RDFConnection](https://jena.apache.org/documentation/rdfconnection/#remote-transactions) | Transactional TDB permits one active writer and concurrent readers. Separate remote calls are not one server transaction; protection/receipt invariants are application obligations. |
| [PostgreSQL 18 row locks](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS) | Serialize edit/protect operations on an existing owner row and check the version in that transaction. Locking a missing optional row does not establish this protocol. |
| [Kleppmann, distributed locking, 2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) | A lease alone cannot prevent delayed writes; storage must enforce fencing. This does not establish that independent lock services are universally inappropriate. |

An Access-only protection flag would leave target-state races to an additional
cross-owner fence. A separate lock authority adds coordination and recovery work
while still requiring storage enforcement. Owner-local protection reuses the
selected transaction boundaries. Cryptographic transparency is a different
requirement: ordinary immutable revisions are not proof against a privileged
operator. No external transparency-log service or new engine is selected here.
