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

The first private manual staging fixture
[`source-manual-intake.test.ts`](../../tests/qa/integration/source-manual-intake.test.ts)
passed in selected integration `20260925t201457-5c3dc9`. It uses the real
PostgreSQL source schema and Main API with an isolated Account verifier: same
provider/namespace/external ID observations keep one source identity but distinct
observation IDs; a different namespace keeps a different identity. It checks
exact retained bytes and digest, unknown rights evidence, explicit omitted fields,
idempotent replay and changed-intent conflict, private read denial, non-retention,
the 64 KiB boundary and immutable rows. LIVE01/02/13/16 remain partial. This
manual submission does not acquire a current provider response or qualify source
drift, failed fetch, native adoption, legal use, a physical query plan or a real
Account OAuth scope.

The fixed-origin Open Library Work acquisition fixture passed selected integration
`20260925t202231-12cd41` with the real PostgreSQL staging owner and an isolated
Account verifier/provider transport. It captures exact Work JSON bytes, revision,
ETag and fetch time, then privately replays the same observation without another
fetch. A changed Work ID conflicts with the original key; a malformed response
leaves no completed receipt and a corrected retry succeeds. The unit cases check
fixed URL construction, no redirects, bad content type/JSON/identity, short or
oversized bodies, 404 and network failure. LIVE01/02/09/11 remain partial until
current live-provider and broader conversion/availability cases pass. The
provider-rate gate is shared in PostgreSQL, but its physical plan and multi-replica
capacity remain unqualified.

The private Open Library conversion fixture passed selected integration
`20260925t202910-3a3b46`. It retained each top-level field's explicit
disposition, source-qualified title/description/author/subject projection,
unknown-field residual, exact replay, private read and immutable PostgreSQL row.
Incomplete or Edition-grain captures returned 422, and no native Work was
created. Unit cases also preserve the exact raw lexical form of a huge integer
while keeping the numeric field out of the structured projection. A separate
one-request live run of the current official Work JSON endpoint on 2026-09-26
captured `OL45804W` (2,660 bytes, SHA-256
`1f8295b8bba7533eb01dc40ba7564c255b54fa68fa6cfa1b65ec8fd1b0d671a6`)
and the converter enumerated all 16 observed top-level fields. Its retained
capture and conversion are under `.artifacts/source-live/`. This is still partial
LIVE01/02/07/09 evidence: one live Work does not qualify current version sets,
upstream drift/reconciliation, source graph, native adoption or rights decisions.

Selected real Account/Access/Main integration `20260925t203408-408374` passed
OAuth issuance and introspection for the four source-staging scopes. A
`source:read`-only token was denied at manual intake, Open Library acquisition
and conversion before a source write or provider call. A full token completed
all three through PostgreSQL and read the private results. Deactivating the
Access principal then blocked another intake and a private read. The provider
transport remained isolated, so this is owner-boundary evidence rather than a
live source or native-adoption qualification.

Selected real PostgreSQL/Main API integration `20260925t204259-e88f47` passed
the bounded Open Library drift comparison for two retained, complete
conversions of one source identity. It reports added, removed, changed and
unchanged top-level fields with both mapping dispositions, while separately
flagging exact-byte changes, including a formatting-only difference. It rejects
cross-record and unauthorized private comparisons and excessive nesting. A
removed source field remains an observation only; there is no
native withdrawal or source graph mutation in this batch. LIVE01/LIVE02/LIVE09
remain partial until current version-set and refresh/reconciliation cases pass.

Selected real integration `20260925t210746-1c1306` exercises the private
source-graph case through Main, the PostgreSQL source owner and cmd0.5.22 Jena.
It verifies that a complete conversion projects three source-qualified nodes
under a deterministic receipt, can be read
privately and replayed at the same sequence, and does not create a native Work.
The command gate rejects an unrelated receipt family and an invalid shape or
profile digest before any graph write. The relay reads the typed private source
event from the command outbox and checks its graph-backed identities. An isolated
read-only token and inactive Access principals cannot start projection.
The Account verifier and provider capture are isolated in this fixture.
Graph restore/reprojection, live version sets, downstream field decisions and
source-use policy remain open, so LIVE01/02/07 are partial.

Selected real Account/Access/Main/PostgreSQL/Jena integration
`20260925t211637-dc4824` passed the new-native-Work proposal boundary. A real
OAuth bearer with `source:propose` recorded one immutable proposal after verified
source-graph projection; a read-only bearer could read it but could not propose.
The owner fixture checked missing-graph 409, exact replay, private read, immutable
PostgreSQL row, inactive-principal denial and a 201-character source title that
failed the native proposal limit without a proposal write. The candidate title,
rights evidence and original graph receipt position were retained while
description, author keys and subjects stayed source-only. No native Work was
created or adopted. The provider transport is isolated, and human confirmation,
native adoption, rights decisions and graph restore remain open; LIVE01/LIVE13
remain partial.
Selected real Account/Access/Main/PostgreSQL/Jena integration
`20260925t212731-69c4bd` passed the first title-only English native Work adoption
path. A read-only bearer and a `source:adopt` bearer lacking `work:create` were
denied before native creation. A missing Access Work grant denied dispatch; the
same reserved intent succeeded after a real representation and grant were added.
A one-shot PostgreSQL binding write failure left the native Work receipt committed;
retry recovered that exact Work and one immutable binding. Two concurrent
requests for a second proposal converged on one native Work. Private read,
replay and inactive-principal denial passed. Description, authors and subjects
remained source-only. This is partial LIVE01/LIVE13 evidence: source-support
triples, human edit-control races, non-English titles, existing-Work matching,
rights decisions, complaints and refresh/withdrawal remain open.

LIVE13–18 are prospective contract cases. Their outcomes exercise recorded scope
and policy behavior; passing them cannot establish a legal conclusion about an
unreviewed real-world use.

## Semantic Web source profiles

Selected JSON-LD/Schema.org and full-statement Wikibase cases qualify representation
and native mappings now. Broad full-corpus indexing is a later workload activation.
When elected, include all required entity/datatype/syntax surfaces, qualifiers,
references, ranks, somevalue/novalue, lexical data and residual exports; truthy
triples or JSON-LD-only coverage cannot qualify the complete profile.
