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

Closed release corrections are enforced by `services/main/src/modules/release/schema.ts`
and `ReleasePolicy`: evidence may replace a record, and a later translation is a new one.

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

## Installed release and translation grain

The first [fixed release](../../services/main/src/modules/work/fixed-release.ts)
seals one published native text draft and its exact Main Version selection. Its
manifest preserves the selected contribution, decision, language and body digest;
current metadata and default-selection edits cannot rewrite those references.
[WORK05 evidence](../../scripts/qa/coverage/work.ts) covers stale, denied,
concurrent and replayed seals plus exact read and graph recovery. The first
[translation link](../../services/main/src/modules/work/translation-links.ts)
pins a target Main Version revision and either an exact source revision or
explicitly unresolved source status. Official authority is version scoped; a
newer target revision does not inherit its link.

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
continuity (and, where needed, cut, chapter or episode). Nothing carries across
versions without reviewed correspondence. Derivation kinds today are only
adaptation, new recording and software fork (`model/definitions/work-derivation-v1.ts`);
revision and reboot must be added.

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

Series progress follows a versioned policy over an exact composition: required
parts, optional extras, chosen order and available translations, counting each
covered unit once so that an omnibus and its volumes never double-count. It
reports "caught up with available material", "finished the published parts",
"series concluded" and "correspondence unresolved" separately. A series' own
ratings stay separate from its volumes' ratings; a derived statistic, if shown,
states its formula and denominator.

Missing today: general series membership and order, series pages and cross-level
projections, release coverage beyond one Work, fragment correspondence and
progress outside book composition (`services/main/src/routes/progress.ts`).
Search hides results that are `isPartOf` another Work
(`services/main/src/modules/work/search-multifield.ts`), which would hide
volumes once they are Works. The M6 series briefs (G-602, G-608, G-609, G-611,
G-612) become adapters over the shared Composed, Versioned and Trackable
capabilities, never a book-only store. The SAO and Index franchises and a set of
works whose web and published versions diverge are the acceptance fixtures.

