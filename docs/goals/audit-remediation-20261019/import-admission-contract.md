# Pending retained-record and native-support contract

This extends the [import specification](import-outcomes.md) under the manager's
joint Source and native-field ownership decision. It is a proposal for program
reading and disposition, not production implementation or proof. The frozen
JSON matrix, original audit baseline, selections, source/record/edge digests,
positive assertions and twelve pending cells are preserved. The executable
proposal types are in
[import-admission-contract.ts](../../../tests/qa/fixtures/catalogue/import-admission-contract.ts);
the assertions are in
[import-outcomes.ts](../../../tests/qa/support/import-outcomes.ts).

## Present contracts and command gaps

Static reading of the current wave establishes these boundaries; it is not an
executed command result.

| Current operation or owner | Current behavior | Pending addition |
| --- | --- | --- |
| `POST /v1/sources/intakes` | One actual observation/Source record and raw-byte digest per intake; 65,536-byte ceiling | None. Retain every real receipt, including part-record identities |
| `POST /v1/sources/observations/{observation}/conversions` | Body contains only a registered mapping `profile`; `source-mapped-conversion-v1` returns one observation, mapping revision, byte-based source digest, projection and field inventory | An explicit `source-retained-record-conversion-v1` request and verified `retainedRecord` addition to that result; no second conversion owner |
| Source adapter registry | `bangumi-subject-map-v1` is the registered mapped converter; Open Library has its existing separate conversion path | VNDB, MusicBrainz multi-grain and full normalized-record/multipart correspondence are not thereby supported |
| `POST /v1/sources/field-supports` | `source-field-support-attachment-v1` takes `sourcePointer` into **one observation JSON**. The evidence owner checks mapping, inventory, raw bytes and `SHA-256(JSON.stringify(pointedValue))` | `source-field-support-attachment-v2` names the verified record binding and a full-record field coordinate, plus exact native-owner basis |
| Native support adapters | Work semantic-types/scalar-value and Structure occurrence slots have verifiers | The proposed name adapter and arbitrary Semantic/Statement fields are not admitted by those adapters |
| Withdrawal and human control | Existing support withdrawal, source-managed/human-controlled synopsis and source-title application owners | Consume them; do not create another support system or infer publication/rights from attachment |

Read the actual schemas and handlers in
[sources.ts](../../../services/main/src/routes/sources.ts),
[source-supports.ts](../../../services/main/src/routes/source-supports.ts),
[support-attach.ts](../../../services/main/src/modules/source/support-attach.ts) and
[provider-adapters.ts](../../../services/main/src/modules/source/provider-adapters.ts).
Current field errors are 400 `invalid_source_withdrawal`, 409
`source_support_changed` and 503 `source_support_unavailable`; the proposed v2
refusal detail below is not a claim about today's responses.

## Record, bytes and field coordinates

The proposed conversion request goes to the existing conversion route at the
**first actual intake observation**. `RetainedConversionRequest` contains:

- `profile: source-retained-record-conversion-v1` and a Source-registered
  `mappingRevision`; a caller naming a revision cannot register one.
- `retained.identity`: exact selected `key`, `provider`, original `namespace`
  and `externalId`; `retained.snapshot`: pinned `id`, logical `digest` and
  exact snapshot `fileSha256`.
- `retained.record`: the entire exact normalized `DatasetRecord`, including
  `title`, `language`, `sourceUrl`, `native` and optional `semanticTypes` outside
  `.data`; `recordDigest` is SHA-256 of the repository's `canonicalJson(record)`.
- Ordered `intakes: [{index, record, observation, byteDigest}]` using actual
  intake receipts. Multipart part namespaces/IDs are not the original record
  namespace/ID. A first part's Source record cannot stand in for that original.
- `payload: {format, byteDigest, byteLength}`: `json` describes the original
  single intake bytes; `rezics-dataset-chunk-v1` describes the decoded ordered
  concatenation verified by the existing `reconstructIntake`. Each part also
  retains its own raw-byte digest. Do not canonicalize a parsed response and
  claim that its digest is the hash of the original bytes.

The Source owner must verify correspondence with a registered normalization
revision, not trust the request's record/digests as a successful conversion.
An actual `rezics-dataset-record-v1` retained envelope can supply `/record/...`;
a bare provider payload cannot be relabeled as that envelope. Fields derived
from source identity or capture metadata need explicit registered rules and
their retained inputs. `native` is an import candidate annotation, not a provider
assertion, adoption or permission. If a normalized field cannot be grounded,
its native admission remains unresolved; do not invent a provider pointer.

`RetainedRecordBinding` returns an actual immutable `binding`, canonical original
`sourceRecord`, `conversion`, mapping and `normalizationRevision`, plus the exact
identity/snapshot/record digest/intake/payload coordinates. It stages evidence;
it does not adopt fields. Repeating the same request returns 200 with the same
binding and `replayed: true`; a first accepted conversion returns 201. Existing
legacy conversion/proposal/adoption receipts remain separate and unchanged.

The proposed support request uses a **full-record** `evidence.field.pointer`,
not v1's observation `sourcePointer`, and includes presence, optional
`valueDigest`, exact optional `language` and optional alias `ordinal`. Omission,
null, empty text/array/object and a measured zero remain different states. The
value digest uses `canonicalJson` of the whole pointed value. For a line alias,
the pointer still names the parent string, its digest covers that string, and
zero-based `ordinal` selects the exact line under the registered rule; an alias
line is not a fictional array element or native occurrence ID. Source grain,
field and source occurrence remain explicit in the existing support flow.

The frozen inventory's existing `source.pointer` remains relative to
`DatasetRecord.data`; its 371 keys and digests do not change. Thus the elected
VNDB `/alias` inventory coordinate corresponds to full-record `/data/alias`,
while normalized `/title` is a distinct coordinate. Neither is automatically
an observation coordinate. RFC 6901 defines pointers within a specified JSON
document, with exact escaping and no Unicode normalization; it does not
establish correspondence between different documents.
([RFC 6901, sections 3–4](https://www.rfc-editor.org/rfc/rfc6901#section-3))

## Native owner verification and receipts

`source-field-support-attachment-v2` retains target, slot, occurrence/context,
source record/conversion/grain/field/source occurrence, acting subject and
expected head. Its `evidence` identifies the retained binding, record digest,
mapping revision and field coordinate. Its `native` is an exact native-owner
basis, using the existing codecs:

- Component property: `kind: component-property`, `target`, owner `revision`
  and `property: {predicate, value: SemanticValue}`. There is no fabricated
  Statement ID or acceptance.
- Statement: `kind: statement`, `target`, owner `revision`, actual `statement`,
  `predicate`, `value: StatementValue`, `context`, exact qualifiers and nullable
  acceptance. G-2772 retains independent readable fact/value/attribution assertions.

The native owner must verify the exact target/value/current head, jointly with
Source's evidence admission. Successful conversion alone cannot authorize
native support. Work scalar/type and Structure slots, and the proposed name
slot, do not accept arbitrary semantic predicates. Unsupported fields remain
an explicit unverified/unmapped disposition until their owner admits them.

The normal support response retains its existing record-scoped identity and
adds `admission: source-field-support-admission-v1`: exact source record,
conversion, evidence, native basis, truthful `headGuarantee`, and
`correspondence: {normalizationRevision, rule, payloadPointers,
selectedValueDigest}`. Payload pointers name the actual single or reconstructed
JSON. For the Bach tests, exact normalized `/data/name` maps to actual `/name`
in bare artist JSON or `/record/data/name` in a genuinely retained envelope;
the release credit similarly retains its real nested pointer. The two fields
both say Johann Sebastian Bach and denote the same retained artist identity.
No test accepts a constructed envelope or inferred successful correspondence.

Same-key replay returns the same support receipt with `replayed: true`; a new
request for the same record/target/slot/occurrence/context still names the same
support identity. Two records yield independently withdrawable supports, not
evidence of independent providers. Withdrawing one preserves the other and
the native name. Separately, after the owner confirms the exact imported
synopsis, withdrawing its actual source support preserves human control and
the exact public text. No replacement provider text is invented for either case.

Preserve source-supplied language spelling or its omission/null in evidence.
A native codec's canonical tag is a separate representation. RDF literal
identity includes lexical form, datatype and language; a UI locale does not
establish a source language.
([RDF 1.1 Concepts, section 3.3](https://www.w3.org/TR/rdf11-concepts/#section-Graph-Literal))
Multiline/oversized/untagged synopsis and description text must remain exact
in retained evidence; trim/truncation and guessed tags cannot make an unsupported
native owner pass. Preserve numeric lexical precision, units and date precision;
do not round a large decimal or expand a month into a made-up day. An owner
limit or missing representation leaves a reasoned unresolved disposition.
The accepted Bangumi synopsis and other elected native fields remain mandatory
positives; blanket source-only still fails.

## Refusals, authority and proof boundary

The executable request mutations specify these **proposed** private refusals:

| Request | HTTP and code | Exact `basis` |
| --- | --- | --- |
| Conversion with another normalized record but the original identity | 409 `source_conversion_changed` | `record` |
| Conversion with a wrong record digest, raw-part byte digest or part order | 409 `source_conversion_changed` | `record-digest`, `byte-digest`, `part-order` |
| Support with another record, record digest, conversion or source value digest | 409 `source_support_changed` | `record`, `record-digest`, `conversion`, `value-digest` |
| Support with a wrong exact native target, value or head | 409 `source_support_changed` | `native-target`, `native-value`, `native-head` |
| Unregistered/unverified mapping or unsupported native verifier | 422 `source_mapping_unverified` | No admitted support |
| Invalid coordinate, alias selector or occurrence basis | 422 `source_coordinate_invalid` | No admitted support |

The mismatch tests use fresh request keys, read the successful binding/support
after each refusal and require it to remain unchanged. Wrong heads use another
actual retained owner revision. No stale native value is manufactured as source
evidence. Unavailable owners remain 503 with no support success; lost responses
use existing settled idempotency receipts. Foreign-principal evidence remains
indistinguishable from absent evidence (404), before disclosing any mismatch.

All commands consume explicit `platform:catalogue-import`, source scopes and
actual scoped native edit authority through Access. Realm role, sign-in,
membership and moderation are negative authority cases. Rights assessment and
publication remain separate real prerequisites for public reads; attachment
does not license synopsis, covers or source activity. New binding/digest/intake
internals must not appear in public coverage or attribution responses.

G-2781 remains producer adapter, G-2778 sole importer wiring owner and G-2791
sole corpus producer. G-2772 owns native Semantic/Statement verification and its
independent information assertions; G-2769 owns retained conversion/inventory
and support lifecycle assertions. Manager relay of this boundary was accepted
as `mail:7ca206eb-1fa1-4f8b-a8b2-60f8311bd2f2`; it is not a program disposition
or evidence that G-2772 has approved these shapes. The earlier program-reading
mail was rejected because no program Goal was registered; it was not delivered.

Only stack-free contract/unit/static checks are authorized here. The
[shared consumer handoff](import-corpus-handoff.md) retains the original baseline,
one stopped-owner backup, isolated serial restores, 600-second preparation
budget, exact prove/persona mapping and deferred execution authorization.
