# Catalogue filter definitions, public bindings and measurement producers

Reviewed on 2026-10-28 against development commit
`8f41588e8177e6fb875d4cddb1139a75fefa30b1` (`dev` and this worktree's starting commit).
This report is evidence for adoption in the definitions owner document; it does not
change definitions, import data, assign native identifiers or certify native filtering.

## Result and scope

The three predicates need independent, adopted native facts: Book work-form light
novel; publicly disclosed harem classification; and a genuine, correctly scoped word
count strictly greater than 1,000,000. Their conjunction must use those same facts.
A novel classification, a matching personal tag, and a character count cannot supply
missing predicates.

The reviewed public vocabulary supplies a defensible light-novel binding to Wikidata
Q747381, a media-harem candidate Q690342, and an actual word-count property P6570.
Bangumi publishes editor-maintained `meta_tags`, including a public Book thematic
category 后宫, but its reviewed Book category/platform is 小说, not light novel.
No executable converter at the recorded pin delivers these three required facts.
No imported native Book above the word threshold is demonstrated by this review.

Use adopted Concepts and reviewed source-key bindings, then commission real
classification and measurement assertions. A trusted explicit counting assertion is
a feasible first-scope producer through existing native proposal/adoption machinery;
it is not evidence that such assertions have already been produced. External
character metadata exists, but neither a compatible external character binding nor
a registered character-count converter is demonstrated here.

The read-only authority inputs were the main checkout's
`.temp/goal/supermanager/decisions/filtered-lists.md`, `identity.md`,
`personal-space.md`, and the data/source portions of
`.temp/goal/supermanager/research/collection-filter.md`. Current first scope excludes
personal-library import and user-saved personal dynamic queries. The older research's
saved-query, facet-count and universal-256 recommendations do not override the
explicit decisions. This report does not reopen engine, identity or library design.

## Evidence record and licences

Public pages were inspected on 2026-10-28. Revision links below pin Wikidata content;
API samples and pages without immutable revisions describe observations on that date,
not guarantees about an older dump or future responses.

| Source                                                                                                         | Exact version or observation                                                                  | Licence / use boundary                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [Schema.org wordCount](https://schema.org/wordCount)                                                           | Displayed development vocabulary V30.1, 2026-09-16                                            | Schema vocabulary CC BY-SA 3.0 under [terms](https://schema.org/docs/terms.html); not a licence for books                                   |
| [SKOS Reference](https://www.w3.org/TR/2009/REC-skos-reference-20090818/)                                      | W3C Recommendation, 2009-08-18                                                                | W3C document-use rules linked by the Recommendation                                                                                         |
| [Unicode text segmentation](https://www.unicode.org/reports/tr29/tr29-47.html)                                 | UAX #29 rev. 47, Unicode 17.0.0, 2025-08-17                                                   | Unicode terms linked by the specification; no text-ingestion permission                                                                     |
| Wikidata entity/property revisions below                                                                       | JSON `lastrevid` and `modified` checked                                                       | Structured data CC0; [Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing); underlying cited texts retain their licences   |
| [Bangumi public-tag announcement](https://bgm.tv/group/topic/406595)                                           | 2024-10-03 announcement; Book/Music launch update 2025-08-24                                  | Entry metadata terms below; discussion prose is not assumed reusable metadata                                                               |
| [Bangumi Book public-tag catalogue](https://bgm.tv/wiki/tag/list?type=1) and public subject API                | Live observation, 2026-10-28                                                                  | [Copyright statement](https://bgm.tv/about/copyright), updated 2022-10-04: wiki metadata CC BY-SA 3.0; images and user writing are separate |
| [Bangumi server](https://github.com/bangumi/server/tree/1997713eafc51487cbea705b37011442f35539fa)              | Reused `.reference/shelves/bangumi-server`, commit `1997713eafc51487cbea705b37011442f35539fa` | `LICENSE.txt`: AGPL-3.0; inspected source uses AGPL-3.0-only notices; read only                                                             |
| [Narou API manual](https://dev.syosetu.com/man/api/) and [guidelines](https://dev.syosetu.com/site/guideline/) | Live observation, 2026-10-28                                                                  | Service-specific restrictions; no open-data licence established; not an approved import source                                              |

The shared reference index records reuse of Bangumi. No reference project was
installed, built or executed. Source code is evidence for behaviour, not material
recommended for copying. Optional new Standard Ebooks reference clones did not
complete; no findings or producer claim below depend on that unreviewed source.

### Reviewed Wikidata revisions

| Term                                                                                                      | Revision; modified UTC            | Reviewed relation and limitation                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [P7937 form of creative work](https://www.wikidata.org/w/index.php?title=Property:P7937&oldid=2556853748) | `2556853748`; 2026-10-14 08:19:18 | Exact property mapping to a generic work-form slot is appropriate; describes a work's structure, not a Book subtype or edition identity                                     |
| [Q747381 light novel](https://www.wikidata.org/w/index.php?title=Q747381&oldid=2548853139)                | `2548853139`; 2026-09-23 16:10:04 | Exact external identity candidate for a Concept deliberately scoped to this Japanese literary form; broader than an individual title, narrower than novel                   |
| [Q690342 harem](https://www.wikidata.org/w/index.php?title=Q690342&oldid=2554335445)                      | `2554335445`; 2026-10-07 04:15:25 | Close candidate for public media-harem classification; not historical households or a work merely titled Harem; exact equivalence is not established for Bangumi's category |
| [P136 genre](https://www.wikidata.org/w/index.php?title=Property:P136&oldid=2561161383)                   | `2561161383`; 2026-10-26 19:22:59 | Existing exact `schema:genre` mapping; not automatically `schema:keywords`                                                                                                  |
| [P921 main subject](https://www.wikidata.org/w/index.php?title=Property:P921&oldid=2558030149)            | `2558030149`; 2026-10-17 16:34:39 | A work's subject matter; only close inventory correspondence to keywords, not an exact tag/genre equivalence                                                                |
| [P6570 number of words](https://www.wikidata.org/w/index.php?title=Property:P6570&oldid=2527590037)       | `2527590037`; 2026-08-05 10:54:50 | Exact property candidate for `schema:wordCount`, subject to counted-text scope and preserved qualifiers; quantity with dimensionless unit, integer, nonnegative constraints |
| [P459 determination method](https://www.wikidata.org/w/index.php?title=Property:P459&oldid=2559696076)    | `2559696076`; 2026-10-22 14:49:35 | Method qualifier candidate, not currently a bundled measurement property; item identity must be resolved                                                                    |

Q747381's description, literary-form statements and narrower-than-novel relationship
support the distinction from generic novels. Q690342's media-genre/theme statements,
Japanese alias and reverse-harem distinction identify the intended media sense; some
statements have no references and unrelated-looking statements exist. Neither its
labels nor an external identifier alone prove a universal cross-source equivalence.
P6570's English meaning and quantity constraints concern words: a misleading Japanese
description using characters does not authorize a character interpretation.

P6570 also declares a determination-method qualifier requirement. Its scope/method
qualifiers distinguish measurements and must survive conversion together.

No correct Wikidata character-count property was verified in the reviewed sources.
This is an unresolved binding, not a claim that no such property could exist.
`Q8034324` (word count) is an item, not a substitute property identifier.

## Native definitions and Concept adoption

At the recorded pin, `packages/definitions/catalogue/book.yaml` defines
`schema:Book` as an abstract book work, mapped to Q47461344, independent of editions.
`bf:Instance`, mapped to Q3331189, is a separate CreativeWork type with
`schema:exampleOfWork`. Its Schema.org Book presentation does not make it a native
Book work. `representativeEdition` chooses a representative edition, not a source
of inherited measurements. Translation and edition identities remain separate.

`packages/definitions/catalogue/classification.yaml` already defines ordinary native
`skos:Concept` and `skos:ConceptScheme` subjects, `skos:inScheme`, `skos:broader`,
`schema:genre` and `schema:keywords`. SKOS separates concepts from their multilingual
labels and schemes from class hierarchies. Its exact/close mapping relations have
different force; close correspondence is not transitive identity. Scheme membership
is a statement about a Concept, not a new Book type. The existing definitions are
sufficient for adopting the classification subjects without a second authority.

Recommend these adoption records, with stable external keys and returned native IDs:

| Adopted subject                                       | Preferred labels                                         | Meaning and scheme membership                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Harem classification Concept                          | en `harem`; zh-Hans `后宫型作品`; zh-Hant `後宮型作品`   | The media-genre sense represented by Q690342, used as a classification of fiction, not historical harem subject matter. Review as a close mapping until category boundaries, including reverse harem, are explicitly reconciled. Member of an adopted public genre/tag scheme. |
| Light-novel work-form Concept                         | en `light novel`; zh-Hans `轻小说`; zh-Hant `輕小說`     | The Japanese illustrated, young-adult-oriented literary form represented by Q747381; no inference from all novels, language, publisher or length. Member of an adopted work-form scheme.                                                                                       |
| Bangumi public-tag scheme and source Concept for 后宫 | Distinguish source-facing labels from canonical meanings | Use the inventory's source scheme key `https://rezics.com/schemes/bangumi/public-tags` as a reviewed external key, not a fabricated native route. Keep the source Concept distinct if exact equivalence to the adopted harem Concept is unresolved.                            |

These are proposed meanings for owner adoption, not already created native data.
Do not add a finer romantic-trope rule from intuition. In particular, the reviewed
Bangumi list supplies a category name, not a formal boundary definition. First adopt
a source-scoped 后宫 Concept; a direct `meta_tags` classification to that Concept
is exact to the source's assertion. Treat its canonical harem correspondence as
close until reviewed. The required public harem filter must name its adopted Concept
and accepted source scope explicitly; no runtime label-based expansion bridges them.
The recommended first scope accepts the reviewed Bangumi media category, with that
scope documented, rather than promising every source's harem terminology agrees.

`services/kernel/src/semantic/bulk.ts` implements idempotent external create-or-resolve:
matching source/external-id claims return the existing subject ID and revision;
otherwise native creation assigns an ID and stores the external claim. Type conflicts
and inaccessible existing subjects are handled rather than guessed around.
`services/kernel/src/semantic/subject.ts` also provides native creation independent
of search. `packages/definitions/src/bulk.ts` separates metadata creation from fact
proposals. Create labels/descriptions, propose scheme membership and reviewed links,
then adopt using the normal authority. Record actual receipts before binding imports.

Never derive a routed UUID from Q747381, Q690342, a scheme IRI or a translated label.
Never search by label and assume identity. An external claim resolves a source record;
it does not, by itself, justify merging two differently scoped Concepts. Release YAML
defines properties/types; it must not become a second registry of Concept subjects.

## Bangumi: published metadata versus converter support

Pinned server evidence, using paths relative to the reused clone:

- [`openapi/components/subject_v0.yaml`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/openapi/components/subject_v0.yaml) declares required `meta_tags` as strings maintained by wiki editors; ordinary `tags` have a separate shape.
- [`web/handler/subject/get.go`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/web/handler/subject/get.go) obtains subject metadata tags separately and applies access/NSFW handling. Public availability does not authorize bypassing withheld subjects.
- [`web/res/subject.go`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/web/res/subject.go) projects metadata tags into `MetaTags`; popularity `Tags` remain separate.
- `internal/tag/domain.go` distinguishes metadata tag category 3 from ordinary subject category 0; `internal/tag/mysql_repo.go` reads source-owned metadata separately from users' collection tags.
- [`cmd/archive/main.go`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/cmd/archive/main.go) serializes `meta_tags` from the source metadata field. This establishes an archive producer, not the contents of every historical record.
- [`openapi/components/subject_cat_book.yaml`](https://github.com/bangumi/server/blob/1997713eafc51487cbea705b37011442f35539fa/openapi/components/subject_cat_book.yaml) and `pkg/vars/platform.go.json` distinguish comic, novel and illustration. Novel is not an explicit light-novel classification.

Two small unauthenticated public API observations are sufficient to verify shape:

```json
{ "id": 3567, "type": 1, "name": "とある魔術の禁書目録 (9)", "platform": "小说", "meta_tags": [] }
```

Source: [subject 3567](https://api.bgm.tv/v0/subjects/3567), observed 2026-10-28.
The empty array proves neither absence of harem nor a negative light-novel judgement.
The title's reputation is not a substitute for an explicit source classification.

```json
{ "id": 1625, "type": 2, "name": "カイバ", "platform": "TV", "meta_tags": ["科幻", "TV", "日本", "原创"] }
```

Source: [subject 1625](https://api.bgm.tv/v0/subjects/1625), observed 2026-10-28.
This is an anime example of a populated string array, not a Book/light-novel example.
No invented Book payload carrying 后宫 is presented as observed data.

The current public Book tag catalogue lists 后宫 under theme and 小说 under category.
It does not list 轻小说 as a public category. The ordinary public popularity page for
[a light-novel tag](https://bgm.tv/book/tag/%E8%BD%BB%E5%B0%8F%E8%AF%B4) is not the
editor-maintained classification. A private or public personal Collection tag remains
a personal assertion. Votes, tag popularity, arbitrary infobox strings, generic novel
platform and user-account data must not be promoted into reviewed catalogue Concepts.
No private collection/account was fetched for this review.

The local inventory `packages/definitions/sources/bangumi.yaml` records:
`dump-2026-10-20.210332Z.zip`, SHA-256
`9fe8de272398ff4bd12994b73e25aac37cca631372383f6aadc503528623aa93`,
archive commit `959474a4fcb833f6dabe8dd2f4fe192f82a71140`, common commit
`2ee87b9995353f77cf02e390e8635bf97dbc1fa2`, API commit
`65d29cff2331e08c0110d30d515f7f1b6488f845`.
Its `meta_tags` mapping is proposed, with source scheme and a close P921 association.
`packages/definitions/test/bangumi-inventory.test.ts` explicitly includes `meta_tags`
in the archive field union. Thus claiming the pinned archive entirely lacks that
field would be wrong. This review did not inspect an actual archived 后宫 Book row.
The synthetic offline `specs/fixtures/imports/bangumi/subject.json` lacks `meta_tags`;
its ordinary tags do not demonstrate the missing producer.

`packages/conversion/src/bangumi.ts` currently maps type 1 to generic Book and does
not consume `meta_tags`. Its projected ordinary tags, platform and infobox fields
are diagnosed as unsupported rather than emitted as reviewed Concepts or counts.
Inventory promises and server support are therefore distinct from executable input
support, converted proposals, adopted facts and indexed native data.

The minimal reviewed Bangumi mapping key is source `bangumi`, subject field
`meta_tags`, exact member string `后宫`, in the public metadata-tag scheme. Bind it
to a returned, adopted source Concept ID; preserve the subject ID and input revision.
Do not fuzzy-match spelling, normalize arbitrary tags into it, or fall back to
`tags`, Collection tags or infobox text when metadata is empty or withheld.
For Wikidata, resolve Q747381 as a Concept value of P7937, not as a new Book type
from a label or an automatic P31-to-Book inference. Each source must separately
establish the counted/classified subject is an admitted Book work.

## Measurements: counted object, method and unknown values

Adopt two distinct quantity properties. `schema:wordCount` counts words; a proposed
local character-count property must have its own reviewed definition and name, with
no invented external exact mapping. Both use integer values greater than or equal
to zero and unit `1`. Zero requires an explicit measurement; absence is unknown.
Reject negative/fractional values and mismatched units. Do not admit rounded estimates
or uncertainty bounds as exact counts. Keep the original evidence when rejecting it.

Every assertion must identify, on the same statement/provenance record:

1. **Counted holder and text:** native work or edition ID, an explicit text/version
   identifier, and language. A work-level assertion must say which realization of the
   work was measured; a count on a physical/digital edition stays on that edition.
2. **Scope:** exactly which body, volumes or parts were included, whether titles,
   footnotes, appendices, markup, ruby readings and whitespace were excluded. A partial
   body count cannot silently become a whole-book count. No implicit series sum.
3. **Method:** a named, versioned counting procedure or an explicit trusted publisher/
   contributor assertion whose declared word/character definition is retained. Include
   segmentation locale/dictionary/version for word counting where applicable.
4. **Evidence:** public stable citation and revision/date, or an auditable trusted
   measurement record with text/version digest and measurement time. A source digest
   identifies an input; it is not itself a counting method or permission to fetch text.
5. **Value state:** exact integer and unit; source bounds preserved as evidence but
   not accepted as exact. Unknown, unavailable, withheld and unmeasured do not mean 0.

Schema.org defines words in a CreativeWork's text and expects Integer; it does not
standardize tokenization. Unicode distinguishes grapheme clusters from code points
and provides default boundaries with language tailoring. Chinese/Japanese word
segmentation needs an explicitly declared procedure; counting characters, bytes,
UTF-16 units or arbitrary non-space substrings must not be renamed word counting.
A word method can use UAX #29 with an identified language-specific tailoring, but
must declare which segments count as words, not count all boundary intervals.

For a new trusted character assertion, recommend a named Unicode-17 extended-grapheme
method, with explicit normalization and whitespace/markup rules. Existing external
character counts retain their source's character convention, even if different;
they are not silently normalized into a different measurement. A character total,
reading duration, page count or a guessed average cannot supply `schema:wordCount`.
Neither this metadata review nor a public source URL grants whole-text ingestion rights.

`schema:inLanguage` and `schema:version` already exist in
`packages/definitions/catalogue/core.yaml`, but being defined does not automatically
allow them as qualifiers on a new property. The owner must admit the required
qualifiers and scope/method representation explicitly. Current `wdt:P518`
`appliesToPart` is restricted to StoryArc for credit/appearance uses; it cannot
represent an arbitrary text-body scope without an adopted definition change.
Do not quietly widen it or drop it during conversion. Recommend a separate measured-
text scope design, retaining existing StoryArc contracts, unless the owner explicitly
chooses and tests a compatible generalization. This is the remaining owner adoption
choice, not an implementation supplied by this report.

No count transfers from work to edition, from source edition to translation, from
one language/version to another, or through `representativeEdition`. If first-scope
Book-work filtering needs edition measurements, its explicit projection policy must
be adopted separately. The minimal recommendation is direct, properly scoped Book-
work assertions only; an edition-only count does not satisfy that leaf automatically.

### Real evidence, feasible producers and delivery gaps

A genuine Wikidata measurement exists on
[À M. Paul Foucher, Q55867126 revision 1717031358](https://www.wikidata.org/w/index.php?title=Q55867126&oldid=1717031358),
modified 2022-08-30 15:15:55 UTC: P6570 amount `+1450`, unit `1`, normal rank,
with P459 Q718390 and P518 Q63246861. Its count statement has no references.
The item is a letter/text with edition relations, not demonstrated native Book data.
The method and part are external item IDs, not resolved native subjects. This proves
an actual word-count source assertion exists; it does not establish trustworthy
whole-Book million-word coverage. The source revision remains a citation even when
the assertion lacks its own independent reference.

The existing Wikidata converter builds bindings from bundled exact property mappings.
It can convert exact dimensionless quantities and diagnoses/skips quantities with
bounds. However, item qualifiers are currently diagnosed and omitted. Enabling P6570
alone could therefore discard precisely the method/scope that makes a measurement
meaningful. Imports must preserve those qualifiers with real resolved identities or
reject the complete measurement; it must not emit a less qualified count.

The Narou manual documents `length` as body character count excluding spaces and
newlines, with documented text-processing exclusions, and `time` as a derived reading-
time estimate. These are not words. The service guidelines restrict purposes and
redistribution; no compatible open-data permission or registered adapter is established.
Consequently it is external character-field evidence, not a recommended first-scope
import producer. Do not relabel a Narou character count or estimated time as words.

The feasible **first-scope word producer** is a trusted catalogue contributor or
publisher submitting an explicit, cited measurement of an identified book text through
the existing native propose/adopt path. It must supply the measurement envelope above;
for self-measurement it uses legally available text locally and records the method and
digest, without uploading the text. An actual reviewed P6570 assertion can later feed
the same shape after qualifier support and holder mapping are complete.

The feasible **first-scope character producer** is the same existing trusted assertion
path with a separately named character method/property. It produces character facts,
including for languages where no word measurement is available. It cannot make the
required word-threshold result true. Neither producer needs a new vertical backend.

These are usable production input routes after definition/adoption, not delivered
measurements. No trusted first-scope Book measurement batch, native receipt, or
million-word Book example was available at the reviewed pin. A generated label,
fixture amount, source inventory row or external QID is not imported native data.

## Existing conversion and API boundary

`services/importer/src/source-registry.ts` registers Bangumi, Wikidata, Open Library
and VNDB. There is no Narou or other count-specific registration.
`packages/conversion/src/open-library.ts` does not produce these classifications or
counts; `packages/conversion/src/vndb.ts` has no relevant measurement producer.
The existing offline fixtures are synthetic converter inputs, not coverage evidence.

`packages/conversion/src/support.ts` exposes `ConversionContext.resolvedReferences`
as an external-key-to-real-native-ID map. Wikidata uses that map, not labels. An
unresolved item may become `somevalue` only where the property's admitted provenance
permits it; it cannot satisfy a concrete Concept-equality filter.
`services/importer/src/importer.ts` has an optional identifier lookup and reconverts
with its returned bindings. The current CLI does not wire that lookup, so an available
interface is not proof that production Concept resolution already runs.
`services/importer/src/record-bindings.ts` persists returned record bindings separately
from source revisions. Use that integration rather than author-supplied UUIDs.

The generic bulk shape already has create metadata (`type`, labels, descriptions,
aliases), propose statements (`property`, value, qualifiers, references and rank),
and source identity (`source`, `external_id`, `record_revision`, `digest`,
`converter_revision`, `field_group`). Item values contain returned native subject IDs;
quantity values carry amount/unit. Reference parts preserve source citations.
Create-or-resolve metadata is not statement adoption or index readiness. A mapping
producer must create/resolve the Concept/scheme, adopt it, then provide real IDs to
conversion; subsequent fact production must preserve statement associations.

## Minimal handoff and acceptance slices

The manager should adopt the mapping/measurement rules in
`packages/definitions/README.md` before commissioning converters. This evidence
report remains a report. Existing general authority documents and current first-scope
decisions stay in force; no personal-space expansion is needed.

Exact future definition/source files and responsibilities:

- `packages/definitions/catalogue/classification.yaml`: move/generalize the existing
  work-form slot here, preserving `wdt:P7937` and relation metadata. Do not duplicate
  its definition. Keep genre versus keywords distinct; document reviewed classification.
- `packages/definitions/catalogue/anime.yaml`: remove the anime-only slot declaration
  after moving it; preserve anime slot use and release semantics.
- `packages/definitions/catalogue/book.yaml`: admit the existing `workFormat` slot, add the word and separate character quantities,
  their permitted qualifiers, and appropriate Book facets. Do not add a LightNovel type.
- `packages/definitions/catalogue/core.yaml`: only if shared method/scope qualifiers
  are adopted; retain StoryArc semantics and existing version/language contracts.
- `packages/definitions/sources/bangumi.yaml`: turn the reviewed metadata-tag association
  into an explicit source-key mapping contract only when Concept adoption is settled;
  leave novel distinct from light novel. Do not promote the P921 close mapping to exact.
- `packages/definitions/sources/README.md`: record reviewed versus proposed/unsupported
  bindings and disclosure provenance. Wikidata executable bindings come from catalogue
  `exact_mappings`, not an invented `sources/wikidata.yaml` writer.
- `packages/definitions/presentation/book/{en,zh-Hans,zh-Hant,ja,ko,de,es,fr}.yaml`:
  localize new facets/units; inspect the corresponding anime presentation files when
  moving the shared property so existing labels still compile.

`packages/definitions/src/compile.ts` exports exact mappings into the release;
close mappings are not executable Wikidata bindings. `src/validate.ts` and
`schema/release.json` validate the release. `src/index.ts` compiles the bundled source
set; inventory YAML is not executable import configuration.
`packages/definitions/scripts/release.ts` is the existing producer of
`packages/definitions/release/rezics.json`. Use that producer and update matching
consumer pins/recordings through their owners, never hand-write another catalogue or
source release. `apps/web/scripts/record.ts` recordings are tied to the active digest.

Small subsequent work slices, with acceptance owned by their respective managers:

1. **Definitions:** adopted measurement scope/method rules, Book work-form admission,
   distinct integer/unit properties, and no Concept authority in release config.
   Extend `packages/definitions/test/release.test.ts`,
   `test/book-recipe-facets.test.ts` and appropriate new acceptance files; validate
   compile/release digest and all eight locales. Existing exact-array bundled-release
   tests in `test/catalogue.test.ts` need owner coordination; this report edits none.
2. **Concept/data:** real native create-or-resolve receipts, multilingual labels,
   scheme membership and adoption; repeat the same external claim and prove the same
   native ID. Public 后宫, withheld metadata and personal labels stay distinguishable.
   Use `services/kernel/test/semantic/bulk.test.ts` integration patterns, not fake IDs.
3. **Imports:** `packages/conversion/src/bangumi.ts` consumes explicit `meta_tags`;
   `wikidata.ts` resolves reviewed item bindings and preserves measurement qualifiers
   or rejects the statement. Add small offline fixtures/tests under
   `specs/fixtures/imports/` and the existing conversion test area. Cover an actually
   observed archived public-tag row before claiming archive data delivery.
4. **Measurement/native data:** a trusted producer supplies cited Book-work and edition
   assertions for both properties, with language/version/method and returned receipts.
   Add native acceptance for the associations and disclosure states below. A synthetic
   converter pass alone is insufficient; producer coverage is separate from filtering.

These are proposed slices, not checks run by this research task. No native engine,
execution-plan, total/facet completeness or readiness/performance claim follows.

## Synthetic acceptance matrix for the missing producers

`L` and `H` below are symbolic references to the actual adopted light-novel and
reviewed public harem Concepts; they are not external IDs or invented native UUIDs.
`F1 = Book AND workFormat=L AND public harem=H`;
`F2 = Book AND wordCount >= 1000001, unit 1`;
`F3 = F1 AND F2`. Counts apply to the same declared text/language/version in each row.
“Unknown” never satisfies a positive predicate or its negation. The rows are
synthetic conformance inputs, explicitly not observations of imported books.

| Case | Native facts / disclosed input                                                     | F1                      | F2                                | F3                       |
| ---- | ---------------------------------------------------------------------------------- | ----------------------- | --------------------------------- | ------------------------ |
| A    | Book, L, public H, words 1000001                                                   | yes                     | yes                               | yes                      |
| B    | Book, L, public H, words 1000000                                                   | yes                     | no                                | no                       |
| C    | Book, generic novel only, public H, words 1000001                                  | no positive LN evidence | yes                               | no                       |
| D    | Book without form, public H, words absent                                          | unknown                 | unknown                           | unknown                  |
| E    | Book, L, public H, words absent, characters 1000001 only                           | yes                     | unknown                           | unknown                  |
| F    | Book, L, H withheld from viewer, words 1000001 visible                             | unknown                 | yes                               | unknown; do not reveal H |
| G    | Book, L, personal/private label harem only, words 1000001                          | unknown catalogue H     | yes                               | unknown                  |
| H    | Book, L, public H, word amount 1000001 with page/other unit                        | yes                     | reject input; no match            | no match                 |
| I    | Source Book, L, public H; translated bf:Instance alone has words 1000001           | yes on source work      | unknown on source work            | unknown on source work   |
| J    | Book, L, H; en/v1 has words 1000000; ja/v2 has words 1000001; query requires en/v1 | yes                     | no                                | no                       |
| K    | Book, L, H; word statement somevalue or novalue                                    | yes                     | unknown                           | unknown                  |
| L    | Book, L, H; count negative, fractional or bounded                                  | yes                     | reject exact-count admission      | no qualifying count      |
| M    | Book, L; no metadata H, but ordinary popularity tag 后宫 and infobox string        | unknown                 | depends only on genuine word fact | no positive H evidence   |
| N    | Book, L, public H; two word statements each missing a different required qualifier | yes                     | no matching complete statement    | no                       |

Case I's edition itself does not satisfy native Book-work membership. Cases J/N must
not combine a value from one statement with qualifiers from another. Case F under
`NOT H` still excludes unknown; hidden data must not become a negative-match leak.
An explicit word count 0 is known and fails the threshold; an absent count is unknown.

The shared pure grammar can express the strict integer threshold with
`range: { gte: 1000001, unit: "1" }`. This admission proves neither native execution
support nor a correct projection over editions, disclosure, qualifiers or complete
indexed populations. Those require the owning native acceptance slice.

## Exact binding and measurement handoff

| Required term/fact   | Binding to adopt / relation                                                                                              | Native holder, value and source contract                                                              | Present delivery gap                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Book work            | Existing `schema:Book` exact Q47461344                                                                                   | Work, independent of bf:Instance edition                                                              | No change to identity/type meaning                                                                           |
| Light novel          | Q747381 exact candidate for adopted literary-form Concept; P7937 exact work-form property                                | `workFormat` on Book; actual adopted Concept ID and explicit public source assertion                  | Book slot and resolved Concept/source assertion producer missing; Bangumi novel is insufficient              |
| Harem                | Bangumi editor `meta_tags` 后宫 exact source-category assertion; Q690342 close canonical correspondence until reconciled | Adopted source/canonical Concept and scheme, disclosed catalogue statement; never a personal label    | Reviewed scope adoption, native receipts and executable metadata-tag producer missing                        |
| Genre versus keyword | Existing P136 exact genre; P921 only close keyword association                                                           | Emit according to the adopted property; no implicit double emission or label join                     | Filter must name accepted classification property/source scope                                               |
| Words                | `schema:wordCount` exact candidate P6570                                                                                 | Counted text/version/language on explicit holder; integer >=0, unit 1; method/scope/citation retained | No demonstrated qualifying native Book batch; qualifier-safe converter and trusted assertion producer needed |
| Characters           | Separate proposed local character-count term; external mapping unresolved                                                | Same measurement envelope, declared character convention, integer >=0, unit 1; never words            | Definition and trusted measurement producer missing; Narou is not an approved adapter                        |
| Threshold / combined | `gte:1000001`, unit `1`; conjunction of independently supported predicates                                               | Same-statement count qualifiers, correct holder and current disclosure                                | Grammar expressibility is not native proof or source coverage                                                |

**Missing producers for Semantic:** adopt the exact scope and source correspondence
of H and L; create/resolve and adopt the real Concepts/schemes; define measured-text
scope/method and holder rules; admit distinct count properties/qualifiers; commission
trusted, cited word and character assertions with native receipts. Decide explicitly
whether any future edition-to-work projection is desired; first scope must not infer it.
Keep the existing release producer as the sole definition-release writer.

**Missing producers for Imports:** receive adopted native bindings before conversion;
wire actual identifier resolution where needed; implement the public Bangumi metadata-
tag projection without personal-tag promotion; establish an explicit light-novel source
assertion route; preserve or reject complete Wikidata measurement qualifiers; produce
real imported/adopted facts with source revision, evidence and receipts. Inventory,
external references, fixture values and generated labels do not discharge these gaps.
