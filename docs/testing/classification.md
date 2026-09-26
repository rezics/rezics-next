# Objects, statements and contextual classification acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| CTX01 | Use one Work/Main Version in two Realms and Zones | Shared resource and statement meaning; independent acceptance/ratings/adopted text. |
| CTX02 | Local reject with inherited Global acceptance | Rejection suppresses; no absent-state fallback. |
| CTX03 | Local decision is unreadable or unavailable | Do not infer absence or reveal private state. |
| CTX04 | Same label or navigation route reaches different scoped meanings | Exact resource/definition/canon references remain independent; Realm naming or navigation changes cannot reinterpret earlier statements. No mandatory Sense identity. |
| CTX05 | HairColor=Red versus bare Red and EyeColor=Red | Distinct meanings and judgment targets; an explicitly equivalent RedHair definition resolves the hair-color meaning without merging RedHair and Red identities. |
| CTX06 | Union conflicting Realm rules before inference | Rejected plan; derivation stays context-bound. |
| CTX07 | Different same-language preferred names | Context label selection preserves SKOS export validity. |
| CTX08 | Cycle/reparent vocabulary concurrently or move a display group | Admitted topology remains valid without global corpus locks; group movement creates no facts and changes no statement identity/count. |
| CTX09 | Retire a definition used by earlier Statements or retained v1 records | Old exact meaning remains resolvable; new use obeys admission; historical receipts/replay cannot reinterpret labels. |
| CTX10 | Change one rule with many targets | Bounded invalidation/generation switch; no Resource x Realm rewrite. |

Record inputs, operation receipts, exact profiles/builds and failures. A mock-only
pass cannot qualify storage, cross-service behavior or capacity.

The 2026-09-26 [model simplification](../contracts/classification.md) changes the
target representation while retaining all ten case IDs and their semantic
obligations. Additional checks within these cases must cover:

- CTX01/CTX05: create a resource/statement without allocating Scheme, Path,
  Expression, Sense and Application companions. Preserve independent supporting
  statements when one effective fact is displayed.
- CTX04/CTX05: same labels with different meanings, one exact named pattern versus
  its expanded statement, and an unmapped source term. No guessed equivalence.
- CTX01/CTX02/CTX03: resolve before grouping; local rejection, unavailable state,
  source withdrawal and private/spoiler-protected support cannot yield a misleading
  fallback, leaked count or fabricated native vote.
- CTX08/CTX10: several navigation paths and overlapping display groups do not
  multiply distinct targets; changing a group does not rewrite semantic facts.

The retained runs below exercised installed v1 Application/Sense profiles.
They do not qualify replacement Statement schemas or aggregate reads. The manager
must re-evaluate migrated coverage and run the relevant owner checks before
claiming complete acceptance on the new profile.

The registered [CTX02 owner fixture](../../tests/qa/integration/public-selection-oracle.test.ts)
creates a real Work, Global decision and Realm classification context. Main's
classification resolution API first returns inherited Global acceptance, then
returns the local Realm rejection with its exact decision identity while the
Global resolution stays accepted. The Realm search result also loses the Work,
and another Realm remains unchanged. Selected integration
`20260925t183629-db4f16` passed; its CTX02 complete-case declaration awaits a
complete run.

The same real owner fixture now creates a Realm-local rejection over an accepted
Global decision, then injects two graph read faults at Main's read boundary. A
response with the local application but unreadable decision/outcome and a failed
read both return 503 from resolution and public classified search. Neither
response falls back to the Global acceptance or includes either decision ID or
the private failure text. Selected integration `20260925t194147-c1de17` passed;
CTX03 is declared for the final complete run. This does not exercise arbitrary
loss of all local application triples from a graph response.
