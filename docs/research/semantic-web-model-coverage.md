# Semantic Web coverage and REZICS-specific model semantics

Semantic audit: 2026-09-22; Jena binding reconciliation: 2026-09-23. Scope: the 20 model families in the preceding model inventory,
the seven definition contracts, and the remaining identity/catalog/time/value
concerns in the [data contract map](../contracts/data-contract-map.md).

The follow-up [model profile contract](../contracts/model-profiles.md) and
[implementation binding](../implementation/model-profile-validation.md) select
the actual reuse/extension/validation/command division from this candidate audit.

## Finding and interpretation

The earlier inventory was an inventory of REZICS-owned application contracts. It
was not evidence that Semantic Web lacks those models. Every listed family has
relevant existing representation mechanisms, vocabularies, or research precedents.
Spatial annotation, versioning, contextual tagging, ordered membership, social
interaction, assessment, rights, and even fictional contexts/spoiler labels must
not be described wholesale as inventions required by a Semantic Web model gap.

The remaining work is mostly a REZICS application profile: selected meanings,
additional properties, eligibility/selection policies, and integration with
operational state. An application profile can reuse several vocabularies and add
only the distinctions they do not already supply. Owning an operation or retaining
a convenient application type name does not imply inventing its underlying concept.

This is a semantic/source audit, not implementation qualification. A vocabulary's
existence does not demonstrate Jena support, lossless mapping, policy enforcement,
or performance. Conversely, absence of a turnkey implementation is not absence of
a Semantic Web model. RDF can represent application-specific resources and
relations; no inspected requirement demonstrates an inability to represent it.
See [RDF concepts](https://www.w3.org/TR/rdf11-concepts/).

Negative findings below mean that the inspected specifications do not prescribe
the exact REZICS semantics. They do not claim that no unpublished or specialized
ontology anywhere contains a similar term. This audit establishes bounded coverage
of the repository inventory, not an exhaustive census of all ontologies.

## Spatial annotation: detailed correction

The local [spatial contract](../contracts/spatial-annotations.md) already cites
Web Annotation and GeoSPARQL. Its product-specific world lifecycle should have
been separated from their existing spatial/annotation machinery.

| REZICS concern | Existing provision | Actual remaining responsibility |
| --- | --- | --- |
| Attach content to a resource | Web Annotation supplies Annotation, body, target and attribution. | Bind the body to an eligible REZICS publication selection. |
| Select a resource fragment/state | SpecificResource, Selector and State; text, image, data-position and media-oriented selectors. | Select the admitted representation and preserve exact revision resolution; a time hint alone is not an immutable business anchor. |
| Feature, geometry, spatial relations and queries | GeoSPARQL 1.1 supplies Feature/Geometry, geometry literals and spatial relation/function families. | Choose supported geometry/query profiles and validate the engine implementation. |
| Coordinate reference identity and axis order | GeoSPARQL WKT literals can carry an SRS IRI, including non-OGC IRIs; axis order follows that SRS. | Define the game/world frame and supported transforms; custom CRS identification alone does not implement a transform. |
| Complete coordinate-system ontology | OGC's ontology-crs repository explores RDF descriptions of CRS elements and custom systems. | Treat this as candidate work with its own maturity assessment, not as proof GeoSPARQL already defines all frame internals. |
| Geospatial selectors | GeoWebAnnotations proposes GeoSelector/WktSelector extensions and has a QGIS proof of concept. | Check exact namespace, semantics and implementation before reuse; these are not built-in W3C Web Annotation terms. |
| Time and observed state | OWL-Time models temporal entities; SOSA/SSN models observations, procedures, results and features of interest. | Use observations only where their meaning fits; an arbitrary subjective annotation is not automatically a sensor observation. |
| WorldRecipe | Generation inputs/processes can be described using provenance and plan concepts. | Pin the adapter/build/input interpretation and the compatibility rules that make two generated regions correspond. |
| WorldInstance, InstanceEpoch and reset/fork/restore | Stable resource identities, temporal scoping and provenance provide building blocks. | Define save/server continuity, epoch transitions and anchor migration/drift. Equal seeds or coordinates do not establish the same world instance. |

Sources: [Web Annotation](https://www.w3.org/TR/annotation-model/),
[GeoSPARQL 1.1](https://docs.ogc.org/is/22-047r1/22-047r1.html),
[OGC CRS ontology work](https://github.com/opengeospatial/ontology-crs),
[GeoWebAnnotations paper, 2024](https://ceur-ws.org/Vol-3743/paper5.pdf),
[author implementation](https://github.com/situx/geowebannotation),
[OWL-Time](https://www.w3.org/TR/owl-time/),
[SOSA/SSN](https://www.w3.org/TR/vocab-ssn/).

In particular, do not treat GeoJSON as a generic game-coordinate encoding with
implicit axes: GeoSPARQL's GeoJSON literal profile uses WGS84 longitude/latitude.
Its WKT profile allows an explicit custom SRS. Nor does dimensional representation
prove that every required 3D operation is implemented. These are format/operator
qualification questions, separate from world continuity.

## Reconciliation of the complete prior inventory

The rightmost column is our comparison/inference from the external specifications
and the linked local requirements. It is not a claim made by the external authors.
Listed candidates are evidence of existing coverage, not automatic adoption or
declarations of owl:equivalentClass / owl:equivalentProperty.

| # / local model family | Existing Semantic Web or Linked Data provision | Smallest material REZICS residual |
| --- | --- | --- |
| 1. [MainVersion, Contribution and adoption](../contracts/main-version.md) | [PAV](https://pav-ontology.github.io/pav/) has version/current-version and authorship/curation relations; [DCAT 3](https://www.w3.org/TR/vocab-dcat-3/) includes version relationships; bibliographic models distinguish creative and publication grains. | A maintained product identity with one main version per admitted Work scope; independent same-language contributions; context-specific reviewed adoption, default composition and shared community continuity. MainVersion is not simply a current-snapshot pointer. |
| 2. [Space, Realm, Zone and curation](../contracts/space.md) | [SIOC](https://www.w3.org/submissions/sioc-spec/) has Space, Site, Forum, Community and containers; [ActivityStreams](https://www.w3.org/TR/activitystreams-vocabulary/) has collections and actor groups; [LDP](https://www.w3.org/TR/ldp/) has container/membership mechanisms. | Realm and Zone as independently admitted/retired capabilities on shared Space identity; governance versus presentation; mount disclosure; dynamic query capture behavior. A SIOC Space is a data location, not automatically this capability aggregate. |
| 3. [ContextPolicy and effective results](../contracts/context.md) | RDF datasets provide graph scoping; [nanopublications](https://nanopub.net/guidelines/working_draft/) separate assertions from provenance; [OntoMedia research](https://eprints.soton.ac.uk/263924/1/thesis.pdf), section 5.5.1, includes fictional-universe Context. | The six selected context roles and the exact Global/Realm accepted/rejected/absent/unavailable resolution table. Contextual representation itself is not missing. A graph name alone establishes none of these policies. |
| 4. [Structure, Occurrence, RevisionAnchor](../contracts/composition.md) | [Schema.org ListItem](https://schema.org/ListItem) separates an entry from its item and position; [ORE Proxy](https://www.openarchives.org/ore/1.0/datamodel) describes an aggregated resource in an aggregation; [IIIF Presentation 3](https://iiif.io/api/presentation/3.0/) provides ordered presentation structures; provenance/version vocabularies describe changes. | Stable identities for repeated placements, edits/reparenting and progress; exact component-to-immutable-RevisionAnchor manifest resolution, retention and sealed transitive selections. Compare cardinality before mapping repeated entries to ORE; a similar contextual proxy is not proof of full occurrence equivalence. |
| 5. [Path, Expression, Sense, Application, Decision](../contracts/classification.md) | [SKOS/SKOS-XL](https://www.w3.org/TR/skos-reference/) cover vocabulary organization and labels. [MUTO](https://muto.socialtagging.org/core/v1.html) distinguishes tags from taggings and reviews earlier MOAT/TAGS work. [OntoLex-Lemon](https://www.w3.org/2016/05/ontolex/) has lexical senses. | Typed path-to-proposition interpretation; canonical proposition keys; versioned Global/Realm Sense; application existence separate from contextual acceptance. An OntoLex lexical sense is not the same thing as a REZICS path interpretation. A SPARQL property path does not itself specify the proposition asserted by our Tag Path. |
| 6. [Fit and spoiler judgments](../contracts/classification-judgments.md) | Annotation/tagging/assessment models provide basic statement and evaluation structure. OntoMedia already introduced spoiler classes: [original thesis, section 5.5.1](https://eprints.soton.ac.uk/263924/1/thesis.pdf). | Independent fit and three-level spoiler dimensions; eligible private counting identity; distinct protection versus displayed-conclusion outputs; selected Wilson policy and override behavior. Neither spoiler labels nor subjective judgments are new generic concepts. |
| 7. [RatingContext and RatingObservation](../contracts/ratings.md) | [Rating](https://schema.org/Rating) expresses values/scales; [RDF Data Cube](https://www.w3.org/TR/vocab-data-cube/) represents multidimensional observations and measures. | Exact question/target/population/scale/cadence profile; standing/daily/experience slots; revisions versus new experiences; anti-persona duplication and selected aggregation/retraction behavior. A domain-specific rating profile is needed, not a new general concept of observation. |
| 8. [SourceRecord, SourceObservation, Binding and field adoption](../contracts/source-lifecycle.md) | [PROV-O](https://www.w3.org/TR/prov-o/) represents derivation and qualified activity/agent relations; PAV distinguishes import/retrieval/authorship; [R2RML](https://www.w3.org/TR/r2rml/) is a specific relational-to-RDF mapping standard. | Provider acquisition coverage; stable child correspondence; source/base/local reconciliation; same-value human takeover; per-source support withdrawal. R2RML alone does not cover arbitrary web-source parsing, human reconciliation or bidirectional loss accounting. |
| 9. [Identity, representation and permissions](../contracts/identity-and-access.md) | [ORG](https://www.w3.org/TR/vocab-org/) models organizations, roles and membership; [ODRL](https://www.w3.org/TR/odrl-model/) models policies/parties/permissions; [Solid WAC](https://solidproject.org/TR/wac) and [ACP](https://solid.github.io/authorization-panel/acp-specification/) specify access-control mechanisms. | Private Principal versus public Agent; selected complete representation path, grantability ceilings, admission generations, dependent versus durable assignments and effective revocation fences. Authentication and credential protocols also exist outside the ontology layer; their operation is not an ontology invention. |
| 10. [NameRecord and identifiers](../contracts/names-and-authority.md) | SKOS-XL supplies identified labels; OntoLex handles lexical entries/forms/senses; [DCMI](https://www.dublincore.org/specifications/dublin-core/dcmi-terms/) supplies titles/identifiers and related metadata. | Name-role/validity/source profiles, context-sensitive selection and editorial control. SKOS label properties are not restricted to Concepts; the actual constraint is preferred-label meaning, including the one-preferred-label-per-language rule and SKOS-XL's corresponding property-chain consequences. |
| 11. [Documents, Blocks and media](../contracts/presentation.md) | [DoCO](https://sparontologies.github.io/doco/current/doco.html) models document components; IIIF models presentation; [MediaObject](https://schema.org/MediaObject) describes encodings/content locations; Annotation selectors identify parts. | Registered executable-free Block payload schemas and renderer behavior; exact asset state/byte/use distinctions; upload activation, compatible reuse and disclosure. An editor AST or rendering implementation is not supplied merely by adopting a document ontology. |
| 12. [Community, messages and notifications](../contracts/community-interactions.md) | SIOC provides posts/threads and related concepts. ActivityStreams supplies Note, Like, Follow, Question, Read and other activities; [ActivityPub](https://www.w3.org/TR/activitypub/) and [Linked Data Notifications](https://www.w3.org/TR/ldn/) provide delivery/inbox protocols. | REZICS reply-origin preservation, independent Realm adoption, ballot eligibility, private progress, history windows, device/recipient read state and delivery reconciliation. Poll representation is already present; privacy and membership policy still need a profile. |
| 13. [Claim, Evidence, Assessment, Acceptance](../contracts/information-verification.md) | Nanopublications carry assertions/provenance; [ClaimReview](https://schema.org/ClaimReview) describes fact-check reviews; [DQV](https://www.w3.org/TR/vocab-dqv/) describes quality metrics/measurements and annotations. | Exact method applicability, independence/dependence of evidence, calibrated assessment and community/platform acceptance. A generic assessment record is available; REZICS's evidential decision procedure is not selected by it. |
| 14. [Rules, reports, enforcement and appeals](../contracts/content-governance.md) | ODRL includes rule, constraint, duty and conflict-policy machinery. Annotation provides evidence targeting; social vocabularies have Flag/Accept/Reject/Undo activities. | Case/evidence/rule version bindings, authorized adjudication, scope-specific enforcement and attributable appeals/reversals. ODRL is a genuine policy model, not merely a free-text license field; its rules still do not prescribe REZICS moderation jurisdiction. |
| 15. [Packages and installation](../contracts/package-management.md) | [SPDX 3.0.1 Package](https://spdx.github.io/spdx-spec/v3.0.1/model/Software/Classes/Package/) and [relationships](https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/) cover artifacts, package metadata and dependency-related descriptions; [SoftwareApplication](https://schema.org/SoftwareApplication) provides application metadata. | Cross-ecosystem requirement interpretation, candidate selection, environment/peer-scoped instances, exact locks, file ownership and recoverable activation. A BOM/dependency relation is not a full package resolver or installation contract. |
| 16. [Skill, Prompt and MCP](../contracts/skills-and-prompts.md) | Creative-work, package and provenance vocabularies cover content/artifacts. [SPDX's AI profile](https://spdx.github.io/spdx-spec/v3.0.1/model/AI/AI/) provides AI software metadata; OWL-S/Hydra provide service-description precedents. | Skill file/entry conventions; Prompt parameter/example/applicability profiles; observed MCP capability revisions and consent-bound execution. A universal ready-made mapping for the entire REZICS Hub was not established. Agent Skills and MCP also have their own non-RDF protocols, so this is not a claim that their formats must be invented. |
| 17. [Filters, graph views and presentation queries](../contracts/filter-documents.md) | [SPARQL](https://www.w3.org/TR/sparql11-query/) provides graph queries, filters, paths, ordering and aggregation; [Hydra](https://www.hydra-cg.com/spec/latest/core/) describes API operations/templates/collections. | Typed UI descriptor/field registry, shared query budgets, context resolution, graph-integrated full-text completeness, protected snippets and generation-bound continuation. The specific filter AST is an application interface; query expressivity itself is not missing. |
| 18. [Subscriptions, benefits, quotas and rights](../contracts/subscriptions.md) | [Offer](https://schema.org/Offer), [Order](https://schema.org/Order), [ProgramMembership](https://schema.org/ProgramMembership), [MemberProgramTier](https://schema.org/MemberProgramTier) and ODRL cover substantial commercial/rights description. | Independent purchased/gifted grants and their overlap rules, entitlement-to-Access bridge, reservation/settlement and callback reconciliation. The exact license-offering recognition lifecycle is also a local contract; standard vocabulary does not determine that policy. |
| 19. [Receipts, events and jobs](../contracts/events-and-jobs.md) | Provenance/activity vocabularies describe performed work. [OWL-S](https://www.w3.org/submissions/OWL-S/) describes service inputs, outputs, preconditions and effects. [SPARQL Update](https://www.w3.org/TR/sparql11-update/) defines graph mutations. | Idempotency key/digest scope, durable outcome receipt, leases/fences/checkpoints, causal transport and compensation across stores. This is predominantly operational engineering, not a missing descriptive ontology. |
| 20. [Worlds and spatial annotation](../contracts/spatial-annotations.md) | Annotation + GeoSPARQL + temporal/provenance vocabularies, with GeoWebAnnotations and CRS ontology work as additional candidates. | Game generation profiles, instance/epoch continuity, world-frame applicability and anchor drift/migration, as detailed above. Geometry, annotation and CRS references must not be counted wholesale as self-invented. |

## Additional foundation and domain coverage

The earlier inventory also relied on these concepts without counting each as a
separate family. They have existing coverage too:

| Concern | Existing basis | REZICS-specific part |
| --- | --- | --- |
| Resource and reference grains | RDF IRIs; provenance/version relations; selector and encoding resources. | UUID allocation, typed API reference contracts, component anchors, routing and exact disclosure-qualified resolution. |
| Books, editions and creative works | [BIBFRAME 2.0](https://www.loc.gov/bibframe/docs/bibframe2-model.html) distinguishes Work/Instance/Item; [LRMoo](https://www.ifla.org/news/newly-available-object-oriented-lrm-conceptual-model/) supplies another bibliographic conceptual model. | Native creative continuity and MainVersion mapping. BIBFRAME Work and REZICS Work can differ in grain; common names do not establish equivalence. |
| Music, recording, tracks and releases | [Music Ontology](https://motools.sourceforge.net/doc/musicontology.html), bibliographic/media vocabularies and ordered-entry patterns. | Selected source mappings, repeated-track occurrence identity and role-qualified credits under local context. |
| Recipes | [Schema.org Recipe](https://schema.org/Recipe), ordered steps and quantity vocabularies. | Ingredient-occurrence/application profiles, substitutions, coverage and non-linear scaling policy. |
| Temporal entities, quantities and units | OWL-Time, SOSA/SSN and [QUDT](https://www.qudt.org/doc/DOC_SCHEMA-QUDT.html). | Exact accepted value/missing-state profiles, source-preserving conversion and query interpretation. The existence of units does not authorize arbitrary conversions. |
| Ownership and deployment placement | Generic resource/provenance/service descriptions exist. | Unique authoritative component writer, dataset routing, fence epochs and recovery are architecture bindings, not new semantic categories. |

Coverage against D01-D22: identity/addressing is covered here; access by row 9;
claims by rows 5/13; names by row 10; books/media/music by this table and row 11;
software by row 15; publication/discussion by row 12; curation by row 2;
classification/interaction by rows 5-7/12; communication by row 12; governance by
row 14; sources by row 8; queries by row 17; extension admission by the next
section; commands by row 19; ownership by this table; creation by rows 1/4/11;
graph views by row 17; Hub by row 16; subscription/participation by rows 9/14/18.

## The seven definition contracts are not seven missing Semantic Web facilities

| Local contract | Existing mechanism | Local addition |
| --- | --- | --- |
| ResourceDefinition | RDFS/OWL classes/properties and SHACL node shapes. | Owner, lifecycle, capability admission and API identity grain. |
| ValueDefinition | RDF datatypes/language literals, OWL datatype restrictions, SHACL and domain value vocabularies. | Lossless wire format, admitted missing states and conversion/comparison policy. |
| RelationDefinition | RDF properties, OWL relation axioms, SHACL paths/counts, qualified relation/entry patterns. | Selected occurrence identity, participant-role profile, order and context rules. |
| ConstraintProfile | SHACL shapes, targets, severity and SPARQL constraints; PROF can describe profiles and supporting artifacts. | Allowed reasoning/validation subset, budget and activation procedure. |
| OperationContract | Hydra operation descriptions, OWL-S process descriptions, LDP and SPARQL Update protocols. | Exact domain authority, compare-and-swap, idempotency, transaction boundary and recovery outcomes. |
| StorageBinding | R2RML describes relational-to-RDF mappings; SPARQL Service Description describes datasets and endpoint capabilities. | Authoritative writer/graph/fields, supported storage transactions, indexes, partitions and relocation protocol. |
| ExchangeMapping | R2RML and vocabulary-specific mapping mechanisms provide precedents. | The chosen source/target profiles, direction, executable conversion, residual/loss accounting and conformance cases. |

Sources: [OWL 2](https://www.w3.org/TR/owl2-overview/),
[SHACL](https://www.w3.org/TR/shacl/),
[PROF](https://www.w3.org/TR/dx-prof/),
[SPARQL Service Description](https://www.w3.org/TR/sparql11-service-description/),
and the linked protocol/mapping sources above.

The seven-part decomposition and common generated IR are REZICS engineering
choices. Their foundations should be reused. A schema constraint is not a
concurrency mechanism, and a service description is not an implemented service.
Neither limitation makes all validation or operation modeling proprietary.

## Minimal residuals worth retaining explicitly

These are the strongest candidates for a REZICS-specific profile or extension,
based on the inspected sources. They do not all require new ontology classes:

1. **Maintained MainVersion selection:** the shared native content/community axis,
   independently owned contributions and context-reviewed adoption.
2. **Typed context resolution:** the role separation and exact local/global
   acceptance, rejection, inheritance and unavailable-state behavior.
3. **Tag Path interpretation:** a versioned path-to-proposition contract and the
   relationship between Sense, Application, Decision and effective results.
4. **Judgment and rating admission/aggregation:** question/slot/counting identity,
   correction semantics, persona protection and the selected spoiler policy.
5. **Editorial source reconciliation:** source/base/local correspondence,
   same-value human takeover and independent source-support withdrawal.
6. **World continuity:** generation profile, save/server/epoch identity and
   compatibility-aware anchor migration across reset/fork/restore.
7. **Authority and participation profile:** representation paths, assignment
   dependence, approval ceilings and admission generations.
8. **Benefit and publication policy:** overlapping independent awards/purchases,
   quota admission and exact Realm review/acceptance.

A second category must remain separate: application-owned revision resolvers over
Jena and retained objects, cross-store receipts/fencing, solver adapters, installation journals, full-text generation
activation and renderer implementations. These are required system mechanisms;
they are not evidence of missing generic entities in Semantic Web.

## Maturity, compatibility traps and follow-up evidence

The audit intentionally includes more than W3C Recommendations. Existing precedent
and suitable production dependency are different findings:

- RDF/OWL, SKOS, PROV-O, SHACL, OWL-Time, SOSA/SSN, Data Cube, ORG, ODRL,
  ActivityStreams, ActivityPub, LDP, LDN, R2RML, SPARQL and DCAT 3 have W3C
  Recommendation publications for the inspected versions; GeoSPARQL 1.1 is OGC.
- DQV and PROF are W3C Notes. SIOC and OWL-S are Member Submissions, not W3C
  Recommendations. OntoLex is a Community Report. Solid WAC/ACP and Hydra are
  community specifications; inspected WAC/Hydra pages explicitly distinguish
  themselves from W3C standards.
- Schema.org is a maintained vocabulary; inspected pages display V30.1 dated
  2026-09-16 and a development-version notice. Pin the elected vocabulary artifact
  for implementation rather than treating a moving documentation URL as a lock.
- PAV, MUTO, Music Ontology, DoCO, ORE, IIIF and nanopublications have their own
  publication/governance processes. SPDX was inspected at 3.0.1; development/RC
  search results were not substituted for that version.
- GeoWebAnnotations is a 2024 research proposal with an author implementation;
  OntoMedia is research precedent. Neither establishes a currently maintained,
  universally supported application profile. OGC ontology-crs repository goals
  are not evidence that every proposed capability is an adopted standard.

Important non-equivalences are MainVersion/current snapshot, native Work/external
Work, Occurrence/aggregation Proxy, path Sense/lexical Sense, Concept/Class,
SIOC Space/REZICS Space, source Observation/sensor Observation, declared rights/
effective permission, BOM dependency/resolved installation and named graph/
authorized perspective. In particular, RDF 1.1 does not impose the relationship
between a graph name's referent and its graph; see [RDF datasets](https://www.w3.org/TR/rdf11-concepts/#section-dataset).

Before activating any new mapping, demonstrate representative round trips and
counterexamples: repeated targets; same-language alternatives; local rejection
without fallback; independent fit/spoiler edits; source withdrawal after human
confirmation; equal seeds in different worlds; custom CRS interpretation;
revoked representation; overlapping gift/purchase; and changed dependency scope.
Compare domain/range, cardinality, identity, inference and losses, not class names.
No mapping, shape, concurrency, performance or Jena-operator test was executed
as part of this research-only audit.

The proposed outcome is to reuse standard terms when they match, define local
profiles for the precise residuals, and retain command/runtime invariants with
their owners. No broad namespace migration or new external ontology dependency
is activated by this document.
