# Platform exposure management

Route: `/{locale}/platform/exposure`, private and no-store. This slice consumes native discovery and commands;
it does not install a writer, grant, flag engine or wider website scope.

## Closed native declaration and Accounts owner handoff

Current native source is `services/kernel/src/access/gates/`:

- `GET /v1/openapi.json` supplies the viewer-filtered installed route catalogue, including `x-exposure` and
  `x-action`. Its visible gate groups are a partial inventory, never a complete management inventory.
- `GET /v1/platform/exposure` returns `{ admitted: string[] }`, meaning **viewer admission** at T. It cannot
  establish public open/closed state, even for a governance viewer. This page does not use it as state.
- `catalogue.ts:readExposure` reads one opening at T internally. There is no native HTTP complete management
  read returning the installed group inventory and each group's current public opening at T. Accounts must
  supply that authorized bounded result before complete inventory or public status can be shown. The local
  typed `readCurrentExposure` adapter therefore returns `unavailable`, never fabricated rows or closed state.
- `POST /v1/viewerActions` currently has neither an installed readable Global Context registry entry nor
  exposure command resource bindings (`routes.ts:detail` omits `x-resource-types`/`x-authority-resource-types`).
  Accounts must publish the actual Global Context resource reference and advertise `exposure:open` with
  `exposure.open`, and `exposure:close` with `exposure.close`. The local typed current-authority adapter remains
  unavailable until that native reference is installed. It must not guess a resource type or use OpenAPI,
  `gate:any`, admitted groups, scopes alone, or governance role names as permission.

The fixed native target is route 0, ID `00000000-0000-8000-8000-000000000000` (`governance-reach.ts` and
`gates/catalogue.ts`). Native commands already check the entire current formula before reading an old receipt,
then execute in the normal admission lane with ordinary write rate limiting. No backend change belongs here.

Commands use the existing generated custom-method transport and an immutable group/action/body/idempotency key.
A recorded `{ group, open, changed }` is historical, including `changed: false`. Current status needs a fresh native
read; loss of a response remains unknown. Only an explicit user retry can resend the same immutable operation.
No automatic write, arbitrary group input, receipt-derived current status or local persistence is allowed.

Native acceptance, recorded native stories, browser review and full Goal closure remain integration debt. This
handoff explicitly keeps the original acceptance command and full acceptance conditions; local typing is not that proof.
