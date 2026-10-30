# Viewer actions

Viewer actions tell an interface which actions and operations current Access permits for its caller on resources
already displayed. A Collection curator and a delegated editor receive the same editing operations when their
current authority and client scopes permit them. Curator identity describes attribution; it does not decide editing.

This document owns the viewer-actions contract. [Research](research/viewer-actions.md) supplies evidence, while the
[Access README](../services/kernel/src/access/README.md) owns the permission formula and [accounts](accounts.md) owns
account behaviour. The outcome suite in [viewer-actions-outcomes.test.ts](../specs/viewer-actions-outcomes.test.ts)
is an executable specification; implementation must bind its real kernel driver before claiming product acceptance.

## Personal batch read

Send `POST /v1/viewerActions` with 1–100 distinct `{ type, id }` resource references. A detail page sends one; a list
sends its displayed rows in one request. Use the same bearer credential as the eventual command, or no credential
for an anonymous read. The body never supplies actor, client, principal, scopes, routes or partitions. The kernel
derives identity from authentication and resolves resource routes and partitions itself.

For example, a detail request is:

```json
{
  "resources": [{ "type": "library.collection", "id": "00000000-0000-8000-8000-000000000001" }]
}
```

A response can offer Collection editing and member operations on their Collection authority:

```json
{
  "resources": [
    {
      "type": "library.collection",
      "id": "00000000-0000-8000-8000-000000000001",
      "viewerActions": [
        {
          "action": "collection:read",
          "operations": ["collection.get", "collection_member.list"]
        },
        {
          "action": "collection:update",
          "operations": [
            "collection.update",
            "collection_member.create",
            "collection_member.delete",
            "collection_member.move",
            "collection_member.update"
          ]
        }
      ]
    }
  ]
}
```

The response preserves reference order. Each resource's entries are sorted by action, with operation IDs sorted
within each entry. Both are unique, and an entry always has at least one operation. The result is allow-only:
`viewerActions: []` is a complete negative for a visible resource. No denial reasons or grant provenance are returned.

A concealed resource and an unknown resource both produce exactly `{ type, id, error: "not_found" }`, without
`viewerActions` or other fields. One failing dependency makes the whole request answer 503, with no partial positives.
Malformed JSON or references, duplicates, more than 100 references, and unsupported types answer 400 before any
permission work. Authentication failures retain their normal statuses. In particular, a suspended caller receives
its normal credential refusal; a refused bearer must never become an anonymous request or reuse an old positive.

## Actions and operations

An action can back several operations whose platform gates differ. A control is enabled only when **both** its
action and its particular operation ID occur in the answer. One admitted operation never enables another operation
merely because they share an action.

The kernel compiles bindings from mounted declarations. An operation whose route names the resource uses its
`x-action` and `x-resource-types` to bind directly to that resource. Only an operation authorized on a different
anchor declares an authority anchor: for example, a Collection-member command binds to its Collection. Modules do
not redeclare direct bindings, enumerate callers' ACLs, infer actions from role names, or add frontend action lists.
Composition rejects more than 64 candidate actions or 256 operation bindings for any resource type; it never
silently truncates an answer. The read action counts toward that candidate limit even when it has no offered
operation. The authority declaration is `x-authority-resource-types`, a list of resource type names that replaces
that operation's direct types for viewer-action binding. Direct declarations are per operation; the action
catalogue retains their union for resource creation, without copying bindings between operations.

## Decision path and time

Every candidate operation first uses admission's existing gate rule: the group is open, or the caller holds
`gate:<group>` or `gate:any` on the Global Context as admission requires, including the principal when present.
It then uses the installed Access formula with the real actor, client and principal: actor grants intersect
consented client scopes and, when assigned, principal grants. A grant-derived positive requires the exact action
in the client's scopes. Neither an open gate nor a gate grant supplies the operation's action or its scope.

The verified anonymous floor retains its existing semantics, including its scope exception. Public visibility
alone does not invent an anonymous floor. Account state, current assignment, membership evidence, denials and
validity intervals remain operands of Access. A Realm ban removes its exact join and participate actions; unrelated
reads keep their own answers. There is no curator, role-name or staff shortcut. Access's supported Global governance
reach is included, without recording governance use during this read.

One kernel read time T applies to the entire batch, including gate and formula evaluations. Share actor, principal
and gate preparation within that request and keep native evidence deadlines. T aligns temporal decisions; it does
not promise a distributed snapshot or authorize reuse of prepared evidence on the next request.

## Authorization and domain state

The answer covers Access and platform gates. Locked, deleted, published and membership state remain on resource
reads and in commands. Modules supply no additional domain-eligibility readers for this endpoint. Existence and
visibility still determine whether a reference is concealed; they do not predict command payload eligibility.

A command always authorizes again at its own T. The answer is advice, not a capability or approval for a future
payload. Revision checks, input validation, workflow prerequisites and domain-state refusals still belong to the
command. An interface treats a command refusal as final, withdraws the offered control and refetches as appropriate.

## Freshness and interfaces

Every response uses `Cache-Control: private, no-store`, including anonymous responses. Recompute on every read;
resource ETags, content revisions, browser TTLs and stale-while-revalidate must not preserve viewer answers.
Viewer fields never enter public DTOs, anonymous HTML, sitemaps or shared hydration payloads.

After hydration, fetch the personal batch for the current detail page or displayed list rows. Enable no mutation
control while the read is pending or unavailable. An unavailable answer offers retry and must not look like
"not allowed". Refetch on navigation, focus, identity change and after a permission-changing command. Identity
includes client, consent and principal context. Discard old controls and in-flight results when that context or the
page generation changes, so another persona's response cannot replace the current answer. An idle tab need not
receive instantaneous push revocation; the next read must observe current authority, even with the same bearer.

## Cost

### Personal viewer-actions batch

- Touches: Bounded indexed existence/visibility reads for the supplied references, one shared actor, principal and
  gate preparation, then the installed formula's pages for the mounted candidate actions. Include account floors,
  assignments, membership proofs, denials and Global governance reach; release each authority connection before
  acquiring another. No ACL enumeration, resource search or history scan fills the response.
- Bound: For N ≤ 100 references of H resource types with at most A ≤ 64 candidate actions per type, at most A·H
  formula pages, each with at most 100 IDs, after the shared preparation. Operation filtering is bounded by the
  composition cap of 256 bindings per type. At fixed selected neighbourhood, admitted membership and catalogue,
  statements and examined rows stay constant as unrelated grants, resources and history grow; indexed blocks grow
  logarithmically. Count preparation, visibility, gate and failure work in this budget, not only successful formula
  results. Request-local reuse must preserve each real authority anchor and operation's gate.
- Growth check: The outcome "statements and rows stay constant as unrelated grants resources and history grow"
  measures native statements, examined rows and shared blocks at three geometric scales, growing each axis
  independently while fixing the selected batch. It includes allowed, denied, empty and unavailable paths, mixed
  types and distinct physical authority partitions, and observes formula-page and shared-preparation bounds.
