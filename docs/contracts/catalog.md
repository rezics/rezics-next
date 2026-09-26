# Provider-independent catalog

## Provider-independent model

REZICS owns native identities and operations. Providers contribute observations,
correspondence and evidence; a new provider does not create another native copy
or dictate service ownership. Semantic type, executable capability, lifecycle,
context and physical placement are independent.

## REZICS Work and primary version

Use [Work/release](work-and-release.md) and [Main Version](main-version.md) across
all creative domains. Main Version supplies the common entry and maintained
content selection. External editions, recordings, cuts, builds and artifacts keep
their own grains. Metadata-only creation needs no dummy body or fabricated source.

## First-stage compatibility

| Domain | Required distinctions and live sources |
| --- | --- |
| Books | Work/Main Version, multiple translations, Post chapters, serialization, external editions and exact releases; Open Library and Bangumi. |
| Software | Project/game, package coordinate, release, artifact, environment and dependency/installation instances; Cargo/npm/Go/Nix and mod sources. |
| Media | Composition/recording/release/medium/track; audiovisual cut/season/episode; visual assets and contextual uses; MusicBrainz/CAA, Bangumi and VNDB. |
| Recipes | Ingredient occurrences, exact quantities/units, grouped ordered steps, yield/time, alternatives, media and Schema.org mapping. |
| Skill and Prompt | Independently maintained content, parameter/example profiles, package directories/files, releases, dependencies and declared tool/runtime needs. |

People, organizations, characters, aliases, credits, series, worlds, events and
relationships support those domains. One contextual credit instance must bind
performer, character and work together; unrelated credits must not join into a
fabricated fact. Repeated tracks/chapters/ingredients retain occurrence identity.

## Concept and association source mapping

Map source tags/traits through [resources and Statements](classification.md);
retain provider IDs, definitions, source support and unmapped residuals. A source
label is not a native identity key. Bare terms need an admitted relation or exact
application pattern; taxonomy membership alone creates no target fact.

The [VNDB Kana schema](https://api.vndb.org/kana), reviewed 2026-09-26, exposes
tag/trait identities and association spoiler data, VN tag ratings, and character
appearances whose role/spoiler may differ by release. Trait names may require
their group to be understandable. Preserve these distinctions in source evidence:
concept objects, qualified statements, release-specific appearances and
display-group labels. Do not interpret a protagonist role as FemaleLead without
additional admitted meaning. Imported ratings remain source statistics.

This mapping direction is a design fit, not complete VNDB API/dump/artwork
qualification. Each elected provider still needs the
[field and workflow checks](../testing/source-conformance.md).

## Operations and source disposition

Every domain supports native create/read/edit/query/publish/withdraw/restore/export
without provider records. Adapters invoke the same commands and authority checks.
Map every selected field to native, structured-source-only, lossy, excluded or
unsupported with a reason. Raw bytes alone do not establish native coverage.

Retain original language, precision, unknown/absent states, external keys and
source coverage. A narrow API response cannot withdraw fields only present in a
dump. Imported aggregate scores remain source statistics. Main Version selection
and Realm acceptance never follow a provider redirect implicitly.

Full Schema.org/Wikidata corpus indexing is a later scale/profile activation;
selected vocabulary, statement-preserving mappings and native domain cases belong
to the foundation now. See [source conformance](../testing/source-conformance.md).

## Organization catalog descriptions

An organization's public description is Content owned by that Organization,
anchored to its Agent resource with the `catalog-description-v1` Content model.
`PATCH /v1/catalog/resources/{resource}/descriptions` saves a language-specific
draft through the existing Content draft command. It does not create an
organizational representation, roster permission or control grant. Publication
uses the existing `POST /v1/content-publications` operation with
`targetProfile: "catalog-description-v1"`; its ContentVariant remains anchored
to the Organization Agent resource, and the exact publication decision is
recorded through the existing Content publication receipt and recovery protocol.

Editing requires an active Content grant on the exact description resource, for
example `content.draft` on `content:draft:{organizationAgent}`, plus the caller's
current representation of the selected Realm for that action. The Organization's
admitted authority issues that scoped grant through
`POST /v1/access/organization-content-draft-grants`. Issuance requires an active
Organization admission, the issuer principal's current representation of that
Organization for `access.grant.assign.content.draft`, and an active assignment
ceiling grant for that same description scope. The operation writes the Content
permission grant, immutable lineage and idempotency receipt, then advances that
scope's authority epoch in one Access transaction. Its row and graph costs are
constant as unrelated organizations and grant history grow. The Realm editor's Content permission
does not imply `access.org.roster.policy`, representation, managed-organization
authority or any other control operation. Draft and publish admission remain
separate Content actions and each is checked against its own exact scope.

The write targets one Organization Agent and one canonical language slot, with a
16 KiB text limit and an expected Content revision head. Its graph target checks,
Access admission and Content CAS have fixed call and row counts as unrelated
resources and history grow; bytes and Content storage work are O(B) in the
bounded description size. It writes one Content revision, receipt and outbox
event. Publication is a separate bounded Content operation tied to the exact
revision and variant. Cold-cache I/O, lock contention and fleet capacity remain
separate qualifications.
