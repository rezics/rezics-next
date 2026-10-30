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
currently absent native binding stays explicitly unavailable. No historical snapshot or write authority is assumed.

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
keys remain with their owning components. Terms mutation and detailed Changes producers still require their actual
native bindings; a menu link establishes neither availability nor a successful write. The Contribute stories use
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

## Browser flow: work parts

The Contents view links to `/{locale}/subjects/{id}/{slug}/work-parts`. This private, noindex editor reads one
bounded native part stream at a time, with its own opaque continuation, current count semantics and projection
freshness. Rows retain native stream order; neither a first page nor its array indices describes a complete
composition. Contents, volumes, episodes and tracks use only existing emitted canonical relations. A missing
relation profile or qualified assertion stays unavailable for editing.

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
