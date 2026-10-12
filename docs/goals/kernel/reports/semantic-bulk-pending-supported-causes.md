No supported command was found to leave a bulk stage pending

The admitted erasure route **can erase a semantic resource's current revision
between bulk admission and activation**, but it does not remove that resource's
current graph facts. The one supported-command probe activated successfully and
replayed its terminal receipt. This is a scoped negative finding, not proof that
every supported command/interleaving is safe. No product code was changed.

## What bulk actually checks

For `POST /v1/semantic/changes/bulk` (`postV1SemanticChangesBulk`),
[staging.ts](../../../../services/main/src/modules/semantic/staging.ts):582–588
checks `referenceReader` **before admission and before receipt replay**. That
reader accepts current semantic read authority or Work read authority
([admitted.ts](../../../../services/main/src/modules/semantic/admitted.ts):35–47).
It is not itself a graph-existence assertion: an explicit scoped grant is one
read-authority path.

The graph-existence condition cited in the brief is **at activation**, not
preflight: `staging.ts:513` requires each referenced component to have some
current `rdf:type`. It does not require the reference's original head, active
lifecycle, non-erased head, or continued disclosure. `activate`, at :518–563,
never calls `referenceReader` again; neither does
[validatedCommand](../../../../services/main/src/infrastructure/invalid-receipt.ts):64–81.
After an unmatched update, :555–561 only attempts a generation-change rejection.
With unchanged generation and no receipt, it throws the pending operation.
Settlement occurs only after a terminal result (:633–645).

Thus the earlier injected disappearance demonstrates a real unmatched-guard
recovery gap. The question here is whether these owners can remove the type
fact, rather than merely make a read unavailable.

## Supported commands and owner effects

Operation IDs are from the generated
[exposure catalog](../../../../generated/openapi/main/exposure.ts). Except for
the marked probe, stage outcomes below are **source inferences** assuming valid
independent bulk write admission, unchanged generation, and successful delivery
and settlement. “Completes” includes same-key recovery after a lost acknowledgement;
it does not assert that read authority permits every later HTTP replay.

| Cause and route / operation ID | Owner command and code evidence | Can commit in the interval? What follows for the bulk stage? |
| --- | --- | --- |
| Erasure: `POST /v1/erasures` / `postV1Erasures` | `requestContentErasure`, [route](../../../../services/main/src/routes/erasures.ts):83–95; [request](../../../../services/main/src/modules/erasure/request.ts):181–198, 226–241. `resolveErasureRevisions` admits a `SemanticRevision` and requires its component to match `resourceId`, [revision-kind](../../../../services/main/src/modules/erasure/revision-kind.ts):93–95, 158–179. | **Yes; probed.** Journal precedes graph suppression. [graph.ts](../../../../services/main/src/modules/erasure/graph.ts):343–375 deletes search units, marks the **revision** `ErasedRevision`, and advances sequence. It preserves the component's current facts and model generation. Stage activated with a success receipt; same-key retry replayed it. |
| Erasure follow-through: `POST /v1/owners/reconciliations` / `postV1OwnersReconciliations`, erasure reconciliation; offline retained-graph purge | `reconcileErasure`, [owner operations](../../../../services/main/src/modules/owner/operations.ts):615–643; [erasure request](../../../../services/main/src/modules/erasure/request.ts):387–397. Native [ErasurePurge.java](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/ErasurePurge.java):173–197. | Reconciliation of a pure semantic journal cannot use Content source remediation (`foreign` is refused). Offline purge is a fenced maintenance operation, not a live competing public deletion, and revision-IRI purge retains current graph facts. No supported removal of the component's type fact was found at either later step. |
| Resource or definition retirement: `POST /v1/semantic/changes` / `postV1SemanticChanges`, state `lifecycle: retired` | `admittedSemanticChange` → `changeSemanticComponent`. [change.ts](../../../../services/main/src/modules/semantic/change.ts):138–176 admits retirement; :322–328 always writes `rdfs:Resource` for a resource or `SemanticDefinition` for a definition; :535–560 replaces owned projection facts under the head guard. | **Yes**, with exact edit authority/head. Retirement preserves a type fact. Public disclosure requires the active revision ([semantic-disclosure](../../../../services/main/src/modules/access/semantic-disclosure.ts):100–103), but bulk does not recheck it. Completes; retirement alone does not create a missing-reference guard failure. |
| Retired definition used by a relation: `POST /v1/relations/changes` / `postV1RelationsChanges` | `changeRelationOccurrence`, [relation/change.ts](../../../../services/main/src/modules/relation/change.ts):468, 491–500. | This is a **different command family**: it seals a terminal `retired-definition` refusal when the exact active definition basis no longer matches. Bulk stages contain resource/definition creates, not relation-occurrence changes; bulk has no equivalent retired-definition guard. Descriptive type admission is lexical, [semantic/schema.ts](../../../../services/main/src/modules/semantic/schema.ts):153–159, not a lookup of a live type-definition revision. |
| Semantic read restriction: `POST /v1/access/policy-changes` / `postV1AccessPolicy-changes`, `publish-revision` on `semantic:read:<resource>`; also `revoke-set` for a read-policy dependency | `AccessPolicyChanges.change`, [route](../../../../services/main/src/routes/access-policy.ts):155–177; [policy-changes](../../../../services/main/src/modules/access/policy-changes.ts):76–128, 149–179. A semantic editor can own this policy through existing edit authority, [semantic-disclosure](../../../../services/main/src/modules/access/semantic-disclosure.ts):24–44. | **Yes**, after the completed preflight read transaction releases its locks. Restricts public or policy-dependent read access, not graph existence. An already executing bulk activation completes. A subsequent HTTP retry can return `422 unavailable_reference` before it reads the already-terminal receipt. A read restriction alone does not establish pending without a receipt. |
| Moderation: `POST /v1/moderation/decisions` / `postV1ModerationDecisions`; `POST /v1/safety-cases/{caseId}/decisions` / `postV1Safety-casesByCaseIdDecisions`; `POST /v1/rights/restrictions` / `postV1RightsRestrictions` | All call `GovernanceStore.decide`: [reports](../../../../services/main/src/routes/reports.ts):195–209, [safety cases](../../../../services/main/src/routes/safety-cases.ts):233–265, [rights](../../../../services/main/src/routes/rights.ts):229–244. [effects](../../../../services/main/src/modules/governance/effects.ts):254–281 and [store](../../../../services/main/src/modules/governance/store.ts):1258–1288 record graph effects/Access restrictions. | **Yes** for admitted owner targets such as Work publication. Direct native semantic-component moderation is not admitted: [schema](../../../../services/main/src/modules/governance/schema.ts):9–11 omits that component, [evidence](../../../../services/main/src/modules/governance/evidence.ts):318–327 resolves Work/Structure heads. Graph effects preserve resource facts; indirect hiding of a linked Work does not remove the semantic reference's type. Completes; later replay can be denied by preflight. |
| Revoke read grant or read representation: `POST /v1/access/revocations` / `postV1AccessRevocations`, target `permission_grant` or `representation`, mode `ordinary` or `strong` | `AccessRevocations.revoke`, [route](../../../../services/main/src/routes/access-policy.ts):259–269; [revocation-requests](../../../../services/main/src/modules/access/revocation-requests.ts):61–123 deactivates the exact source. Strong mode records a fixed drain, [policy-transaction](../../../../services/main/src/modules/access/policy-transaction.ts):100–209. | **Yes.** Read evaluation ends before admission. The bulk's durable authority witness binds its write authority, not the separately checked reference-read grant (`staging.ts:584–588`; [admission.ts](../../../../services/main/src/modules/access/admission.ts):1500–1527). Revoking only that read source does not fence this bulk activation or remove graph facts. Completes; retry fails preflight if neither semantic nor Work read authority remains. Strong revocation may drain other admissions which actually depend on the revoked source. |
| Read grant/representation expiry; no expiry-command route | Current `active` and `valid_until > clock_timestamp()` predicates, [admission.ts](../../../../services/main/src/modules/access/admission.ts):400–420; public read remains a separate path at :600–609. | **Yes**, clock time can cross the deadline in the interval. Same effect as losing only the read source: activation does not reevaluate it and completes; subsequent replay can fail preflight. Expiry was not injected or runtime-probed here. |
| Work withdrawal: `POST /v1/work-publications` / `postV1Work-publications`, `operation: withdraw` | `changeAdmittedWorkStructurePublication`, [publication route](../../../../services/main/src/routes/publication.ts):145; [structured-publication](../../../../services/main/src/modules/work/structured-publication.ts):605–616 swaps publication head and records Withdrawn. | **Yes.** It can remove public disclosure through the Work publication basis but retains Work/semantic resource type facts. Completes; no missing-reference pending effect found. |
| Zone retirement: `POST /v1/zones/{id}/retirements` / `postV1ZonesByIdRetirements` | `changeZoneConfiguration`, [zones](../../../../services/main/src/routes/zones.ts):739–748; [configuration](../../../../services/main/src/modules/zone/configuration.ts):500–504, 645–666. | **Yes**, when retirement's empty-mount condition holds. Replaces Zone head/state, preserves Zone type and semantic resources. Completes. |
| Zone detachment/unmount: `POST /v1/zones/{id}/realm-attachment-withdrawals` / `postV1ZonesByIdRealm-attachment-withdrawals`; `DELETE /v1/zones/{id}/mounts/{occurrence}` / `deleteV1ZonesByIdMountsByOccurrence` | `withdrawZoneRealmAttachment`, [zones](../../../../services/main/src/routes/zones.ts):755–764 and [withdrawal](../../../../services/main/src/modules/zone/realm-attachment-withdrawal.ts):115–121; `changeAdmittedComposition(remove)`, `zones.ts:608–622`. | **Yes**, under their own guards. Remove attachment/placement, not Zone, Realm, Work or referenced semantic resource identity. Completes; no type disappearance found. |
| Delete owning Work, Realm or Zone | No entity-delete API operation/owner command found in [works](../../../../services/main/src/routes/works.ts), [realm admin](../../../../services/main/src/routes/realm-admin.ts), [managed realms](../../../../services/main/src/routes/managed-realms.ts), [zones](../../../../services/main/src/routes/zones.ts) or the generated exposure catalog. | No supported entity deletion identified. The Zone DELETE above deletes a mount only. A semantic resource is not erased transitively by deleting an owning container through any identified route. |

The generic grant-change names should not be mistaken for arbitrary semantic
read-grant management: `postV1AccessGrant-changes` and
`postV1AccessDelegated-grant-changes` use the Work-create grant owner
([grants.ts](../../../../services/main/src/modules/access/grants.ts):18–19,
523–538). `postV1AccessRepresentation-changes` similarly revokes `work.create`
representations only ([representations.ts](../../../../services/main/src/modules/access/representations.ts):320–338).
The exact-source revocations route above is the supported route that can revoke
an existing `semantic.read` grant/mandate.

Losing the **bulk write** source is separate. It can make a retry's admission
ineligible (`admission.ts:1293–1305`), where bulk seals cancellation and records
the graph outcome (`staging.ts:616–623`). That branch returns before Content
settlement, so a pending Content row can coexist with a terminal cancelled
graph receipt until a later eligible preflight reaches reconciliation. This
is not pending **without** a receipt, and was not probed here.

## One supported-command probe

QA run **20261012t011754-167808**, isolated project
**20261012t011754-167808-1**. Command:

```sh
bun scripts/goal/goalctl.ts test tests/qa/integration/semantic-bulk-supported-erasure-probe.test.ts
```

The temporary tier entry was a symlink to the throwaway test under `.temp/`,
using `authorCreditFixture`, the semantic stage harness, real isolated
PostgreSQL/Fuseki and immutable S3 objects. All added authority used
`grantFixtureAuthority`. The tier entry and test were removed after the probe;
neither is committed. Raw evidence remains in
`.temp/semantic-bulk-supported-erasure/evidence.json`.

Exact sequence:

1. Create a Person via `POST /v1/semantic/changes` (201). Grant exact semantic
   read authority and `erasure.request` on that component.
2. Submit a one-item bulk Person create with `schema:knows` pointing to that
   component. Retain the exact request and idempotency key.
3. Pause the first `SemanticBulkChangedEvent` command before sending it to Jena.
   SQL confirms the admission is `claimed`, graph outcome null, Content pending
   row present, Content outcome absent. Thus preflight, admission and staging
   have finished; activation has not committed.
4. In that interval, call `POST /v1/erasures` with profile
   `content-revision-erasure-v1`, component `resourceId`, and its current
   semantic revision UUID. It returns 200, `inventory_complete`,
   `suppression: suppressed`, target kind `semantic_revision`. An independent
   graph read confirms the revision is erased **and the component still has
   current RDF type**.
5. Send the original bulk activation unchanged. Jena returns `committed`,
   sequence 4. HTTP returns 201 with a success receipt. Content records
   `activated`, removes its pending row, and stores that receipt. Access is
   `sealed`, graph outcome `succeeded`.
6. Retry the identical bulk request with the same key and retained scoped read
   authority. HTTP returns 200, `replayed: true`, the same stage, item IDs,
   receipt and source position. A graph read independently finds `Succeeded`.

Stage `22173abf-0070-4728-9caf-94df7a50b8a2` therefore did **not** remain pending.
Erasure `7a589f01-8d4f-4c5f-963c-6992a473c170` completed before its activation.
No supported command in this probe made the stage permanently pending.

**QA qualification failed despite the probe assertions passing.** Bun reported
1 pass, 0 fail, 13 assertions, 7.3 seconds. Its XML attributed the test to the
symlink's real `.temp/` path. The harness therefore added a failing synthetic
`QA file did not complete` result for the selected integration path, with
`Selected file produced no test results`. This run is not a passing QA
qualification; the direct state evidence and assertions are narrower evidence.
No passing test was rerun, preserving the brief's one-probe limit.

Separately, the probe logged an error-level `worker_fault`:
`NestedPoolCheckoutError`, outer
`public-report/preservation.ts:22 withPreservationFence`, inner
`access/topology-control.ts:24`, pool `access`. The route still returned 200
and the observed state above was verified. This fault needs separate owner
work; it was not the synthetic file-attribution failure above.

An earlier **selection-only** invocation,
`bun scripts/goal/goalctl.ts test --tier integration --file .temp/semantic-bulk-supported-erasure.test.ts`,
failed before starting a probe because `.temp/` is not a registered integration
path (QA **20261012t011741-39804a**).

## Limits and checks

- Only semantic revision erasure was runtime-probed. Retirement, policy,
  revocation, expiry, moderation, withdrawal and maintenance outcomes are code
  inferences, not reproduced races or exhaustive concurrency proofs.
- Neither permanent reference disappearance nor pending-without-receipt was
  reproduced through a supported command. The previous raw-update experiment
  remains evidence of the recovery gap if disappearance occurs; this report
  does not disprove that gap or its read-authority recovery obstruction.
- The probe retains private read authority. It does not prove replay after
  revocation, public-only replay after erasure, or the correctness of every
  semantic read surface's erasure handling. It also does not cover Account
  deletion, every indirect administrator/controller/baseline-authority loss,
  restore holds, process crashes or arbitrary combinations of owner commands.
- Type/definition retirement does not itself change the authored model
  generation. If generation actually changes, bulk has a terminal
  generation-change rejection path (`staging.ts:527–542,555–561`); that path
  was not exercised here.
- `task docs:check`: **failed only because this report is unreachable from
  `docs/README.md`**; its 13 checker tests passed and it reported no broken
  links. The brief permits this unlinked-report failure. No navigation or
  kernel state file was changed.
