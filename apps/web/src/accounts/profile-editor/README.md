# Account-specific profile editor

The route is `/accounts/$accountId/profile` (localized URL: `/{locale}/accounts/{immutableAccountId}/profile`).
Performance can link its existing account/organization management detail to this route using the selected account's
immutable ID. `accountProfileHref` in `address.ts` supplies that exact URL. A management DTO is selection only and
does not imply permission to edit. No handle or attribution/operator link supplies authority.

The browser creates a new editor per target, viewer and session CSRF identity, without a shared profile cache.
Each committed browser session result or query-client replacement retires the previous editor, even when viewer
and token are unchanged; ordinary cache notifications preserve the draft.
The cookie BFF uses the server-held authenticated viewer, rejects bearer replacement and binds every read/write
to that viewer. Private native editable GET supplies the actual profile, including handleless targets and Content
avatar summaries. Its advice binds viewer and target independently; a delegated viewer is not the edited account.
Every dispatch rereads native field applicability and the admitted public-view flags for the selected target; an
unadmitted whole patch stays unsent. Advice preflight and PATCH share one ten-second wait, and private setup or
serialization failures use the shared plain failure envelope while Router control flow still throws.
Native GET and PATCH evaluate existing current profile authority; the website does not request
additional scopes. A denied native read shows refusal, including when current consent lacks `account:update`.

Profile and public-view changes each require explicit confirmation for the selected immutable account. PATCH
acknowledges only the immutable command. The shared editor performs CURRENT GET readback before Saved and retains an
unknown attempt with its original credential, key, version, intent and body. A matching current projection is neither
acknowledgement, denial nor commitment. Independent current reads, later drafts, remounts, exact-original retries and
session retirement remain distinct. Every retry rereads exact current native operation advice before sending the same
original body and Structured Field command key; a different current value requires review.
Failed readback keeps acknowledgement or unknown delivery visible without revealing the retained draft; read
recovery never replays an acknowledged command. Departure uses the shared profile draft/command navigation decision.
Read recovery presents the editor's captured Retry-After deadline through the public `settings/ports/profile-editor` retry
hook; the disabled reload control becomes available at that deadline without starting another read.
The shared editor takes `SettingsAmbient` from composition (`SettingsAmbientProvider` in `settings/adapters/ambient-view.tsx`); this route binds the same
adapter and does not acquire `Date.now` or UUIDs in the constructor. Session observation identity uses `ambient.id()`.
Missing real `KERNEL_ORIGIN` is unavailable, including development; the editor never consumes the fake kernel.

Integration acceptance remains the contract's web suite and native authority oracles. Web owns visual review.

Profile reads and saves use Web’s ten-second deadline through headers and body decoding, composed with caller cancellation; a timed-out PATCH retains its exact command and draft for explicit recovery, and only a fresh account-bound read confirms current state.

Settings owns the consumed account capability in `settings/ports/accounts.ts`; its ordinary route binds this feature's
exact-account address, without importing this page into Settings. The delegated route supplies the actual Profile
presentation through `settings/ports/profile-editor-view.ts`. The editor, private reads and writes consume only the
narrow `settings/ports/profile-editor.ts` owner contract instead of Settings private cards, navigation or write modules.
The installed native GET remains authoritative for the selected immutable account and the current actor independently.
Existing confirmation, current-read recovery and immutable-original tests retain their assertions; composed-capability
coverage adds no story states. Worker validation is Web typing; integration owns native, browser and growth acceptance.

`ports.ts` describes the delegated runtime without importing session or request implementations. Route composition
installs `adapters.ts`, which owns query-client observation identity, committed-session revision, attachment custody and
native server-function IO. Every new committed session result or client replacement still remounts the editor; ordinary
cache notifications retain the draft. The page itself consumes the runtime and presentation supplied by the route.
