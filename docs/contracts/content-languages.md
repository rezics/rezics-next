# Content languages and selection

## Language identity

Content language is independent of UI locale. Use BCP 47 identities with a reviewed
registry policy, preserving original source spellings and mappings. Distinguish
missing language, undetermined, multiple languages and no linguistic content.
Do not infer territory or script from a broad language tag.

Metadata localization, declared content languages, admitted contribution languages
and actually available readable content are separate. Multiple contributions in
the same language remain independent; subtitles fit a particular cut and language
packs a particular build. Nonlinguistic assets need no invented language.

An independently published translated Work records its actual language and links
to the source Work/applicable version; it is not a nested translation body on the
source. Native Main Versions can compose multiple language variants within one
version. The [Work contract](work-and-release.md) owns that identity distinction.
Official and third-party provenance applies to the particular version/variant,
with source, translator, authorizing party and evidence; a new release does not
automatically inherit an earlier release's authorization or translation coverage.

## Selection and edits

Resolve disclosure, version compatibility and substantive content adoption before
choosing among eligible language variants. Within the requested language policy,
use an explicit variant request, otherwise personal preference, an optional Realm
recommendation and the version's default. Ordinary translation choice does not
require Realm adoption or one selection row per Realm/language. Store overrides
sparsely; a recommendation cannot grant access or revive rejected content.
Return actual language/contribution/revision and fallback reason. Exact requests
fail explicitly when unavailable. Editing UI locale cannot rewrite content language
or retarget prepared commands. An ordinary edit preserves advanced multilingual state.

Names and short literals may use RDF language tags in exchange. Source/role/
direction/validity-rich names use identified NameRecords. The selected
[storage ownership](../storage/ownership-and-placement.md#authority-map)
keeps semantic labels/values and vocabulary in the graph, with document bodies
in PostgreSQL; native i18n applies to both owners. Preserve lexical evidence when an engine
canonicalizes it. Language direction is explicit where the elected RDF exchange
profile cannot preserve it natively.

Native i18n covers titles, names, summaries, descriptions, annotations, bodies and
community-defined predicate labels/definitions. Stable predicate identity and
typed meaning are independent of localized labels. Definition revisions pin value
kind, cardinality and admitted qualifier/constraint profile; incompatible changes
require explicit evolution, never reinterpretation of old assertions by renaming.
Identified label/definition variants retain language, direction, source, author
and revision where applicable. A free-text predicate value follows its declared
language-aware value profile; a human label cannot be used as the predicate key.

## Queries and acceptance

Index by semantic language and analyzer profile, with deliberate cross-script
search expansions. Translation/transliteration/Unicode normalization are different
operations. Test two same-language translations, missing versus undetermined,
RTL text, mixed scripts, unavailable fallback and export round-trips. Include a
separate translated Work, a native multilingual version, no Realm override, an
ineligible preferred variant and a later release without a compatible translation.
