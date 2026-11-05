# Imports capability acceptance

Current user cases, native scenarios and evidence limits for the [Imports Goal](imports.md). Source mapping and value fidelity belong to [conversion](../../packages/conversion/README.md); acquisition, journals, publication, media integration and cost belong to [importer](../../services/importer/README.md). Shared Access, Content, Semantic, Definitions, Commerce and Library contracts remain in their [owner documents](imports.md#ownership).

Authority split: module READMEs hold current contracts and costs; this file holds user outcomes, exact native scenarios, commands and what the evidence does not prove.

Decision: preserve original showcase claim aliases, source bindings and sealed replay; distinguish native merge admission, operation publication and independent canonical public reads. Focused caller/manifest/redirect cases supplement the unchanged native and browser outcome assertions.

## User outcome

Maintainers and community tools import licensed records through ordinary APIs and permissions, inspect omissions, and safely refresh changed or vanished facts. Pure revisioned converters produce proposals. Independent authorized review accepts and adopts them; separate current public reads verify the result. Refresh preserves source identity, existing adoption and unrelated editorial choices.

## Admitted M1 caller outcomes

Completion includes the complete fresh seed; selected media and graph publication; the personal VNDB Library caller; reviewed cross-provider Person identities and credits; typed franchise relations; shared reviewed tags; and both real light-novel series. These are end-to-end obligations through their real callers and APIs. They do not admit additional providers, inferred mappings or optional discovery scenarios.

- The selected showcase uses the current registered seed roots and selected graph only. It retains exact source keys, citations, source and converter digests, current identity and property reads, independent candidate acceptance/adoption, public readback, and bounded cover acquisition/recovery.
- Person and credit outcomes require current exact provider identifiers and reviewed role bindings. A name, similar credit or stale adoption never resolves identity.
- Franchise and work-link results retain their typed source relations and independent provider identities. VNDB `side`/`par` use released `wdt:P144` direction; reciprocal rows retain both citations on one directed assertion, with current identities and facts fences at both endpoints. A Bangumi identifier comes only from an admitted source-site row with a parsed public Bangumi subject URL; VNDB v2002 and Bangumi 3154 remain separate identities linked only by selected counterpart evidence.
- Shared tags use the current reviewed Scheme and Concept bindings. Kana weights use a current response for the selected work and tag; COPY vote counts, user notes and private identifiers are excluded.
- Personal VNDB Library import follows the [released-state and native-review contract](../../docs/library-import-vndb.md) under Commerce ownership. Private source retention is bounded; progress retention does not infer activity. Its native acceptance is not inferred from catalogue-import tests.

## Required source coverage

Launch sources are Bangumi, VNDB, Open Library and Wikidata. Their grains, formats, revisions, rights, citations and exclusions live in the module contracts. Acceptance uses pinned legal fixtures, not live-provider availability.

- Bangumi: native identity, Person names, biographies, careers and credits; attributed summaries; separate cover rights; source-site and work evidence; omissions and source fences.
- VNDB: COPY headers and native keys, source revisions, permitted metadata, bounded associations and reviewed tags; no prose or images.
- Open Library: five-column TSV, separate Work and Edition grains, Work first_publish_date, Edition page counts and ISBNs; no unlicensed prose or covers.
- Wikidata: item JSONL and genuine revisions; exact released claims and qualifiers; unresolved relations stay unresolved.

## Ordinary import and recovery acceptance

Decision: ordinary Wikidata acceptance retains the original CLI/native cases and separate review/public reads; mounted-page acceptance runs on an approved stack, with no change to importer authority or source bindings.

For each source cover initial import, unchanged reopen, changed and reimported records, vanished fields, mass-disappearance stop, ownership fences, malformed and unsupported values, bounded readers, unavailability, unknown delivery, refusal and resume. Denial is not success. Unknown delivery replays the original sealed actor, destination, body and key under current authorization before any receipt or replacement effect. Current subject and tuple-home fences apply to unchanged, cached and disclosed results. A takedown cannot be restored by refresh. Changed dependency resolution on unchanged source remains visible.

Retained metadata is integrated native acceptance: [coordinator](../../services/kernel/test/library/list-import-metadata-coordinator.test.ts), [entry metadata](../../services/kernel/test/library/entry-import-metadata.test.ts), [VNDB HTTP](../../services/kernel/test/library/list-import-vndb-http.test.ts) and [Bangumi HTTP](../../services/kernel/test/library/list-import-bangumi-http.test.ts) cover selection, partial application, confirmation replay and adapters. Extraction corrections stay with their owner.

## Source-specific outcomes

### Bangumi people, works and games

Keep Person identity, biography, credits, names and careers independent. Type-1 name is und; name_cn or the exact PersonDetail infobox key 简体中文名 is zh. Ambiguous evidence withholds only zh. P106 requires the actual Person and source key, careers Scheme, current bound Concept, released property and exact citation. Pure conversion emits no P106; source Concepts assert no canonical occupation or equivalence. Chinese names remain beside biographies and careers, with separate proposals and current reads.

TVAnime official websites, descriptive links and copyright notices keep separate properties and citations. Game names, first publication date, websites and work evidence remain independent. Creator and voice credits follow Game environment and genres, then Character identity and appearance; Game cast follows Character. Malformed neighbors do not suppress valid facts. Selected Character appearances require exact source rows and released roles.

Cases: [Person careers](../../services/importer/tests/showcase-bangumi-person-careers.test.ts), [Person names](../../packages/conversion/tests/bangumi-person-names.test.ts), [websites](../../services/importer/tests/bangumi-official-websites.test.ts), [work evidence](../../services/importer/tests/bangumi-work-evidence.test.ts), [Game names](../../services/importer/tests/bangumi-game-names.test.ts), [publication dates](../../services/importer/tests/bangumi-game-publication.test.ts), [credits](../../services/importer/tests/bangumi-creator-credits.test.ts) and [Character appearance](../../services/importer/tests/showcase-bangumi-characters.test.ts). Native and public-page outcomes remain separately owned.

### Open Library Work publication date

Decision: retain the ordinary proposal-only Open Library CLI and separate Work/Edition bindings; reviewers adopt Work dates and Edition page counts/ISBNs independently. Only optional Work first_publish_date creates its independently cited schema:datePublished assertion; existing publish_date behavior stays separate. [Conversion cases](../../packages/conversion/tests/open-library-first-publication.test.ts) pin precision, citation, digest changes, malformed values and Edition exclusion. [Native cases](../../services/kernel/test/imports/open-library-first-publication.test.ts) retain separate selection, adoption and current public reads.

### VNDB facts, tags and relations

Preserve native keys, source revisions, null/empty distinctions, exact table origins, selected release names and alias meaning. Decision: VNDB staff/voice credited names use the exact selected alias, never relationship notes; retained release, identity and statistics assertions stay unchanged. Public tags and weights require selected work rows and current reviewed Scheme/Concept reads. Tag removal retracts only importer-owned candidates. User lists, votes and notes are not imported into catalogue proposals.

Vote writes remain unavailable until Content releases the actual conditional question, canonical native unit, bounded counting and current-vote guard. The [Rating source-statistic API](../../services/kernel/src/rating/README.md#provider-source-statistics) is a separate existing interface; the exact missing import guard remains documented in [personal VNDB review](../../docs/library-import-vndb.md#native-score-review). The admitted path requires current question and vote reads plus explicit native-unit consent per row. Native zero, clear and source absence remain distinct; no rounding or aggregate substitution. [Statistics cases](../../specs/imports-vndb-statistics.test.ts) and the [native wrapper](../../services/kernel/test/imports/vndb-statistics-outcomes.test.ts) cover Auth/Access, PUT/read, reopen/change, exact replay, zero-vote and no-vote behavior, reduced or revoked denial and failed-run baseline protection.

### Wikidata and media

Complete cited Wikidata values pass public Definitions validation. Every present timezone, before and after value is retained, including zero; absence stays absent. Quantity amount, bounds, unit and qualifiers remain exact. Unsupported, unresolved or narrowed qualification withholds the entire measurement. Unresolved keys remain cited external identifiers. The [source mapping contract](../../packages/conversion/README.md#exact-quantity-handoff) and [ordinary importer contract](../../services/importer/README.md#registered-source-vocabulary-mapping) retain source-to-native cases and route bounds.

Media is separate from metadata and a 202 is only a reservation. Rights-holder and via-source credit are required; metadata licences do not grant image rights. Content re-encodes available images, serves only current variants and enforces takedown. Unavailable, rejected or fenced media is not success; pending and unknown outcomes retain exact evidence and unresolved commands for bounded recovery.

## Native command acceptance

The account-key CLI is exercised through real Auth, Access, API and media-worker paths. Acceptance uses current converter exports and ordinary current authority. Keep these cases distinct from importer-local tests:

- [Scalar feeds](../../services/kernel/test/imports/provider-cli-native.test.ts) cover Bangumi, Open Library and Wikidata initial import, unchanged reopen, changed supported values, independent adoption, malformed/truncated input and mass-disappearance refusal without advancing the last complete baseline or making public writes.
- [File admission](../../services/kernel/test/imports/cli-file-admission.test.ts) covers all four source formats, valid successor after rejection, malformed replacements before Auth/public effects, VNDB archive parsing and interruption closure.
- [Unknown bulk acknowledgement](../../services/kernel/test/imports/cli-ack-recovery.test.ts) reopens the same state, replays the original sealed body/key before admitting successor input, retains independent selections and denies receipt disclosure after authority revocation.
- [Rejected cover recovery](../../services/kernel/test/imports/cli-rejected-cover-recovery.test.ts) keeps terminal rejection without resubmitting the same source; a changed source creates a distinct media request. Only available media enters review, adoption and current served variants.
- [Concurrent operators](../../services/kernel/test/imports/concurrent-cli-owners.test.ts) prove same-alias refusal before effects, independent aliases, cancellation and exact-state reopen. [Upstream cancellation](../../services/importer/tests/cli-upstream-cancellation.test.ts) proves interrupted input cannot seal an empty/successful generation or start effects.
- [VNDB table materialization](../../services/importer/tests/vndb-materialization.test.ts) stages a complete table generation and publishes in pages of 16; the complete pointer advances only after required members and native effects are durable. Invalid, changed-pending or mass-loss input cannot replace it.
- [Sealed-source recovery](../../services/kernel/test/imports/cli-sealed-source-resume.test.ts) retains the provider-specific admission rule: VNDB validates a replacement archive before recovery, while Wikidata drains sealed work without reading replacement stdin. [Mid-run authority loss](../../services/kernel/test/imports/cli-midrun-authority-resume.test.ts) retains the complete baseline and sealed commands, denies replay under revoked authority, then resumes exact intent after the existing grant returns.

Operator command: bun services/importer/src/cli.ts --source <source> --dump <path> --state <path> --api <origin> --account-key <key> --account <uuid> --client <id> --auth <origin>. Use preview or resume as documented in the importer contract; task seed:dev is only the explicit local showcase publisher. Native test execution and actual handles follow the controller launch plan.

These are authored native scenarios, not proof of current execution, upstream observations or promotion; only integration records native acceptance on the promoted source.

## Receiving, browser and growth acceptance

Decision: The anime visit shows currently selected TVAnime facts with their citations; archive aliases remain exact und names, and Episode, staff, cast and Character links follow current native relation IDs and return to the originating work.

Pure conversion cases establish mapping, validation, provenance, bounds and determinism; they do not prove native acceptance/adoption, Context return, API receiving, visibility or growth.

Retain import-to-discovery receiving obligations for selected Work, Edition and Release facts: propose, accept/adopt through Semantic, then verify current reads and shared meanings through Search/facets, Collections, Zones and TypeLists. Cover Context and public/private separation across importer proposals, editor actions, anonymous/editor reads and separate Alice/Bob populations, grants and state. Reduced, unscoped/delegated, suspended-valid and revoked callers repeat relevant reads and writes; private grants cannot leak. Hidden Concepts, source fences, aliases with hidden originals and late revocation affect membership, ordering, counts, cursors and disclosure.

Use released controls and actual mappings. Bangumi tag/form and VNDB name/link do not establish platform/form; Open Library/Wikidata do not establish cross-surface populations. Imports owns mapping/transport. Semantic owns fixtures, releases, receipts, selection/adoption, identity and Zone routing; Search owns indexing/facets/queries; Commerce owns Collections and owner queries; Content owns disclosure; Web owns publication. The [native discovery cases](../../services/kernel/test/imports/discovery-user-cases.test.ts) remain acceptance, not completion evidence.

Retain native scenarios for connected source/CLI and media recovery, discovery, statistics and source-only refresh. Retained-metadata cases remain integrated. Three-scale growth covers conversion and API writes with existing statement, row, byte, page, fan-out and command bounds. Local tests and fixtures do not claim native execution, browser completion or physical growth. Unbound commands, current native reads, browser stories and owner-specific growth checks remain pending until the promoted source is observed.

## Acceptance entry points

Use specs/imports-*.test.ts, specs/imported-field-outcomes.test.ts, conversion tests and importer tests. Native API acceptance remains in services/kernel/test/imports and services/kernel/test/library. The [importer contract](../../services/importer/README.md) gives the bounded source procedures and command modes. Follow the [verification workflow](../development/verification.md); integration records root, native, browser and growth results on the promoted revision.
