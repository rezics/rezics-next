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
which holds the viewer's authenticated identity evidence. The read additionally advertises `commerce_sale.list`,
`subject.create`, `realm.create` and `provider_review.list` when each exact mounted operation is visible. These
operation markers enable shell journeys without inferring endpoint support from group admission; native exposure and
authorization stay unchanged. They add no Access or SQL calls. The read sends `cache-control: no-store`.

## Current management configuration

`GET /v1/platform/exposure/management` (`exposure.read_management`) declares public exposure and the nonanonymous
action/scope `exposure:manage_read`. It checks that exact action directly on the fixed Global Context, before reading
configuration and again before disclosure. The additive `platform.governance` role supplies this action; neither
`gate:any` nor discovery admission supplies management authority. This action has no Global reach or default grant.
The role's native definition is `access/platform-governance.json`; `resource-roles.json` does not define it.

The native export is
`readExposureManagementPage({ pool, access, clock?, cursorKeys, routes }, actor, { cursor?, limit? }, { deadline })`.
`cursorKeys` is the existing `KeyRing` from `tokens/seal.ts`; `routes` is a readonly array of native `MountedRoute`.
The closed result is `{ viewer: { accountId, clientId }, actions: { open, close }, exposureGroups: [{ group,
open, at }], next }`. Viewer context contains only the admitted acting account and client IDs. Each action is true
only when its installed command operation targets the fixed Global authority and passes independent native checks
before and after the configuration read. The result contains no identity labels, session data, proofs, grants or
inferred roles. `limit` is an integer from 1 through 100, defaulting to 20. The signed native list cursor binds the
current viewer, query and immutable mounted catalogue digest; malformed, expired and old-definition cursors return 400.

Only nonhidden mounted gate declarations supply groups, sorted and deduplicated after composition. Each selected
group reads one genuine temporal opening at the same minted authoritative kernel T. The `at` string preserves that
database instant, including submillisecond precision; it is not an opening's change time. An absent opening means
closed. Failed or moved sources return a typed 503, never a closed configuration. Checkouts are sequential and released
before the final ordinary authority check. No group-specific account or role data is returned, and responses use
`cache-control: private, no-store`.

The existing management page's adapter is `apps/web/src/platform/exposure/data.ts`, rather than a separate
`source.ts`. It calls this exact GET independently of optional generated OpenAPI discovery, validates the closed
bounded page, ordered unique groups and common T, and preserves the safe viewer context, native action advice,
timestamp and next cursor. `invalid_cursor`, refusal and dependency failure stay distinct. The generated OpenAPI
document remains its own viewer-filtered source of partial visible-group context; it cannot authorize management or
open/close actions. Native management remains usable when optional discovery is missing or malformed.

## Cost

`G` is the fixed mounted group count. `M` is the fixed mounted route count, `K <= 1,000` the Access formula's admitted-key cap, and `E` the exposure-opening index size. Gate checks reuse the Access formula bound: O(log E + (1 + K) log G) with constant rows and statements for a fixed request.

| Operation                                  | Touches                                                                                                                                                                                                                                                                                                                              | Bound                                                                                                                                                                         | Growth check                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-request exposure decision              | One `access.exposure_opening` temporal primary-key lookup at request time T.                                                                                                                                                                                                                                                         | One row and statement; logarithmic blocks in E; no range scan.                                                                                                                | `test/access/gates/growth-admission.test.ts`: “checkGrowth keeps gate admission bounded as unrelated accounts, grants, and other openings grow separately”                                                                      |
| Closed-group authorization                 | For each closed group, checks exact `gate:<group>` and `gate:any` actions for the actor and, when present, authenticated principal on the Global Context; this is the shared Access formula.                                                                                                                                         | Constant rows/statements per check; logarithmic blocks in Global grants and assignments, with K capped at 1,000.                                                              | `test/access/gates/growth-admission.test.ts`: “checkGrowth keeps gate admission bounded as unrelated accounts, grants, and other openings grow separately”                                                                      |
| Open and close exposure group              | One exposure-opening point read and at most one opening-row write, plus the native command receipt/event. No scan; no-op repeats do not change catalogue rows.                                                                                                                                                                       | Constant rows and statements; logarithmic blocks in E.                                                                                                                        | Missing: existing admission growth coverage measures reads and unrelated opening growth, not the native open/close command writes.                                                                                              |
| Admitted groups read                       | One open-groups read for the mounted groups and at most G closed-group authorizations for in-scope operations.                                                                                                                                                                                                                       | Constant statements and rows for fixed G; O(M log E + G(1 + K) log G) indexed blocks; G and M are deployment constants.                                                       | `test/access/gates/growth-discovery.test.ts`: “admitted groups read stays bounded as unrelated accounts, gate grants, and openings grow”                                                                                        |
| Current management configuration           | One independently released time mint, two ordinary Global `exposure:manage_read` preparations/checks, up to four independent Global open/close preparations/checks (each installed action before and after configuration), and one partition-key plus temporal-opening point per selected group; no opening history or account scan. | At most 100 selected groups; O(log G + limit) catalogue selection after one immutable deployment capture; O(limit log E) opening probes plus six fixed shared formula bounds. | Focused `test/access/gates/management-read.test.ts` covers exact scope, configuration versus admission, final denial and signed keysets. Native and growth proof is deferred.                                                   |
| Operation discovery and served OpenAPI     | One open-groups read and at most G gate authorizations while filtering the fixed mounted route catalogue; OpenAPI projects that decision.                                                                                                                                                                                            | Linear in mounted routes M; constant rows/statements for fixed M; logarithmic opening and grant probes.                                                                       | `test/access/gates/growth-discovery.test.ts`: “discovery stays bounded as unrelated accounts, gate grants, and openings grow”                                                                                                   |
| Gated account-operation workflow approvals | Exact approval/account keys and up to K command events at each approval step; no approval-history scan.                                                                                                                                                                                                                              | Constant rows/statements for fixed K; logarithmic blocks in account and receipt history.                                                                                      | `test/access/growth-workflow-approvals.test.ts`: “${mode} stays bounded as ${population} grows with K fixed”                                                                                                                    |
| Membership joins and leaves                | Current member and inverse keys per affected member, processed in fixed durable work steps.                                                                                                                                                                                                                                          | Constant rows/statements per member step; logarithmic blocks in membership history; total work linear in affected members.                                                    | `test/access/membership-work-growth.test.ts`: “real durable joins and leaves keep reserve join leave and release command and history work within the same bounds through the shared growth harness at scales 256 1024 and 4096” |
