# Native Work and release grain

A Work is an independently maintained creative scope. A Main Version is its
maintained content axis. A fixed release captures an exact selection; an external
publication retains its own identity and evidence. This separation lets a
metadata correction or new native contribution preserve the Work while an
independently published translation, adaptation, recording or software fork can
remain independently maintained and explicitly related to its source.

Names, bytes, identifiers and provider classes alone cannot prove continuity.
Unknown correspondence stays unknown. An ISBN or other distribution identifier
belongs to the evidenced publication grain; it does not automatically identify
the Work. A release announcement is a separate utterance.

## Closed records and open axes

What REZICS records about the world is closed; what REZICS maintains is open. A
Main Version and a [virtual release](distribution.md#release-kinds-and-status)
accept new content versions. An external edition or physical release, each web
snapshot and a fixed release record what was actually published. Evidence may
correct such a record; a later translation or contribution is never added to it,
but becomes a [new content version](content-languages.md#translations-are-new-content-versions)
that names this record as its source. The number of languages does not matter: a
bilingual edition is as closed as a monolingual one.

A release is a statement of fact, so adding content published later would falsify
it and let it imply coverage it never had. Keeping publisher and community work
under separate identities also keeps their authority, rights and responsibility
apart. The same split underlies [IFLA LRM](https://www.ifla.org/files/assets/cataloguing/frbr-lrm/ifla-lrm-august-2017.pdf)
manifestations and expressions, and MusicBrainz places translations that appear
on no actual release on a [Pseudo-Release](https://musicbrainz.org/doc/Style/Specific_types_of_releases/Pseudo-Releases)
rather than on the official one.

## Release and translation grain

[`ReleasePolicy`](../../services/main/src/modules/release/schema.ts) enforces
closed release corrections, and the [fixed release](../../services/main/src/modules/work/fixed-release.ts)
and [translation link](../../services/main/src/modules/work/translation-links.ts)
owners carry their exact pins. Official authority is version scoped: a newer
target revision does not inherit a translation link.

Membership in an album or anthology does not absorb a child Work's identity,
rights, ratings or future content. Domain measurements apply only to their
actual grain: duration to a timed cut, word count to a language revision, pixels
to an image representation and dependencies to a package/environment. Unknown,
zero and inapplicable remain distinct.

Multi-member native release manifests, general external distribution matching,
release-specific availability and entitlement remain separate implementation
work. Export must state residual mapping and loss when external bibliographic or
music grains do not correspond exactly to REZICS identities.

## Explicit identities, targets and units

Decision 6, product manager under maintainer delegation, 2026-09-29.
Versioned profiles must distinguish series and independently identified volumes,
editions/releases and coverage (omnibus, partial, region, platform), anime
series/seasons/episodes, characters and contextual credits, reading sessions,
copies and loans. Reviews identify story, translation, narration or production;
Collection entries do not become Works. Matching titles never establish identity.

The reason is task fidelity: a person can own an omnibus, reread one volume and
review its translation without making those three acts target the same object.
[IFLA LRM](https://www.ifla.org/files/assets/cataloguing/frbr-lrm/ifla-lrm-august-2017.pdf)
supports distinct creative and publication grains; REZICS extends that reasoning
to progress, community judgments and cross-medium coverage. Installed release
profiles above carry their field-level contracts; unknown correspondence stays unknown.

## Work levels, realizations and versions

Maintainer and product manager, 2026-09-30, adopting R56; the rule for rewrites
is the maintainer's. **A unit is its own Work when evidence identifies a
persistent creative or editorial scope that people need to identify
independently** across occurrences or publications: creator or publisher
designation, stable boundaries, independent attribution, established
bibliographic identity or independent reuse. An ISBN, a file boundary, a title
or a number alone is not enough. A unit that only groups, navigates or
positions content inside one realization is an identified occurrence in the
Work's Structure; it still has a stable ID, revisions, discussion and progress
targets. So series, published volumes and separately identified episodes can
be Works at several levels, while chapters, arcs and visual-novel routes are
occurrences by default, and a mechanical split of one novel is two releases,
not two Works.

Five responsibilities stay separate:

| Responsibility | Meaning |
| --- | --- |
| Work relation | Evidenced part-of, series membership, sequel, adaptation, revision or reboot; several parents allowed, cycles rejected |
| Realization | A particular text, translation, performance or cut with its own contributors, rights, custody and revisions |
| Structure | Revisioned occurrences with grouping, labels and order |
| Release coverage | Which exact realizations or portions a publication embodies; one release may cover several Works |
| Correspondence | A reviewed relation between selections: equivalent, partial, revised counterpart or unresolved |

An anthology is an editorial Work whose entries are occurrences referring to the
stories' own Works, which keep their identity, rights and ratings. **Ordinary
translations, including independently published ones, are realizations of the
same Work** with their own custody, translators and rights; only a creatively
transformed translation is a derived Work. This replaces the earlier rule that
an independently published translation is a separate Work, because splitting a
story by language contradicts one graph; the installed translation links migrate
to realization links. A fan translation is a realization pinned to its source
version and never presented as official.

**A Main Version unifies entry; it does not settle identity.** A typographic
correction, a new printing or a faithful translation stays in the same Work; a
director's cut is the same Work in a distinct cut; a published version that
rewrites the web version's plot or continuity is a second Work with its own
Main Version, linked by a revision relation; a remake or reboot is a distinct
Work linked by a reboot relation. Both rewrite versions stay indexed, and the
choice is a compromise that mitigates rather than removes the problem. Reviews
name their target (story, translation, narration or production, and which
version), progress pins language, version and part, and wiki facts pin their
continuity (and, where needed, cut, chapter or episode). Correspondence alone
transfers no progress or facts. Derivation kinds in `work-derivation-v2` pin exact
lexicon definition revisions; Rewrite and Reboot are seeded definitions, and new
kinds can be added as data. Legacy `work-derivation-v1` keeps its three fixed kinds
(adaptation, new recording and software fork), mapped to lexicon definitions in
the combined relations read.

Worked example, Sword Art Online: the web version is one Work whose Structure
holds its arcs and chapters; the Dengeki Bunko series is a Work whose volumes
are Works; Yen Press's English volume 1 is a realization of volume 1 with
separate paperback and digital releases; a volumes 1–3 omnibus is one release
covering three Works; Progressive is a separate series Work linked by a reboot
relation. Bunko volume 1 and the web Aincrad arc have only a partial, revised
correspondence, so finishing one never completes the other. For A Certain
Magical Index, the overall sequence holds the Original, New Testament and
Genesis Testament subseries, each keeping its own volume numbering beside a
separate order key.

Series progress uses `composition-progress-v2` over an exact composition
revision and its disclosed parts. Required uses define the published-parts
denominator; optional parts and extras do not block a finish. Each Work counts
once, including when the reader finishes both an omnibus with complete coverage
and one of its volumes. Finished sessions in any realization language and
Library `read` statements, including imported completions, complete that Work.
Ownership, a 100% locator, partial release coverage and completion of a different
Work do not. Translations realize the same Work: reading volumes 1–10 in
Japanese finishes them even after choosing zh-Hant for future reading.

The chosen language determines availability and the next edition action, with
language tags compared through the shared canonical language contract. The
private per-Work edition preference pins an exact realization or release
revision and uses expected-version writes. The summary reports "caught up with
available material", "finished the published parts", "series concluded" and
"correspondence unresolved" separately. It returns the next available required
part, otherwise the first required part awaiting that language, then an
available optional part or extra. A bounded or nested composition, session or
release window reports continuation and partial results: aggregate finish and
caught-up states are unknown, and the next part and primary action are null.
Unreadable parts are withheld from identifiers, labels and counts.

An omnibus locator cannot identify a position inside its last volume. A
series' own ratings stay separate from its volumes' ratings; a derived
statistic, if shown, states its formula and denominator. Work-level membership
does not write `schema:isPartOf`, so composed volumes remain discoverable in
search, author listings and Zone browse; the
[progress-summary route](../../services/main/src/routes/progress-summaries.ts)
carries the read. Series pages and fragment correspondence remain separate
work; series features are adapters over the shared Composed, Versioned and
Trackable capabilities, never a book-only store. The SAO and Index franchises and a set of
works whose web and published versions diverge are the acceptance fixtures.

## Catalogue acceptance fixtures

Research R55, 2026-09-30. The default boundary between one Work and two is
**narrative incompatibility or a deliberate independent retelling**, never word
count, language, ISBN or marketing:

| Change | Default |
| --- | --- |
| Corrections, light edits, extra viewpoints or compatible chapters | Same Work; distinct revisions and releases |
| Reordered presentation, events unchanged | Same Work; both orders kept |
| Reordering that changes causality, or an incompatible ending | Two Works linked by Rewrite |
| A renamed protagonist | An alias alone keeps one Work; a rewritten identity is investigated |
| A deliberate reboot | Two Works linked by Reboot |
| A deleted web text or a web-only continuation | Coverage and availability only; deletion creates no Work |

Relations to add: Rewrite and Reboot as derivation kinds; Sequel, SpinOff,
franchise membership and qualified event overlap as their own relations; and a
revised publication inside one Work's history rather than a derivation. A
franchise is a Collection with its Zone, not one giant Work.

The fixture specification is [`tests/fixtures/catalogue/franchises.yaml`](../../tests/fixtures/catalogue/franchises.yaml).
Sword Art Online: web serial 2002–2008 and Dengeki Bunko from April 2009
([Kawahara](https://book.asahi.com/article/14487968), [Kadokawa](https://group.kadokawa.co.jp/documents/topics/20140106_soos.pdf));
Progressive declared a reboot ([publisher](https://dengekibunko.jp/product/sao/321508000327.html));
Alternative GGO by Keiichi Sigsawa with Kawahara credited for the original
concept ([credits](https://dengekibunko.jp/novecomi/novel/16817330662085987651/)).
A Certain Magical Index: Original (22 volumes from 2004-04-10), New Testament
(labels 1–22 plus "22 Reverse", from 2011-03-10) and Genesis Testament (from
2020-02-07) as sequel series ([Dengeki Bunko](https://dengekibunko.jp/product/index/312005300000.html)),
with Railgun, Accelerator and Astral Buddy as spin-offs
([Seven Seas](https://sevenseasentertainment.com/series/a-certain-scientific-railgun/)).
Two Works are warranted where authors state the published story diverged:
[Slime](https://www.animatetimes.com/news/details.php?id=1768438282&p=3),
[Shield Hero](https://mypage.syosetu.com/mypageblog/view/userid/172188/blogkey/1785642/),
[So I'm a Spider](https://mypage.syosetu.com/mypageblog/view/userid/595431/blogkey/2933037/),
[Overlord](https://mypage.syosetu.com/mypageblog/view/userid/170524/blogkey/513110/),
[Seirei Gensouki](https://mypage.syosetu.com/mypageblog/view/userid/388068/blogkey/2670146/),
[The Eminence in Shadow](https://ncode.syosetu.com/n0611em/204/),
[The Isolator](https://dengekionline.com/elem/000/000/902/902669/),
[By the Grace of the Gods](https://ncode.syosetu.com/n5824ct/) (two web serials),
[Herbivorous Dragon](https://ncode.syosetu.com/n9375ea/48/) and
[Cheated Magic Swordsman](https://ncode.syosetu.com/n0447ca/). Ascendance of a
Bookworm, Mushoku Tensei, Log Horizon, Arifureta and KonoSuba are one-Work
controls; Re:Zero and Tanya stay undecided until their texts are compared. That
the SAO web and bunko versions are two Works is the maintainer's decision; the
exact extent of the rewrite remains unverified.

Acceptance queries, each through the API and the UI:

1. List one Main Version per series Work in a franchise, excluding releases;
   changing the grain to volumes or seasons changes the list explicitly.
2. Any ISBN or digital entry resolves to a release, its realization, and its
   parent Work and Main Version.
3. The bunko Work leads to the web Work; unavailable text stays distinct from
   unknown identity.
4. Progressive shows Reboot; Alternative GGO shows SpinOff with Sigsawa as author.
5. Edition, story, translation, manga and anime reviews filter separately, and
   every aggregate states its scope.
6. Progress in the web Spider never completes the book Spider; suggested
   correspondence needs explicit acceptance.
7. Contradictory wiki facts ("dies in the web version", "survives in the
   books") coexist with continuity scope and spoiler boundaries.
8. Reading order and publication order differ without changing identifiers.
9. New Testament "22" and "22 Reverse" stay distinct, Genesis Testament restarts
   at 1, and an omnibus covers its books without duplicating Works.
10. Translations name their source continuity and language (`zh-Hant` versus
    `zh-Hans`); unverified web-version translations stay unverified.
11. Anime to manga to novel source chains are traversable, with unresolved
    links visible.
12. Franchise and event membership never merges Works, and contributors keep one
    identity across Zones.

## Compound catalogue creation and bulk import

`POST /v1/work-imports` creates an independently maintained, public metadata-only
Work with its initial descriptive facts, native Agent credits and global curated
classification decisions. `POST /v1/work-imports/bulk` applies up to 128 independent
items per durable graph commit. Neither command publishes contribution text;
existing contribution/publication APIs retain their rights and selection policy.
The request supplies evidence identifying a new creative scope; matching titles
never identify an existing Work.

The dedicated Access scope `work:create:catalogue-import`, action `work.create`,
requires an explicit representation and membership-independent grant. It includes
initial global curation; ordinary creation, creator maintainership and the
administrator role do not imply this capability. Account requires `work:create`
and, when classifications are present, `classification:decide`. The local dataset
administrator setup elects this additional capability explicitly.

Each item has a stable key, optional imported Work identity, `expectedWorkHead:
null`, a title and declared language, bounded aliases/description, evidence,
semantic types, up to eight native credits and eight global decisions. Credits
may pin an Agent head; omission captures and guards the current head during
preparation. Decisions pin the exact active Sense revision and require an absent
decision head. Existing Works and decision slots are never overwritten. External
source author references continue through their source-qualified owner APIs.

An item has one ordinary Work admission, one terminal graph receipt, one logical
source position and one audited outbox batch. Bulk keys are independent of the
batch envelope and position: retry or regroup the same keys with the same inputs.
Successful, denied, invalid, conflicting and pending items remain distinct;
HTTP 200 with `partial: true` or `complete: false` is not a completed import.
Lost graph responses and Access acknowledgements reconcile from the exact
receipts. A terminal cancellation preserves a validation or stale-basis outcome
on subsequent retries. Retirement prevents new semantic-type creation while
retaining successful receipt replay.

The implementation stages immutable objects before the graph writer, validates
all existing canonical/profile bindings, and isolates candidate RDF changes per
item. Only validated changes and terminal cancellations reach the shared writer.
Jena does not support nested transactions, so the bounded overlay supplies item
isolation without copying the corpus. One search-journal entry covers the physical
commit; per-item logical sequences retain relay and recovery ordering.
[Jena transactions](https://jena.apache.org/documentation/tdb/tdb_transactions.html)
explain the single-writer and copy-on-write mechanics; explicit item outcomes
follow the reasoning in [AIP-233](https://google.aip.dev/233), without adopting its
asynchronous transport contract.

The cost contract is `CATALOGUE_IMPORT_COST` beside the implementation: at most
128 items, 1 MiB of input, 16 KiB per item, eight credits/decisions each, a 16 MB
native envelope and 16,384 staged quads per item. Work grows with those bounded
inputs, not unrelated catalogue/history. Admission and acknowledgement each use
one PostgreSQL transaction with per-item receipts; the native writer has a 30 s
deadline. File preparation runs four items concurrently, syncs each immutable
file and the directory before dispatch, and preserves potentially shared objects
until a terminal cancellation proves they cannot be activated. Broker and object
backpressure remain at the API boundary. Native index page work, end-to-end relay
throughput and production capacity are not established by the command benchmark.
