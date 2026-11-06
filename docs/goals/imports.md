# Imports

## Outcome

Maintainers and community tools turn licensed source records into traceable catalogue proposals and refresh them safely through ordinary APIs. Conversion, acquisition, review, adoption and current public reads remain distinct stages.

## Done when

- Bangumi, VNDB, Open Library and Wikidata have pure revisioned record-to-command converters shared with community tools, plus bounded direct and resumable readers for their admitted formats.
- The importer records source, exact key, source revision or unversioned digest, normalized digest, converter revision and new, changed or vanished decisions. Mass disappearance stops for review; refresh and recovery preserve exact intent, current permissions, ownership and source fences.
- Fixture imports cover idempotence, changed proposals, reimport, disappearance, fenced refresh, unknown delivery, refusal, privacy, concurrency and recovery. Unchanged source cannot hide newly resolved dependencies.
- Imports integrates only the admitted M1 callers: a complete fresh seed; selected media and graphs; the personal VNDB Library caller; reviewed cross-provider Person identities and credits; typed franchise relations; shared reviewed tags; and two real light-novel series. No new providers, inferred mappings or optional discovery admission enter scope.
- Rights and provenance remain exact. Bangumi metadata and attributed summaries use CC BY-SA 3.0; cover rights are separate. Source revisions are genuine or explicitly unversioned with a digest. Unresolved external keys remain cited external identifiers until actually resolved. No user posts are imported.
- Proposals, separate authorized acceptance/adoption and independent current reads remain distinct. Retained native, browser and three-scale growth acceptance covers real routes, privacy, media, Library and receiving outcomes; unbound commands and native evidence gaps remain pending until observed.
- Scoped outcomes are complete on main, with the root gate and native acceptance on the promoted source revision. Helpers, local tests and source-only claims do not complete the Goal.

## Scope

Imports owns source conversion, bounded source readers, the import ledger, run planning, CLI and ordinary API integration for the four launch sources and admitted M1 callers above. It does not own provider discovery, private database writes, user posts, optional discovery admission or new mappings without review. Public scope is defined by [scope](../scope.md).

## Ownership

Imports owns [conversion](../../packages/conversion/README.md) and [importer](../../services/importer/README.md). Conversion owns source mapping and value fidelity; importer owns acquisition, journals, media integration and costs. This Goal links their contracts. [Capability acceptance](imports.capabilities.md) owns user cases, exact native scenarios, commands and evidence limits. Composition regression for declared source admissions, selected-family binding and owner-local showcase contracts is pinned by the importer registration and manifest tests named in the importer contract; existing conversion and importer fixture cases keep unchanged comparisons.

Shared authority stays with its owner: [Access](../../services/kernel/src/access/README.md), [Content](../../services/kernel/src/content/README.md), [Rating](../../services/kernel/src/rating/README.md), [Semantic](../../services/kernel/src/semantic/README.md), [Definitions](../../packages/definitions/README.md), [Commerce](../../services/kernel/src/commerce/README.md) and [Library](../../services/kernel/src/library/README.md). Native Library policy is Commerce-owned; media, votes and publication policy are Content-owned; Rating owns the current vote route; definitions, identity and bulk proposal contracts are Semantic-owned. Imports consumes these interfaces without copying their rules or adding scopes, grants or SQL shortcuts.

## Dependencies

Requires released source mappings, ordinary bulk APIs, Access permissions, Semantic identity and proposal APIs, Content media and takedown interfaces, Commerce-owned Library policy, and typed client routes. Continue using the existing deduplicated first-party Collection scopes and importer exclusions in Access/Commerce owner contracts. The current canonical contracts and evidence boundaries are linked from the [capability acceptance](imports.capabilities.md).

## Acceptance

Use the source fixtures in specs/imports-*.test.ts and specs/imported-field-outcomes.test.ts, the conversion package tests and services/importer/tests. Each source runs end to end through real APIs and includes unchanged reopen, changed records, disappearance and mass stop, source and field fences, bounded readers, unavailable and unknown delivery, refusal, resume and privacy. Keep separate proof for proposal, acceptance/adoption and independent current reads. Retain native metadata coordinator, entry, VNDB HTTP and Bangumi HTTP acceptance, browser scenarios and existing growth ceilings; see [exact cases and evidence limits](imports.capabilities.md).

Follow the [verification workflow](../development/verification.md). Root, native, browser and growth acceptance is recorded on the promoted revision; live providers are not required when legal pinned fixtures exist.

## External conditions

Licensed dumps, upstream availability and production API configuration are external inputs. Functional acceptance uses pinned legal fixtures and does not wait for live provider access.
