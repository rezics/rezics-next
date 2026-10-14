# Content instruction adoption, references and derivation

This is the decided, **unimplemented** API boundary for the Recipe vertical
slice, before [public opening](recipes.md). The executable producer and consumer
examples are the [outcome test](../../tests/qa/integration/outcomes/recipes/instructions-in-any-form.test.ts).
Content owns documents and immutable revisions; Structure orders exact
adoptions; Media retains exact bytes. Content transformation is distinct from
the existing Work-to-Work derivation operation.

## Grain-qualified Resource references

Inline and block extensions use definition
`https://rezics.com/definition/resource-reference-v1`, version `1`, payload
`{ target, selector }` and a text fallback. `target` identifies the Resource,
never a delivery URL. Selectors are a closed union:

| `grain` | Required fields | Meaning |
| --- | --- | --- |
| `resource` | none | Identity only, without an exact version assertion |
| `revision` | `revision` | Exact revision owned by the target |
| `occurrence` | `structure`, `revision`, `occurrence` | One use within an exact Structure revision |
| `content` | `variantId`, `revision`; optional `block` | Exact Content revision, optionally one document-local block |
| `representation` | `revision`, `representation`; optional `fragment` | Exact Media asset revision and retained representation, optionally a temporal fragment |

Content and Media revisions/representations use UUIDs; graph revisions and
resources use native IRIs. A media target is `urn:rezics:media:asset:<uuid>`.
`fragment`, such as `t=npt:0,1`, is validated against the exact recording duration.
Block and occurrence IDs must belong to the selected revision. Mismatched or
unsupported grains are refused, never resolved to latest. Projection uses
Web Annotation `oa:SpecificResource`, `oa:hasSource` and
[selectors/state](https://www.w3.org/TR/annotation-model/#selectors).
The existing `work-reference-block-v1` keeps its Work-only meaning.

A mention retains its fallback without granting target access. Adopted
instructions must resolve the exact selection or return explicit unavailability.
Intermediate Recipe references resolve through a separate bounded request,
never recursive expansion. Readers re-fence all hydrated dependencies. Publishing
a recording adoption binds a normal exact Media Use to the Recipe publication;
the instruction answer includes its `mediaUse` for Media's existing metadata and
byte-delivery operations. A reference alone cannot make private bytes public.

## One structured procedure

The only stored structured instruction form is a Content `extensionBlock` with
definition `https://rezics.com/definition/procedure-v1`, version `1`, payload
`{ items }`. Each ordered item is either
`{ id, type: "HowToStep", document }` or
`{ id, type: "HowToSection", name: { value, language }, items }`.
Step documents are ordinary Blocks documents, admitting prose, inline/block
Resource references and managed media. IDs are unique within the procedure;
sections may be empty. The payload admits at most 128 items, 16 section levels
and 256 KiB; normal document limits also apply. Nested procedure blocks are
refused. Known extension payloads are validated at Content save; opaque payload
retention alone does not establish procedure admission.

Projection uses `schema:HowToSection`, `schema:HowToStep`, ordered
`schema:itemListElement`, names and language. It is derived, not a second
editable representation. Reuse selects a block at an exact Content revision;
native export retains the document, selected block and references.

## Content derivation

Content owns immutable `{ derivation, output, inputs, activity, responsibleAgent }`
records. `output` is an exact Content reference. `inputs` has 1–16 exact Content,
revision, occurrence or representation references with optional fragments;
bare Resource inputs are refused. `activity` is `{ id, kind }`, with `kind` one
of `transcription`, `translation`, `transformation`, `ai-generation`. These wire
enums classify the PROV Activity, not new Recipe-local predicates. The responsible
public Agent is separate from the submitting actor. An AI service Agent maps to
`prov:SoftwareAgent`; transformation credit is neither source authorship nor
clearance. A caller must represent the output custodian and supply evidence of
the responsible Agent's participation; naming another Agent cannot fabricate
its attestation.

For each input the output has `prov:qualifiedDerivation` of type
`prov:Derivation`, with `prov:entity` selecting that input and `prov:hadActivity`
selecting the Activity. That Activity `prov:used` the input; the output
`prov:wasGeneratedBy` the Activity, whose `prov:wasAssociatedWith` selects the
responsible Agent. These are the
[PROV-O qualified derivation terms](https://www.w3.org/TR/prov-o/#qualifiedDerivation).
The output revision's bytes are unchanged. Source support, native control,
withdrawal, input erasure and rights remain independent. Public delivery shows
readable inputs or explicit unavailability without concealed identifiers.

## API operations

The [typed outcome examples](../../scripts/qa/cases/outcomes/recipes/instructions-in-any-form.ts)
pin these requests and responses for this slice. All JSON writes have public
exposure, bearer authentication, Idempotency-Key and the owning write family
(upload family for Media). Current represented custody and Access admission
are required. Stable-key replay returns the same identities and `replayed: true`;
changed retry payloads conflict. Reads use the read family, optional authenticated
`actingSubject` and private/no-store caching. New exposure declarations require
trust-ops review at implementation.

| Operation | Request | Response |
| --- | --- | --- |
| **New** `POST /v1/posts` | `authored-post-v1`, title `{value,language}`, language, document, actor | 201 (200 replay) `{ post, variantId, revisionId, byteDigest, author, replayed }`: native Post custody and private Content draft, not a Work or public publication |
| Existing `POST /v1/content-drafts` | `content-text-v1`, resource/variant, language descriptor, direction, expected head, document, actor | Existing exact draft result `{ resourceId, variantId, revisionId, predecessor, byteDigest, sourcePosition, replayed }`; extended validation for procedure/reference payloads |
| Existing `POST /v1/media/uploads`, new admitted profile | `media-recording-upload-v1`, asset UUID or null, media type, byte length, SHA-256, private disclosure, actor | 201 reservation `{ asset, upload, stateHead, uploadUrl }`; validated WAV audio/MP4 video under existing upload capacity |
| Existing `PUT /v1/media/uploads/{upload}/bytes` | Reserved raw bytes with content type and length | Existing 201 activation `{ asset, upload, status, representation, revision, clearance, clearanceReason, reason, replayed }`; invalid/different bytes cannot activate |
| **New** `POST /v1/content-derivations` | `content-derivation-v1`, exact output, exact inputs, activity `{kind}`, responsible Agent, `expectedOutputHead`, actor | 201 (200 replay) record above plus `replayed`; exact membership, output head, readable inputs and responsible Agent representation are checked |
| **New** `GET /v1/content-revisions/{revision}/derivations` | Optional actor, limit 1–20, opaque cursor | 200 `{ revision, items: [record], nextCursor: string or null }`; revision-bound continuation and input disclosure |
| Existing `POST /v1/compositions/{structure}/changes` | Recipe profile, expected head, actor, 1–16 existing operations; insert/update `instruction` target with selection `{mode:"fixed-revision",revision,selector}` | Existing 200 revision/occurrence receipt; selector above must agree with selection revision; ordering remains Structure's |
| Existing `POST /v1/work-publications` | Exact Work/Structure heads, expected publication head, original-contribution basis, public disclosure, actor | Existing immutable decision plus exact dependency selections; extended admission checks Content/Media custody, rights and every adopted dependency |
| Existing `GET /v1/recipes/works/{work}` | Optional actor, servings, cursor; **new optional `revision`** for exact selection | Existing bounded page plus `instructions: [{occurrence,reference,status,document?,mediaUse?}]`; available procedures retain their block/document, recordings retain representation and exact Media Use; unavailable dependencies are explicit |
| Existing `GET /v1/content-revisions/{revision}` | Optional actor | Existing exact Content result, including original document and serialized bytes; publication exposes only selected dependencies |
| Existing Recipe export, new `format=native`/`schema-org` | Exact authorized Structure revision, optional actor | Native: `{format:"native",structure,revision,occurrences,contents,derivations,losses:[]}`; Schema.org: existing result plus structured `losses` as defined by [exchange](recipe-exchange.md#decided-content-adoption-boundary) |

Invalid payload/selector is 400; missing and concealed targets share 404;
unauthenticated writes are 401; unauthorized changes 403; stale heads/cursors
409; admitted but unpublishable/unsupported forms 422; upload/capacity refusals
413 with measured/allowed values; unavailable owners 503. Multi-owner operations
may return 202 with an existing operation handle, then settle to the result
above. Pending/partial work is never reported as atomic success. Publication
pins dependencies without publishing unrelated Content/Media revisions.
