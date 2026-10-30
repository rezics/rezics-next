# Subject pages

A subject page is the hub for one subject: a work, edition, episode, character, person, organization, concept,
recipe or any other admitted type. This document is the single authority for what a subject page shows and how its
views are organised. Mechanisms live with their owners: covers in [Cover](../packages/ui/README.md#cover) and
[content covers](../services/kernel/src/content/README.md#covers), relations in
[semantic relations](../services/kernel/src/semantic/README.md#relations), ratings in
[ratings](../services/kernel/src/rating/README.md), templates in
[composition](../packages/composition/README.md#subject-views).

This page spans those modules because a reader experiences one page; splitting its rules across owners would let
each owner ship a correct part and the page still fail.

## Create a catalogue subject

`/{locale}/catalogue/new` is the generic initial-terms form, discoverable in the ordinary subject header's
content action slot. It offers the existing header search and search page first; opening a matching subject keeps
that existing identity. Creation never merges identities or assigns a client-generated subject ID.

The form reads the active immutable definition release through the shared release helpers. Its Type choices and
localized help come from emitted metadata and the existing language fallback. Work, edition and release remain
different objects. The data-language tags on names, descriptions and aliases are independent of the interface
language. One name is required per entered language; descriptions and newline-separated aliases are optional.
This route creates initial terms only, with no manufactured statement, citation, custom Type publication, Type
migration or post-create term-update API. Later field contributions use their separate editor.

Submission uses the generated `POST /v1/subjects` ItemInputSchema body and the existing session BFF, CSRF check
and native idempotency key. A confirmed response means **created**, not a pending proposal: initial facts are
virtually accepted and adopted in Global. The same native client reads the exact returned ID without bearer
fallback, carrying the native write session token into that ordinary read. A successful read supplies its canonical
localized subject address; a failed or concealed read never becomes a fabricated page or a different identity.

Definitions loading, no available Types, signed-out, denied, invalid, conflict, unavailable and saving have explicit
states. Errors link to controls. Server value rejection refreshes the active release while retaining the draft.
An uncertain submit freezes the exact draft and idempotency key for retry; concurrent clicks issue one command.
A key conflict requires explicit review before a new request. A confirmed creation with an unavailable reader
keeps its exact ID and offers an ordinary read retry without creating again. This private, uncached form is noindex.

## Correct names and descriptions

The subject header and compact view frame link to `/{locale}/subjects/{id}/{slug}/terms`. This private companion
editor follows the [multilingual terms browser flow](catalogue-editing.md#browser-flow-multilingual-subject-terms),
keeping the exact native subject, explicit per-language changes and recoverable drafts through conflicts.

## Add an edition or release

The work's Editions view and a work header that supports Editions offer
`/{locale}/catalogue/publication?work={id}`. The editor requires the exact readable existing work; missing or hidden
work is concealed, and a merged identity is not silently substituted. Discovery opens the existing search page
before creation. A separate confirmation identifies an independent publication: a file, language/format combination,
personal Library Copy or distribution event alone does not establish this grain.

Only emitted profiles and effective fields are offered: Book editions use `bf:Instance`, video works use
`rezics:AnimeRelease`, and software/game works use `wd:Q20631656` where the released work target permits it.
`schema:exampleOfWork` identifies the work; the released AnimeRelease `bf:hasPart` means an included work instead.
These are separate native relations, not an invented anthology Type. Definition labels follow the interface locale;
the entered name's data language is independent. Optional ISBN, identifier, date, publisher, language and page facts
use their released schema. ISBN text is retained without guessed normalization, date precision and quantity units
are explicit, and publisher selection uses existing discovery summaries and real subject IDs. An entered citation
supports the work link and entered facts. Work credits, word count and progress are never copied.

The form uses the same generated `POST /v1/subjects`, session BFF and CSRF path as generic creation. Native creation
selects initial facts in Global; it is not a proposal-only result. Success reads the exact returned UUID through the
ordinary current reader and opens its canonical address. A concealed or unavailable reader offers only a read retry.
Definite refusal preserves the draft and key until an explicit edit; uncertain delivery freezes the original command
for exact retry. A conflict requires explicit review before a new request. Rejected values refresh current definitions
without discarding the draft. The private editor is noindex and does not infer ownership or media permissions.

## Provider queue decisions

`/{locale}/imports/review` uses the provider queue's current prepared rows. Its selection toolbar acts on at most
20 explicitly checked visible suggestions, scoped to the current source, Context and review status. Changing that
scope clears the selection and any unsubmitted confirmation. Other pages, history and provider-wide selection are
excluded. Queue presence and source provenance never grant decision authority.

Confirmation seals each subject/candidate identity, decision head and independent action key. The session BFF
forwards the current viewer, CSRF protection and native session tokens to each existing candidate accept/reject
endpoint. Accepting is separate from adoption and publication; rejecting does not delete a candidate. Bulk adoption
is unavailable. Every success, stale head, current denial, concealed suggestion, rate limit and unavailable result
is shown separately. Failed and uncertain attempts retain their exact payload and key; retries skip confirmed
successes. An uncertain result stays sealed until resolved. A changed scope clears checkboxes while preserving
the earlier attempt; it must be revisited before retrying under a different visible scope.

After decisions, refresh the actual queue and current subject readings in parallel. Refresh failure retains the
decision results rather than claiming all rows disappeared. Missing and hidden subjects share a concealed state;
related values use supplied summaries, with no per-field fetches or private totals. An unserved queue preparation
port shows unavailable, never a fabricated empty queue or a successful mutation. Definition labels retain their
locale fallback and remain distinct from a value's data language.

## Canonical public reading

`/{locale}/catalogue/definitions` is the read-only Type and field guide linked from catalogue creation and
native scalar/relation contribution forms. It reads the actual active pointer and immutable release through
the generated client and shared release helper, or exactly the requested `release` digest for a pinned
assertion; it never substitutes the active bundle for a missing pin. Released labels and descriptions use
explicit language fallback, independently of authored value languages. Only effective emitted fields,
datatypes, qualifiers, units, multiplicity, targets and native reference or `sourceOrConsent` rules are
explained. Missing meaning, empty metadata, loading, invalid addresses, concealed definitions and unavailable
reads remain distinct. Help opens in a separate tab to retain the original draft and uncertain request; Return
to contribution permits only the existing localized creation or canonical subject editor address, including
its selected field and statement. Current authority, validation and writes remain with those editors and their
private session BFF; the guide has no mutation or publication controls.

Adopt the complete reader journey recommended by [subject design research](research/web-subject-design.md):
discovery or a collection → current canonical identity → public facts and text → traversable relations, editions
and credits → original evidence and current rights. Work, edition and agent identities remain separate until their
native identity authority says otherwise. Presentation follows released definitions rather than a vertical-specific
store. The research's Wikibase statement model, Open Library work/edition/author navigation, Schema.org role
annotation and Omeka resource templates support these choices; they do not supply a REZICS API or permission.
Research observations describe their inspected revision, so delivered native fixes take precedence.

### Original authored catalogue text

`/{locale}/subjects/{id}/{slug}/authored` opens from the existing subject header actions. It retains the exact
canonical subject identity and offers only document-valued fields admitted by the active emitted Type metadata.
The private, noindex composer prepares the current session before its CSRF-protected server actions run. Field
labels follow the existing locale fallback; the authored text's BCP 47 language is a separate explicit input.
An unavailable or concealed read never supplies a cached document or a privileged public fallback.

The shared rich-text editor starts with an empty Text-profile document for a **new replacement candidate**. It
never preloads, flattens or edits the current document. Existing candidates and all their formatting remain intact.
The contributor declares authorship, enters an SPDX licence or LicenseRef and supplies the supporting citation URL
required by the native statement contract. A citation supports the field; it does not license copied text. Provider
names never determine a licence. Withheld text, user posts and recipe-site methods are not authoring inputs.

Submission uses the existing generated `POST /v1/subjects/{id}/candidates` statement input with inline
`value.content: {document, licence, language}`. The public `@rezics/document` snapshot and native validation govern
shape, language, licence and the 2 MiB canonical byte limit; authored media nodes are refused. There is no new body,
upload or Source-metadata writer. A returned candidate means proposed and awaiting review, never published.
Draft, validation, saving, denied, conflict and unavailable outcomes remain distinct. An uncertain retry freezes the
exact document, statement and idempotency key. A key conflict requires explicit draft review before a new request.
Refreshing definitions or public reading retains the draft.

Review opens the existing candidate comparison for the exact returned candidate and field. Its actual statement's
document locator is read through `GET /v1/documents/{id}` with the viewer identity and native session position.
Candidate, subject, language and digest must match before the body renders. Missing, hidden or erased documents
share the neutral unavailable notice. Candidate pagination stays explicit; an absent candidate on a page supplies no
invented body. Acceptance and selection keep their independent native heads and confirmation controls.

The current public text is read independently without the editor's bearer, using the selected rank and existing
language fallback. Its body also comes from the ordinary document endpoint, with current Content disclosure and
rights. Current citations render separately from the work's actual document licence. After a decision the composer
reloads that public statement and body; a receipt or the editor draft never becomes public truth. The overview link
continues to the actual canonical public reader. Story states live under `Pages/Catalogue/Authored text` and use the
shared locale, theme and viewport globals.

### Identity and navigation

The [native subject reader](../services/kernel/src/semantic/http/subjects.ts) owns merges, disclosure and the
applicable release; [Accounts](accounts.md#handles) owns case normalization, verified-agent eligibility and former
claim lifetime. The localized subject slug is a label, never an identity. The shared
[URL helpers](../apps/web/src/subject/subject-href.ts) append a supported view to either a subject or an account
address, preserving query bytes and fragments without double encoding. An id-only, stale-slug or merged subject
address redirects 301 to its current canonical address. A native subject read may follow at most one merge 308;
a further merge response is unavailable, not a successful stale subject. The native page endpoint's account 308
is translated to the same website 301, including verification that changes between canonical and page reads.
The existing exported native redirect adapter retains its 308 shape for compatibility.

A verified account with a current handle has one page at `/@handle`, with every supported view retained. A
handleless account supplies no invented `@` address: keep its readable subject identity. Account case correction
uses 308; a current native `movedTo` uses 302 to the current handle, without alias walks. Web does not reproduce
the forwarding clock, active-state rule or claim syntax. All former-handle, redirect, missing and private outcomes
are `private, no-store`; mutable aliases must never receive five-minute caching. Successful public subject HTML
retains the existing [bounded public cache](../apps/web/README.md#routing).

A closed view redirects temporarily to the overview. A list whose preview contains everything can omit its tab
while retaining its direct view URL. A slug that equals a view name still identifies the canonical overview when
it matches the current localized slug; otherwise that id/view shorthand redirects to the full view address.
Current tabs, frame and list traversal remain with their existing readers, and
[public metadata](../apps/web/src/features/pages/subject-head.ts) continues to own head and JSON-LD.

### Public data and failure states

Public SSR uses anonymous typed `POST /v1/pages:read` subject targets, including the requested language chain and
view. Preserve the actual subject response `{subject, account, summary, related}`, including its release,
resolution, selected statements, qualifiers and support references. Use current bounded related summaries rather
than extra per-card reads. Neither a presentation profile nor a cached label grants current access.

Titles, short descriptions and admitted facts render without JavaScript. Genuine embedded, validated Content
documents use the existing document renderer; a document locator alone is not prose. Select the reader's summary
language before deciding whether its body is available. If the selected body is unavailable, About retains a real
short description when present and explicitly offers a document retry. No summary is different from an unreadable
summary, and a failed dependency is different from an empty successful section. Retry keeps the current query and
view. Raw document IDs and fixture bodies never establish successful native summary delivery.

Library state, reader preferences, own reactions, own ratings and imported suggestions begin only after viewer
preparation and hydration; their requests use the existing private BFF and `no-store`. Anonymous HTML and its
dehydrated data carry no private values. Public failure never initiates a privileged fallback.

### Selected-fact sources

The overview's Sources entry also opens `/subjects/{id}/{slug}/sources`, a companion reader outside the
Composition view template. It uses the ordinary anonymous `GET /v1/subjects/{id}` with the existing language chain,
current disclosure and one-hop merge handling. Stale identities redirect to the current subject and retain the
query and fragment. Missing and hidden subjects use the same concealed not-found state. Denied, invalid, changed
selection and unavailable responses remain failures; retry reads the same address again.

The page groups the currently disclosed selected facts by field, using emitted property labels and released Type
labels with the existing locale fallback. It follows the overview's selected rank, summary-language and safe spoiler
rules. Citation parts belong to the individual selected value; a citation is supporting material, not a verification
badge. Values with no citations remain visible with an explicit notice. Related values use only supplied public
labels, with no per-field target reads. Document and media locators are reading pointers, never rendered IDs, prose
or externally fetched images.

Reuse the existing Sources presentation for any actually returned reviewed provider name, URL, licence and
attribution and for separate cover credit. Provider metadata remains subject-level metadata, never evidence of a
particular field's support. Missing metadata and unknown cover rights are explicit; a structured-data licence does
not license authored text or images. This reader does not create a metadata producer or infer provider identity from
a citation URL.

A supported descriptive field links to the existing Details candidate comparison with `candidateField` selected.
The private review remains explicitly opened after session preparation and uses its existing CSRF-protected BFF;
no candidate or authenticated overlay enters the public sources response. Back to subject returns to that same
public subject. Relation-edge slots continue through their existing target-aware readers.

### Recorded changes

The subject header offers Changes at `/subjects/{id}/{slug}/changes`. This private, no-store, noindex
companion page starts reads after browser session preparation. It follows the native revisions list and its
opaque continuation unchanged, including an empty page with another continuation. The current public subject
read supplies its identity, title and return address; it is independent of the authorized revisions read.

Choosing a revision clears any previous detail and asks the same session BFF for its safe explanation. A failed
detail read preserves the revision list and selection and offers an exact retry. Missing or concealed detail has
one neutral state. A current subject refusal clears the page. No historical value, source input or current value
is used to reconstruct withheld information. Only the producer's authorized summary may describe term fields and
data languages, a proposal, a Context decision or an adoption. A proposal, acceptance and current public selection
remain separate; the latest revision is never labelled as the current selection. Return to current reading uses
the ordinary public subject journey. This page offers no lifecycle command or historical snapshot comparison.

Loading, no revisions, denied, invalid, changed, unavailable/retry and limited safe detail are distinct states.
The temporary detail port remains unavailable until the published closed Semantic response is bound; consumer
presentation examples do not establish native detail availability. There is no guessed detail wire schema or
successful runtime fallback. Definition labels use the existing locale fallback, independently of data languages.

### Open owner joins

These joins complete the adopted journey; naming one here does not claim it is implemented:

| Join                                   | Current authority and required binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Summary body                           | [Semantic authored installation](../services/kernel/src/semantic/authored.ts) emits `{language, document: id, digest}`. [Content document reads](../services/kernel/src/content/document-routes.ts) supply `{document: {availability, body, subjectId, candidateId, …}}` under current disclosure and rights. [Composition reads](../packages/composition/README.md#reads) currently admit no document descriptor. Content/Composition must provide a bounded, typed selected-summary binding inside the public page aggregate, retaining selected support and current erasure behavior. Web does not guess a descriptor, append per-statement reads or authorize from the locator. |
| Relations, editions, credits and Works | Semantic owns native incoming/outgoing/count cursors; Composition and the sibling traversal region own full outgoing and independent group continuations, labels, qualifiers and truthful counts. Preserve their current inputs and newer integrated fixes.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Original source evidence               | The [source-record attribution contract](../services/kernel/src/semantic/source-record-attribution-contract.md) owns exact original tuples, selected support, metadata and fences. Its deferred producer/import registration and source-readiness bindings remain with those owners; reflective or fixture metadata is not delivery. The imported-suggestions region below retains its independent source review.                                                                                                                                                                                                                                                                   |
| Realm and neighboring sections         | The native freeze below remains authoritative. Production Realm selection/revalidation and each rating, review, discussion and list population require their actual admitted bindings. A Global result never becomes Realm output through labeling.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Focused [canonical journey cases](../apps/web/tests/subject-canonical-journey.test.ts) cover the generated-client
boundary, navigation, request bounds and public rendering using native recorded DTOs and explicit failure responses.
They do not establish live native eligibility, document-body delivery or visual conformance. Full served-page,
current-withdrawal and screenshot review remain integration proof across no-JS, keyboard, phone/desktop, locales and
themes. The reusable [public reading pattern](../apps/web/src/subject/reading-state/index.tsx) has one story identity
across those globals and is the same component used by About.

## Edit a released profile

The subject header and compact view frame offer **Edit facts** at
`/{locale}/subjects/{id}/{slug}/edit`. Without a selected `property`, this is the multi-field catalogue workspace.
A property/statement address still opens the existing single-field correction form. Both keep the canonical subject
identity and its current released Type. This workspace is catalogue data, separate from Puck presentation editing.

The private session BFF starts the ordinary public subject and active-definition reads together, then resolves the
immutable release. Effective emitted Type properties determine the field inventory and order; scalar datatypes
group text/identifiers, dates and quantities. Labels/descriptions use definition-language fallback, independently
of authored value languages. Every selected public assertion, qualifier and citation remains visible separately.
Opening an editor creates a clearly labelled private draft, never a selected public value. Multiple selected values
require an explicit choice of assertion; a multivalued field may instead propose an additional value. Cardinality
still governs the later whole-slot selection, not a client-side collapse of existing assertions.

The workspace reuses the scalar editor's native value, qualifier and grouped-citation controls and validators.
Existing unsupported parts stay intact. Names and descriptions use the separate actual terms PATCH editor;
relations/credits use their exact-slot editor. Types with document fields link to the existing
[authored composer](#original-authored-catalogue-text) at `/authored` for a new original-text candidate.

A contributor explicitly includes changed fields and submits at most twelve fields per workspace. Unchanged or
excluded fields issue no request. Blank or incomplete values produce invalid drafts, never deletion or clearing.
Each admitted change seals its own immutable statement body and native idempotency key before any request begins.
The existing generated per-subject candidate POST runs once per included field through the session BFF and CSRF
boundary; no bulk endpoint or grant exists. Individual results distinguish proposed, stale, denied, invalid,
unavailable and uncertain delivery. Failed drafts remain available; uncertain/unavailable requests freeze editing
and retain their exact body/key for retry. Definite failures can be edited into a new explicit intent. Later submits
retry only unresolved included fields and never replay a confirmed success. Refresh preserves drafts and keys;
current concealment or failure hides the workspace until a readable response is available again.

A successful field offers its exact returned candidate at
`/edit?reviewProperty={property}&candidate={candidate}` and an in-place comparison using the existing candidate
review controls. In-place review carries the returned native session token; reopening the address performs a fresh
current read. Acceptance/rejection, cardinality-aware whole-slot adoption and ordinary public reading remain
separate explicit steps. The workspace never claims publication or an atomic save. Current private candidate
visibility and current native command authority remain with the existing review/session APIs.

## Propose a cited correction

A signed-in reader can choose **Propose correction** beside an existing scalar fact in Details (also available
where that fact appears in the overview). The canonical subject route `/subjects/{id}/{slug}/edit` retains the
exact subject, property and selected statement address. The editor names the subject and its released Type,
shows the current assertion and citations, and identifies Global as the proposal context. Missing and hidden
subjects use the same concealed unavailable state; a moved subject resolves through existing canonical routes.

Controls follow the current emitted property definition: text and value language, URL or external code, date
precision with its declared calendar, and quantity with explicit admitted units and optional bounds. No unit,
calendar, date precision or word-count coverage is inferred. Known, unknown and no-value remain distinct.
Qualifiers use the property's admitted definitions. Citations retain their statement-level groups and parts.
Unsupported qualifier or citation values remain visible and are submitted intact with an explanation; an assertion
that is no longer safe under current definitions is rejected without narrowing it. Definition labels use the
existing locale fallback; a value's language remains authored data.

The session BFF sends the generated client's `POST /v1/subjects/{id}/candidates` with only `{statement}` and an
idempotency key. It uses current session authorization and CSRF handling; ingestion Source metadata, term-map
replacement, relations, media and rich document authoring are outside this form. A `schema:name` fact does not
replace labels. The native endpoint owns current Type/release validation, permission and source provenance.
Invalid, denied, stale and unavailable outcomes retain the draft. Reloading definitions retains the draft too.
An uncertain outcome freezes editing until an exact retry resolves the original request and key.

Success means **proposed, awaiting review**. It does not accept, adopt or mutate the selected assertion. The
returned candidate identity and session consistency token feed the existing comparison/review region. That
region selects only that exact candidate, including when it requires continuation; another candidate never
stands in for it. Acceptance and Global adoption remain separate explicit confirmations, followed by the
ordinary anonymous reader. Only the reader's exact selected statement confirms public selection. The public
link uses existing canonical subject handling.

## Imported suggestions

The canonical subject overview and Details offer signed-in readers an **Imported suggestions** region after the
reading content. Opening it loads a private, uncached review through the prepared BFF session; public HTML and
anonymous reads contain no candidate data. A public subject never implies permission to accept or adopt. The
native command checks the current account's permission, and refusal removes the review data from the region.

Choose a named descriptive field admitted by the subject's emitted Type, then traverse its native candidate
pages, twenty suggestions at a time. The review compares the ordinary public field values with a proposed value
and its qualifiers, references and available source-record licence/attribution. Related labels use supplied public
summaries, without per-value hydration. Import details disclose the source record and source/converter revision.
Missing attribution stays missing; the browser does not infer a licence or permission from the provider.

Acceptance, rejection and selection are separate confirmations. Accept and reject use the observed candidate
decision head; rejection retains the assertion. The comparison distinguishes awaiting-decision, rejected,
accepted-but-unselected, actually public-selected and retracted suggestions. A native selected rank without its
ordinary public reading remains unconfirmed. Deprecated assertions do not establish successful selection.

The public-selection draft starts with all currently disclosed selected values, including those outside the
displayed candidate page. Reviewers explicitly include or remove values and choose normal or preferred rank.
The emitted property's multiplicity limits a single-valued field to one selection; multivalued fields permit at
most 32. Rejected, retracted, deprecated and unresolved draft choices cannot be submitted. A draft choice that
has not been redisclosed after reload needs a fresh comparison or explicit removal. Loading another candidate
page, changing fields or reloading does not silently discard the draft, removed choices or edited ranks; newly
disclosed public selections join the draft unless explicitly removed. No hidden count or hidden value is inferred.

Selection uses native Global adoption in replace mode with the observed slot adoption head and the complete
explicit selection. Confirmation shows its values and ranks and explains that unchecked values are replaced;
an empty replacement explicitly clears the field's selection. No per-row action substitutes one candidate for a
multivalued field. Optional exact target, sameAs and qualifier-key addresses remain available to existing relation
callers; browser Context overrides and community editing are not introduced.

Each confirmation carries an independent idempotency key. An uncertain retry retains the exact request, draft,
heads and key and freezes editing until that request is resolved. A 409 retains the selection draft, requires a
reload of the comparison, then another explicit confirmation with a new key. Reload never automatically resubmits.
No command grants permission or changes account scopes; a current refusal removes the review data from display.

After a confirmed command the browser reads the ordinary public subject once without viewer authorization,
carrying the native session consistency token. Only the returned exact selection and its normal/preferred ranks
establish successful public replacement. An accepted suggestion can still need adoption; a submitted adoption
whose public read is not yet confirmed remains pending. Manual reloads check again; there is no polling or
replacement of public page data with proposal or mutation JSON. A confirmed selection links back through the
ordinary canonical subject reader, preserving merge and language handling.

The current native candidate read requires a property and, for relation slots, a target address. There is no
subject-wide candidate or relation-slot discovery read. This region therefore covers descriptive property slots,
including classifications, and does not offer an invented list of imported relation targets or a raw-id entry.

## Withdrawing a just-submitted contribution

After an ordinary field correction succeeds, its exact returned candidate offers **Withdraw contribution** beside
the existing comparison and subject link. The confirmation addresses that contribution alone. It calls the declared
native `DELETE /v1/subjects/{id}/candidates/{candidate}` through the session BFF; original write-revision authorship
and current `statement:delete` authority remain native decisions. Source provenance, subject creation, adoption and
target identity never establish ownership. An unserved lifecycle route remains unavailable, with no local tombstone.

A confirmed deletion clears the correction draft, private comparison and cached subject/candidate payloads. The BFF
rereads the current subject and candidate slot in parallel and returns only availability, without the removed text or
author profile. The subject keeps its identity. **Restore contribution** requires another confirmation and a new
native `POST …/{candidate}:restoreDeleted`, checking current native author authority and Global `statement:propose`.
It does not change acceptance or adoption, undo moderation/source fences or restore terminal consent/account state.
An actual restore 409 ends restoration in this flow. Missing or concealed reads share the unavailable state.

Uncertain retries keep the exact operation, subject/candidate, consistency token and idempotency key. The original
server thirty-day window applies; the interface creates no local deadline. Until the producer publishes a deadline
DTO, it displays no invented date or countdown. The temporary typed port uses the generated client's existing runtime
transport and must bind to generated lifecycle declarations when published. Page stories are declared-interface
examples, not native acceptance or visual-review evidence.

## Context review

An actual subject reading links its native Context to
`/{locale}/subjects/{id}/{slug}/context-review?context={contextId}`. This companion editor retains the public
canonical subject frame. It verifies the explicit Context with native `GET /v1/contexts/{id}` after session
preparation and explicit opening. Its label and Global/community scope come from that response. A Realm name
never supplies editorial scope, and this route does not change the selected Realm reader or its publication.

The editor reuses candidate comparison for descriptive fields. Existing exact-slot links may additionally supply
`property`, `target` or `sameAs`, and an admitted qualifier `key`. Those addresses travel intact through native
candidate listing and adoption; a relation property without its exact address is not offered as a scalar field.
The comparison shows separately the anonymous Global values and the authenticated Context reading, with supplied
related summaries. Native adoption and resolution distinguish inherited, replaced, suppressed and unresolved
readings. Relation resolution is field-wide, so the editor labels its disclosed exact-slot preview accordingly
instead of assigning a field diagnostic to one relation or picking a winning candidate.

Global supports replacement only. Community review additionally offers inherit and suppress with an empty command
selection; switching modes retains the replacement draft. Replacement uses normal/preferred ranks and emitted
cardinality. Candidate acceptance/rejection and slot adoption retain their separate observed heads and native
`context:accept` / `context:adopt` checks. Reading or preparing the Context grants neither write permission.

The private no-store session BFF preserves current identity, CSRF, session continuity and idempotency. A stale
comparison keeps the draft and mode, requires reload, then a new explicit confirmation and key. An uncertain
request freezes its exact payload and key for retry. Confirmed writes re-read the actual Context, subject and slot;
a failed reread remains unconfirmed. A local adoption never claims whole-Context publication. A separate link
opens the ordinary public canonical subject. Candidate data never enters public SSR or its dehydrated cache.

### Named editorial Context lifecycle

The Context review workspace links to `/{locale}/contexts/new`, retaining the exact subject and canonical slug
for its review link. `/{locale}/contexts/{id}` opens the same private lifecycle workspace. Both routes are
noindex; Context content loads only after session preparation through the private no-store BFF. A named Context
uses generated `POST /v1/contexts` with its data-language label and existing native creation authority. Success
retains the returned identity and rereads `GET /v1/contexts/{id}` before offering the existing subject review link.
Creating a Context does not publish a catalogue or website or change the Realm reader's selected Context.

A readable community Context offers an explicit deletion request and confirmation; it does not assert ownership.
Global is communal and offers no deletion. Generated `DELETE /v1/contexts/{id}` and
`POST /v1/contexts/{id}:restore` recheck native current resource-owner grants, independently of creation history.
Only this workspace's successful native deletion response supplies a known tombstone and restoration attempt.
An unknown or nonvisible 404 supplies neither. No owner flag or browser deadline decides restoration eligibility.
Denial, revoked or transferred authority, conflicts and expired native restoration remain refused outcomes.

Confirmed deletion unmounts private candidate comparisons and drops cached Context labels before rereading the
actual native state. A concealed or unavailable reread displays no old private payload. Confirmed restoration is
separate from successful current reading. Ordinary subjects, contributions and Global selections remain independent;
no page claims cascade deletion or completed cleanup. A failed request keeps its draft, exact action and key.
An uncertain request remains sealed for exact retry; a definite refusal allows explicit review of a new request.
All actions preserve current session identity, CSRF, native response/session headers and current authority through
the existing BFF. The generated lifecycle response supplies no restoration deadline.

## Relation contributions

The canonical Global overview links to `/{locale}/subjects/{id}/{slug}/relation-edit`. The route keeps the
subject's canonical identity and shared frame; Realm readings do not expose a Global writer. A Realm query on the
editor shows the unsupported Context state. There is no browser Context override.

After session preparation, contributors choose an effective released relation property and a real target through
the existing subject picker, or edit one of the public reader's existing relations. Classification properties stay
in descriptive-field review. Qualifiers use released property meanings and item pickers for roles and declared
keys. Existing qualifiers, original names and reference parts survive replacement proposals. Citations are attached
to the immutable statement submitted through native candidate proposal, not to a presentation document.

Review addresses exactly the property plus target, or an existing unresolved `sameAs` IRI, and the declared item
qualifier key when present. Target and `sameAs` are mutually exclusive. Twenty candidates and their continuation
belong to that address. The comparison shows the public selection for that slot, proposed qualifiers, evidence,
source details, decision and selected rank. Unresolved references remain unresolved; unavailable summaries never
become invented identities. Related labels come from supplied summaries or the existing bounded suggestion response.

Accept and reject use the observed candidate decision head. Adoption uses the observed slot adoption head and
replaces only that target/key slot with one normal or preferred selection. Retracted and deprecated suggestions
cannot be selected. Each confirmation has its own idempotency key; uncertain retries keep the exact request and key.
A 409 retains both draft and comparison, requires a reread and another explicit confirmation, and never silently
resubmits against a new head. Current denial removes review data from display; missing or hidden remains concealed.

Successful commands reread the ordinary public subject with session continuity. Only the exact candidate in that
slot at an admitted selected rank confirms public selection. A committed adoption with no confirmed public result
stays pending. The canonical reader is refreshed and linked after confirmation; private proposal JSON never replaces
its data. The editor's page stories use the shared shell and locale/theme/viewport globals.

## Statement consent

The relation editor uses the released `disclosure: sourceOrConsent` annotation. For an unsourced assertion,
contributors explicitly declare that its target is the agent linked to their current account before submitting
through the ordinary candidate proposal. The native command validates this declaration; no ownership is inferred
from labels, Source provenance, subject creation or proposal authorship. The returned candidate identity opens
`/{locale}/subjects/{id}/{slug}/statement-consent` with its exact property and relation-slot address. Existing
unsourced candidates in that slot offer the same conditional entry without claiming ownership.

The consent page prepares its private candidate only after session hydration and an explicit opening. A bounded
candidate page and the anonymous public subject read start together. Candidate continuation is explicit; absence
from one page establishes neither ownership nor consent. Labels come from the candidate's immutable definition
release. Cited assertions follow ordinary sourced review and do not offer consent controls. The native candidate
response supplies no eligibility or disclosed flag: the page says so, separating unsourced/private review from
presence or absence in the current public result.

Sharing and retraction require separate explicit confirmations through the generated native
`POST /v1/statements/{id}/disclose` and `POST /v1/statements/{id}/retract` methods. The existing session BFF retains
CSRF protection, current credentials, native idempotency keys and session-token continuity. Only the current native
target-account check grants the action. An uncertain response retains the exact operation, identity and key;
denial or concealment clears prepared values. Invalid/conflicting requests require fresh review and confirmation.

A confirmed write triggers an anonymous public reread of the same subject with the native session token. Consent
sharing is separate from current public selection and availability. Retraction is terminal for this assertion,
not contribution deletion or Account preferences: there is no undo or 30-day restore. Confirmed retraction clears
the assertion payload; a lagging public result reports pending removal without returning that value. Public-read
retry never repeats a confirmed mutation. Private reads and values use no-store responses and component state,
never public SSR, dehydrated query caches or local-success previews.

## Principles

- **Readers first.** A page shows covers, titles, people, scores, what people say and what to do next, in words
  readers already know. Contexts, revisions, identifiers and provenance sit at the end of the page or behind
  "Details".
- **Nothing raw.** No value is ever shown as an internal identifier, a media id, a document id or a property CURIE.
  A value the page cannot present is left out of the reading view and remains available in Details.
- **Every list is traversable.** A preview shows a few items, an exact or "at least" count, and a link to the full
  view. A full view pages with a continuation, never a fixed slice.
- **One type system, no per-vertical code.** Which views and sections a type shows comes from its presentation
  template and the data that exists, never from a branch on the type's name.
- **The page works without JavaScript.** Every view is a server-rendered URL; personal controls hydrate on top.
- **Honest states.** A section whose read failed says so in a sentence with a retry; it is not silently empty and it
  does not break the rest of the page. A contested fact shows as unresolved, with a link to the competing claims.

## Views

A subject page is a set of views, each with its own URL under the subject's address:

| View       | Path          | Shown when                                                                      |
| ---------- | ------------- | ------------------------------------------------------------------------------- |
| Overview   | `/`           | Always                                                                          |
| Editions   | `/editions`   | The type has editions or releases, and at least one exists                      |
| Contents   | `/contents`   | The type has ordered parts (volumes, episodes, chapters, routes) and one exists |
| Characters | `/characters` | At least one appearance exists                                                  |
| Credits    | `/credits`    | At least one credit exists (staff and cast)                                     |
| Relations  | `/relations`  | At least one relation exists in either direction                                |
| Reviews    | `/reviews`    | An open read exists (shown with an invitation when empty)                       |
| Discussion | `/discussion` | An open read exists (shown with an invitation when empty)                       |
| Lists      | `/lists`      | At least one public collection contains the subject                             |
| Details    | `/details`    | Always: every fact with qualifiers, sources, identifiers and history            |

A person or organization shows Works (their credits, grouped by role) instead of Credits, and Characters (roles
they voiced or played) when any exist. A character shows Appearances (works, with role and cast) and Relations.
A Realm-routed page adds nothing to this list; it changes the population of scores, reviews and discussion (see
[Realm context](#realm-context)).

Views appear in the order above. Each tab shows its count when the count is known. A view whose feature is not open is
left out, with no panel or notice; its URL redirects to the overview. A view with no data is left out, except Reviews
and Discussion, whose open reads invite the first contribution when empty. A list view whose items all fit in
its overview preview, with nothing to filter, has no tab: the overview section shows all of it without a "See all"
link, and the view's URL still renders. With typical catalogue data (a median work has about five characters, two
credits and one relation) most subjects show Overview, Reviews, Discussion, Lists and Details, and no tab repeats
the overview. A template may give a view the vertical's word (Contents is "Episodes" on an anime, "Volumes" on a
manga). The tab bar stays in view under the top bar while the page scrolls. On narrow screens it scrolls
horizontally with the active view in sight; it never wraps into several rows.

## Agents

People, organizations (studios, publishers, bands, groups) and automated agents are agents, whether they arrived
as catalogue subjects (an author imported from a source), as accounts, or both. Every agent has exactly one page.

- **One agent, one page.** An account is an agent. When an account is verified as a catalogue person or
  organization, the two are one agent with one page at the account's `/@handle`; the subject's address redirects
  there. An agent without an account keeps its subject address. The page is the same either way.
  While the account is suspended its page is not served, and the subject's address serves the subject page.
- **Views.** An agent's page is a subject page: Works (credits by role) and Characters come from the graph; an agent
  with an account adds its public posts, reviews and collections; an organization adds its members and, if it
  chooses, the accounts that speak for it. The view rules above apply unchanged.
- **Speaking for another agent.** A person's account acts for an organization through membership in that
  organization; what it publishes as the organization is the organization's speech and appears on the
  organization's page. A pen name or a collective name is its own agent, related to the people behind it; a link
  that is not already a sourced public fact is shown only when the people behind it make it public.
- **Who controls what.** The agent controls its self-presentation: display name, avatar, bio, links and which of its
  activity views are public. Sourced facts about the agent (dates, credits, affiliations) stay under the ordinary
  edit and review process with their sources; the agent can dispute them there but cannot remove them by owning
  the page. Its own statements about itself are accepted with the agent as their source.
- **Verification before merging.** An account becomes a catalogue agent only through verification. An unverified
  claim never merges pages or changes attribution.
- **Separate personas are separate accounts.** A person who wants a reading life apart from their author page uses
  another account under the same controller; ratings still count once per controller.
- **Never inside a Realm.** An agent's page is never routed inside a Realm or Zone. A Realm is a venue where the
  agent speaks, not where its identity lives.

## Overview

The overview answers "what is this, is it for me, and what do I do next" in the first viewport, then previews every
other view. Sections a type does not support are left out; the rest keep this order and stable anchors.

1. **Identity and next action.** Cover; title in the reader's language with the original title quietly beside it;
   type and date; principal creators, linked; the headline score with its population and count; the reader's own
   status, progress and rating with one primary action (Continue, Start, Add). On phones the cover is a thumbnail
   beside the title so this whole block fits the first viewport.
   The header's top right holds the reaction cluster (like, love, laugh, insightful and sad, each with its count; a
   subject has no upvote or downvote because its score is its rating) and an overflow menu that carries copy link
   and report. One reaction per reader; choosing another kind replaces it. Signed-out readers see the counts and a
   sign-in link.
2. **About.** The summary (spoiler-safe by default), a short set of key facts chosen by the type's template, genres
   and the most-used tags, and content warnings.
   When a subject has no summary, About shows its short description instead, and the header never shows one.
3. **Parts.** For types with parts: the next part for this reader, then the ordered list preview.
4. **Relations.** Related subjects grouped by relation group (order, derivation, world, membership), each with
   cover, title, relation label and date. Series order is shown as order, not as a list of links.
5. **Characters.** Main characters first, then supporting, each with portrait, name, role and cast.
6. **Credits.** Principal staff by role, in credit order.
7. **Ratings.** The score distribution, count and population, the reader's Realm scores, and a link to Reviews.
8. **Reviews and discussion.** Public Global reviews and discussions in Content’s native last-activity order, with summaries, bylines, canonical thread links and bounded continuation. Realm reviews remain closed until their population binding is delivered; existing Realm discussions retain native Context authority.
9. **Lists.** Public collections and reading orders that include the subject.
10. **Sources.** Cover credits, source records for the facts shown with each source's licence and attribution,
    external identifiers, and a link to Details.

Every preview shows at most twelve items (fewer for reviews, threads and lists) and links to its full view when
there are more. A subject with only a
title still renders a complete page: the cover placeholder, the title, an empty-state invitation to add facts, and
Discussion.

## Covers on pages

The cover area always renders, at the frame ratio of the subject's type, on every surface that shows a subject,
with the designed placeholder when there is no image. On a subject page, the cover opens a viewer with the original
image and its credit; credits and notices are collected in Sources at the end of the page, never as a caption. See
[Cover](../packages/ui/README.md#cover).

## Relations, characters and credits on pages

Relations are shown from the reader's side of the fact: on a sequel the original appears under "Prequel", using the
property's inverse label. Symmetric relations appear on both sides under the same label. A relation group shows its
count, and the full Relations view pages through each group.

Characters, credits and relations come from the subject's facts on every page; they never depend on a wiki Zone,
a Realm or any other site having been set up for the subject.

Characters and credits are grouped by role and ordered by the stated credit order, then by name. A credited name
that differs from the subject's display name is shown with the credit. Spoiler-level qualifiers hide the
character, role or relation behind a reveal control according to the reader's spoiler setting.

Custom relation types from a selected Context appear in their own group under their own label, after the bundled
groups, and are labelled with the Context they come from.

## Scores on pages

A score is never shown without its population and count. The page headline uses the population of the page's
context: Global on the general site, the Realm on a Realm-routed page. Other populations appear as a labelled list
beside the distribution, each with its own figure; they are never averaged, blended or silently substituted for one
another. See [ratings](../services/kernel/src/rating/README.md#display).

## Realm context

The same subject page is reachable from the general site and from a Realm or Zone. The facts come from the
selected Context, inheriting Global except where that Context accepts, replaces or suppresses a value. Current
Context selection and population labeling use the native contract below. Realm ratings, reviews, discussion and
lists require their own population bindings before a page can consume them; a label alone does not establish those
producers. Existing Global output must never be relabeled as Realm output.

### Native page request and response freeze

`POST /v1/pages:read` accepts `{target:{subject:<id>,realm?:<RealmUUID>,view?:<existingView>},languages?}`.
Exactly one existing target family is required. Account and route targets reject `realm`. UUIDs, body types,
languages, views and unknown fields follow the existing API validation rules. Neither a raw Context id nor a Context
override is accepted. Realm choice belongs to this request, never to the persisted presentation profile. Existing
requests without Realm retain their response shape and behavior. Agents retain their canonical Global redirect or
Global subject read; selecting a Realm never creates an agent Realm page.

A successful subject response to a Realm request adds optional subject-page metadata:

```ts
context: {
  id: selectedContextUUID,
  population: { kind: 'global' } | { kind: 'realm', id: realmUUID, title: actualRealmViewTitle }
}
```

The actual subject read's `subject.context` equals `context.id`. A Realm population uses the title returned by the
current native Realm view. A fallback has exactly `{id:GlobalContextUUID,population:{kind:'global'}}`; it contains no
Realm id, title, label, reason or guessed publication status. This labels the current facts, not a Realm score,
review or thread producer. The product can offer a Global switch without disclosing why Realm publication was
unavailable.

### Current authority and dispatch

Resolve `community/realm.ts`'s actual `readRealm(deps, actor, realmId, {deadline})` first. Its `RealmView` includes
`contextId` and `headRevisionId`. A null result conceals with 404, including unknown, denied and currently banned
readers of protected Realms, even when an independent grant exists. The similarly named board-scheme reader is not
this authority; it lacks the protected-Realm ban check.

Then use `community/publication.ts`'s actual
`readPublication(deps, realmId, subjectId, {actor,deadline})`. It returns the current adopted `PublicationHead` or
null and rechecks Realm and subject readability in its own snapshot. Its protected-Realm check delegates
`realmReadEligibility`: a current ban throws `ProblemError(not_found)`; the snapshot rolls back and rethrows.
`readRealm` catches its internal `RealmReadDeniedError` into null, but `readPublication` does not. A thrown
`not_found` from either reader conceals the whole page with standard 404, never Global fallback. Other native
deadline or unavailable errors retain their typing; no catch-all conversion to null is permitted. Genuine null
publication conflates missing or unreadable slots, withdraw and reject; it certifies neither permission nor
unpublished status. Only after a readable Realm and genuine null publication may the page independently authorize
a current Global subject read. A denied Global subject remains concealed.
Never carry Realm labels into that fallback.

A publication pointer and a Realm grant do not authorize the Context. For a Realm result use actual `readContext`,
`publicContextEligibility` and native Context lifecycle authority. Current subject deletion, hiding, candidate
moderation and Context deletion remain effective. Apply the selected Context's existing inherit, replace and
suppress semantics. An operation locator or old Context id supplies no current authority.

These reads use separate snapshots. Before any Realm response, re-read the actual `realm.ts` Realm and compare its
current Context and head revision. Denial conceals; a change requires bounded retry or readiness failure, never a
successful stale Context A response after a change to B. Comparing both `contextId` and `headRevisionId` is necessary but insufficient: publication withdrawal,
rejection and a protected ban can leave both unchanged. Revalidate current publication and protected-ban authority
after selected subject and links execution and before returning Realm output. A late withdrawal or rejection
requires independently authorized current Global subject and links with exact Global metadata, or a truthful typed
503 with no result and standard Retry-After. A later healthy read must return current Global, not permanent
preparing. A late protected ban requires standard whole-page 404 without context, reads, Realm metadata, selected
facts or private reason, even while the independent Realm read grant remains. The same concealment applies when
a ban commits after the initial delegated Realm read but before publication: publication's thrown `not_found`
never becomes Global 200. Reuse the existing deadline and retry policy without a new numerical allowance
or a clock bypass. Final authority work remains charged inside the same bounds; this specification supplies
no runtime growth pass. Runtime growth evidence must include late authority paths at the existing geometric
scales and current owner populations, including final guard costs.

Internal subject and links descriptors carry only the server-resolved current Context. That Context participates
in actual probe reuse, descriptor deduplication, dispatched requests and session binding. Subject and links must
use the same selection. Keep the caller's bearer, Actor, Auth, Access and session throughout. No anonymous
substitution, special permission header, second client request or profile/cache permission is allowed. Keep the
existing 16 distinct reads, 128 read-cost slots, concurrency and request deadline bounds; charge actual Realm,
publication and Context points as well as subject and links work within those bounds.

Use the delivered sticky `withPublicStatementReader` export from `semantic/statement-disclosure.ts` for the whole
aggregate. `presentation/reads.ts` applies it to actual probe and planned dispatch through `readPage`. Its sole purpose is to exclude publisher-private candidates and related ids from public page output.
It does not resolve Realm or publication, grant Context access or make protected Realm metadata globally public.
Standalone permitted private hydration retains the same current caller and its existing behavior. The frozen
[aggregate authority suite](../services/kernel/test/presentation/aggregate-authority-user-cases.test.ts) remains
unchanged.

### Native acceptance and remaining bindings

The [native Realm page cases](../services/kernel/test/presentation/realm-context-user-cases.md) use the existing
Semantic driver and its real composed kernel, Auth and Access. They freeze public subjects, distinct Context A/B
facts, actual protected readable Realms and publication, Global fallback without Realm disclosure, current bans,
lifecycle, candidate audience, subject/links/session consistency, validation, agent canonical behavior and the
Context A-to-B race. Four additional during-read schedules cover an early protected ban, late publication
withdrawal and rejection separately, and a late protected ban. Late barriers hold the actual links completion only
after both selected subject and links responses succeeded; they never hold the subject probe waiting for links.
Mutations use native writes outside page observation, with unchanged Realm Context/head controls for late schedules.
All authorization delegates real Access with the same opaque native time, actor, evidence and session. A suspended account uses its genuine pre-suspension bearer: 401 `invalid_credentials` with
`Bearer error="invalid_token"`, never a manufactured bearer.

| Surface                                        | Binding status                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Subject facts, links and current Context label | Request/response and native acceptance frozen here; production Realm wire still required                               |
| Native Context deletion lifecycle              | NOT YET FROZEN: existing lifecycle acceptance requires DELETE, but the composed Context routes expose only create/read |
| Sticky public statement audience               | Delivered `statement-disclosure.ts` export; `presentation/reads.ts` wraps actual probe and planned dispatch            |
| Realm rating figures                           | NOT YET FROZEN: require Rating's actual question/population binding and current authority                              |
| Realm reviews                                  | NOT YET FROZEN: require Content's actual Context/population read export                                                |
| Realm discussion                               | NOT YET FROZEN: require Content's actual Context/population thread export                                              |
| Realm lists                                    | NOT YET FROZEN: require Library's explicit population binding                                                          |
| Global review/thread previews                  | Independent Content/Search acceptance; no duplicate fixture in this freeze                                             |

This specification adds no page, compiler, schema, client, Realm, Context, Source or figure implementation and no
resolver export. It establishes no Source safety or identity acknowledgment, deployment default or main-branch
completion. Manager acceptance requires full native check output and Root, Search and Community review of this
owner contract and its evidence.

## Qualified relation streams

Credits and characters render each current native statement with its own credited name, order, detailed role and
character qualifiers. Item names and canonical links come from the response's disclosed related summaries. Missing
qualifier fills stay absent. Spoiler markings use the current stored qualifier and reader setting; the entire row,
including title, metadata and links, remains behind the accessible reveal control until explicitly opened.

`OutgoingRelations` selects the existing native forward stream for one property. Each group previews at most 12
rows. In a full view each group owns its cursor, loading, retry and restart state. More resolves the current
template and selected Context again and dispatches only that group's relation read. Other relation groups are
returned as unrequested (204), retaining their existing client state. A continued document opened directly offers
those groups a fresh-start link. No first-page slice or cross-group cursor represents a complete graph or total.
The existing 16-read, 128-slot and native request bounds still apply.
