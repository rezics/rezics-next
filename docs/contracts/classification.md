# Objects, semantic statements and contextual classification

Status: adopted design, 2026-09-26. This contract replaces the mandatory
Tag/Path/Expression/Sense/Application chain. The installed classification v1
profiles remain the bounded implementation described under
[transition](#installed-profiles-and-transition); this decision alone qualifies
no new API, source conversion or aggregation.

## Objects and meaning

Use the shared [Resource identity](semantic-model.md) for works, characters,
people, concepts, roles and relation definitions. A concept can have names,
definitions, media and links like another object. Use `skos:Concept` where that
meaning fits; retain the distinction between a concept, an OWL/RDFS class and an
individual. Numbers, dates and other scalar values retain their admitted value
types and missing states; they need no fabricated resource identity.

There is no native Tag model. An external source's tag or trait is preserved with
its provider identity and meaning, then mapped to a resource and typed statement
through a reviewed source profile. A matching label alone proves no equivalence.
REZICS's product notion of semantic attribution is called `Statement` in the
contract. `prov:Attribution` continues to mean responsibility attributed to an
Agent, including authorship of a statement; it is not a generic semantic edge.

| Earlier abstraction | Adopted responsibility |
| --- | --- |
| Tag | Removed; use the referenced resource and actual relation meaning. |
| Concept | A semantic type on shared Resource identity, without a parallel identity wrapper. |
| Scheme | Optional vocabulary organization; creating a concept does not create a Scheme. |
| Path | Navigation/query structure; no obligatory classification identity or source of asserted meaning. |
| Expression | No mandatory independent record for a simple statement or named term's definition. Structured conditions use the existing versioned definition IR. |
| Sense | No obligatory intermediary. Exact definition references and explicit semantic context carry interpretation. |
| Application | Replaced by the identified Statement; no additional wrapper around each statement. |
| Decision | Existing contextual acceptance and revision mechanism, targeting a statement or exact qualified fact slot. |
| Effective Tag | Removed; effective statements and grouped results are rebuildable query projections. |

Names and navigation may change without changing meaning. A substantive meaning
change uses a new exact definition revision or identity under the owning
[correction rules](identity-correction.md); earlier statements keep their exact
interpretation. Distinct meanings with the same name remain distinct objects.
Different Realm labels or acceptance outcomes do not themselves create meanings.

## Named concepts and structured use

A named concept such as RedHair is one resource with names, a definition and a
resolved avatar. Its optional, reviewed application pattern may specify
`hairColor = Red` for an eligible character target. The pattern is part of the
concept's versioned definition, not another Path/Expression/Sense chain.

    selected term: RedHair, exact definition revision
    statement: Character A --hairColor--> Red
    source of application: selected term and its exact definition

The command expands an admitted pattern into its exact typed statement and
retains the selected term/definition as origin. Reads through either an equivalent
named term or the explicit property/value pattern resolve the same qualified
meaning. RedHair and Red retain separate resource identities. Never infer that
ordinary red hair, naturally red hair and dyed red hair are equivalent from their
names. A concept without an admitted pattern remains usable in an explicitly
named relation, such as subject or genre, without guessed extra facts.

Bare Red, `hairColor = Red` and `eyeColor = Red` have different meanings.
Admitted complex conditions reuse the versioned typed definition/query IR;
unsupported conditions return an explicit capability outcome. A new arbitrary
combination need not allocate a reusable named concept.

## Statement and occurrence contract

A Statement has a stable ID, exact subject/reference grain, admitted relation
definition, resource reference or typed value, semantic qualifiers, provenance,
originator, lifecycle and revision. Qualifiers include applicable release,
valid time or semantic canon when these affect the meaning. Evidence may address
exact revision-qualified text/media. A statement's existence does not establish
its acceptance.

For an identified binary claim with a known value, reuse `rdf:Statement`, `rdf:subject`,
`rdf:predicate` and `rdf:object`, with admitted context, definition and decision
fields. Describing that claim does not assert its base triple. Use Web Annotation
where exact evidence targeting or annotation meaning fits. Ordinary owner-managed
accepted scalar facts may still use direct predicates; do not reify every field.
Accepted edges derived from governed statements belong to a context-qualified,
rebuildable projection with one authoritative statement/decision source.
Value-state profiles preserve explicit unknown/no-value independently of absent
claims; they never fabricate a known object or derive an edge with a guessed value.

Relations with repeated participants or several argument roles use an identified
relation occurrence under the owning domain profile. A character's appearance
binds Work/release, character and narrative role in that same occurrence. A
character's role in one Work is not a permanent property of the character.
An appearance and a statement about that appearance have different referents;
their necessary distinction does not reinstate a universal Application wrapper.

Statement IDs preserve independently withdrawable source/proposal records.
A canonical meaning key groups the exact target grain, relation meaning
reference, normalized resource/value and meaning-bearing qualifiers. Preserve
occurrence identity when repetition is significant. Labels, navigation paths
and supporting-source count are not meaning keys. Value normalization obeys the
owning value profile, including units, missing states and language.

## Context, decisions and judgments

Separate semantic canon/applicability from the authority context deciding whether
to accept a statement. Resolve a qualified meaning slot under the exact
[context policy](context.md). Local acceptance selects its evidence; local
rejection suppresses inherited Global acceptance; confirmed local absence may
inherit; unreadable or unavailable state never becomes absence.

Several independent supporting statements can yield one effective fact without
losing their IDs, evidence or withdrawal history. Decisions identify their exact
statement or fact slot and evidence basis. Source withdrawal removes only that
support and invalidates dependent results under policy. It does not silently
retract another source or a human decision.
Only support admitted by the resolved decision contributes to its effective
fact. Matching a canonical meaning key alone does not adopt another proposal.

Fit and spoiler judgments target admitted statement/occurrence references under
[the judgment contract](classification-judgments.md). Objective existence,
subjective fit, source evidence, spoiler protection and moderation remain
independent. Imported scores never create native voters; Global and Realm
populations stay separate. Existing private accountability prevents persona
switching from multiplying votes.

## Grouping, inference and rendering

Appearance can be a display group of hairColor, eyeColor and other properties in
an existing view/Block descriptor. This membership creates no assertion about a
character. If Appearance itself is a discussed concept, its resource identity
does not automatically identify the view group. Reuse `skos:Collection` only for
groups of concepts/collections; grouping property definitions belongs to view
configuration. SKOS collections and concepts are distinct.

Use `skos:broader` only for appropriate concept relations; it is not subclassing
or automatic target membership. Moving a navigation entry does not reinterpret
stored statements. One concept may be discoverable through several paths without
duplicating its identity or result count.

The [search aggregation contract](search.md#statement-aggregation) resolves
eligible statements, performs admitted context-bound derivation, groups exact
meanings and returns named count grains before pagination. Rules distinguish
entailed facts from retrieval-only expansion and retain exact evidence and rule
generation. A Work containing a red-haired character is not itself red-haired.

The required counterexample is a Work with a non-red-haired female lead and a
different red-haired supporting character. It must not match a query for a
red-haired female lead. Bind character, role occurrence, release and compatible
trait applicability together; do not combine independent matches on the same Work.
Object summaries share [names and avatar resolution](presentation.md#resource-summaries).

## Operations and authority

| Operation | Required contract |
| --- | --- |
| Create/revise a resource or definition | Admitted types, names and exact meaning; optional application pattern. No automatic five-identity bundle. |
| Propose/create/revise/withdraw a statement or relation | Exact target grain, relation profile, participants/value, qualifiers, source and expected revision. Repeated occurrences retain identity. |
| Decide/revise/withdraw acceptance | Exact qualified fact/statement slot, context/policy revision, evidence basis, current authority and expected decision head. |
| Resolve/read statements | Requested grain/context and current disclosure; accepted, rejected, absent and unavailable remain distinct. |
| Query/group/inverse-read | Admitted typed filters, correlated occurrences, count grain, bounded support hydration and truthful completion. |
| Select an avatar | Existing Media Use/selection command, current resource authority and expected selection revision. |

These are owning capabilities; concrete routes/profiles are specified with their
schemas before implementation. Shared statement syntax never authorizes arbitrary
predicates, cross-owner writes, capability grants or authority changes. Each
mutation uses current Access admission, CAS, idempotency, immutable revision,
receipt and outbox at its owner's transaction boundary. Pure inference cannot
commit acceptance or grants.

Bound vocabulary/definition changes and affected statements. Enforce only the
hierarchy constraints admitted by the profile, including guarded DAG checks where
required. Derived indexes rebuild with staged generations and keyset catch-up;
never materialize the whole Resource x Realm x Concept product.

## Installed profiles and transition

`classification-proposition-v1` currently creates distinct Scheme, Concept,
Path, Expression and Global Sense IDs from one English label. Its native guarded
definition command, shape and recovery receipts are installed.
`classification-direct-decision-v1` currently creates a curated Application
and immutable Decision for one MainVersion/Sense/Global-or-Realm slot. The
resolver and bounded classified phrase lanes consume those existing IDs.
These APIs are implementation evidence for the earlier profile, not the target
schema for new general semantic work.

1. Author the replacement owner schemas, relation/definition profiles, operation
   contracts and generated RDF/JSON-LD artifacts first.
2. Qualify a real object/statement write-read, contextual decision and grouped
   query with the retained acceptance cases. Preserve receipts and recovery.
3. Cut new writes and consumers over to the replacement profiles. Map existing
   exact v1 ConceptAssertion meanings and retained evidence explicitly; never
   infer hair color, a character identity or a narrower relation from its label.
4. Retire the old creation chain and obsolete write operations. Retained immutable
   revisions, receipts and replay inputs still resolve through their exact old
   profiles or a verified lossless conversion. This does not require permanent
   parallel product APIs or compatibility with a separate old system.

The manager owns runtime scheduling and the acceptance inventory. Documentation
changes do not add a backend pass or remove a retained acceptance obligation.
See [classification acceptance](../testing/classification.md).

## Evidence

Reviewed 2026-09-26: [RDF reification](https://www.w3.org/TR/rdf-schema/#ch_reificationvocab)
describes statements; [SKOS](https://www.w3.org/TR/skos-reference/) distinguishes
concepts, labels, hierarchies and collections; [OWL 2](https://www.w3.org/TR/owl2-primer/)
supplies property/value conditions. The W3C
[n-ary relations Note](https://www.w3.org/TR/swbp-n-aryRelations/) supports
identified role-bearing occurrences. [PROV-O](https://www.w3.org/TR/prov-o/)
supplies responsibility/provenance, and
[Wikibase's data model](https://www.mediawiki.org/wiki/Wikibase/DataModel#Statements)
illustrates qualified statements with references. These sources do not prescribe
REZICS acceptance, canonicalization, avatar policy or performance. The selected
composition requires the owner API, recovery and workload checks above.
