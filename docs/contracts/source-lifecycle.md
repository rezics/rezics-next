# Source observations, mapping and native adoption

## Identity and authority

A SourceRecord uses provider/namespace/external identity. An Observation captures
the exact fetched representation, acquisition time, coverage, source revision and
provenance. Equal bytes at different observations do not erase causal history.
A Binding maps source grains to native targets; native identity remains independent.

Store original bytes in controlled object storage and a structured source graph
in Jena. Preserve unknown/absent/null/zero, lexical forms, qualifiers, order and
unmapped fields. A failed or narrower fetch cannot withdraw previously observed
data outside its declared coverage. Credentials and excluded-private fields do
not enter public source graphs.

## Conversion and adoption

The pipeline is acquire -> preserve -> parse -> map -> propose -> validate -> adopt
-> publish where applicable. Each stage has an operation identity and explicit
outcome. Source-supported knowledge remains queryable without native adoption.
Raw payload storage alone does not qualify structured conversion.

Field applications record base source observation, mapping revision, target head,
human-control epoch and correspondence. Same-value human confirmation takes over
control just as a changed value does. Source withdrawal removes that support only;
other sources and independent native confirmation survive. Reapply cannot undo a
later human edit. Redirects/merges propose identity correction; they never transfer
grants, ratings or content ownership.

## Child correspondence and structure

Repeated tracks, chapters, ingredients, names and credit participants retain
occurrence identity. Use observation-qualified keys when provider child keys are
unstable. Reordering, split/merge or reused keys can yield conflict rather than
false correspondence. Large bundles stage bounded pages, validate complete coverage
and activate under target/binding/authority generations.

## Change intake and reconciliation

Bootstrap dumps and changes overlap deliberately with dedupe and a recorded
frontier. Gaps trigger targeted reconciliation or a new baseline. A query returning
no row is not necessarily a deletion signal. Rate limits, retries and streaming
joins have provider-specific budgets. Imports cannot synchronously starve product
transactions or rebuild every search document.

Every run fetches current official contracts and representative data; per-run
snapshots support reproduction without freezing future versions. Keep source
coverage, native mapping, query and export qualification separate. See
[source acceptance](../testing/source-conformance.md) and [worker service](../services/workers.md).
