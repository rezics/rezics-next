# Standard vocabulary profiles and application responsibility

Status: selected design, 2026-09-22; Statement simplification and shared Context
semantics adopted 2026-09-26.
This contract assigns representation,
validation, derivation and state-transition responsibilities. Feature owners retain
their business meaning. Runtime delivery remains subject to the existing plan.
The [coverage audit](../research/semantic-web-model-coverage.md) supplies the wider
candidate inventory; the [implementation binding](../implementation/model-profile-validation.md)
defines compilation, transactions and verification.

## Decision and alternatives

Use standard RDF types and properties directly when their referents and semantics
match. Add versioned application profiles for required fields and selected rules.
Keep a REZICS type only for a distinct domain identity/relationship whose lifecycle
or meaning is not adequately named by an admitted standard type. Put authority,
state transitions and atomic invariants in owning commands and their transactions.

| Alternative | Benefit | Reason for selection or rejection |
| --- | --- | --- |
| Native class/property for every application record, standards only on export | Uniform internal naming. | Reject as the default: duplicates standard meaning and creates permanent conversion work. |
| Replace every similar name with a standard class; load entire ontologies | Maximizes superficial reuse. | Reject: incompatible grains, property chains, equality inference and open-world assumptions can change meaning. |
| Standard terms + explicit profiles + small local extensions | Reuses meaning while retaining application integrity. | Selected. Each retained extension names the precise residual and owner. |
| Put business transitions into SHACL or general inference rules | Appears to make all behavior declarative. | Reject for authority and effects. State validation, fact derivation and a committed transition have different inputs and guarantees. |

An SDK type such as `NameRecord`, `Statement` or `Occurrence` can remain a useful
interface name without introducing a parallel RDF class. Likewise, a new property
does not require a new SQL table. Neither class count nor ontology count is an
optimization target independent of meaning.

## Five responsibilities

| Layer | Inputs and output | Examples | Prohibited inference |
| --- | --- | --- | --- |
| Vocabulary and identity | Referent definitions -> typed facts and relations. | SKOS Concept; RDF Statement; OA evidence annotation; identified labels and relation occurrences. | A type/property assertion does not admit an editor, grant or executable operation. |
| Profile and shape | Explicitly selected finite candidate state + pinned shapes -> conformance report. | Required refs, datatypes, cardinality, allowed values, bounded structural checks. | A valid state does not prove an authorized transition, immutable history or a concurrent uniqueness guarantee. |
| Pure rules and selection | Eligible facts + exact policy/context -> derived answer with evidence and completeness. | Classification projection, local/global fallback, rating reduction. | Derivation does not write an accepted decision or execute external effects. |
| Domain command | Verified actor + intent + old state + expected versions -> admitted change or typed failure. | Adopt, publish, judge, reconcile, grant, reserve, reset. | Preview and preflight are not committed success. |
| Transaction and workflow | Guarded local writes -> state + receipt + event; cross-owner stages -> recoverable outcome. | CAS, slot uniqueness, fences, outbox, leases and compensation. | A shape, RDF triple or message enqueue is not cross-store atomicity. |

Rules in this document include two different mechanisms. Positive monotonic
entailments may run in an admitted graph reasoner. Prioritized fallback, latest
revision selection, counting, permissions and absence-dependent decisions are
domain-owned pure functions/query plans with declared closed input scope. They
are not silently translated into unrestricted OWL or SHACL Rules.

## Native term and profile choices

Use `https://schema.org/` for newly authored Schema.org terms and expand external
prefixes using a pinned context. HTTP/HTTPS aliases in source data require a reviewed
mapping; RDF IRI string equality does not equate them automatically. `rezics-vocab`
continues to identify `https://rezics.com/vocab/`, separate from resource IDs.

| Application concept | Selected representation | Local residual / mapping restriction |
| --- | --- | --- |
| Concepts and schemes | `skos:Concept` on shared Resource identity; optional `skos:ConceptScheme`; standard semantic relations where meanings match. | Canonical meaning/version reference and acceptance are local. No mandatory Scheme or parallel Tag identity. A display group is not forced into `skos:broader`. |
| Shared interpretation Context | A Resource with separately versioned semantic and preference components; scoped DefinitionRefs, provenance and explicit adoption selections. | Local Context lifecycle/selection semantics follow [Context](context.md). No mandatory Realm owner, per-person copy, named graph or automatic authority-subject capability. |
| Contextual definitions and usage | Reuse definition components and SKOS documentation where appropriate; optional OntoLex mappings only for actual lexical modeling. | Changed application criteria retain exact qualified meaning. Naming another concept and reinterpreting the original are independent. Scoped definitions are not unqualified Global definitions or a compulsory Sense family. |
| Identified names | `skosxl:Label` with one `skosxl:literalForm`; `prov:wasDerivedFrom` for actual provenance. | `rezics-vocab:nameRecord`, role and validity/context links. Name selection is a separate decision. Do not assert every candidate as a global preferred label. |
| Simple chosen labels | `skos:prefLabel` / `skos:altLabel`, or `rdfs:label` where no preference is intended. | Materialize or expose selected labels only in the appropriate qualified view. The underlying same-language name records remain independent. |
| Work and Contribution | `schema:CreativeWork` and appropriate domain subtypes; standard author/language/derivation properties where applicable. | Work continuity and independently owned contribution profiles. BIBFRAME Work/Instance are exchange mappings with grain checks, not unconditional equivalent classes. |
| Work author credit | An identified `rezics-vocab:AuthorCredit` occurrence and immutable revision, with `schema:roleName` and `schema:position`. | `work-author-credit-v1` accepts an explicitly confirmed external author reference, not a fabricated `schema:Person` or `schema:author` edge. Source occurrence, ordinal, role key and support stay distinct from native identity. See [bounded adoption](source-lifecycle.md#bounded-native-author-credit-adoption). |
| MainVersion | Retain `rezics-vocab:MainVersion` and Work linkage. | A maintained selection identity is not identical to a snapshot or an external edition. PAV current-version relations may be exposed for a resolved content resource only when their meaning fits. |
| Component revisions | Keep `RevisionAnchor` as the immutable resolver contract; use `prov:Entity` for the exact described state and `prov:wasRevisionOf` for an actual revision relationship. | An anchor descriptor and the state it resolves must not be equated accidentally. The implementation specifies which an IRI denotes; never emit revision predicates between arbitrary metadata pointers. |
| Collections and composition | `schema:ItemList` and independently identified `schema:ListItem` entries; `schema:item` identifies the target. | Structure/parent, exact target selection and bounded order key are local fields. Numeric display positions can be derived. Large mutable compositions do not require RDF-list rewrites. |
| Semantic Statement | `rdf:Statement`, `rdf:subject`, `rdf:predicate`, `rdf:object` for an independently identified binary claim; standard provenance and OA selectors for evidence where applicable. | Exact relation/interpretation DefinitionRefs, authored speaker, selected semantic Context revision, qualifiers and separate decision basis follow the [statement contract](classification.md). Reification does not assert the base triple. The API record needs no duplicate generic Application class. |
| Named term application patterns | A structured component of the resource's exact definition, using the existing typed definition IR; selected OWL property/value conditions only where equivalent and admitted. | No mandatory Path, Expression or Sense identity. Pattern expansion preserves target applicability and origin; a concept label or navigation path cannot imply the pattern. |
| Qualified or repeated relations | Identified occurrences under the appropriate domain relation profile, with explicit participant-role predicates. | Do not flatten a Work/character/release/role occurrence into independent edges or use RDF reification to erase the distinction between a relation and a statement about it. |
| Decision and publication selection | Retain local decision/selection records; provenance links describe the command producing them. | State records are not `as:Accept`/`as:Reject` activities merely because the outcome names match. Activities may describe the action that produced a decision. |
| Rating and judgment | `schema:Rating` profile for a scalar opinion where suitable; distinct local judgment profile for fit/spoiler dimensions. Data Cube is an analytical/exchange view. | RatingContext, admitted slots, exact target, revision and private counting handle. Do not type every user rating as a sensor Observation or force mutable votes into an analytics cube. |
| Source records and observations | `prov:Entity` for a captured representation and `prov:Activity` for acquisition; existing retrieval/version properties as applicable. | Acquisition coverage, SourceBinding, child correspondence and human-control epoch remain explicit local fields. Captured bytes are not the acquisition event. |
| Space/Realm/Zone | Retain the local Space and independently managed capability configurations. | SIOC Site/Space/Community may describe an eligible public surface; no unconditional equivalence or rights transfer. |
| Public people/organizations | Appropriate Schema.org/PROV Agent types; ORG for genuine organizational membership/roles. | A generic Realm membership is not automatically an ORG membership, and a permission role is not automatically an organizational job role. |
| Private authority and grants | Existing PostgreSQL Account/Access records and typed commands remain authoritative. | Export only admitted descriptions. ODRL/WAC/ACP are mappings or future adapters, not a second grant store or a replacement for current Access semantics. |
| Media and annotations | `schema:MediaObject` for an encoding, OA SpecificResource/selectors for exact uses, standard format/language/provenance terms. | Stable asset identity, retained byte evidence and contextual Use/selection remain distinct. ImageObject describes appropriate image media; a locator is not the asset identity. |
| Posts, reactions, polls and notifications | Suitable ActivityStreams/SIOC types and predicates; export protocols can reuse ActivityPub/LDN. | Reply origin, Realm acceptance, eligibility, private progress and read/delivery state retain feature contracts. Adopting vocabulary does not activate federation. |
| Claims and assessments | OA/provenance representation; ClaimReview for a genuine fact-check review, DQV for quality metrics, nanopublications for selected exchange. | Assessment method/calibration and acceptance remain local. Do not flatten uncertain claims into accepted triples. |
| Rules, licenses and offerings | ODRL for an exact admitted rights/policy subset; Schema.org Offer/Order for suitable commercial descriptions. | Moderation jurisdiction, rights recognition, grantability, benefit overlap and settlement remain owner-controlled. Do not infer legal validity or live authorization from a description. |
| Packages, Skill, Prompt and MCP | Existing content/artifact/provenance terms; SPDX profile for catalog/BOM exchange. | Native requirement/environment/instance semantics, prompt/skill content profiles, capability observations and execution remain local adapters/commands. No new universal solver or protocol is inferred. |
| Queries, Blocks, events and jobs | Standard query/description terms where exact; local typed descriptors and receipts where needed. | API budget, exact result completeness, renderer payloads, retry keys, checkpoints and effect journals are application/operational contracts. |
| Spatial anchors | `oa:Annotation` targets an identified `geo:Feature`/`geo:Geometry` or an OA SpecificResource when a selector is needed. | Bind world epoch/frame/applicability explicitly. Reuse standard selectors; a geometry selector extension is admitted only if an identified target cannot express the requirement. |
| World recipe/instance/epoch | Provenance plan/entity profiles plus a small local world-lifecycle vocabulary. | Seed/adapter inputs, stable instance identity, resets and compatibility. Custom CRS IRIs do not identify world instances. |

Standard types do not have to be imported with all their ontology axioms. The
release manifest declares the vocabulary terms, the validation shapes, and the
separately elected entailment subset. If publishing standard types, honor their
normative meaning even when the storage engine is not running those entailments.

## When a local type or property is justified

Keep a local type when it answers a stable domain distinction: a MainVersion
versus a creative Work, a policy-scoped Decision versus the activity producing it,
or a domain relation occurrence with its own lifecycle. A profile-specific shape may target an
admitted record without creating a new class merely for validator dispatch.

Use a local property when the relationship is more specific than existing meaning:
classification context, decision head, parent occurrence, world epoch, editorial
control epoch, or protected operation receipt. Write down domain/range and cardinality
in the profile, and writer/state responsibility in the operation/storage binding.
Do not declare a subproperty solely to reuse a similarly named standard predicate:
its entailed parent assertion must also be true.

Profile IDs are versioned identifiers. A stored `dct:conformsTo` assertion is useful
metadata, not permission to choose weaker validation. The trusted owner selects
applicable profiles from the operation, target and admitted capabilities. Removing
`rdf:type`, a profile marker or a selector property cannot disable that obligation.

## Allocation of the remaining business rules

| Requirement | Shape / pure rule | Command and transactional responsibility |
| --- | --- | --- |
| One MainVersion per admitted Work | Shape checks the local required reference and cardinality. | Create/admit under the Work's unique slot; validate continuity and atomically create refs/receipt. |
| Adopt a contribution | Shape checks exact refs and selection form. Resolver follows the selected policy. | Verify current authority, compatibility and reviewed content/dependency revisions; CAS the publication selection. |
| Local rejection stops Global fallback | Pure resolver reads explicit local state and pinned inheritance policy. | Decide/withdraw commands write the decision and advance its generation; unreadable/unavailable local state is never absence. |
| Shared Context and scoped adoption | Resolve explicit/speaker/entry/Global selection, pinned base definitions and conflicts before acceptance. | Context edits require its authority; consumer selections require their own authority and CAS. Semantic publication cannot advance consumers or change earlier statements. |
| Personal and Realm interpretation | Preserve exact definitions, speaker, applicability and independent preference component. | Private selection stays Access-owned; Realm speech needs actual authority. Membership or a shared Context cannot impersonate another speaker or merge voters. |
| Stable repeated occurrence | Shape checks item/structure/parent/order form; structural validator checks the bounded affected topology. | Move/reparent serializes or guards the affected structure generation; progress stays attached to the occurrence. |
| Fit and spoiler independent | Shape checks each optional dimension separately; pure reducer calculates configured outputs. | Judge command validates eligible slot, privately derived counting handle and expected revision; updating one dimension preserves the other. |
| Daily/standing/experience ratings | Shape checks scale/value/time fields; pure reducer selects effective revisions before aggregating. | Admit slot using trusted time/identity, protect uniqueness under concurrency, and distinguish correction from new experience. |
| Human takeover and source withdrawal | Shape checks correspondence/base fields. Pure comparison computes proposed changes/conflicts. | Reconcile against source/base/local and human epoch; CAS the affected fields and remove only the withdrawing source's support. |
| Representation and revoked membership | Pure Access policy evaluation uses its coherent authority snapshot. | Access commands own approvals, ceilings, dependency liveness and admission/revocation fences in PostgreSQL. |
| Overlapping benefits and quotas | Shape/profile checks units/scopes; pure resolver combines eligible grants by policy. | Independent grants, payment reconciliation, reservation and settlement use their owning local transactions. |
| World reset/fork/restore | Shape checks epoch/frame references; pure compatibility calculation reports fit/drift. | Allocate/preserve the correct instance/epoch; activate mappings under expected generations, never silently retarget old annotations. |
| Immutable exact revision | Shape checks the anchor's fields. | Command rejects mutation of sealed meaning; storage retains resolver evidence and payloads. Two different immutable states may both satisfy the same shape. |

## Pure selection and derivation contract

First resolve interpretation using the [selection contract](context.md#selection-and-statement-meaning).
The result pins the applied DefinitionRefs, semantic Context/base revisions,
applicability and selection basis. An explicit existing Statement already carries
that meaning; a viewer's default cannot replace it. Preferences may rank eligible
results without reclassifying them. Incomplete or ambiguous resolution cannot
produce a write or an exact semantic count.

Then evaluate `resolveStatements(target, qualifiedMeaning, acceptanceScope, policyRevision,
dataGeneration, authoritySnapshot)` over explicitly eligible facts. Accepted local
decision selects local evidence; rejected/suppressed stops; confirmed absence may
follow the pinned inherit policy; unreadable/unavailable/partial returns the declared
unavailable outcome. Return chosen decision, inherited flag, input generations and
completion. Do not use generic missing-triple negation as proof of local absence.
Global fallback must address that same meaning or an explicitly admitted mapping,
not just the same concept ID. Contexts sharing definitions do not share acceptance.

The classification v1 implementation still accepts a Sense and selects an
Application/Decision. Its documented passes do not qualify the replacement
Statement profiles. Follow the [transition](classification.md#installed-profiles-and-transition)
before retiring those writers; exact retained revisions preserve their original
interpretation.

For ratings, first determine the effective revision/withdrawal of each logical
observation, then apply the policy's rater/slot/time reduction, then calculate
distributions. The policy artifact pins the algorithm identifier and parameters;
it cannot upload arbitrary source code. A new aggregation algorithm needs an
admitted implementation and evidence, not just another RDF predicate.

Allow finite positive entailment rules with declared inputs, outputs and budgets.
They may produce retrieval/semantic projections, never authoritative acceptance,
membership, grant, payment or publication predicates. Context selection precedes
reasoning. Identity-merging rules (`owl:sameAs`, keys, functional/inverse-functional
properties) are excluded from automatic product identity resolution.

A truncated rule closure is partial, even if a query returns HTTP 200. Missing
inferred rows cannot prove denial/absence, satisfy an exact count or justify a
fallback. Cache keys include manifest, rule/context generation, source snapshot and
disclosure domain; invalidation retracts unsupported derived results.

## Source basis and limits

[SHACL](https://www.w3.org/TR/shacl/) defines graph validation, including targets,
cardinality, closed shapes and SPARQL constraints; it requires its validation
input graphs to remain unchanged during the run. This does not supply a database
transaction protocol. [OWL's primer](https://www.w3.org/TR/owl2-primer/) explains
the absence of a unique-name assumption and identity inference from functional
properties. These justify the separation above.

[SKOS](https://www.w3.org/TR/skos-reference/) supplies label and concept semantics;
identified labels need not invent a new Name class. Basic label predicates have
no concept-only domain restriction. The [OntoLex community report](https://www.w3.org/2016/05/ontolex/)
separates words, referenced meanings and usage conditions; it is not a W3C
Recommendation and does not define our Context authority, defaults or revision
policy. It does not require a lexical Sense record for every native object.
[Web Annotation vocabulary](https://www.w3.org/TR/annotation-vocab/)
provides annotation relationships and classification motivation. [PAV](https://pav-ontology.github.io/pav/)
does not require a current-version target to be immutable, so it cannot replace
the anchor contract. [PROV-O](https://www.w3.org/TR/prov-o/) distinguishes entities,
activities and qualified provenance. [ListItem](https://schema.org/ListItem) and
[GeoSPARQL](https://docs.ogc.org/is/22-047r1/22-047r1.html) support the selected
entry/spatial representations. Other mappings retain the audit's source links.

The chosen division is a REZICS design deduction from these semantics. The
implementation document records bounded experiments separately from prospective
production acceptance. No new UI, federation, commercial operator or game adapter
is activated by adopting this contract.
