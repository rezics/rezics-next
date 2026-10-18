# Information outcome specification handoff

`catalogue/supporting-information` and `catalogue/ordered-domain-read` retain all
12 persona cells as pending. The [matrix](../../../tests/qa/fixtures/catalogue-information-matrix.ts)
and independent tests specify required behavior; compilation and registry admission
establish no product outcome. G-2768 owns registry enrollment.

## Current shared boundary and proposed additions

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

The matrix proposes extensions to those shared contracts, with no provider or
domain switch:

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

These additions require Program's reading before implementation. The request
names the G-2772 brief and the matrix; delivery failed with
`Unknown mail Goal: program`. The retained delivery record is
`.temp/audit-remediation-20261019/event-G-2772-5/program-reading.txt`.
There is no Program approval or contract disposition. A separate implementation
assignment follows that disposition and baseline evidence.

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

## Deferred baseline selection

The named selection `information-support-and-order` comprises exactly these files:

| Prove file | Personas |
| --- | --- |
| `tests/qa/integration/outcomes/catalogue/supporting-information.test.ts` | visitor, stranger, member, owner, moderator, operator |
| `tests/qa/integration/outcomes/catalogue/ordered-domain-read.test.ts` | visitor, stranger, member, owner, moderator, operator |
| `tests/qa/integration/catalogue-partial-read.test.ts` | visitor, stranger, member, owner, moderator, operator |
| `tests/qa/integration/collection-domain-roles.test.ts` | visitor, stranger, member, owner, moderator, operator |

The future pristine product baseline is
`69eac3ceeaf885be70205a70248bc951e9d81cc9`. Decision `task:G-2772:5` corrects
only the future matrix pin; historical attempt metadata keeps its original pin
and result. The prior missing-corpus attempt reached no product assertion, and
this correction establishes no new baseline result.

This outcome author owns the later selection execution, only after explicit
release, Program contract disposition and G-2791's genuine receipts,
baseline-compatible persona setup and stopped backup. Restore a pristine isolated
copy per file; the mutation file must not share live owner state with another
file. Preserve the 600-second preparation budget and classify setup failures
separately from reached test-body assertions. The current resume permits only
stack-free correction and plan checks. No preparation, stack start, baseline or
fixed run, browser work, shared writes or production implementation is released.
Declarations remain pending through combined proof and manager disposition.
