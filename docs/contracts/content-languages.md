# Content languages and selection

Content language is independent of interface locale, localized metadata and
semantic [Context](context.md). A translated display title does not translate a
book's body. An independently published translation is a separate Work linked to
the source; a native multilingual Main Version can instead hold several language
contributions, including same-language alternatives. Publication provenance and
authorization apply to a specific version, never automatically to its successor.

[Native variant selection](../../services/main/src/modules/work/native-variants.ts)
and [translation links](../../services/main/src/modules/work/translation-links.ts)
carry the installed reader and provenance contracts. A personal choice and an
optional Realm recommendation cannot grant publication or disclosure. Exact
requests cannot silently select a different draft or release. The
[WORK02 cases](../../scripts/qa/cases/native-work.ts) exercise these distinctions.

## Language belongs to the content version

Language belongs to a content version, a language contribution in REZICS terms,
not to a release. A release records which content versions it carries, and its
languages follow from them. This is the expression/manifestation split in
[IFLA LRM](https://www.ifla.org/files/assets/cataloguing/frbr-lrm/ifla-lrm-august-2017.pdf)
(language is an Expression attribute; a Manifestation has none), and it lets one
language version appear in several releases without copying its language.

An external edition states those languages through
[`work-metadata-details-v2`](../../model/definitions/work-metadata-details-v2.ts)
and the release record in `services/main/src/modules/release/languages.ts`.

Where a release record must state languages itself, such as an external edition
whose content REZICS does not host, it keeps a list: a parallel-text edition
lists both languages. `zxx` marks no linguistic content, an empty value means not
recorded, `und` appears only where a tag is required, and `mul` never replaces a
list ([RFC 5646 §4.1](https://www.rfc-editor.org/rfc/rfc5646.txt)). The record
also says whether it is or includes a translation and from which original
language ([MARC 041](https://www.loc.gov/marc/bibliographic/bd041.html)), and
keeps the language of its printed titles or track list apart from its content
language ([MusicBrainz release language](https://musicbrainz.org/doc/Release)).
Do not infer script or territory from a broad tag.

## Translations are new content versions

A translation is always a new content version, whoever makes it: a publisher, a
community member or a machine. Official, community, machine and AI-assisted
translations differ in recorded status and rights, not in structure; LRM treats
every translation as a new expression. A translation is never added to an
existing release, because a release records what was published
([closed records](work-and-release.md#closed-records-and-open-axes)).

A translation names its exact source: a contribution or Main Version revision,
an external edition, a fixed release, or a web snapshot with a
[Web Annotation](https://www.w3.org/TR/annotation-model/) TimeState and text
selector. An unknown source stays unresolved rather than guessed. Editions and
snapshots differ in revisions and cuts, so "translated from this Work" is not
enough. A community translation of a hosted Work is a new language contribution
in its Main Version; an independently published translation is a separate Work
with a translation link; a publisher's translated edition is its own release;
translated subtitles or lyrics pin the exact cut or track; a user translation of
indexed web content lives in a [virtual release](distribution.md#release-kinds-and-status).
A title-only translation is localized metadata, not a new content version.

## User-submitted translations

A user translation belongs to its translator, as on
[AO3](https://archiveofourown.org/content) and Genius, and several translations
of one source can coexist; readers and Realms choose among them. Start with one
translator per translation plus co-maintainers: passage-level co-editing needs
the merge protocol that [creation](creation.md) does not yet have.

Each passage carries a state that advances initial, translated, reviewed, final
([XLIFF 2.1](https://docs.oasis-open.org/xliff/xliff-core/v2.1/os/xliff-core-v2.1-os.html)).
When a new snapshot changes a source passage, its translation is kept and marked
as needing an update, as [Weblate](https://docs.weblate.org/en/latest/user/translating.html)
does; it is neither dropped nor silently moved onto the new text.

A translation of protected material is a derivative work
([rights review](../research/source-data-rights.md)). User translations are
private by default. One becomes public only on a recorded basis: a public-domain
or freely licensed source, as [Wikisource](https://en.wikisource.org/wiki/Wikisource:Translations)
requires; the author's permission, which AO3 requires even for published works;
or the author's standing [rights offering](license-grants.md). The author may
refuse the link from the original and may complain through
[content governance](content-governance.md). Anonymous community votes never
publish a translation: YouTube ended viewer-contributed captions in 2020 over
spam and abuse ([report](https://9to5google.com/2020/07/31/youtube-community-captions-end-of-life/)).

## Remaining language work

Broader language support still needs an explicit reviewed BCP 47 registry policy
and lossless source spellings. Missing, undetermined, multiple and nonlinguistic
content remain different states. Direction, mixed scripts, transliteration,
analyzer choice and export round trips need their own executable profiles and
tests. A free-text predicate value and a localized label must preserve stable
predicate identity and authored meaning.
