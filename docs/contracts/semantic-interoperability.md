# Source graphs and portable semantic exchange

## Preservation and native adoption

Preserve source datasets separately from accepted native facts. Keep external
IRIs, source-scoped blank nodes, datatypes/languages, graph structure, ordering,
statements and acquisition coverage. Native correspondence is an explicit mapping
with evidence; source equality/redirects do not establish native identity or control.

Structured source indexing may precede native mapping. Field disposition is native,
structured-source-only, lossy, excluded or unsupported with concrete reason.
Raw bytes support recovery but do not substitute for queryable preservation.

## JSON-LD and Schema.org

Capture referenced context bytes/options for each run. Normalize only under the
selected mapping and retain original evidence. Preserve multi-type resources,
lists/sets, repeated occurrences, nested identifiers, JSON literals and unavailable
fields. Qualified JSON-LD is the initial syntax path; Microdata/RDFa coverage is
required when their full-source profile is activated, not inferred from JSON-LD.

Map Recipe ingredient text without inventing units; Work/edition/media relationships
without fabricated parents; and software versions without imposing one comparator.
Native Main Version has its own semantics and may require multiple mapped export
objects. Record the mapping rather than claiming it is identical to an external class.

## Wikidata/Wikibase

Retain entity kind, statement identity, qualifiers, references, rank and somevalue/
novalue distinctions. Datatype-specific time precision/calendar, quantity bounds/
units, coordinates, external IDs and language values remain exact. Truthy dumps
cannot qualify full statement preservation. Lexemes/forms/senses and other elected
surfaces each need a declared profile and test denominator.

Parsing or reasoning must not turn unaccepted or hypothetical statements
into asserted native edges. RDF 1.1 identified claims are the initial profile;
RDF-star/RDF 1.2 syntax is separately admitted after parser and export qualification. Explicit Assertion resources are the baseline for
source claims. Export only supported meaning and declare residual data/losses.

## Query, update and export

Source queries retain namespace and coverage. Changes/withdrawals propagate through
mapped support and bounded invalidation without overriding human decisions.
Exports pin the requested source/native selection and current disclosure, preserve
blank-node scope or deterministic skolemization policy, and remain replayable.
Cross-source union is explicit and does not silently merge contexts or trust.

Native exports distinguish JSON-LD term contexts from shared semantic Contexts.
Preserve the actual speaker, exact applied DefinitionRefs, Context semantic
revision, applicability and separate acceptance basis of each interpreted claim.
Local definitions/usage notes remain scoped; exporting them as unqualified Global
definitions or membership triples is a meaning loss. A recipient without this
profile receives an explicit residual or unsupported result. Private selection
links and hidden definition dependencies cannot be disclosed or replaced with a
different public meaning. Round-trips must preserve both a named narrower concept
and simultaneous local interpretation of the original concept.

Full-source indexing is a later workload/profile activation. The model and selected
first-stage mappings are required now. See [live conformance](../testing/source-conformance.md).
