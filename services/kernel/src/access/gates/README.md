# Platform gates

Every mounted route declares `x-exposure` as `public` or `gate:<group>`. Group names match
`^[a-z][a-z_]{0,62}$`; `any`, `open`, and `close` are reserved. The kernel validates declarations when it is composed.

A gate is closed when `access.exposure_opening` has no row for its group containing the request's T. A closed route
first checks the actor's authentication, then checks `gate:<group>` or `gate:any` on the Global Context for both the
actor and any authenticated principal. The check uses the route's `x-action` scope and happens before the route's own
authorization and domain reads. Anonymous and ungranted account callers receive the same `403 platform_closed`.
Public routes do not read the exposure catalogue. Gate state is read for each request and is never cached.

Entries that are not mounted routes apply the same rule through `admitGroup` (`admission.ts`), which `admitExposure`
also calls: an open group admits everyone, a closed one only an account holding `gate:<group>` or `gate:any` on the
Global Context. The `organizations` group closes organization creation. The Auth host's account-operation approval for
an `organization` request calls `admitGroup` for it before approving and answers `403 platform_closed` to an ungranted
person. No other account operation is gated, and deletion never is.

The ordinary grant routes manage `gate:<group>` and `gate:any` as direct actions on the Global Context. Platform staff
receive `gate:any`, `access:grant`, `exposure:open`, and `exposure:close` through the additive
`platform.governance` action list.

Opening and closing are idempotent commands:

- `POST /v1/platform/exposure/{group}:open` starts `[T, infinity)` when closed.
- `POST /v1/platform/exposure/{group}:close` ends the open row at T.

Both commands run on the Global Context through the native command executor, require an idempotency key, and use
`exposure:open` or `exposure:close` authorization respectively. Repeating open while already open or close while
already closed is a no-op catalogue change.

`GET /v1/platform/exposure` is a public read (`exposure:read`) with optional bearer authentication. It returns
`{ admitted: string[] }`: the sorted mounted gate groups the caller is admitted to at T. Closed groups the caller
cannot enter are omitted, so their names are never disclosed; consumers treat an absent group as closed. The read
shares the open-groups read and `authorizePlatformGate` port with `visibleOperations`: a closed group is admitted
only when at least one mounted operation is in the caller's scopes and the formula allows its gate, including the
actor and principal requirement for delegated callers. Both served discovery routes use the kernel's Access instance,
which holds the viewer's authenticated identity evidence. The groups read performs no route projection and sends
`cache-control: no-store`.

## Cost

### Admitted groups read

- Touches: One open-groups read for the mounted group set, plus at most G calls to `authorizePlatformGate`, one per closed group with an in-scope operation, at the same T.
- Bound: G is the mounted closed-group count, a deployment constant. The opening probes cost O(M log E) buffers for M mounted groups; each gate check has the bound of "`gate:<g>` and `gate:any` on the Global Context" below. Rows and statements stay constant as unrelated data grows.
- Growth check: `services/kernel/test/access/gates/growth-discovery.test.ts`: "admitted groups read stays bounded as unrelated accounts, gate grants, and openings grow".

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
- Growth check: `services/kernel/test/access/gates/admission.test.ts`: "opening is public from T, close restores denial, and gate:any admits platform staff" runs open, close and their no-op repeats through the native command routes; `services/kernel/test/access/gates/catalogue.test.ts`: "the exposure catalogue enforces valid groups and temporal non-overlap and reads half-open openings at T" covers the catalogue rows they write.

### visibleOperations and served OpenAPI

- Touches: The same open-groups read and at most G gate checks as the admitted groups read. Public operations and operations of open groups are visible; operations of closed groups also require their own action in the viewer's scopes and an allowed gate check. Served OpenAPI projects this single decision.
- Bound: Linear in the mounted route catalogue, plus the opening probes and at most G checks with the bound of "`gate:<g>` and `gate:any` on the Global Context" above. G is the mounted closed-group count, a deployment constant.
- Growth check: `growth-discovery.test.ts` grows unrelated accounts, gate grants, organization role grants on the Global Context, and other groups' opening rows at 1, 8, and 64.
