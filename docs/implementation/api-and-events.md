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
| Main | `POST /classification-applications` | Target grain, expression/sense/context -> application/decision scope. |
| Main | `POST /classification-decisions` | Application, outcome, exact policy/evidence, expected head -> decision. |
| Main | `POST /rating-observations` | RatingContext, target, admitted slot/value -> observation/revision. |
| Main | `POST /structure-operations` | Structure, expected head, bounded edits/import plan -> revision or staged operation. |
| Main | `POST /queries` | Typed context/filter/text/graph descriptor -> truthful result envelope. |
| Main | `GET /resources/{id}` | Typed selection/context and optional fence -> resolved eligible representation. |
| Main | `GET /revisions/{id}` | Exact component anchor -> current-disclosure-qualified historical state. |
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

## Operation representation and errors

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
