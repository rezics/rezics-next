# Content languages and selection

## Language identity

Content language is independent of UI locale. Use BCP 47 identities with a reviewed
registry policy, preserving original source spellings and mappings. Distinguish
missing language, undetermined, multiple languages and no linguistic content.
Do not infer territory or script from a broad language tag.

Language and [semantic Context](context.md) are independent selection dimensions.
A Context may supply language/display preferences, but changing those preferences
does not revise its semantic component or a statement's definition. Individuals
and Realms can share one interpretation across languages. Conversely, same-language
uses can have different interpretations; a matching translation label proves no
equivalence. Translating a statement preserves its authored meaning references.

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

Substantive content admission and ordinary language preference remain separate
from adopting a semantic Context. A Realm's interpretation selection cannot
authorize, reject or replace a translation; use the publication owner's explicit
decision for that effect. Shared Context use creates no Realm/language matrix.

The first native reader path lists at most 64 current public Contribution
publications for one Work/Main Version, retaining each Contribution's author,
language, publication decision and exact draft revision. A reader's optional
choice is one private Access-owned row keyed by principal and Main Version, with
expected-revision and idempotency checks; clearing removes that row. The personal
selection read rechecks the current publication and public disclosure before
using the chosen exact draft. If the stored choice is no longer eligible, it
reports `preferred-ineligible` and uses the currently eligible Main default;
missing or corrupt exact bytes remain unavailable. The public Main selection and
search result continue to use the Main default, independent of this private
preference. The Realm-aware reader path applies a sparse manager recommendation
for an eligible Contribution in the current Main default's language after any
personal choice. An existing Realm adoption or rejection takes precedence over
both. The recommendation does not change public Realm search or the ordinary
public selection. If its Contribution becomes ineligible or the Main default
language changes, selection reports the ineligible hint and falls back to the
Main default.

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
