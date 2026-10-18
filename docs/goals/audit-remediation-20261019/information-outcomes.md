# Information outcome specification handoff

`catalogue/supporting-information` and `catalogue/ordered-domain-read` retain all
12 persona cells as pending. The [matrix](../../../tests/qa/fixtures/catalogue-information-matrix.ts)
and independent tests specify required behavior; compilation and registry admission
establish no product outcome. G-2768 owns registry enrollment.

## Current shared boundary and accepted read target

The existing boundary uses `entity-page-v1` through
`GET /v1/resources/{id}/page`, `subject-statements-v1` through `/statements`,
`resource-relations-v1` through `/relations`, the shared Structure `/parts` read
and `/v1/collections/{id}`. It retains resource identity, base and types, registry
bindings, owner revisions, exact Statement values and qualifiers, evidence,
role-bound relations and occurrence-based order. Component properties retain
their own value codec and revision without fabricated Statement identities.
Descriptive Person/Organization and PublicationEvent identities grant neither
acting authority nor native Release ownership. Access and rights owners remain
the authorities; generic membership does not establish Collection purpose.

The shared information contract reading accepted these extensions as the target
for separate implementation, with no provider or domain switch:

- Fact groups add ordered `display` and explicit `coverage` states, source
  references and retry information. Unknown, unmapped, withheld, empty and
  unsuccessful reads remain distinct; frozen source pointers and digests bind
  attribution to actual values.
- Inverse entries add exact `applicability`; both directions preserve the same
  occurrence, revision, role, counterpart base and citations.
- Collection incidence adds nullable `collectionPurpose`, backed by an adopted
  purpose assertion, distinguishing reading lists, recipe selections, series and
  franchises. A title mentioning series does not establish purpose.
- Shared parts add general admitted-resource `target` and attributed
  `sourceOrder`. Medium containers, repeated track uses, recordings and
  compositions retain their distinct identities and grain.
- Partial pages preserve identity, type and successful sections while independent
  failures expose bounded retry. Cursors bind the public selection: changed
  bindings return 400, stale public selections return explicit 409 restart
  information, and private changes preserve public continuation. Optional counts
  match the visible-only oracle.

That decision supersedes the unresolved reading condition in `task:G-2772:5`
for this read proposal. The earlier delivery failure, `Unknown mail Goal: program`,
remains historical evidence in
`.temp/audit-remediation-20261019/event-G-2772-5/program-reading.txt`;
it is not an acceptance receipt. Contract acceptance establishes no execution or
persona proof and releases no implementation under this outcome brief.

## Joint native-value and source-support proposal

The queued decision at
`03e5fe764bce0bc8b2729a0f8c28327cf0c40d48:docs/goals/audit-remediation-20261019/tasks/G-2772.md`
authorizes this bounded specification. The new admission proposal requires
Program disposition; the accepted read target above stays accepted.
The [test contract](../../../tests/qa/fixtures/catalogue-information-contract.ts)
contains the exact request, binding and receipt types; the matrix's
`nativeInformationAdmission`, `nativeReadCases` and `nativeAttachmentRefusals`
state the decisions and expected refusal codes.

Current native commands are `POST /v1/semantic/changes`, `POST /v1/statements`
and `POST /v1/works/{id}/fields/synopsis/control`, with their existing reads,
current heads and real command receipts. Statement recording, acceptance and
support remain distinct. Source already owns
`POST /v1/sources/field-supports`, `GET /v1/sources/field-supports/{support}`
and `POST /v1/sources/withdrawals`. Its current attachment request names
`target`, `slot`, `occurrence`, `context`, `sourceRecord`, `conversion`, `grain`,
`sourceField`, `sourceOccurrence`, `sourcePointer`, `expectedHead` and
`actingSubject`, with an Idempotency-Key. Successful attachment answers
201 `{support, replayed:false}`; exact replay answers 200 with the same support
and `replayed:true`. Withdrawal reports `nativeEffect: none`.

The current attachment verifier admits Work semantic-types/scalar-value slots
and bounded Structure occurrence paths. The proposed name slot does not admit
arbitrary semantic fields. Current editorial synopsis is a nonempty string
bounded to 8,000 characters, without a supplied-language field; tagged, bounded,
single-line Work localized metadata cannot stand in for every synopsis.
These facts come from the current
[attachment verifier](../../../services/main/src/modules/source/support-attach.ts),
[Source routes](../../../services/main/src/routes/source-supports.ts) and
[editorial owner](../../../services/main/src/modules/source/field-control-native.ts).

Proposed additions through those same owners are:

- `NativeSupportAttachment` adds `native: NativeValueBinding` and
  `retained: RetainedFieldBinding`. Native verification binds exact target,
  owner component/Statement, predicate, typed value, qualifiers, current head and
  genuine native receipt; a Statement also binds meaning and existing acceptance.
  Component properties gain no Statement identity or acceptance.
- G-2769's Source conversion inventory exposes each entry's verified `retained`
  binding: exact inventory/source key, record/conversion/mapping/grain/field,
  normalized record identity/digest/pointer, presence and supplied language,
  resolved observation/pointer/digest and the complete ordered intake part list.
  A normalized `/data/...` pointer is not an observation pointer. Record, raw
  observation, source-value and typed-native digests have distinct meanings;
  the owning conversion must verify the mapping, including multipart intake.
- `NativeSupportReceipt` extends `source-field-support-v1` with those checked
  bindings, rights-filtered `publicEvidence`, and
  `attachment: {profile, receipt, requestDigest, nativeReceipt}` using
  `source-field-attachment-certificate-v1`. `graphReceipt` is the verified native
  receipt. Keep the actual `headGuarantee`; verified-before-commit does not claim
  cross-owner transactional atomicity. A projected candidate or matching digest
  acknowledges neither native admission nor support.
- `NativeSynopsisRequest` adds exact supplied-language state to the existing
  editorial command. Exact text, newlines, numeric/date precision, omitted/null/
  empty distinctions and language spelling survive. No trimming, truncation,
  Unicode rewriting, flattening or UI-locale substitution is allowed. An oversized
  or unrepresentable value remains explicitly pending/source-only, with a reason
  and retained bytes, until its native owner admits a lossless representation.
  This does not allow all source-only: tagged, multiline and untagged synopses,
  an exact numeric lexical, a precise date and a domain fact require native reads.
- Public fact evidence adds readable `attribution: {sourceName, sourceUrl, licence}`
  and `language: {state: omitted|null|value, value?}` while retaining exact evidence
  identity, digest, locator and rights basis. Existing Access/rights owners alone
  determine disclosure, reuse and action authority. Import authority does not
  grant publication rights; private evidence must remain unavailable publicly.

Refusals preserve native content and return no successful support/receipt:
target, property, value, qualifiers, head, conversion, native receipt, resolved
evidence or part-order mismatches use 409 `source_support_changed`; absent or
incomplete retained evidence uses 503 `source_support_unavailable`; another
principal's evidence uses indistinguishable 404 `source_support_unavailable`;
rights refusal uses 403 `rights_denied`. Proposed 400 `invalid_source_attachment`
identifies an unadmitted slot; the current malformed-attachment code is
`invalid_source_withdrawal`. Exact idempotent replay returns the original support;
a changed request under that key refuses with 409. Each genuine source record
keeps a separately withdrawable support. Withdrawal preserves another qualifying
support, native values, acceptance and human content/control. Two records do not
prove independent providers.

Coordination with G-2769 was sent through Goal mail
`mail:c008fe27-61cb-4e30-a326-80a4408a27e4`. The proposed `retained` shape above
is the consumer requirement to reconcile with that owner's conversion/inventory
specification before implementation; no agreement or Program disposition is
inferred from delivery. G-2781 remains a producer adapter and G-2778 the sole
importer wiring owner. Both consume only admitted contracts backed by actual
public native/Source command acknowledgements. No producer or wiring code changes
under this specification.

## Corpus consumer and preparation owner

[InformationCorpus](../../../tests/qa/integration/support/catalogue-information.ts)
consumes profile `catalogue-information-corpus-v1` from
`.temp/fixtures/catalogue-information/corpus.json`, or `REZICS_INFORMATION_CORPUS`.
G-2791 is the single preparation owner; this specification creates no second
producer or ad hoc seeds. The consumer requires:

- Genuine source-backed supporting records and inverse bindings with exact native
  identities, source identities, frozen bytes, JSON pointers, digests and rights
  assessments; a complete visible-only `sectionCounts` oracle for each record.
- Ordered episode, medium and track occurrences, including repeated recording
  uses; explicit Collection purpose assertions and ordinary-membership controls.
- Coverage/value controls, hidden identities/evidence/paths, successful empty and
  null controls, recipe/chapter recovery controls, and public/private mutation
  commands with genuine receipts and idempotency/write bases.
- Baseline-compatible retained six-persona setup, preparation timing and command
  receipts, plus one stopped consistent backup covering Account, Access, Content,
  graph and objects, with verified backup and receipt digests.
- Additive `nativeAdmission` inputs: the ten matrix read cases with original
  normalized records, actual retained observation parts, exact values/languages,
  frozen evidence and truthful native/pending/source-only dispositions; disjoint
  support-control targets, two record supports, scoped rights/private/unavailable
  evidence controls, and genuine stale/mismatched request bases. No new fixture
  producer is introduced. Existing preparation must not demand a successful
  proposed native/support result: absent bindings/receipts are observed in test
  bodies, never filled with successful source data.

Real-command gaps remain: Source's verified normalized-record/multipart inventory
resolution, native owner adapters beyond current slots, language-preserving
editorial admission/read, and acknowledged support/public attribution for those
bindings. G-2791 must retain the actual commands and answers, compatible persona
grants, rights/publication receipts and stopped backup. Missing genuine source
bytes, authority or compatible restore is a preparation/premise failure, not a
product failure. No preparation or command success is claimed here.

## Deferred baseline selection

The named selection `information-support-and-order` comprises exactly these files:

| Prove file | Personas |
| --- | --- |
| `tests/qa/integration/outcomes/catalogue/supporting-information.test.ts` | visitor, stranger, member, owner, moderator, operator |
| `tests/qa/integration/outcomes/catalogue/ordered-domain-read.test.ts` | visitor, stranger, member, owner, moderator, operator |
| `tests/qa/integration/catalogue-partial-read.test.ts` | visitor, stranger, member, owner, moderator, operator |
| `tests/qa/integration/collection-domain-roles.test.ts` | visitor, stranger, member, owner, moderator, operator |

The supporting-information row adds independent exact native synopsis/domain-fact
and readable-attribution assertions for each persona, including current Semantic
and Statement owner reads with exact head, value and meaning bindings. The Collection supplemental
file adds dedicated-target admission/refusal, replay, two-record support and
same-value human-confirmation/withdrawal assertions through real public commands.
All six read the surviving native value and qualifying support; only the explicitly
authorized operator exercises Source commands and the scoped owner confirms human
control. Existing assertions and the other two prove files are preserved.

The future pristine product baseline is
`69eac3ceeaf885be70205a70248bc951e9d81cc9`. Decision `task:G-2772:5` corrects
only the future matrix pin; historical attempt metadata keeps its original pin
and result. The prior missing-corpus attempt reached no product assertion, and
this correction establishes no new baseline result.

This outcome author owns the later selection execution, only after explicit
release, Program disposition of the joint admission proposal and G-2791's genuine receipts,
baseline-compatible persona setup and stopped backup. Restore a pristine isolated
copy per file; the mutation file must not share live owner state with another
file. Preserve the 600-second preparation budget and classify setup failures
separately from reached test-body assertions. The current resume permits only
stack-free specification and affected checks. No preparation, stack start, baseline or
fixed run, browser work, shared writes or production implementation is released.
Declarations remain pending through combined proof and manager disposition.
