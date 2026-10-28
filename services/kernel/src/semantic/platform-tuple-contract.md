# Release platform and language statement grain

Status: owner proposal with frozen native API outcomes, before definitions/data implementation. This document
specifies the missing association; it does not claim that the active release admits it or that Search executes it.
[Native cases](../../test/semantic/platform-tuple-user-cases.test.ts) deliberately require successful writes and
public evidence. A missing qualifier rejected by the API is red evidence, never completion.

## Meaning and minimal representation

Keep an existing `schema:gamePlatform` relation statement on an actual `wd:Q20631656` software release. Its value
is the ID of an actually created and adopted `skos:Concept`. When a source or editor explicitly associates that
platform with an asserted release language, attach `schema:inLanguage` as a native string qualifier to that same
statement. Use `ja` and `en`, not invented language subjects or external/native identifiers. Keep references on
the statement asserting the association, with native reference hashes, rank, acceptance/adoption heads and release
pins. Compact creation and expanded proposal/acceptance/adoption must disclose equivalent selected evidence.

A selected Switch/`ja` statement and a separate selected PC/`en` statement on a release establish those two pairs.
They do not establish Switch/`en` or PC/`ja`. Statements on another release cannot supply the missing qualifier.
An unselected competing Switch/`en` candidate cannot supply it either. Selection uses existing platform-target
slots; language is not a new slot key. Multiple asserted languages on one platform statement mean explicit support
for those languages, only when the source/editor asserts that association.

A work's independent platform and language sets retain aggregate work meaning. They create neither release
identities nor platform/language pairs. Link an identified release to its work using `schema:exampleOfWork`;
a release can represent multiple works under the existing contract. Do not split combinations into Cartesian
release entities or add a backend vertical branch. Do not infer an association from labels, credits, detailed
roles, or StoryArc `appliesToPart`.

Language missing from a statement, explicitly unknown (`somevalue`), or withheld with its statement cannot establish
a positive match. It also cannot establish an exclusion under NOT. Withholding removes the statement's platform,
language, citation and support together from anonymous evidence. Restoring it restores the same selected evidence.
An empty public response is not a complete-absence certificate. Native Search dependencies and current disclosure
must determine `not_proven` rather than treating the pure matcher's false result as a negative proof.

## Existing, proposed and missing surfaces

| Surface                | Current source                                                                                               | Proposal or remaining dependency                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform value         | `game.yaml`: Concept-valued `schema:gamePlatform`, classification relation                                   | Preserve property, Concept targets, inverse and existing target-slot selection                                                                                                                      |
| Language value         | `core.yaml`: patterned multivalued string `schema:inLanguage`                                                | Preserve datatype and language syntax; never convert it into an item                                                                                                                                |
| Qualifier admission    | `gamePlatform` has no declared language qualifier                                                            | Definitions owner adds only native `inLanguage` admission to this property; this change does not edit YAML or released bytes                                                                        |
| Statement validation   | `checkStatementInput` delegates to release checks; qualifier membership is checked before its datatype/value | Existing native validator can validate a string qualifier after release admission; no special platform validator is proposed                                                                        |
| Filter syntax          | `statement.qualifiers: [{property, in}]` already groups qualifiers on one statement                          | Preserve same-statement syntax; no separate language leaf may substitute for association                                                                                                            |
| Filter admission       | Shared admission explicitly restricts qualifiers to `wikibase-item` and validates UUID values                | Separate filter-owner adoption is required for patterned string qualifiers using the existing `schema:inLanguage` pattern; adding YAML alone cannot make the query executable                       |
| Producer/read evidence | Native selected statements retain qualifiers, references, rank and pins                                      | Current indexed qualifier contract describes item targets only; verify actual public projection preserves string language and complete dependencies; do not substitute an in-memory tuple inventory |
| Release date           | Release's existing `schema:datePublished`                                                                    | Keep at release grain; this proposal does not admit a new date qualifier or fabricate statement dates                                                                                               |
| Profiles               | Existing released registry and accepting types                                                               | Preserve all eleven profiles and their pins; this proposal changes no profile or consumer wire                                                                                                      |

The item-only shared filter admission is a concrete current gap, not a reason to replace language strings with
Concepts. The minimal owning choice proposed for manager adoption is the relation/string qualifier above plus
property-declared, pattern-validated string qualifier admission in the shared filter owner. No unrelated string,
credit, relation filter/slot-key or date field is widened here. This is a proposal, not adopted/executed grammar.
It needs no new tuple entity, property, numeric budget or method metadata.

## Source evidence and limits

The actual catalogue sources read are `packages/definitions/catalogue/game.yaml`, `visual-novel.yaml`, `core.yaml`
and `classification.yaml`. Game distinguishes work aggregates from identified software releases. VisualNovel is a
work profile; it does not license manufacturing releases from its work-level facets. Classification Concepts and
schemes use ordinary native creation/adoption.

The pinned inventories `packages/definitions/sources/bangumi.yaml` and `vndb.yaml` distinguish source grain:

- Bangumi's game infobox platform is a work-level hardware/OS assertion. `subject.platform` is a work-format/category
  dispatch value, not hardware. Its first-publication date and platform lists do not identify release combinations.
- VNDB's `releases` rows identify releases; `releases_platforms` uses the release key, and `releases_vn` links releases
  to works. Original release language and title language have distinct source meanings. Joining independent platform
  and language lists, even for an identified release, does not establish a finer platform/language assertion.
  Importers need explicit source association or a cited editorial assertion before producing the qualifier.

[API acceptance gaps](../../../../docs/research/api-acceptance-gaps.md), especially the platform row and
platform-qualifiers case, asks for actual released Concepts, release IDs and false Cartesian controls.
[Catalogue filter mappings](../../../../docs/research/catalogue-filter-data-mappings.md) distinguishes reviewed
source meaning from native producer evidence. Neither report supplies a platform Concept ID or proves a converter.
The controlled native fixture's existing citation is editorial fixture evidence, not an asserted provider import
or an external identity binding for Nintendo Switch or PC.

Read-only reference evidence: the indexed Bangumi server at revision
`1997713eafc51487cbea705b37011442f35539fa`, `openapi/components/subject_cat_game.yaml` and
`pkg/vars/platform.go.json`, confirms game/software/add-on category dispatch. It supplies no release tuple or
native platform IDs. No additional external research or new source pin is introduced.

## Frozen API evidence and pending consumers

Both cases use the versioned shared released-discovery transport, actual kernel HTTP, native Auth/Access, the
actual active bundled release, public created Concepts, and actual returned subject/candidate IDs. They never
compile a test-only property or release, inject projection truth, or clone the runtime. The shared fixture exposes
its existing native grant administration solely to authorize the steward's hide/restore control.

`release platform language qualifiers belong to one actual statement and never form a Cartesian tuple` requires
HTTP 201 for a native qualified candidate, followed by actual acceptance/adoption and anonymous reads. It checks
two selected platform statements, another identified release, aggregate work controls, explicit work links,
acceptance/adoption heads, rank and definition pins. The existing pure Search matcher consumes only those actual
HTTP statements as supplementary association conformance; it does not execute Search.

`compact and expanded selected platform support preserve unknown and source disclosure` requires HTTP 201 for
compact qualified release creation and equivalent expanded support. It checks exact qualifier/reference/rank
association, native reference hashes and pins, an unselected competing language, absent/unknown language,
foreign-release candidate rejection, wrong-type platform rejection, stale adoption fencing with unchanged public
state, and native statement hide/restore. No rejected qualified write can satisfy either case.

Actual Search query/no-Cartesian results and curated Collection, Everything, state Collection, mounted Zone and
TypeList cells remain pending their owners' real bindings and producers. Existing Search cross-surface
specifications own that execution. This suite creates no second cross-surface writer, accepts no mock success,
and makes no current cost, index-readiness, NOT or consumer-completion claim. Once definitions admission lands,
rerun these unchanged frozen cases and commission those owner dependencies separately.
