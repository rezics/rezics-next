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

The adopted [concept/association mapping](../contracts/catalog.md#concept-and-association-source-mapping)
requires a VNDB-oriented fixture within existing LIVE01/LIVE04/LIVE07-LIVE12
coverage. It must retain provider concept IDs and unresolved terms, distinguish
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

The planned [editorial-protection integration](../contracts/source-lifecycle.md#editorial-protection-and-quality-integration)
adds the [protection matrix](editorial-protection.md)'s source-control subcases
to LIVE03/LIVE05. Qualify control/protection CAS, trusted source origin, same-value
takeover and quality invalidation without treating two attachments as independent
evidence. The existing title-specific evidence below does not qualify that full
protocol or alter its recorded scope.

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

Selected real PostgreSQL/Main API integration `20260925t220311-cba7bb`
compared occurrence-qualified author references and subject terms across
complete verified conversions of one Open Library SourceRecord. Unique author
and subject keys matched across reorder, while repeated keys at distinct
observation positions remained ambiguous with no correspondence. A missing
author list returned unavailable and unresolved occurrences, another principal
received 404, and a cross-record pair returned 422. The comparison did not
write native children or treat absence as withdrawal. This is partial LIVE04
and LIVE01 evidence; durable child correspondence and a native adoption policy
remain open.

Selected PostgreSQL/Main API integration `20260925t220828-d5741a` recorded an
explicit one-to-one ambiguous author occurrence pair after re-verifying both
complete retained conversions. The immutable decision replayed from one
idempotency key; changed-key intent, reuse of either occurrence, a unique-key
pair and a cross-record pair were rejected. A private exact read rechecked the
source evidence, another principal received 404, and the row could not be
updated. The Account assertion in this fixture is isolated rather than a real
OAuth grant. This remains partial LIVE04 evidence: native child identity,
different-key correspondence, unavailable lists and source withdrawal have no
accepted adoption command.

Selected real Account/Access/Main/PostgreSQL integration
`20260925t221015-f1bb1c` passed the child correspondence OAuth boundary. A
`source:read` bearer could assess repeated occurrences but could not record
their pair; a `source:correspond` bearer recorded the exact pair but could not
read it. The active owner could read with `source:read`, another active principal
received 404, and deactivation denied both operations. This is partial IAM10
and LIVE04 evidence; the correspondence remains source-only and does not qualify
native child identity or a provider-wide change run.

The bounded [native author-credit fixture](../../tests/qa/integration/source-author-credit.test.ts)
passed selected integration `20260926t074730-1831a8` through real
Account/Access/Main/Content/Jena owners with isolated provider transport. It adopts
two repeated author occurrences independently, adds explicit and unambiguous
reorder support without rewriting native position, and rejects ambiguity, reuse,
wrong principal, missing edit authority, stale proposal/head, unrelated record,
changed role and missing/unmapped lists. A lost graph acknowledgement and missing
Source completion certificate recover by exact authorized retry. A native Work
title edit and another source support survive withdrawal. At 8/64/512 background
intents the selected lookup returns one row within 32 buffer accesses; reads use
at most 16 graph calls and 64 KiB, and creation at most 24 calls and 64 KiB plus one
command under 24 KiB, two native focuses and one intent/certificate pair.

The [held-graph recovery fixture](../../tests/qa/fault-recovery/source-author-credit.test.ts)
passed `20260926t074730-20dab9`. It restores a fresh isolated graph from retained
Source/Access/relay owners, rejects missing or mismatched Source evidence, and
preserves the withdrawn support and exact native event/revision. Preparation took
less than the 600-second limit. It uses a monotonic decimal routing lineage as
required by the existing restore protocol; ordinary stack defaults use opaque
UUID routing epochs. This does not qualify coordinated Source/Access physical
PITR, general protection/control, editable native credit history, Agent resolution,
other child families or a live provider version-set run. LIVE04 and the associated
model IDs remain partial.

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

Selected real Account/Access/Main/PostgreSQL/Jena integration
`20260925t214357-2e33e2` passed the private Work-to-source title-support read.
It returned the exact adopted source title, rights evidence and application
revision, denied another active principal with 404, and showed the current head
moving after an Access-admitted same-value Work edit while the source support
remained tied to its original revision. Deactivation blocked the reverse read.
This is partial LIVE01/LIVE03/LIVE13 evidence: no source refresh raced the edit,
and field-control, withdrawal and complaint rules are not implemented by this
read.

Selected real Account/Access/Main/PostgreSQL/Jena integration
`20260925t214830-f0b604` passed a private source refresh assessment for a
second complete observation of the same Open Library Work. It reported the
changed source title and representation, then showed the target head changed
after an Access-admitted same-value Work edit. A different SourceRecord returned
409, another active principal received 404, and the inactive owner was denied.
No native Work title was refreshed. This is partial LIVE01/LIVE03 evidence; a
source-controlled application and its race with human confirmation remain open.

Selected real Account/Access/Main/PostgreSQL/Jena integration
`20260925t215604-5790ff` passed a guarded title application from a later
same-SourceRecord proposal. Missing OAuth scope and Work edit grant were denied.
The native Work edit committed while an injected PostgreSQL application-binding
write failed; retry recovered the same Work revision and exact receipt without
another title edit. Private GET and other-principal denial passed. An
Access-admitted same-value human edit then advanced the Work head, and a newer
source proposal could not apply from that human-controlled head. A different
SourceRecord also conflicted. This is partial LIVE01/LIVE03/LIVE13 evidence:
concurrent human/source dispatch, cross-epoch source ordering, other adopted
fields, rights decisions and complete field-control qualification remain open.

Selected real Account/Access/Main/PostgreSQL/Jena integration
`20260925t215833-95465f` raced a same-value human Work edit with a source title
application at the same expected revision. Exactly one compare-and-swap won;
the other returned stale-head conflict. If source won first, the human confirmed
the resulting title at its new revision. A distinct later source proposal then
conflicted with the human-controlled head, and the graph retained the human
revision. This is partial LIVE01/LIVE03 evidence: a complete field-control
epoch, compensation policy and every interleaving remain unqualified.

Selected isolated fault/recovery `20260925t213510-a73d87` passed a source
projection replay into a fresh graph cut over to a held restore epoch. It used
the retained relay event and immutable PostgreSQL source evidence to recreate
the exact private source triples, original receipt position and outbox envelope;
a second replay was idempotent. An open Access recovery fence, altered relay
envelope and absent Content conversion each failed before a graph write. The
test did not replay a later adopted Work or compare a complete mixed-owner
backup frontier, so OPS03 and LIVE01/LIVE02 remain partial.

The same isolated fault/recovery case was extended and passed as
`20260925t213841-0592bc` with an Access-admitted title-only Work created after
the source projection. The relay retained both events. Under graph restore hold,
source projection replayed first, then Work creation replayed with its exact
immutable manifest and Access admission. The private source adoption binding
could not be read while its Work receipt was absent, then resolved to the same
Work after replay; a changed binding receipt failed closed. This qualifies one
ordered source-to-native event pair, not a complete mixed-owner backup frontier,
source refresh, complaint handling or human edit-control. OPS03/LIVE01/LIVE13
remain partial.

LIVE13–18 are prospective contract cases. Their outcomes exercise recorded scope
and policy behavior; passing them cannot establish a legal conclusion about an
unreviewed real-world use.

The G-010 title-withdrawal selection adds `LIVE05` to the real Account/Access/Main
source API case. It checks exact support identity, owning-principal and OAuth
denial, deactivation, a committed withdrawal with a lost response, identical
retries and conflicting intents, immutable history, a pending Work application,
same-value human-head survival, an independent authorized native revision read,
another binding's unchanged support, and narrow/failed acquisition without
inferred withdrawal. A small companion PostgreSQL test exercises migration from
existing adoption/application/pending rows, foreign-principal legacy evidence,
concurrent withdrawal and indexed head/pending lookups at geometric owner sizes.
The held graph recovery case retains the source-owner withdrawal while replaying
the exact source projection and native Work receipts; a missing Work receipt
fails closed before that replay. It does not restore a lagging PostgreSQL backup
or qualify a complete mixed-owner backup frontier. LIVE01/LIVE03/LIVE05/OPS03
remain partial: multi-source competition, provider runs, complaint/rights scope,
general child withdrawal, stale-intent resolution and complete capacity/recovery
qualification remain open. Selected integration `20260926t054355-66d87b` and
fault/recovery `20260926t054512-998e35` passed on the same stable worker source;
`yarn check:backend` passed. These are affected checks, not full backend acceptance.

The G-014 v2 selection adds a bounded second title support for the same native
Work. Integration `20260926t064128-c38e1e` passed the real Account/Access/Main/
PostgreSQL/Jena fixture, migration/constraint/indexed-growth fixture and current
Work-edit authority fixture in 12.9 seconds. The expanded shared API test uses an
explicit 30-second test bound; production Source transactions remain limited to
five seconds. It checks distinct SourceRecords, private deterministic collection
and exact reads, conflicting titles/heads/principals/keys, weak authority, a lost
Source commit response, concurrent same-intent requests, immutable rows, altered
Jena evidence, unchanged singular v1 responses, per-binding withdrawal and v1
receipt replay. A forced same-value human edit after Jena preflight remains the
current native head while the attachment records its earlier verified revision.
The owner fixture upgrades existing adoption/application/pending rows through
migration 018, rejects same-record/wrong-Work/wrong-principal and pending-intent
attachments, races attachment with original-support withdrawal, rejects reuse
by adoption and checks bounded indexed reads at 64 and 512 original owner rows.
The authority fixture observes an actual blocked grant revocation until Source
commit, rejects a grant expiring during lock wait, returns typed unavailable on
the two-second lock deadline, rolls back failed Source work and creates no fake
Access graph admission. The provider transport is isolated in these tests.
A final selection `20260926t064445-b06c7b` repeated all three files in 13.1 seconds
with human native revisions stored in RustFS/S3 while original Source adoption
receipts remained filesystem-backed. The attachment reads Main's configured
immutable object store and its verified filesystem fallback. Backend static,
documentation and the v2 OpenAPI contract regression checks passed.

Held graph recovery `20260926t064311-22920a` passed in 24.6 seconds with the
original source projection, native Work creation and second independent source
projection replayed in order. Missing native or second-source evidence prevents a
successful collection; exact event replays preserve the immutable attachment,
the first support's withdrawal and the second support's independent state. A
later second withdrawal leaves the original withdrawal unchanged. The complete
Source PostgreSQL state remains retained during this held-graph test; it does
not restore a lagging PostgreSQL backup.

LIVE03/LIVE05/OPS03 remain partial. The v2 receipt explicitly promises only a
head verified before commit, not that Jena's current head stayed fixed through
the PostgreSQL commit. The ordinary Access lock envelope is bounded and tested,
but abrupt loss of its connection can release authority locks before Source
commits; an atomic distributed authorization/recovery protocol is unqualified.
General field arbitration, more than two supports, child/provider withdrawal,
rights/use decisions, reinstatement and full capacity remain separate work.
These affected selections do not close LIVE05 or qualify the complete backend.

## Semantic Web source profiles

Selected JSON-LD/Schema.org and full-statement Wikibase cases qualify representation
and native mappings now. Broad full-corpus indexing is a later workload activation.
When elected, include all required entity/datatype/syntax surfaces, qualifiers,
references, ranks, somevalue/novalue, lexical data and residual exports; truthy
triples or JSON-LD-only coverage cannot qualify the complete profile.
