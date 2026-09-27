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

Broader language support still needs an explicit reviewed BCP 47 registry policy
and lossless source spellings. Missing, undetermined, multiple and nonlinguistic
content are different states. Do not infer script or territory from a broad tag.
Direction, mixed scripts, transliteration, analyzer choice and export round trips
need their own executable profiles and tests. A free-text predicate value and a
localized label must preserve stable predicate identity and authored meaning.
