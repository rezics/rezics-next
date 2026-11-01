# Platform exposure management

Route: `/{locale}/platform/exposure`, private and no-store. This slice consumes native discovery and commands;
it does not install a writer, grant, flag engine or wider website scope.

## Closed native declaration and Accounts owner handoff

Current native source is `services/kernel/src/access/gates/`:

- `GET /v1/openapi.json` supplies the viewer-filtered installed route catalogue, including `x-exposure` and
  `x-action`. Its visible gate groups are a partial inventory, never a complete management inventory.
- `GET /v1/platform/exposure` returns `{ admitted: string[] }`, meaning **viewer admission** at T. It cannot
  establish public open/closed state, even for a governance viewer. This page does not use it as state.
- The delivered native `GET /v1/platform/exposure/management` read supplies one bounded page of
  `{ exposureGroups: [{ group, open, at }], next }`. The consumer uses the owner's `CurrentExposure` projection
  and retains the native time string verbatim. A page defaults to 20 groups (maximum 100), and continuation
  is an explicit user selection of the opaque signed `next`; reload reads only the selected page.
  No count or complete-inventory claim is inferred. Unknown or denied reads discard prior private rows.
  The default `data.ts:readCurrentExposure` binding calls that exact route when discovery declares
  `exposure.read_management` / `exposure:manage_read`. It validates the closed response, ordered unique groups
  and common timestamp. The native contract is owned by
  [platform gates](../../../../../../services/kernel/src/access/gates/README.md#current-management-configuration).
- Exposure commands publish `x-authority-resource-types: ['semantic.context']` with the canonical fixed Global
  `x-authority-resource-id`. The parser consumes that exact reference and checks the native `viewerActions`
  result for `exposure:open` with `exposure.open`, or `exposure:close` with `exposure.close` independently.
  Malformed fixed IDs, authority types and account overrides supply no binding. Kernel's default Global-only
  reader uses Semantic's actual `globalContextAnchor`; it supplies existence, not permission. Neither
  `gate:any`, admitted groups, configuration read permission, scopes alone nor governance role names grant mutation.

The fixed native target is route 0, ID `00000000-0000-8000-8000-000000000000` (`governance-reach.ts` and
`gates/catalogue.ts`). Native commands already check the entire current formula before reading an old receipt,
then execute in the normal admission lane with ordinary write rate limiting.

Commands use the existing generated custom-method transport and an immutable group/action/body/idempotency key.
A recorded `{ group, open, changed }` is historical, including `changed: false`. Current status needs a fresh native
read; loss of a response remains unknown. Only an explicit user retry can resend the same immutable operation.
Paging and reload retain an unresolved immutable operation. A selected management page may supply a group
independently of the visible discovery catalogue, but sending still refreshes both that native source selection
and exact action authority. No automatic write, arbitrary group input, receipt-derived current status or local
persistence is allowed.

Native acceptance, recorded native stories, browser review and full Goal closure remain integration debt. This
handoff explicitly keeps the original acceptance command and full acceptance conditions; local typing is not that proof.

The catalogue parser bounds processing to 4,096 paths/operations and 256 visible groups, rejecting malformed or
oversized responses as unavailable. It preserves installed declaration syntax (`^[a-z][a-z_]{0,62}$`, reserved
`any`, `open`, `close`); it does not widen declarations to the command's historical hyphen allowance.
For fixed metadata, `viewerActions` transport asks for the declared native type and fixed ID. Existing declarations
without the optional fixed-ID extension retain their original Global selection using their declared type; the parser
does not invent a type. Only the exact action AND operation pair can enable confirmation. Missing bindings and source
errors are unavailable, never denied by inference.
The session guard also classifies this route as private so the root cannot prepare anonymous exposure during SSR.
Messages currently use English fallbacks in every supported locale.

The production route uses `readPlatformExposureBound` to return a serializable `{ page, sessionSubject }` envelope.
`sessionSubject` is captured from the same prepared request that supplied the credential for that read; an absent
subject remains unbound. The original `Page`, `readPlatformExposure` and `changePlatformExposure` contracts stay
unchanged for standalone callers. The mounted page compares the envelope's actual reader with the existing
successful session-cache observation before showing private rows or admitting a command. That comparison does not
authenticate the route or create browser authority from loader data. The page keeps the existing private first-render
boundary: SSR can render only a reader-bound page from the signed-in route's session cache, and mutation controls stay
disabled until the mounted browser owner connects.

The feature-local lifetime observes only committed session success, error and removal events. Ordinary fetch and
observer notifications and route IO closure allocation do not retire it. A same-subject successful replacement keeps
healthy read-only rows but retires its pending read and frozen CSRF continuation; a different subject, sign-out,
retained-data error, removal, provider replacement or real unmount retires the rows and continuation. An eligible
fresh visit must perform a new bound read before it can act. Confirm and explicit retry retain the first CSRF token
and the exact frozen operation. Retired or late command results remain hidden historical state, and cannot settle a
successor. Standalone `PlatformExposurePage` keeps its injected Page/IO path without claiming session authority.

Retained integration acceptance: `bun scripts/worker-check.ts --local -- bun run --cwd apps/auth test`, including
“Manage existing platform exposure data through native open and close actions preserves exact current native
authority target privacy and immutable operation readback”. The focused local transport tests exercise the web
contract with explicitly labeled fixtures; they do not replace native permission-formula, replay/revocation,
transactional opening, Origin/CSRF, discovery/gate-filtering or end-to-end privacy acceptance.
