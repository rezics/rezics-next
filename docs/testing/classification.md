# Objects, statements and contextual classification acceptance

These are prospective tests, not executed results. Run at the applicable
[verification phase](../plan/execution-workflow.md), preserving actual owner
boundaries, source snapshots and positive/denied/partial outcomes.

| ID | Scenario | Required result |
| --- | --- | --- |
| CTX01 | Use one object and shared Context across two Realms, an individual and Zones | Shared identities/definitions with independent scoped selections, speaker authority, acceptance, ratings and adopted text. |
| CTX02 | Local reject with inherited Global acceptance | Rejection suppresses; no absent-state fallback. |
| CTX03 | Local decision is unreadable or unavailable | Do not infer absence or reveal private state. |
| CTX04 | Same label/object reaches different personal/Realm meanings while a narrower named concept exists | Exact resource/definition/canon references remain independent; concept creation does not remove local reinterpretation. Global/default selection, Realm voice and personal voice stay explicit; existing statements retain their meaning. No mandatory Sense identity. |
| CTX05 | HairColor=Red versus bare Red and EyeColor=Red | Distinct meanings and judgment targets; an explicitly equivalent RedHair definition resolves the hair-color meaning without merging RedHair and Red identities. |
| CTX06 | Union conflicting Realm rules before inference | Rejected plan; derivation stays context-bound. |
| CTX07 | Different same-language preferred names | Context label selection preserves SKOS export validity. |
| CTX08 | Cycle/reparent vocabulary concurrently or move a display group | Admitted topology remains valid without global corpus locks; group movement creates no facts and changes no statement identity/count. |
| CTX09 | Retire a definition used by earlier Statements or retained v1 records | Old exact meaning remains resolvable; new use obeys admission; historical receipts/replay cannot reinterpret labels. |
| CTX10 | Change one rule with many targets | Bounded invalidation/generation switch; no Resource x Realm rewrite. |

## Shared Context qualification

The [shared Context contract](../contracts/context.md) adds these prospective
subcases to the same ten IDs; it adds no inventory ID or runtime pass:

- CTX01: create a Context without a Realm, adopt the same published semantic
  revision in two Realms and one private personal selection, and keep their
  acceptance/voters independent. One Realm retains Global for a different
  object/domain. A member's personal statement and an authorized Realm statement
  use different interpretations of the same object without changing authorship.
- CTX01/CTX08: a reader can use an eligible public Context without its creator's
  Realm membership; a Realm selector cannot edit the Context, and a Context editor
  cannot select it for an unauthorized Realm or speak on that Realm's behalf.
  Cover allowed, denied, revoked, stale, idempotent and concurrent transitions.
- CTX02: acceptance inheritance considers the same exact meaning; Global acceptance
  of a broad definition cannot silently support a local changed criterion. An
  explicit rejection still stops fallback. Reviewed mappings retain exact basis.
- CTX03: a private personal selection, hidden Context/base/definition and missing
  retained revision reveal no identity or count. An unavailable or explicitly
  unresolved entry cannot inherit as though absent. Public statements require a
  readable meaning basis or an explicit incomplete/unavailable outcome.
- CTX04: Global contains a complete specialist definition without a specialist
  Realm. Distinguish omitted entry default, explicit Global and explicit local
  selection; unresolved polysemy returns qualified candidates/ambiguity.
- CTX04: keep both `後宮` and `真後宮` as concepts while Realm and personal
  Contexts reinterpret `後宮` differently. Also reinterpret `真後宮`; neither
  name settles open-ending/cohabitation/marriage criteria. No rename, deletion or
  automatic equivalence occurs merely because the other concept exists.
- CTX04/CTX05: distinguish a changed criterion, disagreement about evidence under
  one criterion, and preference for certain outcomes. Only the first changes
  qualified meaning. Two Contexts sharing the same exact definition need not
  produce different meaning keys; separate support and decisions remain intact.
- CTX06: explicit selection wins over admitted speaker scopes, then entry default,
  then Global. Equal-priority overlap, a pinned-base cycle and over-budget depth
  return declared failures rather than an arbitrary winner or mixed inference.
- CTX07: changing language, chosen name, emphasis, avatar or order preserves
  interpretation; export retains scoped definitions and valid SKOS labels.
  A preferred reading cannot replace an authored statement or saved exact filter.
- CTX08/CTX09: concurrent Context edits have one expected-head winner. Publishing
  a semantic successor changes no pinned consumer or statement; successor adoption
  has its own CAS. Derived Contexts preserve their exact base. Retire/restore and
  replay retain definitions, selections, speaker, decisions and private ownership.
- CTX10: grow unrelated consumers and statements while resolving one bounded slot;
  no member scan, per-object interpretation calls or Cartesian materialization.
  Preference-only changes do not rewrite semantic projections. Explicit adoption
  and rule changes invalidate only the declared dependent generations.

Use real graph-owned Context/Realm selections and Access-owned private selections,
current authority and retained owner receipts in implementation qualification.
Documentation, shape-only checks and existing Work/Realm APIs do not establish it.

## Earlier Statement transition and retained evidence

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
`20260925t183629-db4f16` passed for that earlier profile. The superseded CTX02
complete-case declaration is retired pending replacement qualification.

The same real owner fixture now creates a Realm-local rejection over an accepted
Global decision, then injects two graph read faults at Main's read boundary. A
response with the local application but unreadable decision/outcome and a failed
read both return 503 from resolution and public classified search. Neither
response falls back to the Global acceptance or includes either decision ID or
the private failure text. Selected integration `20260925t194147-c1de17` passed;
the superseded CTX03 complete-case declaration is retired pending replacement
qualification. This does not exercise arbitrary loss of all local application
triples from a graph response or the shared Context contract above.
