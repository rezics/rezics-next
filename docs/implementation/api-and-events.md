# API commands and event envelopes

## Transport conventions

Origins are deployment configuration; paths below are target API designs under
`/v1`, except Main's installed fixed-profile `POST /v1/works`,
`POST /v1/content-edits` and `GET /v1/revisions/{id}`. OAuth/OIDC keeps its standard discovery and
protocol paths. Use opaque typed native references, versioned JSON contracts and
lossless numeric strings where required. Authorization headers are verified at
each receiving boundary; a body authority selection does not authenticate it.

Writes require operation identity and appropriate expected revision. Creation
uses an explicit absent/create-only condition. Idempotency scope includes owner,
operation family and admitted caller scope; collisions with another request digest
return conflict. Domain-specific revision errors use one declared convention,
with the current safe revision supplied only when the caller can read it.

## Command surface

| Owner | Example operation | Essential inputs / result |
| --- | --- | --- |
| Access | `POST /authority-contexts` | Agent/subject and intended scope -> admitted context reference and expiry. |
| Access | `POST /access/checks` | Bounded action/target batch -> allow/deny/unavailable with decision/freshness. |
| Access | `POST /roles`, `/bindings`, `/representation-grants` | Exact definition/recipient/scope/ceiling -> versioned state or pending approval. |
| Access | `POST /authority-revocations` | Target authority, expected generation, required fence mode -> operation outcome. |
| Main | `POST /works` | Continuity/domain profile, metadata, authority -> Work and MainVersion refs. |
| Main | `POST /contributions` | Work/type/language/applicability -> independently controlled contribution. |
| Main | `POST /contribution-publications` | Exact private draft, expected publication head, original-author rights basis and public disclosure -> contributor eligibility decision. |
| Main | `POST /content-edits` | Component, expected head, validated patch/payload -> revision anchor. |
| Main | `POST /publication-selections` | Context, target slot, exact/follow selection, expected head -> published/adopted selection. |
| Main | `POST /spaces` | Capability set, owner, context policies -> Space and provisioning state. |
| Main | `POST /classification-contexts` | Active Realm, expected absent classification-context link, fixed Global inheritance policy and authority -> distinct typed context. |
| Main | `POST /classification-propositions` | One English label and Global interpretation scope -> distinct Scheme, Concept, Path, Expression and Sense IDs with one immutable bundle revision. |
| Main | `POST /classification-applications` | Future proposal and evidence channels for target, sense and context. |
| Main | `POST /classification-decisions` | Curated MainVersion/Sense/Context slot, accepted/rejected outcome and expected head -> Application and immutable Decision. |
| Main | `POST /classification-resolutions` | Public Work/MainVersion/Sense and Global or Realm context -> effective direct decision and source position. |
| Main | `POST /rating-contexts` | Active Realm, English question and authority -> distinct standing RatingContext with fixed MainVersion grain, 1–10 scale and policies. |
| Main | `POST /rating-observations` | RatingContext, target, admitted slot/value -> observation/revision. |
| Main | `POST /rating-aggregates` | Active RatingContext and MainVersion -> bounded complete current-head distribution and latest-per-rater mean. |
| Main | `POST /structure-operations` | Structure, expected head, bounded edits/import plan -> revision or staged operation. |
| Main | `POST /queries` | Typed context/filter/text/graph descriptor -> truthful result envelope. |
| Main | `GET /resources/{id}` | Typed selection/context and optional fence -> resolved eligible representation. |
| Main | `GET /revisions/{id}` | Exact component anchor -> current-disclosure-qualified historical state. |
| Main | `GET /content-revisions/{id}` | Content revision UUID and acting subject -> current-Work-disclosure-qualified exact Content reference, serialization and parsed body. |
| Main | `POST /source-adoptions` | Observation/mapping/binding, target/base/human epochs -> adopted/pending/conflict. |
| Main | `POST /reports` | Exact component/evidence reference, reason and context -> restricted case. |
| Main | `POST /exports` | Exact coverage/profile/context -> asynchronous export operation. |
| Package runtime | `POST /resolutions` | Requirements/environment/source/policy -> resolution operation. |
| Package runtime | `POST /installations` | Lock, expected environment, executor grant -> installation operation. |
| Package runtime | `POST /installation-changes` | Update/rollback/remove intent and expected generation -> recoverable plan. |
| Operation owner | `GET /operations/{id}`, `POST /operations/{id}/cancel` | Progress/outcome and admitted cancellation. |

These surfaces are grouped domain commands, not table CRUD or an unrestricted
graph-update endpoint. Bulk item effects declare independent versus all-or-nothing
atomicity. A single response cannot claim atomic success across independent stores
unless its explicit workflow has completed all required steps.

The installed first `POST /v1/spaces` profile accepts
`{"profile":"space-realm-v1","name":"...","capabilities":["realm"],"actingSubject":"..."}`
with a bearer assertion and idempotency key. Account requires `space:create`;
Access requires a separate `space.create` grant at `space:create:root`. The
actor becomes the Space owner. One guarded graph commit allocates distinct Space
and Realm identities with a fixed closed membership policy, manager review
policy and Main Version fallback selection policy. The response returns both
identities, both initial revisions and the source position; a same-key replay
returns the same IDs. `GET /v1/spaces/{id}` exposes the current public identity
and policy references. Other capability sets and policy configuration are
unavailable in this fixed profile; their requested form is rejected as invalid.
Access grants for managing the created Realm are provisioned separately and are
not implied by ownership or creation.

The installed `POST /v1/classification-contexts` accepts
`{"profile":"classification-context-v1","realm":"...","actingSubject":"..."}`
with an Account bearer assertion and idempotency key. Account requires
`realm:classify`; Access independently requires `classification.context.configure`
at `classification:context:{Realm URI}`. An active public Realm must have no
classification context. The guarded transaction creates the fixed isolated
Global root if absent, a distinct Realm classification Context with the fixed
`classification-inherit-global-v1` policy, the reciprocal Realm link, an
immutable context revision, terminal receipt and typed private outbox event.
One winner is admitted for concurrent create-only requests. A same-key replay
returns the same context; strong closure can seal a pending request without
allocating one. `GET /v1/realms/{realm}/classification-context` returns the
current public context, policy and revision, or an unavailable response when
the context is not configured. The stopped mixed-cut drill replays both a
successful context and a terminal cancellation from retained relay and Access
evidence. Applications and effective decisions remain separate commands.

The installed `POST /v1/classification-propositions` accepts
`{"profile":"classification-proposition-v1","label":"Science fiction","actingSubject":"..."}`
with an Account bearer assertion and idempotency key. Account requires
`classification:define`; Access requires `classification.proposition.define`
at `classification:define:global`. The Global classification root must already
exist. Jena SHACL validates five distinct linked identities before one guarded
transaction inserts their active projections, one Sense-owned immutable bundle
revision, terminal receipt and typed private outbox event. The bundle preserves
the exact five IDs and English label; the relay carries its manifest reference
without the label. Same-key replay returns the same IDs; strong closure cancels
a pending admission. `GET /v1/classification-propositions/{sense}` verifies the
manifest bytes against the current projection and returns the linked definitions
and label. The mixed-cut drill replays creation and cancellation only with
current sealed Access evidence and the exact immutable bundle bytes.

The installed `POST /v1/classification-decisions` accepts
`{"profile":"classification-direct-decision-v1","context":{"kind":"global"},"work":"...","mainVersion":"...","sense":"...","expectedDecisionHead":null,"outcome":"accepted","actingSubject":"..."}`
with a bearer assertion and idempotency key. For a Realm, context is
`{"kind":"realm-classification","id":"{Realm URI}"}`. Account requires
`classification:decide`; Access independently requires
`classification.decision.set` at `classification:decide:global` or
`classification:decide:{Realm URI}`. The active shared Sense and typed Context
must exist. The curated slot is unique for the target MainVersion, Sense and
Context. A create requires no current Application; a revision names its exact
Decision head. The guarded transaction writes an immutable Decision and current
Application head with a receipt and typed private event. Same-key replay returns
the same IDs; a stale head returns 409 with a terminal receipt, and strong
closure seals a pending admission. The retained mixed-cut drill verifies the
immutable manifest and current sealed Access proof before replaying ordered
Global and Realm decisions and terminal outcomes.

Public `POST /v1/classification-resolutions` accepts
`{"profile":"classification-resolution-v1","context":{"kind":"global"},"work":"...","mainVersion":"...","sense":"..."}`
and returns `state` (`accepted`, `rejected`, `absent`), `source` (`global`,
`local`, `inherited-global`, `none`), source Context and Decision references,
and the graph source position. A Realm with no local head inherits the Global
decision; a local rejection suppresses it. An incomplete head or a changed
graph sequence during resolution returns unavailable. Search filters based on
effective classification are installed only for the bounded public phrase
profiles below.

`POST /v1/queries` also accepts `public-main-classified-phrase-v1` with
`phrase`, `language` and `sense`, or `public-realm-classified-phrase-v1` with
those fields plus the existing `realm-local` context. It checks the complete
public phrase population bound first and returns only matches with an accepted
effective direct classification. Each returned item names the Decision,
Application and Global, local or inherited source. A changed graph sequence or
unavailable classification makes the whole query unavailable; an absent or
rejected decision gives no result. These profiles use position-checked reads
after the public phrase query, so the planned single ARQ classification/rating
join and broader filters remain pending.

## Operation representation and errors

The installed `POST /v1/rating-contexts` accepts
`{"profile":"realm-standing-rating-context-v1","realm":"...","question":"Overall quality","actingSubject":"..."}`
with a bearer token and `Idempotency-Key`. Account requires `rating:configure`;
Access requires `rating.context.create` at `rating:context:{Realm URI}`. A
guarded graph update creates a distinct context under an active public Realm,
an immutable manifest, terminal receipt and typed private relay event. Replays
return the original identity and position. Public `GET /v1/rating-contexts/{id}`
returns its question, fixed policies and revision after checking graph and
manifest. Retained creation and cancellation replay under recovery hold.

The installed `POST /v1/rating-observations` accepts
`{"profile":"realm-standing-rating-observation-v1","context":"...","work":"...","mainVersion":"...","expectedRevisionHead":null,"value":7,"actingSubject":"..."}`
with a bearer token and `Idempotency-Key`. Account requires `rating:submit`;
Access requires `rating.observation.set` at `rating:observe:{RatingContext URI}`.
The trusted Access principal defines an opaque standing slot. A non-null
expected head performs correction, withdrawal with `value:null`, or restoration;
a stale head returns terminal `stale_head`. Each revision stores its predecessor,
availability, value when available, four server times and an immutable manifest.
Private exact-revision GET requires Account `rating:read`, Access
`rating.observation.read` at `rating:read:{RatingContext URI}`, and the same
active principal. Typed private relay events and retained source-order replay
carry the revision manifest without an Account principal ID. Aggregate queries
use the same current heads.

The installed public `POST /v1/rating-aggregates` accepts
`{"profile":"realm-standing-latest-mean-v1","context":"...","work":"...","mainVersion":"..."}`.
It counts all standing slots in that Context/MainVersion, rejects more than 100,
checks each current revision's immutable manifest, then reduces available 1–10
values. Its ten-bucket histogram uses index zero for value one. Withdrawn heads
contribute to the slot count but not the mean. Empty populations return `mean:
null` and `precision.kind: "no-data"`; nonempty results include an exact integer
numerator and denominator beside the numeric mean. The source position names
the complete graph snapshot. Materialized generations and search joins remain
pending.

Main's first Work command accepts JSON
`{"profile":"metadata-only-v1","title":"...","actingSubject":"https://rezics.com/id/..."}`
with `Authorization: Bearer ...` and `Idempotency-Key`. Account verifies the
resource-bound `work:create` token and its current session, then Access admits
the actor and `work.create` grant. A new commit returns 201; a same-key replay
returns 200. Both return Work and MainVersion references, their initial revision
anchors, `replayed`, and a
`sourcePosition` with dataset ID, data epoch and decimal-string sequence.
The fixed-profile content edit accepts a Work reference, exact `expectedHead`,
new title and acting subject with the same headers. Account requires `work:edit`;
Access requires a `work.edit` grant scoped to `work:edit:{Work URI}`. A matching
head returns the new revision and predecessor; an obsolete head returns 409
`stale_head` after terminal receipt sealing. An exact revision read takes the
revision UUID in the path and `actingSubject` in the query. Account requires
`work:read`; Access checks the current `work:read:{Work URI}` grant, and Main
requires the Work to remain in the current graph. The resolver verifies the
retained manifest and payload digests. Unknown or undisclosed revisions return
404; missing or corrupt committed bytes return 503.
The installed `POST /v1/contributions` accepts
`{"profile":"text-contribution-v1","work":"...","language":"en","body":"...","actingSubject":"..."}`
with the same bearer and idempotency headers. Account requires `work:edit`;
Access requires an independent `contribution.create` grant at
`contribution:create:{Work URI}`. A successful command creates a distinct
Contribution identity and immutable draft revision, returning 201 or 200 on
identical replay. The draft body lives in the immutable object store; its
graph record and private outbox event contain references and a manifest, not
the body. `GET /v1/contributions/{id}/drafts/{revision}` takes `actingSubject`
and requires Account `work:read` plus a current `contribution.read` grant at
`contribution:read:{Contribution URI}`. Unknown or undisclosed drafts return
404. Neither command publishes a Contribution or creates a public MatchUnit.
`POST /v1/contribution-edits` accepts `profile`, `contribution`, exact
`expectedHead`, replacement `body` and `actingSubject` with the same headers.
Account requires `work:edit`; Access requires `contribution.edit` at
`contribution:edit:{Contribution URI}`. A winning edit returns the new draft
revision and predecessor. A stale head returns 409 `stale_head` with a terminal
receipt; strong closure can seal an uncommitted edit without moving the head.
The original Contribution, Work, author and language remain fixed, and both
draft revisions remain private exact reads under current authority.
`POST /v1/contribution-publications` accepts `profile: text-publication-v1`,
the Contribution URI, exact `expectedDraftHead`, nullable
`expectedPublicationHead`, `rightsBasis: original-contribution`,
`disclosure: public` and `actingSubject`. Account requires `work:edit`;
Access requires `contribution.publish` at
`contribution:publish:{Contribution URI}`. The actor must be the original
Contribution author. The command checks the current draft and publication
heads, verifies the immutable draft, validates a fixed SHACL decision and
records its rights basis, disclosure and selected draft in an immutable
manifest. A winning command advances the Contribution publication-decision
head and returns 201 (200 on identical replay); a stale head returns 409 with
a terminal rejection. Strong closure seals a pending command. The typed
`contribution.eligibility-recorded.v1`, `publication-rejected.v1` and
`publication-cancelled.v1` relay events contain references and a manifest,
not draft text. This first profile records only an original contribution by
its own author. The decision does not select a Main Version or Realm context,
create a public MatchUnit or expose the draft body. Those require later
separate selection and projection commands.
The first installed `POST /v1/publication-selections` profile is
`main-default-selection-v1`. It takes a typed
`{kind:"main-version-default",id:MainVersion}` context, Work, Contribution,
exact publication decision, nullable expected selection head,
`selectionBasis: main-maintainer` and acting subject. Account requires
`work:edit`; Access requires a separate `publication.select` grant at
`publication:select:{MainVersion URI}`. The server verifies the current eligible
decision, its retained manifest and selected draft, then atomically advances
the Main Version selection head, deletes only its old public MatchUnit, inserts
the new public selected-body MatchUnit, and records an immutable selection,
receipt and outbox event. Stale selection returns 409; strong closure settles
pending admission. Replays retain the exact selection and unit. A public
`GET /v1/main-versions/{id}/selection` returns the current selected text and
exact references. Contributor eligibility alone never serves text.
The same selection endpoint also admits `realm-local-selection-v1` with a typed
`{kind:"realm-local",id:Realm}` context, Work, Main Version, Contribution, exact
eligible publication decision, nullable expected local selection head,
`selectionBasis: realm-manager-review` and acting subject. Account requires
`realm:adopt`; Access requires `publication.adopt` at
`publication:adopt:{Realm URI}`. The fixed Realm policy requires an active Realm
and public Space. One guarded commit advances only that Realm/Main Version slot,
replaces its former public MatchUnit, and retains the selection, receipt and
private typed outbox event. Stale heads seal with 409; strong closure cancels
pending admission. `GET /v1/realms/{realm}/main-versions/{id}/selection`
resolves the local selected body or the Main default with an explicit reason and
effective context. A local choice leaves the Main default and other Realms
unchanged.
`POST /v1/publication-rejections` admits `realm-local-rejection-v1` with a typed
Realm context, Work, Main Version, nullable expected local head, fixed
`decisionBasis: realm-manager-review`, `reasonCode: not-approved` and actor.
Account requires `realm:reject`; Access independently requires
`publication.reject` at `publication:reject:{Realm URI}`. A guarded commit
replaces the slot head with an immutable negative decision, removes only its
former local MatchUnit and emits a private typed event. The Main default and
other Realms remain unchanged. A stale head seals with 409; strong closure
cancels pending admission. Realm selection reads return an explicit
`status: suppressed`, rejection reference and reason code while this head is
current, and Realm phrase queries omit that Main Version rather than inherit it.
An expected-head local adoption can replace the rejection.

The installed `POST /v1/queries` profiles `public-main-phrase-v1` and
`public-realm-phrase-v1` accept a literal `phrase` and nullable language; the
Realm profile also requires a typed Realm context. They return every matching
effective public MatchUnit, ordered by score and Main Version ID, with source
position, exact references and `complete: true`. The Realm result states
whether each match used a local adoption or Main fallback. One SPARQL query
counts **all** public units across contexts and joins jena-text results against
current effective selections in a TDB2 read snapshot. The Lucene limit is 101;
population over 100 returns 422 `query_budget_exceeded` instead of a partial
success. These profiles have no pagination or private search claim. The wrapped
update path maintains the Lucene index;
post-restore index consistency still needs a qualified release check.
[Jena text query syntax](https://jena.apache.org/documentation/query/text-query.html)
documents the property/limit form, and [TDB transactions](https://jena.apache.org/documentation/tdb/tdb_transactions.html)
document the TDB2 read snapshot used for the count and match relation.
When the graph outcome is uncertain, 202 returns an opaque `operationId`,
`status: reconciling`, and a retry instruction. Retry the identical body and
key; a changed intent receives 409. The first profile does not yet serve
`GET /v1/operations/{id}`. Invalid bodies and keys return 400, inactive Account
assertions 401, denied Access decisions 403, conflicts or cancelled operations
409, and unavailable dependencies or a recovery hold 503. Error bodies use stable `code` values
and disclose no private Account or Access identifiers.

Common operation `status` is pending, running, waiting, reconciling, succeeded,
failed or cancelled. A typed `phase` records domain-specific steps such as fetching,
staging or activating. A target's `active` state is separate from the operation's
terminal success. Cancellation reports whether an effect has already committed.

```json
{
  "operationId": "operation-ref",
  "status": "waiting",
  "phase": "publication-disclosure",
  "progress": { "completed": 12, "total": null },
  "result": null,
  "retry": { "allowed": true, "afterMs": 1000 }
}
```

Use RFC 9457 Problem Details with stable REZICS error codes, safe request/operation
references and typed field/precondition details. Do not expose SQL, raw query text,
private account IDs or hidden resource existence. Unsupported semantics, budget
exhaustion, incomplete source, stale selection and dependency unavailable have
different codes even when their HTTP class overlaps. [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html)
defines the envelope, not REZICS's business decisions.

## Committed event envelope

Use CloudEvents 1.0 structured JSON for interoperability, with versioned domain
data. Source + event ID is the dedupe identity. Occurrence time, source-commit
position and transport publication time are separate. Big transaction counters
use strings in domain data rather than an unqualified JSON number.

```json
{
  "specversion": "1.0",
  "id": "event-ref",
  "source": "https://rezics.com/services/main",
  "type": "com.rezics.publication.selection.changed.v1",
  "subject": "resource-ref",
  "datacontenttype": "application/json",
  "data": {
    "operationId": "operation-ref",
    "selectionRevision": "revision-ref",
    "context": "publication-context-ref",
    "sourcePosition": {
      "datasetId": "product",
      "dataEpoch": "b839d47a-9a8a-4cd8-892e-1d4b7f378a54",
      "sequence": "42"
    },
    "routingEpoch": "3",
    "causationId": "prior-event-or-request-ref"
  }
}
```

For Main graph commands, persist event identity/data, the guarded application
sequence increment and the operation receipt in the same TDB2 transaction through
Fuseki. `sourcePosition` is the receipt's `{datasetId, dataEpoch, sequence}`, with
an opaque random epoch and decimal-string sequence; Jena supplies no Fluree ledger
`t`, commit CID or minimum-transaction HTTP header. Access uses its own PostgreSQL authority revision/fence type. Producer
positions are not comparable across owners, datasets or epochs.

The relay polls retained outbox records by `(dataEpoch, sequence, eventId)` and
checkpoints after durable handoff/effect acknowledgement, with idempotent consumers.
No SSE/commit-history feed is assumed. A restore changes `dataEpoch`; a missing
retention boundary requires reconciliation or rebuild, not replay from wall time.
Read-after-write waits compare the matching application fence and required index
freshness separately. SPARQL `LIMIT`/`OFFSET` and this fence do not provide a retained
snapshot cursor across HTTP requests. See [Jena storage](../storage/jena.md) and
[search continuation](../contracts/search.md).

Separate `source.observed`, `native.adopted`, `publication.selection.changed`,
`authority.revoked`, `resource.erasure.requested`, `index.generation.activated`
and installation outcomes. A source observation is not publication; an index
event is not another authoritative content change. Restrict streams/subscriptions
by audience and keep secrets/private control links out of public payloads.

See [CloudEvents](https://raw.githubusercontent.com/cloudevents/spec/v1.0.2/cloudevents/spec.md)
and [event contracts](../contracts/events-and-jobs.md). Protocol compliance does
not provide atomic delivery or authorize a consumer's effect.
