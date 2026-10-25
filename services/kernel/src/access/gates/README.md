# Platform gates

Every mounted route declares `x-exposure` as `public` or `gate:<group>`. Group names match
`^[a-z][a-z_]{0,62}$`; `any`, `open`, and `close` are reserved. The kernel validates declarations when it is composed.

A gate is closed when `access.exposure_opening` has no row for its group containing the request's T. A closed route
first checks the actor's authentication, then checks `gate:<group>` or `gate:any` on the Global Context for both the
actor and any authenticated principal. The check uses the route's `x-action` scope and happens before the route's own
authorization and domain reads. Anonymous and ungranted account callers receive the same `403 platform_closed`.
Public routes do not read the exposure catalogue. Gate state is read for each request and is never cached.

The ordinary grant routes manage `gate:<group>` and `gate:any` as direct actions on the Global Context. Platform staff
receive `gate:any`, `access:grant`, `exposure:open`, and `exposure:close` through the additive
`platform.governance` action list.

Opening and closing are idempotent commands:

- `POST /v1/platform/exposure/{group}:open` starts `[T, infinity)` when closed.
- `POST /v1/platform/exposure/{group}:close` ends the open row at T.

Both commands run on the Global Context through the native command executor, require an idempotency key, and use
`exposure:open` or `exposure:close` authorization respectively. Repeating open while already open or close while
already closed is a no-op catalogue change.

## Cost

### Per-request exposure read

- Touches: One `access.exposure_opening` lookup by the temporal primary key.
- Bound: One row and one statement, O(log E) buffers, with no scan.
- Growth check: `growth-admission.test.ts` grows unrelated group openings at 1, 8, and 64.

### `gate:<g>` and `gate:any` on the Global Context

- Touches: Only for a closed group and an account, the existing Access formula checks the two exact gate actions on route 0 and the Global Context ID.
- Bound: O(log E + (1 + K) log G), K <= 1000, with constant rows and statements and no scans.
- Growth check: `growth-admission.test.ts` grows unrelated accounts and their gate grants at 1, 8, and 64.

### Open and close

- Touches: One point read and at most one write in `access.exposure_opening`, plus the native command receipt and event.
- Bound: One catalogue row and at most one catalogue write; no scan.
- Growth check: `catalogue.test.ts` exercises open, close, and their no-op cases through the native command routes.
