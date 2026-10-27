# @rezics/definitions

The immutable definition catalogue release format stored by the kernel. This package
exports the release types, the JSON Schema 2020-12 document at
`@rezics/definitions/schema/release.json`, and pure validation and digest functions.

Use `validateRelease(input)` before storing a release. An empty array means valid;
otherwise violations carry RFC 6901 pointers and `invalid`, `unsafe_pattern`, or
`limit` codes. Results are sorted, deduplicated by pointer, and capped at 64.
Validation checks references, CURIE expansion, sorted unique lists, type bases,
facets, relation metadata and cover ratios, datatype-specific members, fixed value
schemas, context defaults, saved filters, and regular-expression safety. A facet is
an item, a time, a quantity, or a code: a `string` whose release definition has a
`pattern`. Pattern checks use recheck's in-process synchronous entry point, with a
three-second timeout per distinct pattern; inconclusive results fail validation.

Releases allow at most 1,024 types, 4,096 properties, 64 properties and 16 facets per
type, 256 context settings, 64 defaults per settings, 1,024 saved filters, 64 per
group, and 4 MiB of canonical UTF-8 JSON. Collection and size limits precede schema
and pattern checks.
A property may name at most 1,024 targets. Compilation allows at most 256 schema files.

The launch grain is three types and twelve properties in one schema file. The bundled
catalogue has 17 types, 68 properties and 12 schema files. One hundred such verticals
add 300 types, 1,200 properties and 100 schema files: 317 types, 1,268 properties and
112 schema files, 874,688 canonical bytes. `foaf:focus` ranges over `Thing`, so its
target is `schema:Thing`; a later type matches through its `bases`.
`schema:exampleOfWork` ranges over `CreativeWork`, so its target stays
`schema:CreativeWork` when a vertical adds a creative-work subtype. Adding a
vertical never changes another vertical's properties. The previous caps of 256
types, 1,024 properties and 64 schema files do not fit that grain. The measured
body is 874,688 bytes, so the previous 1 MiB cap still holds it. The new caps multiply those limits by four: 1,024
types, 4,096 properties, 256 schema files and 4 MiB. Targets are the exception: every
target is a type, so the target cap equals the type cap. That is about three times the
measured type and property counts. Per-type caps stay 64 properties and 16 facets,
because a request touches one type.

A release is validated once per digest per process. Later requests read the subject's
type and the properties on its facts from that cached release. The limits bound
publishing and the cold read. A cold read is linear in the release's canonical bytes
and happens once per digest per process. It does not bound request cost after that.
Inputs are parsed JSON, without cycles. Validation does not mutate them.

`valueSchema(datatype, options)` builds the fixed Wikibase value-content schema.
`releaseDigest(release)` returns `sha256:` followed by the SHA-256 digest of its
RFC 8785 canonical JSON. Validate first: the digest function does not validate.

## Bundled catalogue

The LinkML sources in `catalogue/` define the bundled terms. `rezics.yaml` imports
the shared `core` terms and each profile schema. These profiles add types and
properties through catalogue data; they do not need package code. The compiled
release is checked in at `release/rezics.json`, and `src/bundled.ts` discovers all
catalogue, presentation, context-settings, and saved-filter YAML files for
compilation. Each type release records its structural `bases` as CURIEs, nearest
first, and its registered `facets` in display order. Each vertical declares its own
facets.

An item property may compile a `relation` with a group, exactly one of an inverse
CURIE, `inverse: "none"`, or `symmetric: true`, optional acyclicity, an order key
(default `name`), a filter naming one or a list of at most two distinct item qualifiers, and an optional `slotKey`.
The `slotKey` names an admitted item qualifier whose value distinguishes repeated
relations to the same target. The bundled voice-actor property (`wdt:P725`) uses
the character voiced (`wdt:P453`), distinguishing actor–character pairs. A standard inverse is export and
mapping metadata; it cannot also be a property in the release. Directed inverses
also carry `relation.inverseLabels`, supplied under `inverseProperties` in the
presentation group for the schema file that defines the property. Types may carry
`coverRatio` as `W:H`, where each positive integer is at most 64; compilation
inherits the nearest annotated base's ratio when a type has no annotation of its
own. A type may also carry `schemaOrgType`, a full `https://schema.org/Type` IRI
that consumers use as the JSON-LD `@type`; a release without it stays valid, and
the release defines no default. Consumers choose their fallback for older releases.

Bundled values are presentation correspondences for JSON-LD. They do not replace
native type IRIs, bases or mappings; they do not assert ontology equivalence or
guarantee Schema.org rich-result eligibility. In particular, book works and
editions retain separate native identities even though both serialize as `Book`.

| Native type                  | Schema.org serialization type            |
| ---------------------------- | ---------------------------------------- |
| `schema:Book`                | `https://schema.org/Book`                |
| `bf:Instance`                | `https://schema.org/Book`                |
| `schema:VideoGame`           | `https://schema.org/VideoGame`           |
| `wd:Q689445`                 | `https://schema.org/VideoGame`           |
| `wd:Q20631656`               | `https://schema.org/CreativeWork`        |
| `wd:Q209163`                 | `https://schema.org/CreativeWork`        |
| `wd:Q2620972`                | `https://schema.org/CreativeWork`        |
| `schema:TVSeries`            | `https://schema.org/TVSeries`            |
| `schema:Movie`               | `https://schema.org/Movie`               |
| `schema:TVSeason`            | `https://schema.org/TVSeason`            |
| `schema:Episode`             | `https://schema.org/Episode`             |
| `schema:ComicSeries`         | `https://schema.org/ComicSeries`         |
| `schema:PublicationVolume`   | `https://schema.org/PublicationVolume`   |
| `wd:Q95074`                  | `https://schema.org/Thing`               |
| `wd:Q2095`                   | `https://schema.org/Thing`               |
| `wd:Q7725310`                | `https://schema.org/CreativeWorkSeries`  |
| `schema:BookSeries`          | `https://schema.org/BookSeries`          |
| `schema:Person`              | `https://schema.org/Person`              |
| `schema:Organization`        | `https://schema.org/Organization`        |
| `schema:SoftwareApplication` | `https://schema.org/SoftwareApplication` |
| `skos:Concept`               | `https://schema.org/DefinedTerm`         |
| `skos:ConceptScheme`         | `https://schema.org/DefinedTermSet`      |
| `schema:Recipe`              | `https://schema.org/Recipe`              |
| `schema:MusicAlbum`          | `https://schema.org/MusicAlbum`          |

The relation groups are `order`, `derivation`, `world`, `membership`, and
`association` for the Relations view; `credit` for staff and cast in Credits and
Works; `appearance` for characters in Characters and Appearances; and
`classification` for concept-valued facts such as genre, tags, platform, gender,
and form. Every bundled item property declares a relation, including item
qualifiers. Qualifier-only role properties use `inverse: none`; they do not
create standalone inbound relations.

Bundled facts are stored on the later work (`wdt:P155`), derived work
(`wdt:P144`, `rezics:spinOffOf`, `wdt:P8646`), edition
(`schema:exampleOfWork`), member (`wdt:P179`), contained work
(`wdt:P361`, `schema:isPartOf`, `wdt:P1433`), or credited work
(credits and `schema:character`). Their reverse terms are metadata, never
additional properties. `wdt:P1889` is symmetric. Credits admit credited-as,
position and detailed role, sort by position, and filter by `[wdt:P3831, wdt:P518]`;
appearances filter by either that role or a story arc and sort by name. Series members sort by
position; follows and edition-of reads sort by date. Other bundled relations
sort by name without inventing a source ordinal. Episode, edition and release
profiles admit the credit properties with the same qualifiers as works.

Source inventory mappings may declare `inverse: true`: `term` names the
canonical bundled property, and the related subject holds the statement whose
value is the source subject. Without that field, the source subject holds it.
The external `mapping` or `wikidata`, meaning and citations retain the source
direction. In a vocabulary map keyed by a source term, an explicit `term`
overrides that key as the canonical property. Omitted mappings remain omitted.
Reverse terms without a standard equivalent use `rezics:` with labels in all
eight locales; `rezics:spinOffOf` is the canonical reverse of `wdt:P2512`.

Work profiles admit multivalued `rezics:representativeEdition`, targeting the
book edition and software release classes that hold `schema:exampleOfWork`.
Its `schema:inLanguage` qualifier distinguishes the chosen edition for each
language. It is a holder-only derivation relation: a cover read follows that
choice directly rather than scanning editions. Work classes without a more
specific cover ratio inherit 2:3; other subjects inherit 1:1. Character and
person portraits use 3:4, games and their releases use 3:4, music releases use
1:1, and recipes use 4:3. Books, manga, volumes and anime inherit 2:3.

`schema:inLanguage` is the BCP 47 language tag of the resource. The catalogue stores
the canonical case of the subtags it uses: a lowercase language, an optional
title-case script, and an optional region. Its pattern is
`^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$`. `ja`, `zh-Hant`,
`pt-BR` and `es-419` match. Writers produce that spelling with
`Intl.getCanonicalLocales`.

To add a vertical, add its schema as `catalogue/<vertical>.yaml`, add that schema
to the imports in `catalogue/rezics.yaml`, and add one label file per locale at
`presentation/<vertical>/<tag>.yaml` for each locale the vertical supports. Keep
each term's labels in the group named for the schema file that defines that term.
Profiles with no current terms can contain only metadata and an import of `core`.

### Type interface words and descriptions

A type label is a short interface word that is true for every subject of that
type's catalogue contract. A label can be more specific than its external mapping:
`schema:TVSeries` here means an animated television series, so its Chinese labels
are `TV 动画` and `TV 動畫`, and its Japanese label is `TVアニメ`. Book editions and
software releases both use the neutral Chinese word `版本`; their separate type
identities and properties distinguish them. Manga labels omit the old Japanese
origin restriction. General series labels also cover nonfiction and different
media; they do not imply a finite multipart work. Game add-ons include independently
referable DLC as well as expansions, so their labels use broad store terms such as
`add-on`, `追加内容` and `追加コンテンツ`, rather than expansion-pack terminology.
The catalogue still determines which add-ons have their own work identity.

Neither types nor properties previously had localized release descriptions. Type
presentation files now accept an optional `typeDescriptions` map from type CURIE
to text, alongside the existing `types` and `properties` label maps. Compilation
holds that text as `types[curie].descriptions[locale]` in the release. Descriptions
use the same BCP 47 locale keys as labels, allow one to 1,500 Unicode characters,
and need no English entry. Omitted descriptions stay omitted, so older releases
remain valid. Empty, malformed, unknown-type and duplicate descriptions fail
compilation. Catalogue class descriptions still define the type contract.

Every replaced label is retained verbatim in its locale's `typeDescriptions`,
including replacements of words that were too broad, not just long glosses. Type
labels and descriptions live in the presentation group of the schema defining the
type. All current declarations already had one owner; there was no duplicate to
remove. The compiler has no special case for any vertical.

The review covered all 21 released types in all eight UI locales. The following
Chinese and Japanese labels are pinned by `test/type-labels.test.ts`; unchanged
labels were reviewed too. Ordinary names such as film, recipe, video game, album,
visual novel, book series and the SKOS vocabulary names remain in the other locales.
The technical SKOS labels identify classification resources rather than works.

| Type                       | zh-Hans  | zh-Hant  | ja                 |
| -------------------------- | -------- | -------- | ------------------ |
| `schema:Episode`           | 集       | 集       | エピソード         |
| `schema:Movie`             | 电影     | 電影     | 映画               |
| `schema:TVSeason`          | 季       | 季       | シーズン           |
| `schema:TVSeries`          | TV 动画  | TV 動畫  | TVアニメ           |
| `bf:Instance`              | 版本     | 版本     | 版                 |
| `schema:Book`              | 书籍     | 書籍     | 書籍               |
| `wd:Q95074`                | 角色     | 角色     | キャラクター       |
| `skos:Concept`             | 概念     | 概念     | 概念               |
| `skos:ConceptScheme`       | 概念体系 | 概念體系 | 概念体系           |
| `schema:Organization`      | 组织     | 組織     | 組織               |
| `schema:Person`            | 人物     | 人物     | 人物               |
| `schema:VideoGame`         | 电子游戏 | 電子遊戲 | コンピュータゲーム |
| `wd:Q209163`               | 追加内容 | 追加內容 | 追加コンテンツ     |
| `wd:Q20631656`             | 版本     | 版本     | リリース           |
| `schema:PublicationVolume` | 卷       | 卷       | 巻                 |
| `schema:ComicSeries`       | 漫画     | 漫畫     | 漫画               |
| `schema:Recipe`            | 食谱     | 食譜     | レシピ             |
| `schema:BookSeries`        | 丛书     | 叢書     | 叢書               |
| `wd:Q7725310`              | 系列     | 系列     | シリーズ           |
| `wd:Q689445`               | 视觉小说 | 視覺小說 | ビジュアルノベル   |
| `schema:MusicAlbum`        | 音乐专辑 | 音樂專輯 | アルバム           |

Each changed label below was written by hand. References establish the usage of
the word in its language; choosing it for a catalogue type is an editorial decision
from that type's contract. No translation service or character conversion was used.
For Chinese TV labels, the space separates the Latin abbreviation from the Chinese
word. Wikipedia's Chinese pages are cited as references, not used to convert labels.

| Type                 | Locale  | Interface label | Usage reference                                                                                                        |
| -------------------- | ------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `schema:TVSeries`    | zh-Hans | TV 动画         | [Wikipedia: Digimon series, TV animation usage](https://zh.wikipedia.org/wiki/数码宝贝系列)                            |
| `schema:TVSeries`    | zh-Hant | TV 動畫         | [Bahamut animation interface and news](https://acg.gamer.com.tw/news.php?p=anime)                                      |
| `schema:TVSeries`    | ja      | TVアニメ        | [Wikipedia: television anime](https://ja.wikipedia.org/wiki/テレビアニメ)                                              |
| `schema:TVSeason`    | zh-Hans | 季              | [Wikipedia: Happy Heroes season list](https://zh.wikipedia.org/wiki/开心宝贝)                                          |
| `schema:TVSeason`    | zh-Hant | 季              | [Wikipedia: Is the Order a Rabbit? animation seasons](<https://zh.wikipedia.org/wiki/請問您今天要來點兔子嗎？_(動畫)>) |
| `schema:TVSeason`    | en      | season          | [Wikipedia: television seasons](<https://en.wikipedia.org/wiki/Season_(television)>)                                   |
| `schema:TVSeason`    | es      | temporada       | [Wikipedia: Temporada](<https://es.wikipedia.org/wiki/Temporada_(televisión)>)                                         |
| `schema:TVSeason`    | fr      | saison          | [Wikipedia: Saison](<https://fr.wikipedia.org/wiki/Saison_(télévision)>)                                               |
| `schema:Book`        | zh-Hans | 书籍            | [Bangumi book browser](https://bgm.tv/book/browser)                                                                    |
| `schema:Book`        | de      | Buch            | [Wikipedia: Buch](https://de.wikipedia.org/wiki/Buch)                                                                  |
| `schema:Book`        | es      | libro           | [Wikipedia: Libro](https://es.wikipedia.org/wiki/Libro)                                                                |
| `schema:Book`        | fr      | livre           | [Wikipedia: Livre](<https://fr.wikipedia.org/wiki/Livre_(document)>)                                                   |
| `schema:Book`        | ko      | 책              | [Wikipedia: 책](https://ko.wikipedia.org/wiki/책)                                                                      |
| `bf:Instance`        | zh-Hans | 版本            | [Wikipedia: book versions](https://zh.wikipedia.org/wiki/版本)                                                         |
| `bf:Instance`        | de      | Ausgabe         | [Wikipedia: Ausgabe of a work](https://de.wikipedia.org/wiki/Ausgabe)                                                  |
| `bf:Instance`        | es      | edición         | [Wikipedia: Edición de libros](https://es.wikipedia.org/wiki/Edición_de_libros)                                        |
| `bf:Instance`        | fr      | édition         | [Wikipedia: Édition](<https://fr.wikipedia.org/wiki/Édition_(activité)>)                                               |
| `schema:Person`      | zh-Hans | 人物            | [Bangumi people navigation](https://bgm.tv/character)                                                                  |
| `schema:Person`      | de      | Person          | [Wikipedia: Person](https://de.wikipedia.org/wiki/Person)                                                              |
| `schema:Person`      | es      | persona         | [Wikipedia: Persona](https://es.wikipedia.org/wiki/Persona)                                                            |
| `schema:Person`      | fr      | personne        | [Wikipedia: Personne](https://fr.wikipedia.org/wiki/Personne)                                                          |
| `wd:Q95074`          | zh-Hans | 角色            | [Wikipedia: 角色](https://zh.wikipedia.org/wiki/角色)                                                                  |
| `wd:Q95074`          | zh-Hant | 角色            | [Wikipedia: 角色](https://zh.wikipedia.org/wiki/角色)                                                                  |
| `wd:Q95074`          | ja      | キャラクター    | [Wikipedia: キャラクター](https://ja.wikipedia.org/wiki/キャラクター)                                                  |
| `wd:Q95074`          | de      | Figur           | [Wikipedia: Figur in fiction](<https://de.wikipedia.org/wiki/Figur_(Fiktion)>)                                         |
| `wd:Q95074`          | fr      | personnage      | [Wikipedia: Personnage de fiction](https://fr.wikipedia.org/wiki/Personnage_de_fiction)                                |
| `wd:Q95074`          | ko      | 캐릭터          | [Wikipedia: character terminology](https://ko.wikipedia.org/wiki/캐릭터)                                               |
| `schema:ComicSeries` | zh-Hans | 漫画            | [Wikipedia: 漫畫](https://zh.wikipedia.org/wiki/漫畫)                                                                  |
| `schema:ComicSeries` | zh-Hant | 漫畫            | [Wikipedia: 漫畫](https://zh.wikipedia.org/wiki/漫畫)                                                                  |
| `schema:ComicSeries` | ja      | 漫画            | [Wikipedia: 漫画](https://ja.wikipedia.org/wiki/漫画)                                                                  |
| `schema:ComicSeries` | ko      | 만화            | [Wikipedia: 만화](https://ko.wikipedia.org/wiki/만화)                                                                  |
| `wd:Q7725310`        | zh-Hans | 系列            | [Wikipedia: series of works](https://zh.wikipedia.org/wiki/系列)                                                       |
| `wd:Q7725310`        | zh-Hant | 系列            | [Wikipedia: series of works](https://zh.wikipedia.org/wiki/系列)                                                       |
| `wd:Q7725310`        | en      | series          | [Wikipedia: Series fiction](https://en.wikipedia.org/wiki/Series_fiction)                                              |
| `wd:Q7725310`        | de      | Reihe           | [Wikipedia: Reihe, publication uses](https://de.wikipedia.org/wiki/Reihe)                                              |
| `wd:Q7725310`        | es      | serie           | [Wikipedia: Serie, cultural uses](https://es.wikipedia.org/wiki/Serie)                                                 |
| `wd:Q7725310`        | fr      | série           | [Wikipedia: Série, works in different media](https://fr.wikipedia.org/wiki/Série)                                      |
| `wd:Q20631656`       | zh-Hans | 版本            | [Wikipedia: software and other versions](https://zh.wikipedia.org/wiki/版本)                                           |
| `wd:Q20631656`       | zh-Hant | 版本            | [Wikipedia: software and other versions](https://zh.wikipedia.org/wiki/版本)                                           |
| `wd:Q20631656`       | en      | release         | [GitHub: releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)                |
| `wd:Q20631656`       | de      | Release         | [GitHub: Releases](https://docs.github.com/de/repositories/releasing-projects-on-github/about-releases)                |
| `wd:Q20631656`       | es      | versión         | [GitHub: version details](https://docs.github.com/es/repositories/releasing-projects-on-github/about-releases)         |
| `wd:Q20631656`       | fr      | version         | [GitHub: versions](https://docs.github.com/fr/repositories/releasing-projects-on-github/about-releases)                |
| `wd:Q20631656`       | ja      | リリース        | [GitHub: リリース](https://docs.github.com/ja/repositories/releasing-projects-on-github/about-releases)                |
| `wd:Q20631656`       | ko      | 릴리스          | [GitHub: 릴리스](https://docs.github.com/ko/repositories/releasing-projects-on-github/about-releases)                  |
| `wd:Q209163`         | zh-Hans | 追加内容        | [PlayStation: add-on types](https://www.playstation.com/zh-hans-cn/support/games/add-on-dlc-in-game-currency-support/) |
| `wd:Q209163`         | zh-Hant | 追加內容        | [PlayStation: add-on types](https://www.playstation.com/zh-hant-hk/support/games/add-on-dlc-in-game-currency-support/) |
| `wd:Q209163`         | en      | add-on          | [PlayStation: add-on types](https://www.playstation.com/en-us/support/games/add-on-dlc-in-game-currency-support/)      |
| `wd:Q209163`         | de      | Add-on          | [PlayStation: Add-on types](https://www.playstation.com/de-de/support/games/add-on-dlc-in-game-currency-support/)      |
| `wd:Q209163`         | es      | complemento     | [PlayStation: complementos](https://www.playstation.com/es-es/support/games/add-on-dlc-in-game-currency-support/)      |
| `wd:Q209163`         | fr      | extension       | [PlayStation: extensions](https://www.playstation.com/fr-fr/support/games/add-on-dlc-in-game-currency-support/)        |
| `wd:Q209163`         | ja      | 追加コンテンツ  | [PlayStation: add-on types](https://www.playstation.com/ja-jp/support/games/add-on-dlc-in-game-currency-support/)      |
| `wd:Q209163`         | ko      | 추가 콘텐츠     | [PlayStation: add-on types](https://www.playstation.com/ko-kr/support/games/add-on-dlc-in-game-currency-support/)      |

Context settings are the defaults a community Context created for that vertical
starts with. Add them beside the vertical layout as `contexts/<id>.yaml`. The id
matches `^[a-z][a-z0-9-]{0,63}$`. Presentation files hold labels and type descriptions
only. The settings document has `labels` and `defaults` only. `labels` maps a locale tag to the
Context's name under the rules for type labels: a BCP 47 tag, nonempty text of at
most 256 characters, and an `en` label. `defaults` maps a property CURIE to
`inherit` or `suppress`. A default must name a property in the release. `replace`
is never a default: it needs a per-subject selection. One settings file has at
most 64 defaults, and a release has at most 256 settings. `src/bundled.ts` reads
every `contexts/*.yaml` in id order, and `scripts/release.ts` compiles them, so a
vertical adds a file and edits no code. The release records `contexts` with those
ids sorted and omits `contexts` when there are none. The release format stays
`https://rezics.com/definitions/release/1`. Releases that omit `contexts` stay
valid. A Context keeps the defaults it was created with. A later settings file
applies to Contexts created from that release. This package ships no settings file.

Saved filters are named filter documents a reader picks and a Zone starter uses to
scope itself. Add them beside the vertical layout as `filters/<group>.yaml`. The
group matches `^[a-z][a-z0-9-]{0,63}$`. The document maps each slug, with the same
pattern, to `labels` and `filter`. `labels` follows the rules for type labels: a
BCP 47 tag, nonempty text of at most 256 characters, and an `en` label. `filter`
names types, facets, years and amounts. Subject ids, concepts included, are runtime
data that differs per deployment, so a saved filter that names one is refused. A
saved filter also cannot contain a saved leaf. One group has at most 64 filters,
and a release has at most 1,024. `src/bundled.ts` reads every `filters/*.yaml` in
group order, and `scripts/release.ts` compiles them, so a vertical adds a file and
edits no code. The release records `filters` with keys `<group>/<slug>`, sorted,
and omits `filters` when there are none. Releases that omit `filters` stay valid.
A search request references a saved filter with the leaf `{ saved: '<group>/<slug>' }`,
expanded before admission. A Zone starter scopes itself with that same leaf.
Releases stay cached by digest, with no request path changes. This package ships
no filters file.

To change the catalogue, edit its LinkML source or the language files in
`presentation/`, then run `bun run --cwd packages/definitions release` and review
the resulting release. A term has one meaning for its lifetime. If its meaning
changes, add a new term instead of editing the existing one.

Run `bun run --cwd packages/definitions check` from the repository root.

### Shared terms

`CreativeWork`, `Character` and `CreativeWorkSeries` are abstract anchors. Book
works, editions and launch works extend `CreativeWork`; `FictionalCharacter` and
`Series` extend the other two anchors. An item property's `targets` name its
declared range. `schema:exampleOfWork` ranges over `CreativeWork`, so its target
is `schema:CreativeWork`. A value matches when its subject's type is that target
or the type's `bases` contain it, including editions and any later creative-work
subtype. Adding a vertical never changes another vertical's properties. The two
concrete profiles add no slots of their own here.

A credit is a statement whose property names the job and whose value is a person
or organization. Its qualifiers record the name as credited, credit order and a
detailed role concept, such as a Bangumi staff position. Existing identifier
qualifiers remain available. A voice credit can also name the character portrayed.
Only `schema:contributor` is inherited from `CreativeWork`; profiles attach other
credit properties and character appearances to the types that use them.

An appearance is a `schema:character` statement, qualified by an appearance role
concept (main, supporting, and so on), its credited name and spoiler level. The
custom `rezics:spoilerLevel` quantity uses unit `1`, from 0 (no spoiler) through
2 (major spoiler). This disclosure mechanism has no standard vocabulary term.

Genres, tags and detailed roles are SKOS concepts. A concept and its scheme are
subjects, created and adopted like any other subject; a Realm's board scheme is
one example. When a classification value stands for another subject, the concept
names that subject with `foaf:focus`, whose range is `Thing` and whose target is
`schema:Thing`. Any type under `Thing` matches that target through its `bases`.

Series membership is an adopted `wdt:P179` statement on the member creative work,
with its ordinal in `schema:position`. It is never a list membership. The shared
catalogue adds a fixed set of terms; releases remain cached by digest, with no
runtime path changes.

The following list cites the vocabulary terms and Wikidata mappings used here.
SKOS and FOAF terms cite their publishing vocabularies. New terms have labels in
`en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr` and `es`, in their respective
presentation groups. Type labels follow the interface-word policy above; external
Wikidata glosses belong in descriptions when replaced. Property labels use the
vocabulary's language-specific labels where appropriate. Labels are authored
locally without a translation service.

| Term                        | Source and meaning                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema:CreativeWork`       | [CreativeWork](https://schema.org/CreativeWork), the shared work anchor                                                                                    |
| `schema:CreativeWorkSeries` | [CreativeWorkSeries](https://schema.org/CreativeWorkSeries), the shared series anchor                                                                      |
| `wd:Q95074`                 | [character](https://www.wikidata.org/wiki/Q95074), the concrete fictional character profile                                                                |
| `wd:Q7725310`               | [series of creative works](https://www.wikidata.org/wiki/Q7725310), the concrete series profile                                                            |
| `schema:exampleOfWork`      | [exampleOfWork](https://schema.org/exampleOfWork), mapped to [edition or translation of (P629)](https://www.wikidata.org/wiki/Property:P629)               |
| `schema:author`             | [author](https://schema.org/author), mapped to [author (P50)](https://www.wikidata.org/wiki/Property:P50)                                                  |
| `schema:translator`         | [translator](https://schema.org/translator), mapped to [translator (P655)](https://www.wikidata.org/wiki/Property:P655)                                    |
| `schema:publisher`          | [publisher](https://schema.org/publisher), mapped to [publisher (P123)](https://www.wikidata.org/wiki/Property:P123)                                       |
| `schema:illustrator`        | [illustrator](https://schema.org/illustrator), mapped to [illustrator (P110)](https://www.wikidata.org/wiki/Property:P110)                                 |
| `schema:director`           | [director](https://schema.org/director), mapped to [director (P57)](https://www.wikidata.org/wiki/Property:P57)                                            |
| `schema:musicBy`            | [musicBy](https://schema.org/musicBy), mapped to [composer (P86)](https://www.wikidata.org/wiki/Property:P86)                                              |
| `schema:producer`           | [producer](https://schema.org/producer), mapped to [producer (P162)](https://www.wikidata.org/wiki/Property:P162)                                          |
| `schema:productionCompany`  | [productionCompany](https://schema.org/productionCompany), mapped to [production company (P272)](https://www.wikidata.org/wiki/Property:P272)              |
| `wdt:P58`                   | [screenwriter](https://www.wikidata.org/wiki/Property:P58)                                                                                                 |
| `wdt:P178`                  | [developer](https://www.wikidata.org/wiki/Property:P178)                                                                                                   |
| `wdt:P725`                  | [voice actor](https://www.wikidata.org/wiki/Property:P725)                                                                                                 |
| `schema:contributor`        | [contributor](https://schema.org/contributor), mapped to [contributor to the creative work or subject (P767)](https://www.wikidata.org/wiki/Property:P767) |
| `wdt:P1932`                 | [object of statement named as](https://www.wikidata.org/wiki/Property:P1932), the name as credited                                                         |
| `schema:position`           | [position](https://schema.org/position), mapped to [series ordinal (P1545)](https://www.wikidata.org/wiki/Property:P1545)                                  |
| `wdt:P3831`                 | [object of statement has role](https://www.wikidata.org/wiki/Property:P3831), a detailed role concept                                                      |
| `wdt:P453`                  | [character role](https://www.wikidata.org/wiki/Property:P453), the character portrayed                                                                     |
| `schema:character`          | [character](https://schema.org/character), mapped to [characters (P674)](https://www.wikidata.org/wiki/Property:P674)                                      |
| `rezics:spoilerLevel`       | `https://rezics.com/vocab/spoilerLevel`, the custom disclosure quantity described above                                                                    |
| `skos:Concept`              | [Concept](https://www.w3.org/2009/08/skos-reference/skos.html#Concept), a classification concept                                                           |
| `skos:ConceptScheme`        | [ConceptScheme](https://www.w3.org/2009/08/skos-reference/skos.html#ConceptScheme), a concept scheme                                                       |
| `skos:inScheme`             | [inScheme](https://www.w3.org/2009/08/skos-reference/skos.html#inScheme), scheme membership                                                                |
| `skos:broader`              | [broader](https://www.w3.org/2009/08/skos-reference/skos.html#broader), a broader concept                                                                  |
| `foaf:focus`                | [focus](http://xmlns.com/foaf/spec/#term_focus), the subject a concept stands for                                                                          |
| `schema:genre`              | [genre](https://schema.org/genre), mapped to [genre (P136)](https://www.wikidata.org/wiki/Property:P136)                                                   |
| `schema:keywords`           | [keywords](https://schema.org/keywords), tag concepts                                                                                                      |
| `wdt:P179`                  | [part of the series](https://www.wikidata.org/wiki/Property:P179), membership on the member                                                                |

Release tooling imports `compileCatalogue` and `CatalogueError` from
`@rezics/definitions/compile`. This separate entry point loads
`@neverblink/linkml` 0.17.1; the default entry point never imports the compiler or
LinkML. Compilation runs at release time, with all source text supplied in memory:

```ts
import { compileCatalogue } from '@rezics/definitions/compile';

const release = await compileCatalogue({
  root: 'catalogue.yaml',
  schemas: { 'catalogue.yaml': catalogueYaml, 'core.yaml': coreYaml },
  presentation: { en: englishLabelsYaml, ja: japaneseLabelsYaml },
});
```

Source conventions:

- Supply at most 256 schema files, each at most 256 KiB of UTF-8. YAML is parsed
  with `Bun.YAML.parse`. Imports may reference `linkml:types` or supplied files,
  using LinkML's relative paths and optional `.yaml` or `.yml` extensions.
- Schema keys are limited to `id`, `name`, `title`, `description`, `version`,
  `license`, `prefixes`, `default_prefix`, `default_range`, `imports`, `classes`,
  and `slots`. The root's `id` and `version` identify the release catalogue.
- Class keys are limited to `class_uri`, `description`, `is_a`, `abstract`,
  `slots`, `slot_usage`, `exact_mappings`, `close_mappings`, and `annotations`.
  Every concrete class needs an explicit `class_uri` CURIE and becomes a type.
  LinkML derives its properties through `is_a` and `slot_usage`; each type has at
  most 64.
- A class may set `annotations.facets` to a space-separated list of slot names and
  `annotations.cover_ratio` to a `W:H` ratio with positive integer sides from 1 to 64. A type compiles its own ratio or the first annotated base's ratio, nearest
  first; absent ratios stay absent for consumers to default.
- A class may set `annotations.schema_org_type` to `https://schema.org/` plus one
  term of ASCII letters, digits, underscores or hyphens (a term may start with a digit, as in
  `3DModel`). The compiler copies the value to that type's `schemaOrgType` and rejects anything else
  (other origins, queries, fragments, extra path segments, nonstrings); nothing is fetched. The
  transport is explicit only: no value is inferred from class names, Wikidata ids, mappings or
  ancestors, and subclasses do not inherit it. Older releases and types without the annotation omit
  the field; the release defines no default, so consumers choose their fallback.
  A type inherits its ancestors' declarations from root to leaf, retaining that
  display order. Each facet must be one of the type's properties. Its datatype is
  `wikibase-item`, `time`, or `quantity`, or `string` with a `pattern` in the
  release definition. That fourth kind is a code: an identifier such as a language
  tag. A `string` without a pattern, and every other datatype, is refused at the
  same pointer and code as any other unfilterable facet. A slot may appear only
  once in the inheritance chain, and a type may have at most 16 facets. The type
  itself is always a facet and is not listed in this annotation.
- A type's `bases` list contains its `is_a` ancestors that declare `class_uri`,
  nearest first. It omits the type's own CURIE and repeated CURIEs; ancestors
  without `class_uri` are skipped.
- Slot keys are limited to `slot_uri`, `description`, `range`, `any_of`,
  `multivalued`, `pattern`, `minimum_value`, `maximum_value`, `exact_mappings`,
  `close_mappings`, and `annotations`. `slot_usage` entries allow the same keys
  except `slot_uri`. Each `any_of` entry permits only `range`. Every global slot
  needs an explicit `slot_uri` CURIE, including slots used only as qualifiers.
  Class and slot keys must each be unique. Prefix expansions must be consistent
  across files. Different induced contracts for the same property cannot be
  represented in one release and are refused.
- Slot `annotations` permits `datatype`, `units`, `qualifiers`, `relation_group`,
  `inverse`, `symmetric`, `acyclic`, `relation_order`, `relation_filter`, and
  `relation_slot_key`. The last annotation compiles to `relation.slotKey` and must
  name an admitted item qualifier.
  `datatype` is required: `wikibase-item` needs a class range or `any_of` class
  ranges; `string`, `external-id`, `monolingualtext`, `document`, and `media` need `string`;
  `url` needs `uri`; `quantity` needs `integer` or `decimal`; `time` needs `date`.
  An omitted range uses the source schema's default, otherwise `string`.
- `external-id` requires exactly one exact mapping, matching `wd:P<digits>`.
  Exact mappings become release mappings; close mappings are accepted as source
  metadata. Quantity requires `units`, a space-separated string of `1` or
  CURIEs, expanded to IRIs, or `'*'` alone for any unit (`1` or an absolute IRI).
  Quantities alone permit minimum and maximum bounds. Amounts and optional
  `lowerBound` and `upperBound` are exact signed decimal strings; bounds enclose
  the amount and obey the property's limits. APIs preserve those strings.
  `qualifiers` is a space-separated string of existing slot names.
- Patterns are allowed only on `string`, `external-id`, and `monolingualtext`.
  Every source pattern must compile with JavaScript's `u` flag, contain at most
  256 characters, and receive `safe` from recheck's synchronous checker.
- Each presentation entry uses a BCP 47 language tag or `<group>/<tag>`, where
  group matches `^[a-z][a-z0-9-]{0,63}$`, and contains a YAML object with optional
  `types`, `properties`, `inverseProperties`, and `typeDescriptions` maps, keyed by release CURIE.
  Inverse-property labels belong to the group of the schema file that defines the
  property. Files with the same tag merge; a term can be labelled only once per
  tag. Labels must be nonempty strings
  of at most 256 characters. Unknown terms and other keys are refused. Every
  emitted type and property requires an `en` label; other locales may be partial.
  Type descriptions are optional strings of one to 1,500 characters, with at most
  one per type per tag and no required English entry.
- Optional `contexts` supplies Context settings YAML keyed by id. Each id matches
  `^[a-z][a-z0-9-]{0,63}$`. The document allows only `labels` and `defaults`.
  Defaults name properties in the release and use `inherit` or `suppress`. There
  are at most 256 settings and 64 defaults in each. An empty map omits `contexts`.
- Optional `filters` supplies saved-filter YAML keyed by group. Each group and slug
  matches `^[a-z][a-z0-9-]{0,63}$`. Each entry allows only `labels` and `filter`.
  Labels follow the type-label rules, including an `en` label. Each filter is checked
  with `validateFilter` from `@rezics/filter` against the release being built, with
  saved leaves refused. Subject ids are refused. There are at most 1,024 filters and
  64 in each group. An empty map omits `filters`.

Limits and profile checks precede LinkML loading and linting, then mapping, then
labels, then context settings, then saved filters. A `wikibase-item` property's
`targets` name its declared range: the CURIE of each class named by `range` or
`any_of`, sorted and unique. A named class without `class_uri` contributes the
CURIEs of its nearest descendants that have one, resolved across all supplied
schemas; a range that contributes none is invalid. Emitted targets are sorted
and unique, and a property may name at most 1,024. A value matches a target when
its subject's type equals that target or the type's `bases` contain it, so adding
a vertical never changes another vertical's properties. Compilation stops at the
first stage with violations. LinkML
warnings are permitted; errors are refused. Derived JSON with derivation enabled supplies
classes and induced attributes. An auxiliary abstract class induces all global
slots through LinkML, preserving unused qualifier properties without resolving
inheritance in this compiler. CURIE lists are sorted and deduplicated except for
`bases` and `facets`, which retain ancestor and display order. Release prefixes
contain exactly those used in keys, mappings, targets, bases, and facets; unit-only
prefixes are expanded but omitted. Generator metadata comes from `LinkML.buildInfo()`.

`CatalogueError.violations` contains `{ file, pointer, code, message }` records,
sorted by file and RFC 6901 pointer and capped at 64. Label files are named
`presentation/<tag>` in diagnostics. Context settings are named `contexts/<id>`,
and their pointers start at `/contexts/<id>`. A release with more than 256
settings is reported at `/contexts`. Saved filters are named `filters/<group>`.
Pointers use the release key `<group>/<slug>`, with `/` escaped as `~1`. Each
filter error is reported at `/filters/<group>~1<slug>/filter` plus the filter
pointer: `limit` when the filter exceeds a limit, otherwise `invalid`. A release
with more than 1,024 filters is reported at `/filters`. A group with more than 64
is reported at `/filters/<group>`. Codes are `unsupported`, `invalid`, `limit`,
`unsafe_pattern`, `linkml`, `duplicate`, and `missing_label`. The final release is
checked with `validateRelease`; a failure at that point throws a plain `Error`
because it indicates a compiler defect.

## Term extensions

`@rezics/definitions/extension` holds the format of a Context's custom relation types: an immutable body
(`format` `https://rezics.com/definitions/extension/1`, the Context's `context` id and its `terms`) addressed by
`extensionDigest`. A term is a relation property in the Context's namespace: its CURIE is `c<context id as 32 hex>:<localName>`,
its IRI `https://rezics.com/contexts/<context id>/terms/<localName>`. It carries a `description`, `labels`, `domain`,
`targets`, `multivalued`, optional `qualifiers` and `mappings`, and a `relation` (group `order`, `derivation`, `world`,
`membership` or `association`, one of `inverse` or `symmetric`, optional `acyclic` and `order`), and may be deprecated with
`deprecated.replacedBy`.

- `validateExtension(value, release, { context, sources })` returns the violations of a body against the release it extends
  (RFC 6901 pointers, at most 64 terms). A term with no description, domain or targets is refused with its field named. Only
  Global's extension may name terms of other Contexts, and only as copies of the term in `sources`.
- `checkExtensionUpdate(previous, next)` returns the violations of replacing an active extension: a term keeps its
  description, domain, targets, multiplicity, group, acyclicity and direction, is not dropped and does not lose its deprecation.
- `applyExtension(release, extension)` returns the release as the Context sees it, a pure function of both bodies that
  stays valid under `validateRelease` and quietly omits terms whose types the release no longer has. Its digest is the
  digest of the composed release.

## Portable input validation

`@rezics/definitions/validate` exports `Violation`, `ItemTarget`,
`checkSubjectInput(input, release)` and `checkStatementInput(statement, release)`.
These pure checks share the kernel's structural and release validation, including
RFC 6901 pointers, error codes, ordering and a 16-violation cap. Subject pointers
start at the subject root; proposal pointers start at `/statement`. Each returns
`{ violations, targets }`. Item targets carry the value pointer, subject id and
allowed target types for the caller to check against its database. The checks do
not read a database or import the kernel; compiled value validators are cached
per release. Supply an immutable, validated release and parsed JSON inputs.

An item property's release `targets` may name a type key or any CURIE listed in
the `bases` of a release type. This lets a target name an abstract base that has
no entry in the release's `types`. A value matches when its subject's type equals
a target or its type's `bases` contains a target. The compiler emits the declared
range, so adding a subtype matches through `bases` and does not change `targets`.
Expanded lists of concrete type keys remain valid.

Structural limits apply to every release: decimal strings have at most 127
characters and a time's year has at most 16 digits. An oversized value reports
`out_of_range` at its decimal member or `/time`, without further value checks.
The release value schemas retain their Wikibase shapes. Document and media
values are portable. Single-subject writes and single-statement routes accept
text-only document snapshots as `{ document, licence, language }`. The licence
must be an SPDX identifier or `LicenseRef-` identifier; language must be BCP 47.
Content stores the body and licence, and semantic stores `{ language, document: id, digest }`.
Media contents remain `unsupported` on these routes. Sourced bulk summaries and
covers retain their separate provenance and rights contracts.

## Bulk subject writes

`@rezics/definitions/bulk` exports the portable TypeBox request and response contract for
`POST /v1/subjects:batchWrite`, together with static types and structural validators.
A request contains 1 to 100 commands. Each command has a printable ASCII idempotency
key, a source identity and exactly one operation: create a subject, propose a statement,
or retract a candidate. `checkBatchWrite` validates shapes, field names, limits, enums,
and duplicate keys, returning RFC 6901 pointers and one of `required`, `unknown_field`,
`invalid_type`, `invalid_format`, `out_of_range`, or `unsupported`. Passing a release
also runs the shared subject and statement input checks, then field/property compatibility
checks: summaries use `document`, covers use `media`, and facts use neither. Results preserve
one result per command and its request order; each result contains either a value or an
RFC 9457 problem.

The endpoint requires `subject:batch_write` on the Global Context through an explicit
grant with no standing grant, checked once per request. Before reading a receipt, every
command is authorized as its single-command equivalent: create uses `subject:create`
through parent authorization on the Global Context; propose and retract use
`statement:propose`. This authorization also runs on every replay.

The kernel serves `facts`, `summary`, and `cover` on this route. Any other field
group receives a command-local 400 with only `/commands/<i>/source/field_group`
`unsupported`. A create still rejects `summary` and `cover`. Without an active
release the request receives 503 `semantic_not_ready`. Request-level shape errors
receive 400 and nothing runs; command-level errors retain their original pointers
and do not prevent valid peers from running.

Each command runs alone in one partition and uses a receipt keyed by caller, command
key and `subject.batch_<op>`, with a digest covering the whole command. Commands on
the same partition run in request order; at most eight partitions run concurrently.
A batch is not atomic. The 200 response contains `{ results }` in request order,
one `{ key, status, value }` or `{ key, status, problem }` per command. Problems carry
the single-request body without `instance`. The session header merges command
positions in request order, keeping the latest 32 partitions. The shared write-rate
stage charges the request once, using its command count.

A create claims `(source, external_id)` permanently on the route shared with content's
source fences, without a field group in that identity. A new claim creates one subject,
adopts its labels, descriptions and aliases in Global, and returns 201 `{ id, revision: 1 }`.
A resolving create ignores the supplied subject body and returns 200 `{ id, revision }`
with the existing subject's latest revision. A different type conflicts, an invisible
subject is not found, and a redirected subject conflicts with `redirect: { from, to }`;
a claim is never re-created or reassigned. Creates cannot carry statements: importers
propose each fact to the returned id.

Propose returns 201 `{ candidate, revision }`. A source's refresh with the same
`(source, external_id, field_group)` returns 200 with its existing candidate and
the latest subject revision when the statement identity matches. Facts and covers
use the canonical property, value, and qualifiers. A summary uses the property,
language, and SHA-256 of `serializeDocument` after block ids are replaced in
document order, computed before content's hook, so an unchanged summary appends
no document. Generated block ids are not part of that identity. References and rank do not
change that identity. Refreshes cannot restore moderated content. A hidden or
taken-down candidate answers its id only to a command that is currently allowed.
Retract requires a candidate proposed by the same source tuple; another source's
candidate conflicts and an unknown candidate is not found. It appends a cited
retraction revision, removes the source-candidate identity, and returns 200 `{ revision }`.
A retract in `summary` or `cover` uses those same 404 and 409 answers. It carries
no rights, calls no content hook, and leaves the document and the media claim
with content. A later proposal may then create a new candidate. Proposals and
retractions leave Context adoptions unchanged.

Revision listings include the source envelope or null for individual writes.
Candidate listings expose the proposing `source`, latest `retracted` revision and
`retraction: { source, references }`, each null when absent. Provenance follows the
listing's usual visibility rules. Every command with a source reads that tuple's fence through content's
`readFences` before its receipt and before deduplication. A taken-down tuple is
that command's 409 `fenced` with no effect, including an unchanged refresh and a
replay of a command key. Subject views, candidate listings, and the search source
read omit candidates whose source tuple is currently fenced. Command failures
include 400 `invalid_request`, 403 `forbidden`, 404 `not_found`, 409 `conflict`,
409 `fenced`, 422 `idempotency_conflict`, and 503 as for an individual write.
Retry a lost response with the same command key to replay its receipt.

The contract has no runtime path. `checkBatchWrite` is linear in request size, bounded by
`BATCH_LIMIT` and the statement limits. Proposals require nonempty `references`;
missing or empty references report `required`. Proposal ranks are `normal` or
`preferred`.

### Import field groups

A converter never fabricates a REZICS id or a licence. Subject ids come from an
existing subject or a successful create result; media ids come from an upload.
Use `LicenseRef-unknown` when the source licence is unknown. A source record's
facts, summary and cover have separate provenance and fence identities.

`facts` contains ordinary statements. Treat a source title or name as a
`schema:name` candidate; changing it does not change the labels set at subject
creation. Retract the old candidate when the source record changes. For books,
propose an edition's authors on the edition as the source states them, and keep the
work's authors on the work; a converter never copies authors between them. Convert
an ISBN-10 to ISBN-13 under ISO 2108 by prefixing `978` and recomputing the check
digit, and propose only the ISBN-13 under `schema:isbn`. For a month-only date,
use Wikibase time precision 10 with day `00`, cite the source record, and omit
the raw date string. An unresolved relation uses `somevalue` when the target is
known by a Wikidata item URI, stored in a `schema:sameAs` qualifier; it never
substitutes an external identifier for a REZICS subject id. If a converter has
no identifier for a target, it proposes no relation for that target. Only `facts` supports `create`;
a create subject contains only `type`, `labels`, `descriptions` and `aliases`.
`statements` on a create is `unsupported`. Propose each source statement separately
so its source-candidate key can track refresh and retraction.
Every group supports `propose` and `retract`, and a retraction carries no rights. The following
commands share this setup:

Each imported record fact cites the exact source record with its URL, its
catalogued source identifier property, its source revision in `schema:version`,
and its last-modified date in `schema:dateModified`. For example, an Open Library
work can use one reference with these four parts:

```ts
const openLibraryReference = {
  parts: [
    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://openlibrary.org/works/OL45804W' } },
    { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL45804W' } },
    { property: { id: 'schema:version' }, value: { type: 'value', content: revision } },
    {
      property: { id: 'schema:dateModified' },
      value: {
        type: 'value',
        content: {
          time: '+2024-01-11T00:00:00Z',
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
      },
    },
  ],
};
```

Here `revision` is the revision value from the Open Library record, and the date
is `last_modified` represented at day precision in UTC. Keep `record_revision`
in the source envelope as its separate field.

```ts
import { fromPlainText } from '@rezics/document';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';

// Supplied by subject creation/lookup and media upload, respectively.
declare const subjectId: string;
declare const uploadedMediaId: string;
const source = (field_group: Source['field_group']): Source => ({
  source: 'bangumi',
  external_id: '253',
  record_revision: 'unversioned',
  digest: 'd'.repeat(64),
  converter_revision: 'bangumi@1',
  field_group,
});
const references = [
  {
    parts: [
      {
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content: 'https://bgm.tv/subject/253' },
      },
    ],
  },
];

const create: BatchCommand = {
  op: 'create',
  key: 'bangumi:253:create',
  source: source('facts'),
  subject: { type: 'schema:Book', labels: { ja: '吾輩は猫である' } },
};
// After creation returns subjectId, send each statement as a propose command.

const fact: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:facts:1',
  source: source('facts'),
  subject: subjectId,
  statement: { property: { id: 'wdt:P5732' }, value: { type: 'value', content: '253' }, references },
};

const changedTitle: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:title:2',
  source: source('facts'),
  subject: subjectId,
  statement: {
    property: { id: 'schema:name' },
    value: { type: 'value', content: { language: 'en', text: 'Revised source title' } },
    references,
  },
};

declare const previousTitleCandidate: string;
const retractPreviousTitle: BatchCommand = {
  op: 'retract',
  key: 'bangumi:253:title:3',
  source: source('facts'),
  subject: subjectId,
  candidate: previousTitleCandidate,
  references,
};

// The source has ISBN-10 4-10-101013-0; only its ISBN-13 is proposed.
const isbn: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:isbn:1',
  source: source('facts'),
  subject: subjectId,
  statement: {
    property: { id: 'schema:isbn' },
    value: { type: 'value', content: '978-4-10-101013-7' },
    references,
  },
};

const publicationMonth: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:publication-month:1',
  source: source('facts'),
  subject: subjectId,
  statement: {
    property: { id: 'schema:datePublished' },
    value: {
      type: 'value',
      content: {
        time: '+1980-05-00T00:00:00Z',
        precision: 10,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      },
    },
    references,
  },
};

const unresolvedAuthor: BatchCommand = {
  op: 'propose',
  key: 'openlibrary:OL45804W:author:1',
  source: { ...source('facts'), source: 'openlibrary', external_id: 'OL45804W', converter_revision: 'openlibrary@1' },
  subject: subjectId,
  statement: {
    property: { id: 'schema:author' },
    value: { type: 'somevalue' },
    qualifiers: [
      {
        property: { id: 'schema:sameAs' },
        value: { type: 'value', content: 'http://www.wikidata.org/entity/Q1001' },
      },
    ],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://openlibrary.org/works/OL45804W' },
          },
        ],
      },
    ],
  },
};

const summary: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:summary:1',
  source: source('summary'),
  subject: subjectId,
  rights: {
    license: 'CC-BY-SA-3.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
    attribution: 'Bangumi contributors',
  },
  statement: {
    property: { id: 'schema:abstract' },
    value: { type: 'value', content: { language: 'ja', document: fromPlainText('吾輩は猫である。名前はまだ無い。') } },
    references,
  },
};

const cover: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:cover:1',
  source: source('cover'),
  subject: subjectId,
  statement: { property: { id: 'schema:image' }, value: { type: 'value', content: uploadedMediaId }, references },
};
```

`summary` and `cover` support only `propose` with a concrete `value`. A summary
requires `rights`: an SPDX licence identifier or `LicenseRef-` identifier of at
most 80 characters, zero to four distinct CC REL requirements (`cc:Attribution`,
`cc:ShareAlike`, `cc:Notice`, `cc:SourceCode`), and attribution of 1–500 characters.
Its document uses a `text` or `blocks` profile accepted by `@rezics/document`, with a
`serializeDocument` representation of at most 32,768 UTF-8 bytes. The document
has its own licence and its body is stored by content. `schema:abstract` is
multivalued, with one summary per language by convention.

A cover value is an uploaded media object's UUID. Credit, licence and provenance
belong to that media object. Rights on any command except a summary proposal are
unsupported. Field/property compatibility belongs to release validation: summaries
use `document` properties, covers use `media`, and facts use neither. The bulk
route serves summary and cover through content's hooks. Semantic stores the
document id and digest, or the media id, and never the summary body, a licence
of its own, or a fence. Single-subject writes accept authored documents with
an explicit licence and language; media contents remain `unsupported`.

The launch profiles include books, editions, recipes, television series, albums,
video games and visual novels. Identifier labels follow their Wikidata properties
([Open Library](https://www.wikidata.org/wiki/Property:P648),
[Bangumi subjects](https://www.wikidata.org/wiki/Property:P5732),
[Bangumi people](https://www.wikidata.org/wiki/Property:P6298),
[VNDB](https://www.wikidata.org/wiki/Property:P3180)); the summary and cover terms
follow [schema:abstract](https://schema.org/abstract) and
[schema:image](https://schema.org/image).

Story arcs are subjects of type `StoryArc` (`wd:Q2620972`, verified against
[Wikidata](https://www.wikidata.org/wiki/Q2620972)), inheriting CreativeWork's 2:3
cover ratio. CreativeWork and its series profiles hold `rezics:storyArc`, an
acyclic membership relation ordered by `schema:position`. Its `rezics:firstPart`
and `rezics:lastPart` string qualifiers preserve the work's episode or chapter
numbering. The inverse page names the work. Appearance and credit statements
admit `wdt:P518` to name the arcs they apply to. A relation page still selects one
subject id with `filter`; values across both declared qualifiers share the same
index range and are deduplicated per statement. Changing a declared filter list
requires rebuilding the relation projections as described in the kernel's semantic README.

## How-to documents

Any `document` property can carry how-to content. Its steps form one top-level
`orderedList`, starting at 1; each `listItem` is one step, in document order.
Use the `blocks` profile when a step contains extensions. A duration is an
`extensionInline` with definition `http://schema.org/timeRequired`, version `1`,
an ISO 8601 duration string as its `payload` (for example `"PT30M"`), and readable
`fallback` text (for example `"30 minutes"`). A tip is an `extensionBlock` with
definition `http://schema.org/HowToTip`, version `1`, an empty object payload,
and the tip text as `fallback`. These are document components, not statement
qualifiers. Content owns their representation; semantic stores a document reference.

The bulk `summary` field group accepts any catalogue property with datatype
`document`, including instructions, with the same rights and source evidence.
Single-subject writes use `{ document, licence, language }` for those properties.
Both routes accept Text and Blocks snapshots. Existing content restrictions on
image and media nodes still apply to these field writes.

Recipes declare structured materials through the general `wdt:P186` relation.
Each target has its own slot. `schema:position` orders the list; `wdt:P1114`
qualifies it with an exact quantity, `rezics:note` with preparation wording and
`rezics:listSection` with a section heading. An unresolved object uses `somevalue`
with `wdt:P1932` preserving its source wording and `schema:sameAs` when an external
IRI is known. Without an IRI, it uses the single property-level slot.
The food type uses Wikidata's [food item, Q2095](https://www.wikidata.org/wiki/Q2095)
as its class URI, verified against that item's English label and definition.

A page uses the structured materials list whenever `wdt:P186` statements exist;
otherwise `schema:recipeIngredient` preserves unstructured source wording.
`schema:recipeYield` gives the base servings. Clients multiply the structured
amount and any bounds by `servings / recipeYield` with decimal arithmetic; the
API returns amounts exactly as stored and never rounds or scales them.

## URL slug

`slug(label)` is the canonical URL slug of a display label. Subjects and threads share
it; `subjectSlug` is the identical function. Import it from the browser-portable entry
`@rezics/definitions/slug`, which maps directly to `src/slug.ts`; the module imports
nothing and uses no runtime globals.

The label is NFKC-normalized and lowercased with `String.prototype.toLowerCase`, never
a locale-sensitive form. Each run of characters other than Unicode letters, marks and
numbers becomes one hyphen, and hyphens are trimmed from both ends. CJK stays actual
Unicode: nothing is transliterated, romanized, percent-encoded or stripped of marks.
The result holds at most 60 Unicode code points, never UTF-16 units. When the text is
longer, it is cut at the last hyphen inside the first 60 code points if there is one,
otherwise at 60 code points, then trimmed again. An empty result is `subject`. The URL
builder, not this helper, serializes the slug into a URL. An unchanged label gives an
unchanged slug, and a slug is its own slug.

Cost: the helper touches only the supplied string in memory, with no database, network
or locale-catalogue access. Work is O(label code points) and the output is at most 60
code points, independent of subjects, manifests and history.

## Statement disclosure

A property may declare `disclosure: sourceOrConsent` in a release. Catalogue slots use the same annotation. Omission retains ordinary statement rules; every other value is invalid. This is an authorization contract for semantic writes, not an editor preference: a reference makes the statement eligible for ordinary public review; without one, only the account linked to the target agent can state it, and it stays private until that account discloses it.

`rezics:penNameOf` is a multivalued association from a person or organization representing a pen name or collective name to each person or organization behind it. Its inverse is `rezics:penNames`, labelled “pen names”. The named agent retains its own credits. Each core presentation locale supplies its property label, inverse label and `propertyDescriptions` entry. Optional `propertyDescriptions` maps compile to `properties[curie].descriptions`, using the same locale, length and duplicate rules as type descriptions.

### Cost

- Touches: one optional enum on each property and optional localized descriptions; validation and compilation traverse the existing bounded property and presentation collections.
- Bound: disclosure adds no lookup or data-dependent traversal to definitions reads. Definitions tests cover valid and invalid release values, compiler annotations, localized descriptions and unsourced input validation in `test/disclosure.test.ts`.
- Growth check: semantic's public-read check is `test/semantic/growth-private-statements.test.ts`: `public inverse rows stay flat with 64, 512 and 4096 private pen-name links`, scales `[64, 512, 4096]`, one warm-up per scale.
