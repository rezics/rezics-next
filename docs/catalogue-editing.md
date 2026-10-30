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

The session BFF preserves identity, CSRF, concurrency, idempotency and native session headers. Uncertain delivery
freezes the payload, ETag and key for retry. Stale revisions or conflicting keys require reload, comparison and an
explicit new confirmation. A successful write is followed by a native read of the same returned ID; only that read
supplies current terms and the canonical reader address. Failed or concealed rereads never publish a local preview.

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

Creation configures the existing game initial-facts and terms controls with the active emitted profile.
Only explicitly added facts enter native subject POST. **Use this base work** adds the emitted `wdt:P8646` assertion
only after the contributor chooses it; it never copies base credits, languages, platforms or progress. Targets use
the existing picker and exact native IDs. Date precision, language strings, qualifiers and grouped citations retain
native schemas. Item-valued qualifier keys use the same native picker as game credits; later corrections use the
existing relation editor. Initial facts are selected at creation; the exact returned UUID is reread before offering
the reader and correction links.
Concealed or unavailable readback keeps that UUID and offers a read retry without another creation.

Correction reuses the multi-field workspace, classification controls, authored and terms destinations, exact-slot
relation editor and native candidate review. Platform claims use field-wide classification review; credits retain
emitted character-key slots. Unchanged values are excluded, each field reports its own result, and a proposal or
acceptance alone never establishes current selection. No platform compatibility is inferred. Current denial,
unavailability and metadata changes retain drafts; uncertain writes retain their sealed body and key. Ordinary
forms send citations as statement references, never ingestion Source metadata. Existing BFF, native disclosure,
rights and source-or-consent rules remain authoritative; unavailable terms production stays unavailable.

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

Names and descriptions link the existing terms adapter. Its pending native producer, binding and deduplication
remain Semantic-owned; this profile never substitutes `schema:name` proposals for terms writes. Authored text
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

# Catalogue editing

The adopted [catalogue editorial journey](research/catalogue-editorial-journey-design.md) connects a correction
to the current Subject reader and explains an individual change without inventing a historical Item. Imports
owns browser binding. Semantic owns these native contracts. Subject creation, proposal, acceptance and adoption
keep their existing APIs and authority. A selected scalar `schema:name` statement is independent of labels.

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
describe only the recorded adoption. The terms tag now uses the same mounted native detail response.
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
for term-map writes. Its current denied, unavailable and conflict outcomes remain authoritative. Current
classifications are visible; the shared relation editor currently excludes classification proposals, so no successful
classification mutation is implied. A later proposal awaits
review and does not alter the current reading. Existing disclosure and source-or-consent rules remain native.

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
