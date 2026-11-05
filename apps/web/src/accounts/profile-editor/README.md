# Account-specific profile editor

The route is `/accounts/$accountId/profile` (localized URL: `/{locale}/accounts/{immutableAccountId}/profile`).
Performance can link its existing account/organization management detail to this route using the selected account's
immutable ID. `accountProfileHref` in `page.tsx` supplies that exact URL. A management DTO is selection only and
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
Missing real `KERNEL_ORIGIN` is unavailable, including development; the editor never consumes the fake kernel.

Integration acceptance remains the contract's web suite and native authority oracles. Web owns visual review.

Profile reads and saves use Web’s ten-second deadline through headers and body decoding, composed with caller cancellation; a timed-out PATCH retains its exact command and draft for explicit recovery, and only a fresh account-bound read confirms current state.
