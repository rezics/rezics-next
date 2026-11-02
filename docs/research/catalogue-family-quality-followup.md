# Catalogue family quality follow-up

Research date: 2026-11-02. REZICS source: `83481fac405d6be55b894e60db7ea4887447def2`.
Recommendation: take StoryArc refresh disclosure first, then the Game creation recovery journey. Queue exact
creation-error recovery for Album, Manga and Screen as separate page deliveries. Keep the source-present family
composition; these findings do not justify another component migration or a new native API.

This report is evidence for the [Web owner](../goals/web.md), [subject-page contract](../subject-pages.md) and
[shared-family design](home-and-list-items.md). Adoption belongs in those documents. It does not replace the
[prior research](quality-round3-backlog.md) or establish that any migration passed its original acceptance.

## Evidence and method

The survey follows three steps for each family: enter creation and submit initial facts; open the exact returned
subject through the ordinary current reader; enter its specialist correction workspace and follow proposal,
review and public-reading links. Source inspection traced routes, profile composition, state transitions and
existing tests. All eight families have source at this revision. No dependency was assumed installed from a
future-tense brief, and no absent migration was turned into a defect.

**Screenshot review: no attributable current screenshots were supplied or found at the linked evidence location.** The prior report names
`.temp/goal/web/research-shots/quality-round3-fresh/`; that directory is absent here. The tracked Web image
inventory contains a default share card, not journey captures. Historical published-folder images are therefore
not evidence for these changed consumers. No current renderer/story/shared-UI/publication closure is supplied.
This survey uses the contract's source-inspection alternative; browser verification and new capture are deferred
under the launch policy. Occupied legacy captures are not needed for the recommendations.

Every defect below is a **source-demonstrable transition or address mismatch**, with an explicit scenario for
later mounted verification. There are no measured claims about appearance, clipping, contrast, hit areas, focus
movement, screen-reader announcements or published equality. Existing test files were read as scenario evidence,
not run as an acceptance campaign. A test's presence is not a passing result.

In the tables, `C/` means `apps/web/src/features/catalogue/`; test names are under `apps/web/tests/`.
The common public-reader entry points are
[`subject.tsx`](../../apps/web/src/features/pages/subject.tsx) and
[`subject-frame.tsx`](../../apps/web/src/features/pages/subject-frame.tsx). They expose type-specific editors
alongside terms, facts and authored-text navigation. Specialist current values are not proof of anonymous public
selection: proposal, acceptance, adoption and an ordinary selected-statement read remain separate.

## Eight-family journey survey

| Family    | Creation and exact reader                                                                                                                                                                                      | Current reading and correction                                                                                                                                                                                                                          | Disposition and evidence                                                                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literary  | `/catalogue/literary`; `C/literary-profile-view.tsx` uses `CreateSubjectForm`, optional rows per Book/BookSeries and retained metadata. The shared form retains confirmed identity and reader retry.           | `/subjects/{id}/{slug}/literary`; human identity and multilingual terms lead, technical references are disclosed. `SubjectFacts` supplies scalar corrections; relations and authored text open their own workspaces.                                    | Preserve delivered bibliography and identity hierarchy. `literary-create-family.test.tsx`, `specialist-correction-identity-hierarchy.test.tsx`. No separate Literary delivery recommended by this survey.                                                                             |
| People    | `/catalogue/people`, optionally `?work=`; `C/people-profile-view.tsx` retains Person/Organization drafts and the returned reader. `C/people-profile.ts` resolves released fields and credit properties.        | `/subjects/{id}/{slug}/people`; `ProfileIntro` uses supplied identity and work labels. Shared `SubjectFacts` exposes current assertions, terms, authored entry when admitted, exact review and relations.                                               | Preserve delivered creation and work-reference presentation. `people-create-family.test.tsx`, `people-addon-reference-family.test.tsx`, `catalogue-people-profile.test.ts`. Qualified-credit presentation remains Semantic-owned.                                                     |
| Album     | `/catalogue/album`; `C/album-profile-create.tsx` seals the native command, refreshes metadata locally and retains confirmed creation/reader retry.                                                             | `/subjects/{id}/{slug}/album`; `C/album-profile-view.tsx` separates identity, selected scalar facts, explicit proposals, relation review, classifications and authored entry.                                                                           | New creation-error addressing gap below; retain existing creation controls and correction hierarchy. `catalogue-album-profile.test.ts`, `specialist-correction-identity-hierarchy.test.tsx`.                                                                                          |
| Manga     | `/catalogue/manga`; `C/manga-profile-view.tsx` keeps series/volume creation mounted across read failure, retains drafts and seals retry commands. A volume needs explicit independent-edition acknowledgement. | `/subjects/{id}/{slug}/manga`; `C/manga-profile-corrections.tsx` keeps grouped selected facts, per-field inclusion/results, exact candidate review and separate relation/authored editors.                                                              | New creation-error addressing and session-state gaps below. Preserve delivered creation/correction families: `manga-create-family.test.tsx`, `manga-correction-family.test.tsx`.                                                                                                      |
| Game      | `/catalogue/game`; `C/game-profile-view.tsx` augments the common form with per-Type initial rows from `C/game-profile-fields.tsx`. It uses the exact native returned reader.                                   | `/subjects/{id}/{slug}/game`; human identity/current values lead; general facts, classifications and relations have separate workspaces. Classification uses its own candidate review.                                                                  | New failed-refresh draft loss and unmapped initial-fact errors below. Preserve delivered field family: `game-fields-family.test.tsx`, `catalogue-game-profile.test.ts`, specialist hierarchy test.                                                                                    |
| Screen    | `/catalogue/screen`; `C/screen-profile-view.tsx` retains creation metadata through failure and keeps per-Type rows; shared form handles confirmed identity/reader retry.                                       | `/subjects/{id}/{slug}/screen`; selected grouped facts precede correction workspaces, with terms/publication navigation. Current qualifiers/references are rendered separately from proposals.                                                          | New repeated-field error addressing below. Preserve delivered controls in `C/screen-profile-fields.tsx`; `catalogue-screen-profile.test.ts`. Qualified-credit/text-read presentation is a Semantic follow-up, not a Web rewrite.                                                      |
| Character | `/catalogue/character`, optionally `?work=`; `C/character-profile-create.tsx` supplies initial identity/traits, while `C/character-profile-view.tsx` retains confirmed identity and reader retry.              | `/subjects/{id}/{slug}/character`; current groups, classification, facts, authored entry and work relations are composed separately. `retained` plus `hidden` also requires current-reading scrutiny.                                                   | **Assigned:** Character current-reading belongs to Semantic; assess its delivered replacement when available. Do not create another writer. Preserve `character-create-field-correction.test.tsx`, `character-classification-family.test.tsx`, `catalogue-character-profile.test.ts`. |
| StoryArc  | `/catalogue/story-arc`, optionally `?work=`; `C/story-arc-profile-view.tsx` fixes the Type in the shared creation form and offers continuation from the exact created reader.                                  | `/subjects/{id}/{slug}/story-arc`; current identity, scalar review and both arc/work relation editors are independent. `C/story-arc-profile-session.tsx` deliberately refuses Realm editing because current contribution producers support Global only. | New retained-identity disclosure after a refused reload below. Preserve supplied work-reference family and native scope. `catalogue-story-arc-profile.test.ts`, `people-addon-reference-family.test.tsx`. Realm refusal is not a missing Web feature.                                 |

The ordinary reader's public statements, terms, sources and canonical navigation remain the reading contract for
all eight rows. This report does not infer missing product data, missing credits or incomplete launch vocabulary
from a fixture, nor treat a specialist editor as a replacement public subject page.

## New complete deliveries, in priority order

### 1. StoryArc: current-read refusal must remove retained identity from markup

**Owner:** Web, StoryArc page composition. **Size:** 45–60 minutes for the full reload/recovery journey.

**Source:** [`story-arc-profile-view.tsx`](../../apps/web/src/features/catalogue/story-arc-profile-view.tsx),
`retained`, `current`, and the `current && <div hidden={!query.data?.ok}>` region;
[`story-arc-profile.ts`](../../apps/web/src/features/catalogue/story-arc-profile.ts), `readStoryArcProfile`.
The reader returns `denied` for a current 403/404. The page retains the previous successful response and only
hides its subtree. That subtree still contains the arc's supplied name, terms/context links, and mounted fact
and relation children. Gating the outer public link and `FictionalReferenceDetails` does not gate those siblings.

**Scenario:** open a readable named arc with a work; reload after the current read becomes 403/404. The alert
changes, but the former identity remains in DOM text/attributes under `hidden`. This is a disclosure-contract
defect, not a claim that hidden content is visibly painted or a new server-side authorization bypass. The adopted
[Web identity rule](../goals/web.md#adopted-quality-round-three-requirements) forbids withheld identity in markup.

**Complete fix:** distinguish retained private draft state from renderable current public data. Refusal must render
the honest unavailable state without old public identity or links, while preventing commands against that old
reader. Restore the correct page only after a successful current read. Preserve draft bodies/keys internally as
the existing contract permits; do not solve disclosure by silently creating new contribution intent. Keep Global
editing and the existing Realm refusal unchanged.

**Acceptance to add in the page's mounted scenarios:** readable → denied and readable → unavailable → readable;
inspect all DOM text and attributes, including hidden children, for old names/IDs/addresses after refusal; invoke
saved action callbacks and settle earlier pending reads to ensure they cannot revive the old page. Restore only
the newly readable identity, with draft/retry semantics intact and no extra per-row reads. Coordinate the analogous
Character case with its Semantic writer instead of expanding this delivery into that page.

### 2. Game: finish the creation failure-to-correction-to-reader journey

**Owner:** Web, Game creation consumer. **Size:** about one hour.

**Source:** [`game-profile-view.tsx`](../../apps/web/src/features/catalogue/game-profile-view.tsx),
`const read = query.data`, the early failure return and `profile`/`definitions(refresh)` adapters;
[`create-subject-form.tsx`](../../apps/web/src/features/catalogue/create-subject-form.tsx), automatic
`refreshDefinitions` handling and `CreationCorrection`;
[`create-subject-guidance.ts`](../../apps/web/src/features/catalogue/create-subject-guidance.ts),
`createSubjectControls`;
[`game-profile-fields.tsx`](../../apps/web/src/features/catalogue/game-profile-fields.tsx), `GameInitialFacts`.

**Scenario A:** enter multilingual terms and initial Game facts; the create request returns an invalid/stale
definition result with `refreshDefinitions`; the subsequent profile load returns `{ok:false}`. Updating the outer
query makes it take its early return and unmount `CreateSubjectForm`. Reloading successfully mounts a new form:
its locally owned terms and failure state have gone, even though the outer initial-fact drafts survive. Literary
and Screen already retain the creation mount for this situation. This finding concerns a definite rejection;
it does not claim every lost response automatically refreshes definitions or duplicates a created subject.

**Scenario B:** reject an entered initial fact at `/statements/schema:gamePlatform/0/value/content`. Game supplies
neither `profile.control` nor `profile.errorLabel`; the common resolver only maps Type and term pointers. The
error therefore has no named field link and uses the unavailable-field fallback. The initial rows have no
matching correction address. Shared family styling did not finish this recovery path.

**Complete fix:** preserve terms, per-Type rows and any sealed request across unsuccessful creation metadata
refresh; visibly distinguish failed metadata from a ready release, block new invalid intent and provide recovery.
Map known initial-fact pointers to the exact row/control with a human field label; retain unknown pointers in
technical details without inventing a target. Preserve native validation, byte-for-byte uncertain retry and
explicit key-conflict review. Also replace Game correction's `session === 'unavailable'` loading message with a
truthful recoverable session state when touching this complete page journey.

**Acceptance to add:** the real mounted Game consumer with two authored languages and two initial facts; rejected
submit → failed metadata refresh → successful reload; all draft values and applicable frozen command identity
survive. Reject the second repeated fact and a qualifier/reference, follow each correction link, repair and submit,
then follow the exact returned reader. Include unavailable session, uncertain retry, conflict review and retirement;
do not infer rendered geometry from a DOM-only test. Extend the Game consumer coverage, not only its codecs.

### 3. Album, Manga and Screen: complete each creation page's precise error recovery

**Owner:** Web creation consumers. These are three independently landable page deliveries, **30–60 minutes each**,
sharing an address-resolution pattern. Take Album first; do not dispatch a competing shared-editor rewrite.

| Page   | Source-demonstrable residual problem and reproduction                                                                                                                                                                                                                                                                               | Complete page fix and acceptance to add                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Album  | `C/album-profile-create.tsx`, failure error list: `rows.find(pointer.includes(property.id))` always selects the first row with that property. Two creator assertions with only the second invalid point to the first. Every term error points to `#album-terms`, losing the actual language/control; the visible advice is generic. | Resolve decoded native pointer segments and the submitted assertion index, not substring matches. Identify the actual language/value/qualifier/citation control, give supported corrective text, and move keyboard focus when following its summary link. Submit two creator rows plus two languages; reject only the second creator and second language, repair each through its error link, then complete create/reader recovery. Preserve original key retry, conflict review and local metadata retention.     |
| Manga  | `C/manga-profile-view.tsx`, `errorControl` and failure list: statement errors choose the first matching property row, ignoring assertion index; qualifier/citation detail is lost. `/independent` correctly links to the acknowledgement but its visible label falls through to **Terms**, misidentifying what the user must fix.   | Keep the delivered mounted series/volume family. Resolve the exact row and supported inner control, label the independent-volume acknowledgement as that action, and explain known errors without exposing pointers as instructions. Exercise two repeated facts, a second-row citation error, missing acknowledgement and duplicate-language correction; finish volume creation and exact reader retry. Include a real unavailable-session state: this page currently calls every non-signed-out failure loading. |
| Screen | `C/screen-profile-view.tsx`, `profile.control`, discards all pointer segments after the property. `C/screen-profile-fields.tsx` deliberately gives only the first occurrence `screenFactId(property)`. With two cast/credit rows, an error on the second targets the first group. This is **not** a duplicate-ID finding.           | Retain the delivered Screen field family and create-metadata retention. Map assertion index to stable row identity, then the known nested control, and retain the correct human field name. Enter repeated credits, reject only the second value/qualifier/reference, activate its summary link and finish correction/create/read. Verify switching Types, unknown pointers and uncertain retry do not redirect the error to a different draft.                                                                    |

For each delivery, use the existing scalar codecs and
[`statement-validation-presentation.ts`](../../apps/web/src/features/catalogue/statement-validation-presentation.ts)
where applicable. It already separates known controls, human instructions and unsupported addresses. Do not flatten
citation groups, erase unsupported parts, replace an unknown assertion with an empty one, or expand producer
authority. New mounted scenarios should be additive to existing acceptance. Original phone/keyboard/locale/native
proof belongs to the owning delivery after integration, not this research attempt.

## Already delivered, assigned or pending: not new work

| Finding/class                                                                                                   | Current disposition                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Literary, People and Manga creation family anatomy; Manga correction groups; Game initial/classification fields | Source-present with dedicated mounted test files named above. Preserve independent draft/action semantics; do not repeat their migration merely because publication is older. This is source presence, not a claim of passing checks.             |
| Game/Literary/Album/Manga correction identity and optional technical details                                    | Source-present in `specialist-correction-identity-hierarchy.test.tsx` and their renderers. That test's refusal case resets/remounts before denial; it does not establish the StoryArc successful-read → refusal transition.                       |
| Supplied People work reference and fictional work references                                                    | `C/people-profile-view.tsx` and `C/fictional-work-reference.tsx` use supplied human labels, independent links/actions and inspectable technical details. Preserve them.                                                                           |
| Character current-reading, including retained data on refresh                                                   | Assigned to Semantic by this contract. Current source can be inspected, but the owning migration's delivered result remains pending here. No claim that it is fixed or a new Web assignment.                                                      |
| Addon, identifiers, Zone, qualified-credit and text-read presentation                                           | Semantic-owned. Shared Game/fictional helpers and Screen reference rendering do not transfer their ownership. Carry any presentation concern to that writer's full journey; no additional writer recommended here.                                |
| Generic creation entry's 44px phone/coarse-pointer target                                                       | Already recorded and assigned in quality round three; `C/create-subject-entry.tsx` still uses the ordinary small anchor. Keep it inside its existing complete creation journey, not a newly discovered standalone task. No measurement made here. |
| StoryArc Realm correction refusal                                                                               | Explicit current producer limitation in `C/story-arc-profile-session.tsx`. Do not invent Realm command support or disguise refusal as successful editing.                                                                                         |
| Publication, responsive screenshots and native acceptance                                                       | Pending proof, not product defects inferred from old folder coverage. Current stories, shared components and deployed pin must be reconciled before visual comparison.                                                                            |

## Primary-source comparison

Reference paths below are relative to `/home/edge/projects/rezics/rezics-next/.reference/`. Existing clones were
reused read-only; source was inspected directly or with `git show`. No reference code was installed, built or run.
Snapshot dates are inspection dates, not claims that these clones track the latest upstream release.

| Source, pin and licence                                                                                                | Inspected evidence and applicable pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primer React, `f733dcb2b086c6da7902bfecfcf68cd61c7daab3`; MIT, `LICENSE`; `storybook-practice/primer-react`            | [`packages/react/src/FormControl/FormControl.tsx`](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/FormControl/FormControl.tsx) and [`_FormControlValidation.tsx`](https://github.com/primer/react/blob/f733dcb2b086c6da7902bfecfcf68cd61c7daab3/packages/react/src/FormControl/_FormControlValidation.tsx) associate generated control and validation-message identities through a shared context. Apply stable addresses to the repository's existing Field/scalar controls, without importing Primer or copying its implementation. |
| Open Library, `37e446827465be2febad416de1bc18753b66997d`; AGPL-3.0, `LICENSE`; `partitioned-sitemap-feeds/openlibrary` | [`openlibrary/templates/type/edition/view.html`](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/edition/view.html) consumes separately resolved Work, Edition and lending state and labels factual values. Preserve REZICS's work/volume/release identity and current-read boundary through correction; do not turn a successful create or proposal into inferred public selection. This is source evidence, not a visual comparison.                                                                          |
| W3C WCAG 2.2 Understanding, official guidance read 2026-11-02; W3C document terms                                      | [Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html) and [Error Suggestion](https://www.w3.org/WAI/WCAG22/Understanding/error-suggestion.html) support naming the erroneous item and giving known correction advice. A generic invalid message or link to another assertion does not provide the intended recovery. These informative explanations are not a conformance audit of this app.                                                                                                                                                    |
| WHATWG HTML Living Standard, official text read 2026-11-02; CC BY 4.0                                                  | [The hidden attribute](https://html.spec.whatwg.org/multipage/interaction.html#the-hidden-attribute) controls rendering of an existing element/subtree. It is not a removal or authorization boundary. This supports inspecting DOM contents in the StoryArc refusal case; it does not establish a visible leak from a screenshot.                                                                                                                                                                                                                                                      |

**Shared pattern and recommendation:** keep object identity, current facts and actionable control identity explicit.
Primer associates feedback with a particular control; Open Library preserves the particular object and prepared
reading state; the standards distinguish useful error recovery from notification and hiding from removal. In
REZICS's React/TanStack composition, use stable draft-row IDs plus decoded native addresses, preserve sealed intent
outside replaceable reading markup, and let the existing current reader decide what public identity can render.
These are design patterns to implement in the existing stack, not source files or passages to port.

## Research acceptance and decisions

The worker-designed acceptance for this report is a source-review rubric: all eight families have creation,
current-reading and correction dispositions; each recommended defect has a concrete transition/address example,
source, owner, bounded complete fix and additive future verification; existing repairs/assigned work are separated;
primary sources have paths, URLs, pins and licences; visual evidence limitations are explicit. The tables and
scenarios above satisfy that rubric without a product-code test or acceptance campaign.

Decisions for the manager: prioritize disclosure over generic polish; group Game's related failure recovery into
one creation journey; split the repeated-field error class by complete page rather than assign a cross-catalogue
cleanup; leave Character and the other named Semantic scopes with their existing owner. Source-only observations
do not establish publication equality, measured accessibility or whole-feature completion.
