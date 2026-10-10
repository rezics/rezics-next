# Hidden ids

A read that accepts an id of a resource answers a hidden id and an absent id
the same way. Hidden means the resource exists and this caller may not see it.
The two answers use the same status, the same body bytes aside from a
`requestId`, the same cost (graph calls, SQL statements, and bytes), and the
same media-generation and rate-limit effects.

Access disclosure decides visibility. This check only compares the two answers.
It does not decide them.

## Inventory

`scripts/qa/hidden-id-equality.ts` reads `generated/openapi/main/public.json`
and lists every GET or POST whose path, query, or body accepts a resource id:
a path parameter that names a resource, a query id (an id pattern, an `id` /
`Id` name, or an address alias), or a body array named `ids`, `resources`, or
`targets`. Enumerations, integers, generation counters, and short vocabulary
slugs are not resource ids.

`scripts/static/hidden-id-reads.json` is that list. Each operation is
`registered`, `exempt` with a reason, or `unregistered`. Unregistered rows are
frozen debt. A new id-accepting operation fails the inventory test until it is
registered or exempted. `bun scripts/qa/hidden-id-equality.ts --write` rewrites
the file and refuses to add unregistered debt. Removing a row that no longer
occurs, or moving one to `registered` or `exempt`, shrinks the debt and is
written.

## Register

Add the operation to `registeredHiddenIdReads` and call
`assertHiddenIdEquality` once from `tests/qa/integration/hidden-id-equality.test.ts`,
with a caller, one hidden id, and one absent id. The helper records the
difference (status, body, cost, or side effect) and stops on that operation.
A body may repeat the id the caller submitted; that echo is removed before
the bytes are compared. A `requestId` is removed the same way.

## Exempt

An exemption is a reason the operation cannot reveal someone else's resource.
The current rule exempts a read whose only id is the caller's own acting
subject. Add another reason in `exemptionReason` only when the route is built
so every unauthorized caller receives that same refusal. Then rewrite the
inventory.
