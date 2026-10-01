# Live source conversion and conformance

## Acquisition and reproduction

Fetch current official contracts and representative records/version sets on each
live run. Choose by scenario criteria, not permanently pinned package releases.
Under the [source acquisition/reuse basis](../contracts/source-lifecycle.md#basis-for-acquisition-and-reuse),
capture exact bytes subject to actual retention limits, plus response metadata, source
revisions, coverage, acquisition time and tool/profile versions once for that run.
Record retention limits and omitted surfaces explicitly; a conformance fixture
does not authorize prohibited caching. If a required capture conflicts with an
applicable restriction, leave that surface unqualified or use a separately
permitted sample. Incomplete license metadata alone is not a capture failure.
Reuse an admitted capture for native conversion and differential checks so
mid-run upstream changes do not masquerade
as mapper defects. Authored offline counterexamples remain deterministic.

Normative vocabulary/compiler dependencies and deployment binaries are pinned
separately. Live conformance does not require them to float. Keep acquisition
definitions and mapping assertions in source control; fetched data and run artifacts
belong to controlled ignored/artifact storage, not the design collection.

## Required source matrix

The elected providers and semantic surfaces are declared in
[`sourceConformanceTargets`](../../scripts/qa/cases/source-conformance.ts).
Each provider/surface needs its own acquisition and mapping evidence; a selected
Open Library run does not qualify the rest of the matrix.

Official entry points: [Open Library](https://openlibrary.org/developers/api),
[MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_Database/Schema),
[CAA](https://musicbrainz.org/doc/Cover_Art_Archive/API),
[VNDB](https://api.vndb.org/kana), [Bangumi](https://github.com/bangumi/Archive),
[Recipe](https://schema.org/Recipe), [Agent Skills](https://agentskills.io/specification).
Package/provider details are in [profiles](../contracts/package-profiles.md).

## Field and workflow coverage

The concept/association mapping requires a VNDB-oriented fixture within existing
LIVE01/LIVE04/LIVE07-LIVE12 coverage. It must retain provider concept IDs and
unresolved terms, distinguish
same-label meanings, preserve group-qualified display, keep repeated
release-specific appearances and source spoiler/score fields, and verify exact
native/export dispositions. Include the same-character role/trait conjunction
and withdrawal of one supporting source. A reviewed schema is not a passing live
conversion, and imported aggregates never manufacture native voters.

LIVE07-LIVE12 exchange/mapping cases also preserve exact interpretation definitions,
speaker, Context semantic revision and separate acceptance under the
[portable exchange contract](../contracts/semantic-interoperability.md).
Round-trip a named narrower concept together with simultaneous contextual
interpretations of the original. Unsupported scope is an explicit residual;
same labels cannot justify equivalence, and export cannot flatten a qualified
claim into an unconditional Global triple or leak private selection dependencies.
These prospective additions do not certify a live conversion.

For each elected source surface enumerate field/grain dispositions: native,
structured-source-only, lossy, excluded or unsupported. Validate source queries,
native owner commands, API/export and change handling. Raw bytes, schema counts
or a few successful records do not qualify all fields. API/dump/archive/artwork
coverage are separate. Authentication/network/rate-limit failures remain acquisition
failures, never empty data or successful skips.

LIVE01–18 scenarios and required results are declared in
[`source-conformance.ts`](../../scripts/qa/cases/source-conformance.ts), and the
live tests under `tests/qa/` carry their evidence. A selected provider run
qualifies only its captured provider, surface and fixture: one live Work does
not qualify version sets, upstream drift, source graphs, native adoption or
rights decisions. The [editorial-protection integration](../contracts/source-lifecycle.md#editorial-protection-and-quality-integration)
adds source-control scenarios from the [pending protection subcases](../../scripts/qa/cases/editorial-protection.ts)
to LIVE03/LIVE05; two attachments are never independent evidence.

## Semantic Web source profiles

Selected JSON-LD/Schema.org and full-statement Wikibase cases qualify representation
and native mappings now. Broad full-corpus indexing is a later workload activation.
When elected, include all required entity/datatype/syntax surfaces, qualifiers,
references, ranks, somevalue/novalue, lexical data and residual exports; truthy
triples or JSON-LD-only coverage cannot qualify the complete profile.
