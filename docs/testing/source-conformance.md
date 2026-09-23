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

| Domain | Sources | Semantic cases |
| --- | --- | --- |
| Books | Open Library, Bangumi and native novel cases | Work/edition distinction, authors/roles, languages, repeated chapters, multiple translations, metadata-only and Main Version adoption. |
| Music/media | MusicBrainz/Cover Art Archive, Bangumi, VNDB | Composition/recording/release/medium/track, credits/aliases/characters, cut/episode/platform/language, artwork use and source-primary selection. |
| Software | crates.io/Cargo, npm plus pnpm/Yarn strategy cases, Go module sources/proxies, Nixpkgs/flakes | Native version/feature/peer/MVS/input/derivation semantics and exact artifacts. |
| Minecraft/mods | Modrinth, CurseForge, Nexus Mods, Steam Workshop; Fabric/Forge/NeoForge manifests | Project/file/version/mod grain, loader/game/runtime/side, embedded/advisory/hard requirements and load ordering. |
| Recipes | Current Schema.org Recipe-bearing sources and native examples | Free-text/structured ingredients, exact/unknown quantities, units, step groups, yield/time and variants. |
| Skill/Prompt | Current Agent Skills specification and publicly available package repositories | Manifest/content/files, parameters/examples, dependencies, tool/runtime declarations, exact release and non-execution on ingest. |

Official entry points: [Open Library](https://openlibrary.org/developers/api),
[MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_Database/Schema),
[CAA](https://musicbrainz.org/doc/Cover_Art_Archive/API),
[VNDB](https://api.vndb.org/kana), [Bangumi](https://github.com/bangumi/Archive),
[Recipe](https://schema.org/Recipe), [Agent Skills](https://agentskills.io/specification).
Package/provider details are in [profiles](../contracts/package-profiles.md).

## Field and workflow coverage

For each elected source surface enumerate field/grain dispositions: native,
structured-source-only, lossy, excluded or unsupported. Validate source queries,
native owner commands, API/export and change handling. Raw bytes, schema counts
or a few successful records do not qualify all fields. API/dump/archive/artwork
coverage are separate. Authentication/network/rate-limit failures remain acquisition
failures, never empty data or successful skips.

| ID | Scenario | Required result |
| --- | --- | --- |
| LIVE01 | Current source adds/removes/changes a field | Explicit drift and disposition; no silent dropping. |
| LIVE02 | Partial/malformed/failed fetch | No completed receipt or omission-driven deletion. |
| LIVE03 | Same-value human confirmation races with refresh | Human epoch prevents source overwrite/compensation. |
| LIVE04 | Repeated children reorder or reuse source keys | Occurrence-qualified correspondence or conflict. |
| LIVE05 | Source withdraws one of several supports | Independent support/native acceptance survives. |
| LIVE06 | Provider redirects/merges a record | No automatic native identity/grant transfer. |
| LIVE07 | Round-trip exact/unknown/language/time/quantity values | Preserve meaning and concrete losses. |
| LIVE08 | Import provider scores/users | Source statistics; no native ballot/account invention. |
| LIVE09 | Source changes during a run | Frozen run capture used consistently; next run refreshes. |
| LIVE10 | Export accepted Main Version with external releases | Grain-aware mapping and residuals; no fabricated edition. |
| LIVE11 | Required data unavailable behind provider access | Mark that surface unqualified; no bypass or guessed values. |
| LIVE12 | Stream dump/bootstrap then consume changes | Gap/overlap handling, resumable progress and bounded memory. |
| LIVE13 | Enter facts and a synopsis from a source with incomplete license metadata | Intake preserves provenance and explicit rights unknowns without a blanket rejection/quarantine. Distinguish factual entry from expressive copying; neither manual entry nor acceptance fabricates permission. |
| LIVE14 | Company-operated wiki use of NC material; later reuse in a paid data product | No company-wide rejection or wiki-wide approval. Preserve the evidenced use scope; reassess the changed use without inheriting the earlier conclusion. |
| LIVE15 | Publish a bounded quotation with a documented fair-use basis, then request a full source export | Preserve the specific exception rationale and scope without inventing a license. The different export requires its own basis. |
| LIVE16 | Source API terms disallow retaining a response but the importer requests a raw capture | No retention solely for reproducibility; report the acquisition/retention limitation. Independently supported data from another route remains eligible. |
| LIVE17 | Combine ShareAlike sources with native facts and export the result | Preserve provenance, notices and applicable sharing/access obligations. Neither corporate status nor named-graph separation decides the combined export's license scope. |
| LIVE18 | A complaint decision restricts an imported synopsis, then refresh or human-confirmed reapply runs | Restricted expression is not restored; independently supported facts and resource identity survive. Edit-control confirmation is not rights clearance. |

LIVE13–18 are prospective contract cases. Their outcomes exercise recorded scope
and policy behavior; passing them cannot establish a legal conclusion about an
unreviewed real-world use.

## Semantic Web source profiles

Selected JSON-LD/Schema.org and full-statement Wikibase cases qualify representation
and native mappings now. Broad full-corpus indexing is a later workload activation.
When elected, include all required entity/datatype/syntax surfaces, qualifiers,
references, ranks, somevalue/novalue, lexical data and residual exports; truthy
triples or JSON-LD-only coverage cannot qualify the complete profile.
