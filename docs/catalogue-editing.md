# Catalogue editing

The adopted [catalogue editorial journey](research/catalogue-editorial-journey-design.md) connects a correction
to the current Subject reader and explains an individual change without inventing a historical Item. Imports
owns browser binding. Semantic owns these native contracts. Subject creation, proposal, acceptance and adoption
keep their existing APIs and authority. A selected scalar `schema:name` statement is independent of labels.

## Browser flow: multilingual subject terms

The subject header and compact subject frame offer **Edit names and descriptions** at
`/{locale}/subjects/{id}/{slug}/terms`. The private, noindex page keeps the exact subject identity and reads native
terms with their quoted ETag. Released Type names use the existing locale fallback; data language is a separate
explicit choice. This is catalogue data, separate from Puck presentation documents and cited statement proposals.

Each language shows original names, descriptions and aliases. Keep, replace and remove are explicit choices;
blank replacement inputs are invalid, never implicit deletion. Only intentional changes enter the patch. Other
languages and drafts survive language switches, denials and stale responses. Remaining labels and aliases use
native limits. Current authority and derived-term eligibility belong to the server; server refusal details remain
visible, and a profile link appears only when the existing canonical account lookup supplies it.

Discard restores only the selected language's local draft; an added language without stored terms stays removable,
even after discard. The unsaved-language review lists explicit field choices, including invalid or unchanged-value
replacements, and lets the contributor return to each language. Both local reset actions lock during submission,
uncertain delivery and stale comparison; they never delete stored terms or send a request.

Navigation is dirty only when the effective patch changes stored terms; staying retains every language draft and the
selected language, and the existing pending-send warning says an unresolved request may finish and is not cancelled by
leaving.

The session BFF preserves identity, CSRF, concurrency, idempotency and native session headers. Native website proof
provisions subjects through ordinary `POST /v1/subjects`; imported field support remains the kernel terms command
that BFF already calls. Uncertain delivery freezes the payload, ETag and key for retry. Stale revisions or
conflicting keys require reload, comparison and an explicit new confirmation. A successful write is followed by a native read of the same returned ID; only that read
supplies current terms and the canonical reader address. Failed or concealed rereads never publish a local preview.
The generated client supplies the PATCH body type. A successful response must contain exactly the requested Subject
and positive revision with its matching strong ETag; its returned Session is passed to the immediate current read.
A served 404 is the uniform missing/concealed outcome. Source integration and type validity alone establish neither
native execution nor visual acceptance.

Semantic owns the native terms API. An unavailable operation remains unavailable in the browser; it never becomes
a successful local preview or a substitute catalogue mutation.

## Browser flow: why this value

Each displayed scalar statement offers **Why this value** at the subject’s `/value` route, addressed by the exact
property and statement ID. A fresh, authorized current Subject read establishes its value, selected rank, qualifiers,
references, actual Context and statement release/revision. The latest subject revision and acceptance alone never
establish selection. A changed selection, unresolved reading, suppressed field, concealed read, denial and failed read
remain distinct from native unknown-value and no-value assertions. Metadata keeps its actual language and fallback.

The page reuses the ordinary value and document renderer. Only an authorized document representation in the current
response can supply text; a locator is unavailable text. Citations are supporting material, with no verification or
rights badge. Sources, Changes, existing review and the current reader remain available as navigation.

Review metadata comes from one bounded current candidate page for the exact emitted slot. Only metadata of the
selected statement is retained. An absent row is explicitly not returned, with a next-page control only when the
native response supplies its opaque continuation, including through empty pages. There is no automatic history
scan, private-alternative cache, point-read API or inference of erased content. Emitted relation metadata is required
to address relation slots; without it, review information is unavailable. A link carrying another Context cannot
silently fall back to Global; the existing Realm resolver still owns that native binding.

The session BFF preserves caller authorization and continuity and marks responses private/no-store. The existing
safe change-detail adapter can explain the selected statement’s exact revision when supplied and matched; its
generated native binding validates the exact Subject/revision and supported closed response before explaining it.
Concealed, denied and unavailable detail stays explicit. No historical snapshot or write authority is assumed.

Each value loader result starts a read episode; the browser rereads under its observed current reader before displaying it.

## Browser flow: subject contributions

The existing subject header and compact view frame expose one **Contribute** menu. The shared UI Menu supplies
keyboard navigation, Escape/focus return, and the phone bottom sheet with its localized Back control. Initial
creation, editing this subject, review, and read-only Sources/history occupy separate groups. The entry consumes
the existing native action components and their shared destination descriptors, preserving the caller's actual
Recipe and publication conditions and unrelated native actions. It introduces no second search or editor engine.

The review link uses the exact current Context returned by the subject/page read; without that identity it offers
no guessed Context. Relations retain the current Realm address and its native unsupported-context explanation.
Sources and Changes remain ordinary readers. Signed-out editing/review navigation carries the exact chosen
localized destination, including Context or work query, through the existing session sign-in return parameter.
This is navigation, not a client permission model: native pages and BFF responses still decide current access,
availability, disclosure and action authority. Initial creation remains separate from later proposals and term
PATCH, and citations never become ingestion Source metadata or a permission grant.

Navigation adds no producer call or per-row hydration read. Existing forms, readers, drafts, concurrency and request
keys remain with their owning components. Detailed Changes consumes the delivered native read, and terms mutation
uses the native PATCH command documented below. A menu link establishes neither availability nor a successful write. The Contribute stories use
actual routes for navigation and the existing terms page for explicit denied/unavailable samples. Native acceptance,
interaction execution and phone/desktop visual review remain integration work.

Recipe departure reuses the localized authoring prompt; uncertain retries preserve the exact command while bypassing
local definition checks and still reaching current native authorization.

Initial Subject creation uses the shared departure guard for entered terms, Type changes and profile controls;
blank language rows and a preset profile Type remain clean, while pending or uncertain commands warn that leaving
loses local retry recovery without cancelling the request. Profile controls are compared with their initial values
per Type without invoking validation callbacks, so returning to unchanged values clears that draft's warning.

The generic creation route uses one search field with an explicit localized-label-prefix or exact-Type-ID mode;
running a search keeps the selected Type and multilingual term drafts, while choosing a result requires its current
exact descriptor.

## Browser flow: fictional character identity and credits

The catalogue creation entry, a fictional character's header and a work's Characters view offer **Character identity
and credit editor**. `/{locale}/catalogue/character?work={id}` starts from an exact existing work;
`/{locale}/subjects/{id}/{slug}/character` corrects the canonical character, optionally retaining `work`. These
private, noindex routes keep the actual `wd:Q95074` identity separate from people and accounts. Current public
subjects and the active release load independently; the immutable release decides effective fields, targets,
qualifiers, units and classifications. Definition fallback carries its actual language.

Subject and work entries use the shared **Contribute** menu, preserving the exact character or work address and
the existing signed-out return destination. The standalone catalogue creation entry shares that destination.

Names, original text, traits, measurements and identifiers appear in meaningful groups. Initial creation reuses
native subject POST, initial-term validation and scalar controls. Only explicitly entered languages and added facts
are sent; no birth year, classification, image, Source metadata or work credit is inferred. Native initial facts
are selected at creation. The exact returned UUID is reread before providing the canonical reader and correction
address; concealed or unavailable readback offers a read retry without another create.

Scalar corrections reuse the multi-field workspace, with unchanged fields excluded and independent per-field
results. Classification targets use the existing subject picker and the same statement, qualifier, grouped-reference,
validation and sealed-command helpers, with field-wide candidate review. Current assertions, other languages,
qualifiers and references survive replacement drafting. Name maps link to the actual terms adapter; an unavailable
native producer stays unavailable. Original text links to the existing authored editor with explicit language and
licence. No candidate is presented as current publication.

Appearances and credits are statements on the selected existing work. The existing relation editor retains separate
emitted properties, the native `wdt:P453` character qualifier and exact target/key slots, credited names, roles,
order and citations. The current release emits `schema:character` and qualified `wdt:P725` voice credits, but no
separate actor-to-character credit property. That gap is visible; no actor control or substitute property is invented.
Choosing another work never copies credits. Existing native candidate decisions, adoption, disclosure and
source-or-consent behavior remain authoritative. Invalid input, stale metadata, denial and unavailability retain
drafts. Uncertain requests freeze the original body and key for retry; changing metadata or session state hides
the retained workspace until it can be read again.

## Browser flow: add-ons and expansions

The subject's existing **Contribute** menu offers **Add-on and expansion editor**. Creation uses
`/{locale}/catalogue/addon`, optionally retaining an exact base-game `work` query. An add-on's menu opens
`/{locale}/subjects/{id}/{slug}/addon`. Both private, noindex routes retain the native `wd:Q209163` identity and
released `game.addon` profile. A game work, distribution, file or language/platform combination is a different
object. Neither the editor nor a base-work link changes Library behavior.

Decision: a `work` query is preview context only; creation and correction require a separate exact readable subject
choice admitted by the current `game.addon` release, and only native results establish selected membership.

Creation configures the existing game initial-facts and terms controls with the active emitted profile. Only
explicitly added facts enter native subject POST. The exact work from a `work` query is shown as a suggestion and is
never staged automatically. A base-work picker resolves the chosen subject through the current public reader and
checks target admission against the current immutable release before staging `wdt:P8646`; an unavailable, concealed,
stale or unadmitted target leaves the existing draft editable. Contributors can revise or remove the unsent choice,
then add admitted qualifiers and grouped citations with the shared statement fields. This does not copy base credits,
languages, platforms, availability, progression or licence. Date precision, language strings, qualifiers and grouped
citations retain native schemas. Item-valued qualifier keys use the same native picker as game credits. Initial facts
are selected at creation; the exact returned UUID is reread before offering the reader and correction links.
Concealed or unavailable readback keeps that UUID and offers a read retry without another creation.

Correction shows the selected current base-work assertions separately from the route suggestion and gives `wdt:P8646`
its own filtered view of the existing relation editor. Values, qualifiers, rank, grouped evidence, exact-slot review,
acceptance and adoption use the ordinary native candidate lifecycle. The suggested work cannot choose a target,
replace a selected holder or imply adoption. A proposal or acceptance alone never establishes current selection; the
same add-on is reread after selection. Correction also reuses the multi-field workspace, classification controls,
authored and terms destinations, other relation fields and native candidate review. Platform claims use field-wide
classification review; credits retain emitted character-key slots. Unchanged values are excluded, each field reports
its own result, and no platform compatibility is inferred. Current denial, unavailability and metadata changes retain
drafts; uncertain writes retain their sealed body and key. Ordinary forms send citations as statement references,
never ingestion Source metadata. Existing BFF, native disclosure, rights and source-or-consent rules remain
authoritative; unavailable terms production stays unavailable.

## Browser flow: work parts

The Contents view links to `/{locale}/subjects/{id}/{slug}/work-parts`. This private, noindex editor reads one
bounded native part stream at a time, with its own opaque continuation, current count semantics and projection
freshness. Rows retain native stream order; neither a first page nor its array indices describes a complete
composition. Contents, volumes, episodes and tracks use only existing emitted canonical relations. A missing
relation profile or qualified assertion stays unavailable for editing.

The entry retains the current native Context and Realm address. Current relation contribution APIs admit Global
only, so another Context or a Realm shows the existing unsupported-context explanation without reading or writing
a substitute Global composition.

Inverse rows belong to the individual part, not the displayed parent. Corrections keep that exact holder,
property, target or external address, and optional native slot key. The existing relation editor supplies target
discovery, citations, native validation, exact-slot competition and explicit decision/selection controls. Only an
admitted `schema:position` on a relation declaring position order is editable; all other qualifiers remain intact.
An emitted relation without that qualifier remains readable without an invented order field. Choosing a new
containment target opens its separate slot and does not remove the original assertion.

Relation fields and qualifiers come from one exact descriptor for the authorized Subject Type, with its release
digest retained. Missing or incomplete descriptors stay unavailable and recover in place with drafts intact; stored
candidates keep their own immutable release pins. An uncertain proposal retries with its original command key and
payload, leaving current authorization and validation to the native command.

Each opened assertion retains an independent draft and native idempotency key. Proposing creates a candidate;
acceptance and selection are separate explicit actions. No atomic composition save, automatic adoption, identity
merge or work/edition/release conversion exists. Selection rereads the actual current stream; an incomplete or
uncaught-up result remains labelled. Denied or failed page reads conceal the previous page while retaining mounted
drafts for recovery. Ordinary forms send statement references, never ingestion Source metadata. These controls do
not infer rights or replace the existing disclosure and source-or-consent rules.

## Browser flow: game and visual-novel works

`/{locale}/catalogue/game` is the profile-guided entry in catalogue creation. Game, visual-novel, add-on and
software-release readers link to `/{locale}/subjects/{id}/{slug}/game`. The private, noindex journey retains the
actual native identity and Type. Work facts, creators, classifications and related works/releases follow effective
emitted metadata. Labels retain their actual fallback language. The current visual-novel work Type does not emit
`schema:gamePlatform`; its absence does not authorize adding that field. Released software and independently
referable add-ons remain separate subjects. Language/platform combinations never manufacture release subjects.

Creation composes the existing multilingual initial-terms form with optional native statement controls, target
picker, qualifiers and references. Only explicitly added facts enter ordinary `POST /v1/subjects`; native initial
facts are selected in Global. The exact returned UUID supplies the current reader, with read retry after concealment
or unavailability. Draft facts are retained independently for each selected Type. Uncertain delivery preserves the
exact augmented payload and key. Invalid current definitions refresh without discarding entered facts.

Corrections compose the common multi-field scalar editor, qualified relation editor and per-field submission
helpers. Classification claims use native item values in scalar competition slots; credits and work links retain
the native target and any declared slot key. Every selected statement keeps its qualifiers and evidence together.
Only changed facts become candidates; unchanged languages and other fields remain intact. Submission reports
independent results and exact candidate IDs awaiting review, separate from acceptance, adoption and the ordinary
current reader. Uncertain attempts retain their commands and keys. Metadata, denial, stale and unavailable states
remain visible. Missing controls confer no additional native capability.
Withdrawn scalar drafts in the shared generic and profile editors retain a bounded private assertion and original
label outside the disabled admitted fields; cancellable local removal preserves siblings, while commands and locked
results require exact recovery through matching definitions.
Game classification drafts keep their prior release definitions privately for read-only inspection while withdrawn;
fresh proposals and exact replays wait until current admission returns.

Names and descriptions link the existing terms adapter. Its generated native binding is integrated.
Native authority and deduplication remain Semantic-owned; this profile never substitutes `schema:name` proposals
for terms writes. Authored text
uses the existing document/licence editor. Ordinary forms do not submit ingestion Source metadata, infer rights,
copy provider prose or covers, publish profiles, or change Library progress.

## Browser flow: ordinary identifier evidence

Details and Sources share the existing **Contribute → Edit this subject → Identifier evidence** entry at
`/{locale}/subjects/{id}/{slug}/identifiers`. The private, noindex route resolves the canonical subject address.
It uses the ordinary session BFF, public subject read and current immutable definition release. Effective Type
properties, in emitted order, admit external identifiers, URLs (including `schema:sameAs`) and patterned string
codes. This is the definitions contract's code classification, not a universal provider inventory. ISBN remains
edition data; work and edition identities never change. Labels retain their actual fallback language.

The page scopes the existing multi-field fact workspace, scalar controls, native validators and citation/value
renderers. Each disclosed selected statement remains separate, with its original literal, qualifiers and grouped
references. Editing a selected assertion starts a replacement candidate; an additional value is explicit where
multivalued. No URL, scheme, identifier spelling or provider key is normalized or looked up globally. Names,
relations and original text retain their separate editors. Citations support a fact; they do not prove identity,
license an asset or supply ingestion Source metadata. Bootstrap receipts and imported claim tuples are untouched.

Changed included fields seal separate native candidate requests and keys. Partial success, denial, invalid values,
stale metadata, uncertainty and unavailability retain the existing per-field behavior. Session preparation hides
retained work until the current read is available again. A field no longer admitted by the refreshed Type disables
submission while retaining the draft and sealed key. No proposal changes the current reader or creates a subject.

Each confirmed result links to its exact property and candidate on this same route and opens the existing native
candidate reader in place, carrying native session continuity. An absent exact candidate remains absent on that
page; only the supplied opaque continuation can fetch another page. Review, acceptance, whole-slot adoption and
confirmed current reading remain distinct. The existing native API owns authority, disclosure, constraints and
source-or-consent fences; the page adds no permission or validation engine.

Web capture handoff: `pages-catalogue-ordinary-identifier-evidence-editor--` followed by `route-entry`,
`current-evidence`, `empty`, `loading`, `signed-out`, `denied`, `unavailable`, `stale-metadata`, `proposed`, `invalid`,
`uncertain-retry`, `partial-results`, `exact-candidate-continuation`, `accepted-awaiting-selection`, `selected`,
`pending-reading` or `reader-unavailable`. Use the same IDs with phone390/desktop1280, light/dark and locale globals.
Connected examples use synthetic native-shaped payloads through production adapters; the route story uses
`PageStory`. Existing native subject/candidate APIs are bound through the current BFF; execution of the plays,
normal Web captures and native integration acceptance remain pending. There is no new missing producer adapter.

## Narrative story arcs

The Contribute menu opens `/catalogue/story-arc`; an existing `wd:Q2620972` Subject also offers its
`/subjects/:id/:slug/story-arc` correction workspace. These entries preserve locale and Realm addresses.
The current generic producers support Global only, so a Realm address shows their unavailable-context state
without silently submitting to Global. A physical volume, release, season or pagination segment does not establish
an arc. The editor selects real native IDs and the current emitted Type and properties; it creates no schema,
mapping or inferred membership.

Initial creation reuses the ordinary multilingual terms form, its frozen retry key and actual created-Subject
reread. The form creates names first; existing names link to the terms editor. Later scalar and classification
facts reuse the shared multi-field/statement controls and candidate review, with independent partial results.
The workspace links to the actual Subject and its current context review. A created identity and a proposed fact
remain separate outcomes; a concealed or unavailable reader never becomes a fabricated success preview.

An explicitly selected existing parent work owns the forward `rezics:storyArc` relation. Its shared relationship
editor retains exact arc target slots, `schema:position`, `rezics:firstPart`, `rezics:lastPart` and grouped citations
as emitted. Creating an arc creates no parent statement. The arc's own series, part-of, predecessor and other
admitted relationships open the existing relationship workspace. Acceptance and adoption use current heads and
the actual reader; an unselected adoption stays pending. Other slots and their evidence remain intact. Ordinary
forms submit no ingestion Source metadata, and existing source-or-consent and disclosure decisions remain native.

## Ordinary multilingual correction

The selected operation is `PATCH /v1/subjects/{id}/terms`. Required headers are a strong quoted `If-Match`
containing the actual Subject revision, and the existing quoted `Idempotency-Key`. Its closed request is:

```ts
type TermsPatch = {
  labels?: Record<string, string | null>;
  descriptions?: Record<string, string | null>;
  aliases?: Record<string, string[] | null>;
};
type TermsResult = { subject: string; revision: number };
```

Omitted fields and languages remain unchanged. Null removes that language entry. An alias array replaces that
language's complete alias set. Native language, text, count and request byte limits apply; at least one valid
label must remain. Type, release semantics and derived Account-agent terms cannot be edited here. The native command is `correctTerms(pool, input)` in `services/kernel/src/semantic/terms.ts`; its
input binds the Subject, expected revision, patch, Actor, receipt key/digest, exact creation authorization,
ordinary no-effect authorization, current Subject read preparation, route key and deadline. Its validation exports are `TermsPatch`, `TermsResult`, `TermChange`, `patchTerms` and `termRevision` in
`services/kernel/src/semantic/terms.ts`. The mounted closed HTTP schemas are `TermsPatchSchema` and `TermsResultSchema` in
`semantic/http/subjects.ts`. Imports can bind the mounted PATCH and this small result directly. The native authorship
inputs are `revisionResource(subject, revision): Resource`, `REVISION_NS: string`, and
`initializeRevisionAuthorship(tx, {subject, revision}): Promise<void>` from `semantic/authorship.ts`.
The command must predeclare the exact revision resource through the existing creation manifest and parent
creation authorization, then initialize it after the real revision insert. A revision collision requires whole-command
authorization and manifest preparation again within the original deadline; replay initializes nothing.

The write must require the existing Global `statement:propose` grant together with current Subject eligibility,
Actor, Scope, visibility, redirect and fence checks before inspecting a receipt or producing an effect. Unknown
and concealed Subjects both return 404. A fresh stale revision returns 412; conflicting reuse of a key returns 422. A denied attempt has no effect. An authorized replay returns its original `{subject, revision}` without
another revision. Unchanged input uses native `noEffect` semantics and the actual current revision. It never
reports a fabricated change.

One native Subject-partition command must atomically append a never-reused revision, current terms, immutable
changed field/language identity and existing command bookkeeping. Its receipt stores only `TermsResult`, never
an old full Item. The response supplies ETag and Session; the browser then reads the actual current Subject.
Per-revision author-resource initialization must use the native authorship producer, and publication must call
the actual `recordSubjectPageTransition` hook. Neither direct Access SQL nor a second permission engine supplies
those obligations.

Ordinary overrides must retain exact original imported term Source support and current tuple/field fences.
They cannot detach provider evidence, turn a taken-down import into native text, or reconstruct withheld text.
The [Source attribution contract](../services/kernel/src/semantic/source-record-attribution-contract.md) owns
original `(subject, fact_revision)` support. Current Subject, labels, related, summary and Search readers must
use bounded authoritative term heads, without scanning the Subject's complete history or adding a stale name
cache. Existing personal-payload locators and minimizers must cover every new persisted payload and receipt/event
role while preserving communal identity, the nonpersonal change skeleton, account time T and legal holds.

`correctTerms` now composes the actual native authorship and publication producers. Each changed
field/language switches an indexed `semantic.term_head` pointer to a fresh immutable fact slot. Text stays
in `semantic.fact`, using its existing Source-role capture and minimization; the head stores only technical
coordinates. A head retains its original support transaction even across deletion and replacement. The
`current_term_fact` view supplies current Subject, labels, related, summary, Search and publication reads.
The native revision stores only changed fields/languages and original revision support locators. Source-fenced
current terms or addressed deleted heads conceal the write, including receipt replay; they are never recovered
from stored payload. Empty alias arrays and null both remove that language's alias set. No-op commands use
ordinary Global proposal authorization without declaring a resource that will not be created. Actual writes
retain the exact revision creation manifest and initializer finalization.

Kernel typing is the delivery check for this stage. The preserved real API acceptance remains later proof;
local Source enrollment does not certify shared-history coverage or account-erasure completion.

## Individual revision explanation

`GET /v1/subjects/{id}/revisions/{revision}` is implemented by `readRevisionDetail` in
`services/kernel/src/semantic/revision-detail.ts`; its closed HTTP schema is `RevisionDetailSchema` in
`services/kernel/src/semantic/http/subjects.ts`. The existing revisions list remains unchanged. The response is:

```ts
type Selection = { candidate: string; rank: 'normal' | 'preferred' };
type Reading = {
  decision: { head: number; verdict: 'accept' | 'reject' | 'abstain'; revision: number } | null;
  selected: boolean;
  rank: 'normal' | 'preferred' | 'deprecated' | null;
};
type RevisionDetail = {
  subject: string;
  revision: { revision: number; kind: string; release: string };
  change:
    | { kind: 'record' }
    | { kind: 'terms'; fields: { field: 'labels' | 'descriptions' | 'aliases'; languages: string[] }[] }
    | { kind: 'candidate'; candidate: string; property: string; context: string; reading: Reading }
    | {
        kind: 'decision';
        candidate: string;
        property: string;
        context: string;
        head: number;
        verdict: 'accept' | 'reject' | 'abstain';
        reading: Reading;
      }
    | {
        kind: 'adoption';
        property: string;
        context: string;
        head: number;
        mode: 'inherit' | 'replace' | 'suppress';
        selection: Selection[];
      };
};
```

UUID fields are `subject`, `candidate` and `context`. Revision and head numbers are positive integers; adoption
selection retains its native 32-entry bound. `record` is the minimal nonpersonal skeleton when existing revision
metadata has no single corresponding editorial record. No actor, token, write basis, payload, historical snapshot
or textual diff is returned. Actual immutable term revisions supply the tag
`{kind: 'terms', fields: TermChange[]}`, where `TermChange` is
`{field: 'labels' | 'descriptions' | 'aliases', languages: string[]}`. It is served from the native revision, after checking its original Source support.

The read applies current Subject, Context, candidate, related-target and exact Source-tuple disclosure, including
terminal erasure. Unknown and currently concealed records return 404. Original and redirected related targets
must independently remain visible and authorized; preparation releases each checkout before foreign authority.
The final read checks current disclosure again. Responses use `Cache-Control: no-cache` and the existing Session.
`reading` uses actual current decision and selected slot rank in the record's Context (Global for proposals).
An adoption's selection describes that recorded adoption only. Revision order never proves current adoption.

The existing revision, candidate, decision and adoption stores remain authoritative. Three Subject/revision
indexes locate the relevant record without enumerating history; candidate hydration and current selection retain
the native selection bounds. No second history or personal-payload store is introduced. The generated client now
binds this read in the existing Changes browser and selected-value explanation, through their private/no-store
session BFF. Runtime validation rejects mismatched identities, unknown tags, extra fields, nonpositive heads and
selection beyond 32. Candidate and decision readings describe the current native Context; adoption mode and selection
describe only the recorded adoption. The terms tag now uses the same mounted native detail response. The browser
keeps each field with its own language list and uses translated field labels and language names. Its closed parser
retains the native three-field bound; Changes and Why this value share the adapter and explanation. A terms change
cannot be presented as the origin of a selected scalar statement.
Own-contribution withdrawal and restore
now bind the generated candidate `delete` and `$restoreDeleted.post` methods. Their closed
`{subject, candidate, deleted}` result must match both requested UUIDs and the requested deletion state before
success and a current read. Current availability comes only from that read; an absent bounded candidate row proves
neither deletion nor ownership, grants or a restore deadline. Native outcome checks and promotion to main remain
separate; type checking alone does not prove those outcomes.

Web owns the normal next visual review using the unchanged `pages-catalogue-changes--` IDs: `revisions`,
`continue-and-explain`, `proposal`, `limited-safe-detail`, `loading`, `empty`, `denied`, `invalid`, `conflict`,
`concealed`, `unavailable-retry`, `detail-retry` and `detail-loading`. The unchanged
`pages-catalogue-why-this-value--` stories retain their existing outcomes and plays. Root samples direction;
there is no capture restart.

## Browser flow: manga series and volumes

`/{locale}/catalogue/manga`, linked from catalogue creation, offers the released `schema:ComicSeries` and
`schema:PublicationVolume` profiles. Their existing subject headers and compact frames include the editor in the
Contribute menu, linking to `/{locale}/subjects/{id}/{slug}/manga` through the shared destination descriptor.
The editor groups current membership, creators, publication, identifiers,
classifications and original writing using effective emitted properties. Definition labels retain their actual
fallback language. Initial term languages remain independent of the interface language.

A volume requires an independently identifiable published object and the exact readable manga series selected
through the common target picker. `wdt:P179` carries this relationship; an explicitly entered `schema:position`
qualifier supplies its ordinal. Row order does not. A series receives neither volume pagination nor ISBN fields.
The emitted series part count uses its explicit volume or chapter unit; no latest, maximum, sum or progress is
inferred. Editions remain separate: the current edition producer does not admit these manga Types as work targets,
so this editor offers no invented edition action. It never derives a subject ID from names or ordinals.

Creation reuses native `POST /v1/subjects`, the session BFF and its idempotency contract. Only entered initial
facts are submitted; the confirmed creation selects those facts in Global. The exact returned ID supplies the
ordinary current reader. A failed read retains that ID and retries only the read. Uncertain delivery freezes the
payload and key; conflict requires explicit draft review. Invalid values refresh the active release while keeping
the draft, and a removed or changed field is rejected rather than silently dropped.

Corrections reuse the common per-field draft, partial-result and candidate-review controls. Unchanged scalar
fields are omitted, qualifiers and citations survive replacement, and each uncertain field keeps its own key.
Membership and creator changes use the integrated relation editor's actual qualified slots and target discovery.
Original abstracts use the shared authored-text, explicit language and licence controls. Names and descriptions
link to the existing terms adapter and its native conditional PATCH; `schema:name` proposals do not substitute
for term-map writes. Its current denied, unavailable and conflict outcomes remain authoritative. Classification
corrections reuse the shared item-value control already used for Character: an admitted Concept through the
existing picker, ordinary citations, per-field candidates and explicit decision/selection. Decision: Manga,
Album and Screen bind that control; Game keeps its existing specialized classification workspace. A later
proposal awaits review and does not alter the current reading. Existing disclosure and source-or-consent rules
remain native.
Decision: Album and Manga keep that Character classification writer mounted across reading loss and when every
admitted classification field is withdrawn, hiding stale public and private controls while retaining drafts,
citations and exact sealed retry identity. Compatible drafts resume under a newly admitted reading; withdrawn
assertions stay inspect-only and admit no new writes. Explicit discard and departure, or viewer/CSRF
replacement, retire the holder. Keyboard recovery orients to the classification summary. A hidden reading does
not construct a review session; resumed review uses the newly admitted reading. Creation and
selected-reader recovery remain independent. Semantic retains Concept suggestion, proposal, review, selection
and command authority; Web binds the existing generated candidate methods and does not invent an endpoint.

The real-route story IDs are:

- `pages-catalogue-manga-series-and-volume-editor--create-series`
- `pages-catalogue-manga-series-and-volume-editor--create-volume`
- `pages-catalogue-manga-series-and-volume-editor--correct-series`
- `pages-catalogue-manga-series-and-volume-editor--correct-volume`
- `pages-catalogue-manga-series-and-volume-editor--uncertain`
- `pages-catalogue-manga-series-and-volume-editor--denied`
- `pages-catalogue-manga-series-and-volume-editor--invalid`
- `pages-catalogue-manga-series-and-volume-editor--conflict`
- `pages-catalogue-manga-series-and-volume-editor--stale-correction`
- `pages-catalogue-manga-series-and-volume-editor--reader-unavailable`
- `pages-catalogue-manga-series-and-volume-editor--reader-concealed`
- `pages-catalogue-manga-series-and-volume-editor--saving`
- `pages-catalogue-manga-series-and-volume-editor--loading`
- `pages-catalogue-manga-series-and-volume-editor--unavailable`
- `pages-catalogue-manga-series-and-volume-editor--empty`
- `pages-catalogue-manga-series-and-volume-editor--signed-out`

Use the locale, theme and phone390/desktop1280 viewport globals. They are declared request examples; native
acceptance and normal Web captures remain separate verification.

## Browser flow: book and book-series works

The existing create entry and the Book or BookSeries subject’s Contribute menu offer **Book and book-series work editor**.
`/{locale}/catalogue/literary` reuses the common initial-terms form; the work reader offers
`/{locale}/subjects/{id}/{slug}/literary`. These pages consume effective emitted `schema:Book` and
`schema:BookSeries` properties, constraints, units and relation metadata. Labels and descriptions keep their actual
metadata language and the existing fallback. They do not publish definitions or change a subject's Type.

Creation sends only entered multilingual terms and explicitly added initial scalar facts through ordinary
`POST /v1/subjects`. Each fact reuses the shared value, qualifier and grouped-reference controls, with a URL-first
citation part for the existing quick-entry path. Additional parts stay in their chosen reference group and order;
their datatypes, units and available qualifiers come from the exact admitted release. Untouched citation scaffolds
are omitted, while typed zero and false values remain. No number, language, classification or relation is inferred
from another field. Decision: Literary initial entry remains scalar-only; relation qualifiers stay in the existing
post-creation relation editor. The form retains independent drafts across Type choices. Native rejection refreshes
metadata while retaining the draft; uncertain delivery retains the exact command and key. The returned subject ID
is reread before offering its canonical current-reader link. A created identity with an unavailable reader is
shown as created, with a separate read retry.

Initial Literary metadata retry admits one read, retains its recovery action while pending, and moves focus to the creation heading only for still-current keyboard intent; failure retains the action and moved focus, pointer initiation or caller, locale or session retirement stays silent.

The current work groups identity/original names, bibliography/declared quantities, creator/series/classification
relations and admitted original text. Bibliography reuses the multi-field editor and its independent results and
keys; relations reuse the native target picker and qualified-slot editor; original text reuses authored fields,
per-document language, licence and evidence. Opening a relation or authored section starts its bounded read and
keeps its editor mounted when collapsed. Corrections create candidates for exact native review, not immediate
publication. The names link uses the existing native terms adapter and its actual result; an unavailable write remains
unavailable, and no `schema:name` proposal substitutes for a title-map edit.

ISBN and page counts remain edition facts. Book word count uses the released exact unitless quantity, without
page conversion, text-coverage inference or trusted whole-work evidence. BookSeries part count uses only its
released volume/chapter units; membership is contributed on each member, without deriving totals. Unsupported
conveniences are omitted, including a BookSeries author field when only contributor/publisher are emitted.
Initial authored text and relations are entered after creation through the existing integrated editors. These
ordinary forms submit no ingestion Source envelope and infer no prose, cover or rights permission.

## Browser flow: person and organization catalogue profiles

`/{locale}/catalogue/people` guides creation of the released `schema:Person` and `schema:Organization` catalogue
identities. The existing Contribute menu in subject headers and compact frames links their identity under Edit to
`/{locale}/subjects/{id}/{slug}/people`; work credit actions pass the exact work ID as `?work=` under Create. These
entries share the standalone profile entry's destination and the menu's existing signed-out return flow. Duplicate discovery
uses the existing global search. The work remains separate: after creating or finding the person or organization,
the work's native relation editor selects that identity and contributes its cited role and qualifiers. Creation
does not manufacture a credit or creator ownership.

The profile reads the actual active immutable definitions and current subject in parallel. Effective properties
and datatypes determine support. Initial multilingual terms reuse generic creation; optional initial scalar facts
reuse its native value controls and validation. Only explicitly entered facts enter `POST /v1/subjects` and are
selected at creation. The returned ID is read through the ordinary reader. An uncertain request freezes both
terms and facts with the original key; confirmed creation with an unavailable reader retains its ID and retries
only that read. Drafts survive Type switches and stale-metadata rejection, including fields no longer admitted.
An explicit retry keeps Retry focusable with `aria-disabled` while pending, then returns focus to Retry on failure
or moves it to the profile/form heading on success.

Corrections reuse the integrated multi-field editor's selected values, qualifiers, references, independent keys,
partial results and exact-candidate review. Submission proposes an alternative; acceptance and selection remain
separate. Unchanged fields and all other term languages remain intact. The profile links the existing terms adapter
for the mounted native terms command; unavailable responses remain unavailable in this journey.
For correction reload, keyboard intent keeps a surviving focused opener; otherwise current success focuses the
profile heading and current failure focuses Retry. Focus movement, pointer use and route, locale, session, reader or
workspace retirement cancel that handoff.
`schema:name` proposals never replace term-map editing. Account-agent derived names, software-agent creation,
eligibility, personal disclosure and `sourceOrConsent` stay with their existing native authorities. Ordinary forms
never send ingestion Source metadata or infer private relationships.

The present person and organization releases admit no authored biography field, so this profile supplies no
biography or licence controls. Released media fields are identified as requiring their dedicated editor; this
flow supplies no cover import or inferred rights. Future authored fields must use the existing authored composer.
Metadata text retains its actual fallback language, independently of the entered facts' languages.

The Storybook page is **Pages/Catalogue/Person and organization catalogue editor**, with base ID
`pages-catalogue-person-and-organization-catalogue-editor`. Its `create-route`, `person-route` and
`organization-route` stories enter the real router; `create`, `person`, `organization`, `correct-cited-fact`,
`loading`, `person-loading`, `organization-loading`, `empty`, `signed-out`, `denied`, `invalid`, `stale-metadata`,
`unavailable`, `uncertain-submit`, `created-readback-unavailable` and `created-readback-concealed` expose the
connected states. Current-profile loading is Character/add-on `current-loading`, Screen `correction-loading`, and
People `person-loading`/`organization-loading`. Locale, viewport and theme use globals. Connected relationship
writes are deliberately unavailable in the preview; real routes bind the existing session relation editor. These
fixtures do not establish native execution or visual acceptance; Web owns normal phone390/desktop1280, light/dark
captures.

## Browser flow: released album catalogue editor

The existing catalogue creation row offers **Create album** at `/{locale}/catalogue/album`. An admitted album's
current reader and compact work frame offer **Edit album profile** through the existing Contribute menu at
`/{locale}/subjects/{id}/{slug}/album`, only when the current native Context is Global and no Realm is selected.
The shared destination descriptor also preserves the menu's exact signed-out return address.
These private, noindex pages retain the exact native subject ID and `schema:MusicAlbum` Type. Canonical slug
corrections keep that identity; a different resolved ID is not silently edited. Realm/context addresses do not
fall through to a Global write.

This is a profile for the already emitted creative-work Type, not a recording, release or personal copy. Controls
come from the effective active definitions release: no publication date is invented or required by the profile.
Native dates and scalar details, artist/part relations, classifications and authored text have distinct groups.
Definitions retain their actual metadata language and fallback attribution. Existing names, descriptions and
aliases show their own languages and link to the terms adapter described above. `schema:name` proposals do not
patch the title maps. The terms editor binds the mounted native writer and reports its actual availability.

Creation reuses native subject input validation and the existing session BFF's `POST /v1/subjects`. It sends only
explicitly entered terms and added assertions, qualifiers and citations; it sends no ingestion Source metadata.
There are no default artist, date, role, part or classification assertions. Actual target search, scalar controls
and qualified relation controls are shared with the existing editors. Artist credits use `schema:contributor`
with admitted person/organization targets. Its emitted qualifiers supply credited-as text, a role concept,
position and an applies-to-part target. Positions follow the native string constraint; applies-to-part currently
accepts a story arc, not an invented track. `wdt:P361` part-of-work has no order qualifier. Series membership uses
its separate native relation and position. No track, recording, audio store, streaming service or lyric controls
are supplied. The initial classification picker is native; correction reuses the shared item-value control for
admitted classification fields, with independent drafts and the ordinary candidate review.
Album classification correction keeps that private holder mounted while a current reading is missing or every
admitted classification field is withdrawn, then recovers compatible drafts and citations under the newly
admitted reading. Withdrawn assertions remain visible for reconciliation; sealed unknown commands keep their
original sender, credentials, key and operands. A hidden reading does not construct a review session.
Creation readback and this correction holder stay independent.

Correction reuses the scalar multi-field staging and per-field partial results, exact candidate review, qualified
relation editor and original authored-text composer. Unchanged language maps, qualifiers and references remain
intact. Blank values do not imply clearing. An original summary is a separate authored document with an explicit
language and licence. Successful proposals remain awaiting review; neither a proposal nor an aggregate submit
claims publication. Exact returned subject/candidate IDs lead to the actual native reader or review. Failed
creation readback retains the created ID and retries the read rather than creating again.

Invalid, denied and conflicting creation results retain the draft and submitted command for comparison, with an
explicit choice to review a new attempt. Uncertain delivery freezes the exact payload/key for retry. Stale metadata
cannot prevent native receipt replay: retries use the same native POST without a new definitions preflight. Metadata
is reloaded without discarding entered rows; withdrawn fields remain visible for deliberate removal. Correction
reload failures retain staged scalar and relation drafts, and disable further edits until a successful reload.
Withdrawn scalar commands retain a read-only private assertion and exact per-holder retry through the existing native writer; refusal preserves the sealed intent, and only deliberate current recovery moves focus to its result.
Only emitted support is offered; unknown rights remain unknown and no provider prose, covers or permissions are
inferred.

The focused payload regressions live in `apps/web/tests/catalogue-album-profile.test.ts`. Connected story examples
live in **Pages/Catalogue/Released album catalogue editor**, under the ID prefix
`pages-catalogue-released-album-catalogue-editor--`. The state IDs are `ready`, `loading`, `empty`, `signed-out`,
`unavailable`, `concealed`, `correction`, `denied`, `invalid`, `conflict`, `stale-metadata`, `reader-unavailable`,
`created`, `retry`, `proposed` and `credit-correction`. They exercise existing generated request helpers against
explicit fictional examples, using the recorded emitted definitions and genuinely empty `sourceRecords: []`.
They are not native integration or visual evidence. Locale, phone390/desktop1280 viewport and light/dark theme
use globals. The shared terms writer is bound through the existing editor. Native integration and visual
acceptance remain separate; Web owns normal captures.

## Browser flow: film, television and episode profiles

`/{locale}/catalogue/screen` is the released film/series/season/episode creation journey, linked from ordinary
catalogue creation. Existing work headers and compact view frames offer the profile in their Contribute menu at
`/{locale}/subjects/{id}/{slug}/screen` for corrections. The private, noindex routes use the existing shell,
session BFF and current canonical subject reader.
Complete Screen creation, recovery and long review examples render that shell with the
production editor; independent field examples stay supplementary.
The entry follows the existing contribution menu's Realm restrictions.

The active emitted release decides the four available Types and their effective properties, labels, targets,
qualifiers and units. The editor groups dates, quantities, creators/cast, parts, classifications and text. Metadata
uses the interface locale's normal fallback with its actual language; subject term languages remain independent.
Duration uses the released seconds unit where offered, date precision is explicit, and episode position is text,
including specials and fractional ordinals. No season-number property or parent-season relation is invented.
An independently identified publication belongs in the existing AnimeRelease/publication editor. Language,
format, files and viewing progress never manufacture an edition or transfer a work's credits to it.

Creation uses the common profile and multilingual initial-terms form. Only explicitly added rows enter the native
`POST /v1/subjects` body; blank added rows are invalid until changed or explicitly removed. Subject targets use
the existing picker, with released target admission. Each row reuses the shared value, qualifier and grouped-reference
controls, with a URL-first part and explicit Add part/Add reference actions. Qualifiers, reference part datatypes,
units and multiplicity follow the exact admitted release; populated references preserve group boundaries, order and
stable holder identity. Untouched citation scaffolds are omitted without losing typed zero or false values. Optional
qualifiers and citations retain their native shape.
Initial creation facts are selected in Global. Confirmation retains the exact returned subject ID, and only an
ordinary read of that ID supplies its reader address. Failed readback offers a read retry without another creation.
Uncertain delivery freezes the full terms/facts command and key; definite refusals retain the draft, stale metadata
refreshes without discarding it, and key conflicts require explicit review before a new confirmation.
The native API validates the submitted command. An uncertain retry reaches that same native idempotency path
without replacing its payload or key after a metadata change.

Initial Screen metadata retry replaces the failure with a pending status, keeps one read in flight, and preserves the Retry action on another failure; successful keyboard recovery orients to the creation heading only while focus intent survives movement, pointer use and caller retirement.

Corrections compose the common multi-field editor and qualified relation editor. Unchanged fields and unedited
languages, qualifiers and references survive; each changed scalar field has its own result and retry key. A
submitted proposal is still awaiting review and selection, and review follows the exact returned candidate ID.
Creators, cast roles and part relations keep their emitted slot semantics. Existing original-text/licence and
multilingual-terms editors remain distinct companions; a `schema:name` candidate cannot replace the term map.
The terms entry uses the shared native writer and reports its actual availability, refusal and conflict outcomes.
Ordinary forms send no ingestion Source metadata and confer no prose, cover or other reuse rights.

Original long descriptions are contributed through the existing authored-document editor after creation.
Classification facts may be entered at creation when emitted. Correction reuses the shared item-value
classification control for those emitted fields, with independent drafts and explicit candidate
decision/selection. No substitute writer or Concept seed is supplied.

## Browser flow: definition guide

Decision: the active guide opens on the first bounded page and provides separate localized label-prefix and
exact-Type-ID inputs; next-page navigation follows the current prefix cursor. Active browsing uses the released
Type directory and exact selected-Type descriptors. An explicit release digest continues to mean its immutable
historical release.
Decision: missing qualifier definitions on an exact Type descriptor are completed from that descriptor's
release digest through the existing immutable release reader; admitted fields stay the descriptor's list, and
a missing pin stays unread rather than becoming the active bundle.
Decision: a pinned field opened from a validated editor return offers Compare current definition. That view
resolves the original exact digest and the active pointer's exact digest independently, shows native
differences side by side, and never substitutes the current release for an unavailable pin. Label differences
are not definition changes. Comparison does not require the return URL, but the Compare control does.
Decision: comparison reads stay bounded to the active pointer and the two exact releases; Type directory
search is not used. Opening, switching and closing comparison keeps the original editor return, including
its field and statement.
