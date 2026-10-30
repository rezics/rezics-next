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

The catalogue parser bounds processing to 4,096 paths/operations and 256 visible groups, rejecting malformed or
oversized responses as unavailable. It preserves installed declaration syntax (`^[a-z][a-z_]{0,62}$`, reserved
`any`, `open`, `close`); it does not widen declarations to the command's historical hyphen allowance.
If native command metadata eventually declares exactly one resource type with a resource authority anchor,
current `viewerActions` transport asks for that declared type at the fixed Global ID. Only its exact action AND
operation pair can enable confirmation. Missing bindings and source errors are unavailable, never denied by inference.
The session guard also classifies this route as private so the root cannot prepare anonymous exposure during SSR.
Messages currently use English fallbacks in every supported locale.

Retained integration acceptance: `bun scripts/worker-check.ts --local -- bun run --cwd apps/auth test`, including
“Manage existing platform exposure data through native open and close actions preserves exact current native
authority target privacy and immutable operation readback”. The focused local transport tests exercise the web
contract with explicitly labeled fixtures; they do not replace native permission-formula, replay/revocation,
transactional opening, Origin/CSRF, discovery/gate-filtering or end-to-end privacy acceptance.
