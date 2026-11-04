# Imports audit-gap journeys

This plan maps the Imports portions of the three audits to existing assignments on the retained source
`683638d2c18047d3f389f25c68dda8dba9738dd5`. An integrated assignment is a mapping, not a claim that its entire
audit row has passed acceptance. Several rows combine conversion, definition publication, private Library data
and interface work; those responsibilities remain separate.

Decision: retain the five existing active source-fidelity journeys and the integrated mappings below; create no
duplicate continuation or new provider/profile scope from an audit's conditional capability.

The empty-backlog/idle-worker premise does not hold: the Imports queue already contains three running source
journeys and two ready source journeys, besides this planning assignment. Existing assignments are identified
below by their exact titles; integrated work also names its retained commit. Task identifiers remain in commit
metadata rather than this document.

## Report coverage

| Report and row | Imports disposition |
| --- | --- |
| [Page needs, API and rendering](page-needs-api-render-audit.md#ranked-api-design-gaps), A01–A10 | No row assigns Imports as its owning Goal. Content, Library, Search, Semantic and Accounts own the listed read/command gaps. A09's main-character meaning belongs to Semantic; the existing Imports character journeys preserve an unsupported identity relationship as a gap rather than inventing that meaning. |
| [Page needs, API and rendering](page-needs-api-render-audit.md#ranked-interface-gaps), all ranked interface rows | The ranked interface queue belongs to Web and its named native owners. It does not authorize a second importer or replacement page projection. |
| [Component parity](web-component-parity.md#delivered-and-reserved-component-owners), all component families | The report assigns Feed, thread, shell, UI, Library and Semantic owners; there is no Imports-owned open component row. Generic tagging remains reserved by Semantic. Source-concept imports do not implement community tag votes. |
| [Platform coverage](api-first-platform-coverage.md#gaps-ranked-for-vndb-and-bangumi-users), ranks 3–6 | Source metadata portions map to the existing journeys in the following tables. Remaining definition, ballot, progress and presentation portions retain their owners. |
| Platform coverage, ranks 1, 2 and 7 | Private-list portability, canonical episode progress and occurrence history are Library/rating journeys, not public catalogue conversion. The [Imports Goal](../goals/imports.md#scope) explicitly separates personal-library migration from provider mapping. |
| Platform coverage, rank 8 | Optional graph, quote and domain browsing is a Semantic/Web outcome. Imports' representable cross-media graph is already assigned and integrated below. A graph visualizer is not required for import completion. |
| Platform coverage, rank 9 and non-launch provider tables | Steam observations, AniDB file matching and additional provider adapters are not additions to the four-source Imports launch scope. Arbitrary Wikidata datatypes require adopted Semantic meanings before a lossless converter can be promised. |

## Existing active journeys

These assignments already contain the connected production-operator outcome, native adoption/readback,
idempotence, changed-record and fence cases. Keep their existing contracts; do not enqueue another brief with
the same outcome. Their estimated changes are already within the requested 2,000–3,000-line journey size.

| Exact existing assignment | State | Audit rows it covers | Complete user journey and boundary |
| --- | --- | --- | --- |
| Publish exact Bangumi creator and voice credits from admitted association members | Running; 2,600 lines | Platform Bangumi “Persons/organizations, professions, pseudonyms and qualified subject credits” and “Characters, subject appearances and person/voice associations”; ranked gaps 3 and 6 | Operator imports staff/voice rows; an independent editor adopts and reads exact creator roles and character endpoints. Missing/retracted role or endpoint withholds the full credit. Music/live-action credits use actual admitted mappings. New profession properties and biographical profile publication remain Semantic work. |
| Carry reciprocal Bangumi relation meaning through the production graph importer | Running; 2,500 lines | Platform Bangumi “Subject relations including adaptations, sequels, summaries, same setting/characters and side stories”; ranked gap 6 and the representable part of rank 4 | Operator imports reciprocal/one-sided relations; editor adoption and current reads establish canonical holder, target, direction and qualification. Missing endpoints, unknown codes and absent released meanings remain precise gaps. It does not substitute an existing relation for a new source code. |
| Import Bangumi character kinds and qualified appearances as readable native facts | Running; 2,400 lines | Platform Bangumi “Characters, subject appearances and person/voice associations”; ranked gaps 3 and 6 | Import two real character identities and exact kinds/appearance roles; adopt and read their qualified work facts. Missing/retracted bindings and tuple fences suppress publication. Unknown kinds and unsupported ordering stay addressable diagnostics. Character-to-character identity meaning is not work membership. |
| Import VNDB staff aliases and exact credited roles through the native operator | Ready; 2,400 lines | Platform VNDB “Producer and staff identities, aliases and credited names” and “Work appearances, roles, voice actors and spoilers”; ranked gaps 3 and 6 | Import aliases for one staff identity and distinct roles; independent adoption/readback retains credited spelling and exact role/character endpoints. Missing alias targets, false staff kinds and withdrawn role Concepts withhold the whole credit. No personal list or vote is imported. |
| Publish admitted VNDB public tag associations with exact categories and spoilers | Ready; 2,300 lines | Platform VNDB “Tag/trait hierarchy, aliases and per-assertion spoiler level”; ranked gap 6 | Operator imports public associations in distinct tag categories with spoiler qualification, then editor adoption/readback proves exact Concepts. Unknown codes and excluded confidence/false cases remain explicit. Source tags create neither local ballots nor source aggregates. |

## Existing integrated journeys

The following mappings prevent re-briefing work that has already landed. Their limitations are part of the
mapping: retaining an exact unsupported-field diagnostic does not close the missing native meaning.

| Audit row or source portion | Exact existing assignment and retained commit | Remaining boundary |
| --- | --- | --- |
| Bangumi episodes, fractional order, special kinds, duration, date and parent; ranked gap 6 | Import Bangumi episode metadata and exact kinds through the operator journey — `2d283428c8` (implementation `ea0e44dea8`) | Unknown duration units/kinds and missing released kind bindings remain source gaps. Episode catalogue facts do not implement the private episode-state checklist in ranked gap 2. |
| VNDB release dates/status, release → work and completeness; ranked gap 6 | Import VNDB release dates, states and work-completeness without conflating grains — `186f3a1787`, with release/work coordinator fix `857d366c42` | Preserve exact year/month/day precision and distinct TBA/unknown/absent dates. Completeness remains a qualifier-admission gap where the native profile does not admit it. No fabricated date or work-level replacement is permitted. |
| VNDB traits, qualified character appearances and source spoilers; ranked gaps 3 and 6 | Import VNDB character traits and source-qualified appearances with honest losses — `c288bcd8f1` (implementation `94031523d9`) | False-positive traits and unsupported release-specific appearance context are withheld. Age-at-appearance and related/main-character identity need their own Semantic admissions; the mapped task does not claim those meanings exist. |
| Exact role/tag/trait/episode-kind Concepts, unknown codes, release-to-release relations; ranked gap 6 | Map source status and qualified codes to Semantic’s released vocabulary — `f24b86bf1d` | Shared pure mappers validate actual release descriptors and return bounded gaps. Production row traversal is covered by the active and integrated operator journeys above. Release supersession stays release-to-release `wdt:P155`; its absent Release-profile admission is not permission to retarget it to a work. |
| Bangumi music/live-action source adapter; ranked gap 4 | Import Bangumi music and live-action through their released native profiles — `e9c9b1f3f7` (implementation `728893d47d`, grain correction `4e2723ef88`) | Types 3/6 are no longer universally ignored. Type 3 uses admitted MusicAlbum; type 6 uses pinned Movie/TVSeries platform evidence. The absent music work/release/track split and MusicAlbum Library profile remain explicit Semantic/Library outcomes. |
| Reading and correcting the admitted imported music/live-action profile; ranked gap 4 | Read and correct admitted imported music and live-action profiles — `50803e3618` | Reader/correction work consumes released profiles and bounded relationships. It does not promise a complete track list, new music grain or unsupported consumption controls. |
| Representable cross-media relations, character and staff graph; ranks 3, 6 and 8 | Seed real cross-media franchises from Bangumi and VNDB through the API — `4249545b43`; Read the complete cross-media graph after a real dump seed — `c1695ad40b` | Unsupported native meanings and unresolved endpoints remain exact-field gaps. The narrower operator journeys above own their detailed fidelity cases; do not duplicate the graph collector. |
| Admitted source classification observations; ranked gap 5 and VNDB confidence/ballot distinction | Continue classification observation import and delivery — `64faab89ce`; generated-client continuation “Remaining outcome” — `07dc1ac178` | Import only admitted, licensed observations and preserve original sealed delivery intent. Public VNDB dump payload/licence combinations remain unadmitted. Native ballots, source observations and source aggregate figures remain distinct. This mapping does not assert that a generated-client seam has passed integration acceptance. |

## Residual ownership and readiness

Ranked gap 3's organization history, occupations/languages, extra biography and character-to-character meanings
require definition/profile publication. Existing source schemes and mapper seams must consume those exact
published descriptors; they must not infer them from a provider ID, label or appearance role. The audits classify
these as conditional definition work, not an approved new Imports profile design.

Ranked gap 5's native classification ballots and non-VNDB source statistics belong to the rating owner. The
Imports observation journey is already integrated and the public-tag journey is already ready. Neither converts
a provider mean into a native public figure or a metadata tag into a user's ballot.

Open Library's historical personal imports/statistics, Wikidata's arbitrary datatypes/writeback, and other
platforms' synchronization rows do not introduce an additional public catalogue journey within this assignment.
The existing four-source conversion boundary remains authoritative.

No new continuation is necessary for an unassigned Imports outcome in these reports. The five active journeys
remain the ready/running work; integrated mappings remain subject to their actual acceptance and producer
boundaries. Do not add filler briefs to reach a backlog count.

## Cost and verification requirements for retained journeys

Each engine journey keeps the owning importer/conversion Cost section and measures fixed bounded work while
unrelated records, receipt history and source vocabulary grow at three scales. Conversion validates bounded
input rows, schemes, Concepts and command counts; graph traversal and native API work must be measured through
the production operator, not only the pure mapper. Acquisition may be linear in supplied input, while unrelated
native history must not turn one bounded proposal/read into a scan.

The existing journey contracts retain replay/reopen, changed-body, absent/retracted binding and tuple-fence
cases. Product changes own the few user-visible tests needed for those cases, with fewer test lines than product
lines. No additional stories are requested by this mapping. Where an existing reader is involved, its owner
continues to compose viewer state and allowed actions from bounded native page reads; Imports does not introduce
per-row private fetches or another page API.

## Owner and reference links

- [Imports outcome and scope](../goals/imports.md), [capability manifest](../goals/imports.capabilities.md).
- [Conversion source vocabulary](../../packages/conversion/README.md#registered-source-vocabulary-rows) and
  [source mappings](../../packages/conversion/README.md#source-mappings-and-limits).
- [Importer source vocabulary](../../services/importer/README.md#registered-source-vocabulary-mapping).
- [VNDB source inventory](../../packages/definitions/sources/vndb.yaml) and
  [Bangumi source inventory](../../packages/definitions/sources/bangumi.yaml).
- The three linked audit reports supply the source comparison. The read-only
  `/home/edge/projects/rezics/rezics-next/.reference/INDEX.md` supplies the reference registry; no new external
  product capability or source licence is adopted by this plan.
