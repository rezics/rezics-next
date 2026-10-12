# Bangumi episode reference refusal

The refusal is a **measurement-fixture artefact**: its acting Agent lacks the
active Person provision and control mandate that the product dataset session
provides. The parent Work exists and is catalogue-visible; the caller cannot
read it. No owner implementation change is warranted by this reproduction.

| Reference chain | Refused value / expected prerequisite | Evidence |
| --- | --- | --- |
| First batch item, `bangumi:episode:1807` | `items[0].properties[3].value.ref`, predicate `rv:semanticWork`; points to the imported `bangumi:subject:975` Work, **not** its MainVersion | [Importer](../../../../scripts/datasets/import.ts):1093–1095 emits the sole resource-valued reference; [collector](../../../../services/main/src/modules/semantic/change.ts):233–237 excludes types, predicates and external identifiers. Every episode in the original first batch uses this same parent. |
| Work creation | Reproduction Work `https://rezics.com/id/37533983-0262-be2a-55e9-8d0aecdaf9ca` | Work import returned a succeeded receipt; an immediate ASK confirmed CreativeWork, MainVersion, reverse Work binding and `catalogueVisible true`. [Catalogue import](../../../../services/main/src/modules/work/catalogue-import.ts):205,209 writes these atomically. |
| Reference read | Semantic read **false**, then Work read **false** for that exact IRI | [Reader](../../../../services/main/src/modules/semantic/admitted.ts):37–41. [Semantic disclosure](../../../../services/main/src/modules/access/semantic-disclosure.ts):105–106 deliberately excludes CreativeWorks. |
| Missing authority prerequisite | Fixture has **0 active provisions, 0 active `agent.control` mandates**; five dataset grants contain no Work read grant | [Work authority](../../../../services/main/src/modules/access/admission.ts):363–414 requires a baseline/preview proof or explicit authority. [Member proof](../../../../services/main/src/modules/access/baseline.ts):138–155 requires an active Person provision and live control. Verified email alone does not suffice. |
| Emitted refusal | HTTP 422 `unavailable_reference`, before Access registration or Content staging | [Bulk check](../../../../services/main/src/modules/semantic/staging.ts):583–588; [API mapping](../../../../services/main/src/routes/semantic.ts):53–57 discards reference details. |
| Product prerequisite and counterexample | Public Person provisioning makes Work read **true**; episodes **1807 and 1808** each return HTTP **201**, complete import has 1 Work + 2 resources | [Dataset session](../../../../scripts/datasets/auth.ts):300–328 provisions a Person before administrator setup. [Provision activation](../../../../services/main/src/modules/agent/provision.ts):154–169 creates control and activates the provision. Same five grants and same public importer/semantic route; no explicit read grant or projection wait. |

## Reproduction and limits

QA **20261012t002117-00e073**, project **20261012t002117-00e073-1**, passed
`bun scripts/goal/goalctl.ts test tests/qa/integration/episode-reference-reproduction.test.ts`.
The disposable wrapper loaded `.temp/episode-reference.test.ts`; evidence and
exact request/response bodies remain in `.temp/episode-reference/evidence.json`.
It used the locked anime pin, real owner PostgreSQL/Fuseki/object storage,
`startMediaStack`'s verified Account substitute, and `importDataset` with
`nativeBatchItems: 1`. No catalogue data was written directly to stores.
The two scenarios used separate import identities/journals in one isolated QA
epoch. The initial QA **20261012t002032-284c90** failed before test execution:
Bun treated the registered `.temp` path as a filter; the integration wrapper
resolved that harness problem.

The staged `bangumi-evidence.json` contains timings/statuses, **not** the raw
request/response journal described in the brief. Consequently the original
run's Work UUID cannot be recovered here. Its refused field and parent are
established by the retained measurement test and importer; the exact IRI above
is from the new reproduction. I did not rerun all 1,191 episodes or the original
16-item batch. Two accepted episodes disprove universal refusal, but do not
certify the complete pinned import or its throughput.

## Smallest correction and class

Correct the throwaway measurement test's setup: replace its unprovisioned
`stack.member(...).actor` with the active Person returned by `POST /v1/agents`,
then apply the existing dataset grants to that Agent. This matches
`localDatasetSession`; do not add a read bypass, change `referenceReader`, or
wait for a projection. Retain both refused and provisioned cases as a regression
if the measurement becomes permanent.

The observed class is **creation authority mistaken for readable identity**,
not a reference resolved before its target is created. The same external
reference reader serves semantic create/edit, relation changes and lexicon
presentations at `semantic/admitted.ts:83`; incomplete fixtures can fail there
too. Other `unavailable-reference` sites inspected:

- Exact prerequisite checks: `semantic/admitted.ts:213`,
  `relation/change.ts:379`, `lexicon/change.ts:210`,
  `relation/work-authority.ts:34,41,60`.
- Disclosure/concurrent graph guards: `relation/change.ts:202,497,504,508,558`,
  `rating/question-presentation.ts:436,463`.
- Notation collision: `semantic/change.ts:588`; receipt replay:
  `semantic/command.ts:121`.

Static inspection establishes no additional premature-creation defect at these
sites. A separate untested question is whether loss of a bulk reference between
preflight and activation can leave the operation pending: `staging.ts:513`
requires existence, while :555–561 only seals generation change after an
unmatched update. Reproduce that race before proposing a repair.

## Diagnostic recommendation and open question

Recommend returning the **caller-supplied** item index, JSON pointer and reference
with the same `unavailable` classification for hidden and absent targets. This
adds no identity the caller did not submit. Never expose labels, policies,
existence, or server-discovered hidden conflict references. The error type
(`semantic/command.ts:27–29`), API problem contract and hidden/missing equality
test (`tests/qa/integration/semantic-change.test.ts:209–223`) need a deliberate
owner change preserving indistinguishability apart from echoed input.
The remaining measurement question is the completed 1,191-episode import's cost
after correcting fixture provisioning; it was not measured here.

The open bulk-reference recovery question is investigated in
[Bulk semantic reference loss and pending recovery](semantic-bulk-pending-reference.md).
