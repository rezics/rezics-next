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

## Selection and edits

Resolve requested language, eligible context adoption and Main Version policy.
Return actual language/contribution and fallback reason. Exact requests fail
explicitly when unavailable. Editing UI locale cannot rewrite content language or
retarget prepared commands. An ordinary edit preserves advanced multilingual state.

Names and short literals may use RDF language tags directly. Source/role/direction/
validity-rich names use identified NameRecords. Preserve lexical evidence when an
engine canonicalizes it. Language direction is explicit where the elected RDF
profile cannot preserve it natively.

## Queries and acceptance

Index by semantic language and analyzer profile, with deliberate cross-script
search expansions. Translation/transliteration/Unicode normalization are different
operations. Test two same-language translations, missing versus undetermined,
RTL text, mixed scripts, unavailable fallback and export round-trips.
