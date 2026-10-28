# Owner predicates in shared filters

This document owns the approved owner-predicate wire and private fact semantics. It adopts a specification,
not runtime support. [Library and Collections](library-and-collections.md), [Dynamic Collections](dynamic-collections.md),
[profile consumers](library-profile-consumers.md) and [independent labels](library-labels.md) own their underlying
facts. [Filtered lists](filtered-lists.md) remains the sole authority for indexed execution, disclosure, freshness,
preparation and numeric budgets; [Collection source](collection-source.md) owns source integration.

Semantic owns the shared grammar producer and Collection/dynamic source contract integration. Commerce owns private
fact semantics and native owner plans. There is one shared filter protocol, with no separate Boolean interpreter,
compatibility ABI, personal query parameter, AND-only recipe query or private mirror in the public index.

## Closed additive wire

The following are the exact additive leaves beneath the existing shared `and`, `or` and `not` nodes:

```json
{ "owner": { "presence": true } }
{ "owner": { "state": { "profileId": "PROFILE", "stateSetId": "SET", "in": ["STATE"] } } }
{ "owner": { "label": { "id": "LABEL" } } }
{ "owner": { "session": { "profileId": "PROFILE", "lifecycle": "completed" } } }
{ "owner": { "holding": { "profileId": "PROFILE" } } }
```

These are independent leaf examples, not one JSON request. Uppercase identifiers are logical placeholders, not
valid instantiated wire values. Every object is closed. `owner` contains exactly one family. `presence` accepts
only `true`. State requires exactly `profileId`, `stateSetId` and `in`; `in` contains one or more distinct state IDs
within the accepted descriptor's bounds. Label requires exactly `id`. Session requires exactly `profileId` and
`lifecycle`, whose values are `active`, `completed` or `abandoned`. Holding requires `profileId` and permits only
the optional `kind` and `status` fields, each a released data identifier. Omitting both means any retained holding
accepted by that profile; no additional qualifier is required.

Profile, state-set, state, kind and status IDs use native released-data identifier validation. Label IDs use native
opaque identifier/UUID validation. The existing shared AST bounds apply, including expansion and Boolean nesting;
this document introduces no separate budget. JSON validation stays strict, with no coercion. Unknown fields,
unsupported predicates and operators remain explicit admission errors, never silently ignored successful filters.

There is no account, route, principal, client or pin selector. Release digest and accepting type are not query
fields. Session lifecycle is the fixed native session lifecycle, not a profile entry state. Profile/state/kind/status
vocabularies remain definitions data rather than new kernel enums or vertical-specific flags.

The [shared Filter entry point](../packages/filter/src/index.ts) currently re-exports
[the actual grammar implementation](../packages/filter/src/filter.ts). Its existing type leaf is
`{type:{in:[...]}}`; statement leaves use `property` with `in` or `range`, and optional same-statement qualifiers.
Those spellings, released datatype/unit rules, saved-filter expansion and catalogue unknown semantics remain intact.
The current parser and `FilterDocument` do **not** admit `owner`. Adding the leaves to the shared schema and its
admission/execution consumers is required work, not an export or runtime type supplied by this document.

## Viewer-self binding and admission

For a caller-supplied HTTP filter, `owner` implicitly means the current authenticated request principal's own account.
Native subject/delegation rules determine that principal. It never means the Collection curator or an inferred human
behind a delegated client. Another account's facts cannot enter the lookup namespace, even if identifiers coincide.

Admission checks current authentication, the existing scopes and gates for **every** referenced private family,
and source/read/disclosure authority before private SQL. A public source may be personally filtered only by an
authenticated viewer where native owner-plan admission explicitly supports that source. An anonymous owner filter
is denied, never ignored or folded into public results. A readable public source does not itself admit owner plans.
Do not infer a new scope or denial policy from these leaves.

Native suspension fences pre-existing bearers: such a request returns HTTP `401`, a JSON Problem with code
`invalid_credentials`, and `WWW-Authenticate: Bearer error="invalid_token"`; its outcome maps to denied. Auth cannot
mint a valid suspended bearer. Do not fabricate one through SQL account or token edits. Correct-password suspended
sign-in returns `403 ACCOUNT_SUSPENDED` without creating a session; that behavior belongs to Auth. Missing, invalid
or revoked required credentials retain the existing `401` behavior, insufficient scope retains
`403 insufficient_scope`, and active-account admission remains unchanged. This reachable native contract supersedes
the hypothetical valid-suspended-bearer `403 account_suspended` wording in the linked older list documents.

Trusted built-in/publication membership production is a separate owner-authorized source context, not a caller's
account selector. Public saved output uses only its completed published membership, with current subject disclosure;
it never evaluates fresh curator-private facts for a public reader. Anonymous output and public output viewed by an
editor cannot borrow the curator's private query, pins, labels, progress or holdings.

## Exact private meanings

Predicates select unique canonical subjects within the admitted source/population. They do not automatically make
all owner predicates range over Everything. Explicit presence is how a broader source is restricted to that union.
Stored originals and accepted pins remain unchanged and editable; canonical browsing never collapses distinct
sessions, copies or curated occurrences into one fact. Current original support and terminal eligibility both matter.

### Presence

`owner.presence` is Everything's qualifying union: a live explicit non-null entry state, an effective current live
label assignment, retained nondeleted own session/history, or a retained nondeleted own holding. Any surviving
qualifying fact suffices. Clearing state removes only that state contribution; removing the last qualifying fact
removes presence. Completed and abandoned retained sessions still qualify as history.

Empty or cleared entry shells, label definitions without assignments, trash/soft-deleted snapshots, follows,
curated occurrences, catalogue facts, ratings, reactions alone and published-log snapshots alone do not qualify.
There is no independent presence flag or default state. A label-only or holding-only subject needs no fabricated entry.

### Current state

`owner.state` tests the current canonical effective state. Among merged originals, choose the highest **live**
`owner_write_seq`, then match its scoped accepted `(profileId, stateSetId, stateId)` against the requested profile,
set and `in` values. Do not choose an older matching state instead of the current winner. Archived/deleted states
never compete. Preserve conflicts and each original pin's immutable accepted meaning.

[Owner state-write order](library-and-collections.md#owner-state-write-order) owns allocation, clear, Undo, replay,
migration and bigint semantics. Digest order, timestamps and unrelated revisions cannot substitute for that order.
State clear does not invent a live tombstone and does not erase retained completed-session history.

No live entry means state is false when native evidence is complete. `NOT state X` therefore includes no-entry
subjects in the admitted source/population. It is not a test for absence of completed consumption: a cleared entry
can have a retained completed session, and a label-only subject can have no entry at all. Missing profile capability
for a new write does not reinterpret historical pins or remove historic read/clear rights.

### Label

`owner.label` requires an effective current own assignment and its current live same-owner label parent, including
the native reservation rules in [independent labels](library-labels.md). A deleted parent immediately defeats a stale
positive even while child cleanup is paused. No profile lookup or binding is required; name, current subject type
and public classification cannot stand in for the opaque label ID. A foreign label ID conveys no lookup authority.

### Session history

`owner.session` is `EXISTS` a retained, nondeleted own progress session whose native lifecycle equals the requested
value and whose stored accepting pin has the requested `profileId`. Soft-deleted snapshots do not match. Check the
session's actual stored accepting profile, not current type, current release/head, guessed historical type, entry
state, elapsed amount or a published log. Release activation/retirement does not rewrite accepted session meaning.

Any qualifying session suffices even when other sessions have different lifecycles. Alice's completed session
counts for Alice; Bob's completion never does. Clearing Alice's state leaves her completed history effective until
that native session ceases to qualify. No recipe-specific `notCooked` flag or state-to-history inference exists.

### Holding

`owner.holding` is `EXISTS` a retained, nondeleted own copy accepted by the requested profile, matching each supplied
kind/status against that copy's stored accepted data. Both qualifiers, when supplied, must match the same copy.
Copies remain independent identities, including multiple copies of one subject. A holding does not imply an entry,
session, payment, entitlement or platform; kind/status are profile data, not inferred from a purchase or current type.

## Absence, readiness and disclosure

Complete native evidence with no qualifying own fact establishes known absence. Negation of that owner predicate
can therefore match within the admitted population. Unresolved pins, partial producer coverage, missing canonical
mapping, incomplete indexes, failed dependencies or unavailable native observations are readiness, never
manufactured false or a ready empty answer. A failed stale positive does not by itself prove canonical absence.

Existing catalogue unknown stays unknown/not-proven under NOT. For example, unknown diet is not vegetarian and
does not become a proven nonvegetarian fact through negation. The extension changes no catalogue matcher semantics,
same-statement qualifier association, scalar unit meaning or compact/expanded representation conformance.

Private plan output, including preparation and continuation, is private and `no-store`. Private facts do not enter
public indexes, full text, facets, counts or public subject-membership projections. Current source authority,
Access, original and terminal eligibility, consent, foreign dependencies and tuple fences cover membership,
exclusion, order, fields, source metadata and cursor-visible information. Candidate-only checks cannot protect NOT
exclusions or ordering. Complete generations, index revisions, published identity epochs and prepared rows are not grants.

Use the shared native privacy-reduction observation and repair/acknowledgement contract before execution and again
before disclosure, including relevant excluded subjects and foreign dependencies. Missing, changed or unsafe evidence
and a pending identity epoch return readiness. Owner writes appear on the owner's next read; private preparation
cannot hide a committed change behind catalogue lag. Public fields and cursor bases do not change when curator-private
facts change without changing completed published output. Reauthorize every continuation and retain existing opaque
cursor binding/restart behavior; cursor content must not reveal private query facts or cached permission.

Admit filter, source and order together as a direct owner index or prepared owner result, composed with catalogue
plans where supported. Success fills the requested page or proves genuine final exhaustion. Otherwise return preparing
with retained bounded progress, or the existing unavailable outcome when no progress is possible. Finite ready input,
including sparse matches, must reach useful full/final output after finite preparation. Endless preparing or short/empty
success chains over raw candidate windows do not satisfy this contract. All direct, prepared, composed-page and
maintenance work is charged under [Filtered lists cost](filtered-lists.md#cost); no numeric allowances are added here.

## Required Recipe query and controlled outcome

The query uses the existing Collection members encoding: `filter=JSON.stringify(filter)`, URL-encoded as a query
parameter, with `sort=id` and `limit=2`. The target is Alice's Everything through the existing
`GET /v1/collections/{collectionId}/members` surface. Presence is redundant there but deliberately explicit.
The same filter restricts a broader catalogue, curated, TypeList or Zone source only where that authenticated
personalized plan is admitted; it does not make public personalization universally available.

```json
{
  "and": [
    { "type": { "in": ["schema:Recipe"] } },
    { "statement": { "property": "schema:suitableForDiet", "in": ["VEGETARIAN_CONCEPT_ID"] } },
    {
      "statement": {
        "property": "schema:cookTime",
        "range": { "lte": 30, "unit": "http://www.wikidata.org/entity/Q7727" }
      }
    },
    { "owner": { "presence": true } },
    { "not": { "owner": { "session": { "profileId": "RECIPE_PROFILE_ID", "lifecycle": "completed" } } } }
  ]
}
```

This is a logical template, not valid instantiated HTTP input: replace `VEGETARIAN_CONCEPT_ID` with the actual
released VegetarianDiet Concept ID and `RECIPE_PROFILE_ID` with the actual released Recipe accepting profile ID.
Use the fixture's genuine released property/type declarations and accepted pins. The expanded minute IRI is
`http://www.wikidata.org/entity/Q7727`, not a scalar `minute`/`MINUTE` alias. The type leaf above matches the current
source grammar; owner admission and any missing released diet/profile data remain explicit gaps. No placeholder
or rejected query can count as a successful required native case.

The [shared discovery fixture specification](../packages/definitions/src/released-discovery-fixtures.md)
defines quick/25, edge/30, slow/31, meat/nonvegetarian, unknown-diet, cooked/20 and other-cooked/20 controls.
All four diet/time-eligible recipes have actual Alice presence. The complete result across pages is exactly
`{R-quick, R-edge, R-other-cooked}`. Alice's actual completed session excludes `R-cooked`, including after she clears
its entry state. Bob-only completion leaves `R-other-cooked` included. Slow, nonvegetarian and unknown-diet controls
fail catalogue predicates; absent cookTime also fails. No-entry support remains included without default state.
A separate NOT-state control includes complete no-entry cases and must not replace the completed-history test.

## Delivery boundary and required native evidence

This adoption unlocks native-case freezing and shared grammar implementation. It adds no production code, exported
runtime symbol, schema migration, API tests or gate. File presence and document format/link validation establish
**prose delivery only**, not product acceptance.

Required producers remain missing: actual shared Filter schema admission; owner indexed/prepared plan ports;
complete selected-public-facet projection and privacy-reduction log; published identity epoch and current canonical
mapping; actual Collection/dynamic source group integration; full native driver bindings; and composed-budget proof.
The shared released-fixture specification exists, but required released data may remain red. Commerce's native
population specification is a real producer requirement, not evidence that its runtime population exists.

After adoption, freeze required raw HTTP cases against existing profile, label, dynamic and source suites, using
actual native commands and released IDs rather than a new fake driver. Cover exact closed shapes and Boolean
composition, viewer/delegation scope and denial, complete absence versus readiness, current label parents, old pins,
state-clear history, independent holdings, canonical uniqueness, public publication isolation, current exclusion/order
privacy, full/final/preparing progress and cursor reauthorization. Bind real SQL/index/preparation counters and the
shared composed growth harness before claiming native acceptance. Specified, native-bound, implemented/exposed,
passed at a revision and promoted remain separate evidence stages. No second protocol engine closes a missing producer.
