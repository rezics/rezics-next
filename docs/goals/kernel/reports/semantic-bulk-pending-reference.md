# Bulk semantic reference loss and pending recovery

**Reproduced under injected graph disappearance.** A one-item bulk request can
leave its Content stage pending without a terminal graph receipt. Losing read
authority then prevents retry from reaching recovery, even after admission
expiry. This does not demonstrate a supported public deletion causing the loss:
the disappearing reference was injected through the isolated QA raw-update
surface. No product implementation or diagnostic response was changed.

## Reproduction

QA **20261012t010145-5985a9**, project **20261012t010145-5985a9-1**, passed
`bun scripts/goal/goalctl.ts test tests/qa/integration/semantic-bulk-reference-race-probe.test.ts`
(one test, 7.3 seconds). The disposable integration wrapper called the probe in
`.temp/semantic-bulk-reference-race.test.ts`, using `authorCreditFixture`, the
existing semantic-generation stage harness, real isolated PostgreSQL/Fuseki and
S3 immutable objects. New authority used `grantFixtureAuthority`; scope closure
used `ensureFixtureScopeGate`. Full request, responses, command outcomes and
owner-state snapshots remain in `.temp/semantic-bulk-reference-race/evidence.json`.
The wrapper was removed and is not committed.

Exact sequence:

1. Grant semantic single-create and bulk-create authority. Create a Person
   resource through `POST /v1/semantic/changes`; response is 201. Grant scoped
   semantic read authority for the returned resource.
2. Submit `POST /v1/semantic/changes/bulk` with one resource item, type
   `https://schema.org/Person`, and one property: predicate
   `https://schema.org/knows`, value `{ kind: "resource", ref: <created IRI> }`.
   Use one idempotency key for every subsequent call.
3. Intercept the first activation command containing `rv:bulkCount`, after
   preflight and staging. On the QA raw-update endpoint execute
   `DELETE WHERE { GRAPH <urn:rezics:graph:current> { <created IRI> ?p ?o } }`.
   Independently verify that the reference has no current RDF type or triples.
   Execute the original activation command unchanged; it returns
   `guard-unmatched`. The generation-change rejection also returns
   `guard-unmatched`.
4. Retry the identical request twice with scoped read authority retained. Both
   activation attempts and their generation-change rejection attempts return
   `guard-unmatched` again.
5. Close the reference's read scope. Retry, then force the existing admission's
   `expires_at` to one second before PostgreSQL's current time and retry again.
   Verify expiry from PostgreSQL rather than waiting for the real deadline.
6. Restore the exact captured current triples through QA `INSERT DATA`, reopen
   read authority, and make one further identical retry.

| Observation | HTTP result | Access admission | Content stage | Bulk graph receipt |
| --- | --- | --- | --- | --- |
| First activation after disappearance | 202, `reconciling`, retry allowed | claimed, no graph outcome | pending, no outcome | absent |
| Two identical retries | 202 each, same operation ID | claimed, no graph outcome | pending, no outcome | absent |
| Read scope closed | 422, `unavailable_reference` | claimed, no graph outcome | pending, no outcome | absent |
| Admission expired, scope still closed | 422, identical refusal | claimed, expired, no graph outcome | pending, no outcome | absent |
| Reference and read scope restored after expiry | 503, `dependency_unavailable` | sealed, cancelled | still pending, no outcome | present, cancellation committed |

The stage was `f5bae4da-0893-4a58-8503-d309a186a2ab`; its admission was
`01a12da1-b439-7111-8952-becfb27a01f5`. The active model generation matched the
stage's generation in every snapshot. The last row measures only the first
restored retry; another retry through the sealed-admission branch was not run.

## Mechanism and limits

[Bulk preflight](../../../../services/main/src/modules/semantic/staging.ts):582–588
checks readability before registering or recovering the admission. It does
**not** establish graph existence: scoped authority can pass independently of
the graph, via
[Access read authority](../../../../services/main/src/modules/access/admission.ts):600–609.
[Activation](../../../../services/main/src/modules/semantic/staging.ts):513
requires a current RDF type for every reference. After an unmatched command,
the only attempted terminal refusal is generation change (:555–561). With the
generation unchanged there is no receipt, so the operation remains pending.
Unreadable retries stop before the cancellation/expiry branch (:616–622).

No background semantic-stage reconciler was found in the service call sites.
Pending rows are removed when a stage outcome is inserted, through
[stage settlement](../../../../services/content/migrations/220_semantic_stage_generation_iri.sql):45.
The experiment establishes finite observations; indefinite persistence is the
code-supported inference while the reference remains unreadable and no
independent maintenance intervenes. Expiry alone did not repair it. Restoration
can reach cancellation, but its first retry did not yet settle Content.

Ordinary command deletion was refused with `invalid` and report
`prestate canonical type removed`, consistent with
[model mutation policy](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/ModelMutationPolicy.java):169.
Semantic retirement retains RDF types;
[erasure policy](../../../../infra/jena/command-module/src/main/java/com/rezics/jena/ErasurePolicy.java):68,97–98
excludes current-owner deletion. Hiding read authority alone does not remove the
activation existence match. The result therefore demonstrates a recovery gap
under storage disappearance, not a verified public delete/retire/hide race.

Two preliminary runs failed for probe setup, not as successful reproductions:
**20261012t005956-41689d** used a product command to remove the canonical type,
which was refused; **20261012t010052-0c794f** did not select the QA raw-update
assembler because its raw call lived only in the ignored `.temp` helper.
Putting the raw callback in the disposable wrapper selected the correct isolated
assembler. The final probe records and rethrows interceptor failures outside
activation's broad catch, so an injected exception cannot masquerade as the
observed pending race.

## Manager decision and deferred diagnostic work

Per the brief's reproduction stop condition and manager note, stop at this
report. Program should decide a separate recovery item before proceeding with
the caller-input diagnostic change. That diagnostic remains unimplemented;
its hidden/absent full-body equality proof still needs TRUST-OPS review.
Relation, lexicon, rating and work-authority unavailable-reference diagnostics
remain separate follow-ups, as identified in the
[original refusal report](anime-episode-reference-refusal.md#smallest-correction-and-class).
