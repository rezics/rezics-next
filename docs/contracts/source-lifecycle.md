# Source observations, mapping and native adoption

## Identity and authority

A SourceRecord uses provider/namespace/external identity. An Observation captures
the exact fetched representation, acquisition time, coverage, source revision and
provenance. Equal bytes at different observations do not erase causal history.
A Binding maps source grains to native targets; native identity remains independent.

Default to preserving original bytes in controlled object storage and a structured
source graph in Jena under the intake policy below. Record actual acquisition or
retention limits and omitted fields; reproduction requirements cannot expand rights.
Preserve unknown/absent/null/zero, lexical forms, qualifiers, order and
unmapped fields. A failed or narrower fetch cannot withdraw previously observed
data outside its declared coverage. Credentials and excluded-private fields do
not enter public source graphs.

## Basis for acquisition and reuse

REZICS includes a collaborative wiki operated by a U.S. company. Neither that
company status nor the wiki purpose is a blanket decision about commercial use,
copyright protection or permission. Manual entry and automated import distinguish
unprotected facts from expressive text, images and original compilation structure.
See the [U.S. legal and provider evidence](../research/source-data-rights.md).

The operating policy is to maximize data intake and preservation, retain provenance
and rights evidence, and respond to concrete complaints at the affected scope.
Company status, an NC marker or incomplete license information alone does not
reject intake or force blanket quarantine. Do not impose universal legal clearance
or a separate permission request before every entry or import; reuse source/field
rules for ordinary cases. Missing rights information remains explicitly unknown,
not a fabricated permission or a conclusion that the use is unlawful.

Record available evidence for the relevant material and operation: original
contribution, unprotected facts/public domain, applicable license or permission,
or a reasoned statutory exception such as fair use. Intake acceptance records an
operational decision, not legal clearance. Known restrictions, concrete evidence
of infringement and effective complaint decisions require scoped action; the
absence of a complaint cannot override them.

Assess API/service eligibility and retention terms separately from data rights.
Acquisition, storage, wiki display, search and redistribution can have different
bases and conditions. NC is use-specific; ShareAlike alone does not prohibit
commercial use. Preserve attribution and applicable sharing obligations through
mapping and export. A supported wiki use does not automatically authorize a paid
feed, full dump or different downstream use. Keep uncertain rights visible without
excluding independently supported facts or contributions from the provider.

## Complaints and source continuity

Use [content governance](content-governance.md#rights-complaints) for notices,
targeted restriction, decisions and appeals. A complaint about one image, synopsis
or use does not automatically remove every fact from the provider or the native
resource's identity. Apply the actual decision scope to raw payloads, derived
fields, search and media, and prevent refresh/reimport from restoring restricted
material. Human confirmation changes edit control, not the rights in copied
expression. Retain independently supported facts and permitted evidence; physical
deletion follows the [erasure owner](../operations/erasure.md) when required.

## Conversion and adoption

The pipeline is acquire -> preserve -> parse -> map -> propose -> validate -> adopt
-> publish where applicable. Each stage has an operation identity and explicit
outcome. Source-supported knowledge remains queryable without native adoption
within its recorded use and disclosure scope.
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
