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
avatar summaries. Native GET and PATCH evaluate existing current profile authority; the website does not request
additional scopes. A denied native read shows refusal, including when current consent lacks `account:update`.

Profile and public-view changes each require explicit confirmation for the selected immutable account. PATCH
acknowledges only the immutable command. The shared editor performs CURRENT GET readback before Saved, retains
unknown attempts with their original key/body, and reconciles current state before a new attempt. A current value
different from the submitted value requires review. Every retry rereads native rights before sending the same body.
Missing real `KERNEL_ORIGIN` is unavailable, including development; the editor never consumes the fake kernel.

Integration acceptance remains the contract's web suite and native authority oracles. This delivery's permitted
verification is local web workspace typing; Web owns subsequent visual review.

Profile reads and saves use Web’s ten-second deadline through headers and body decoding, composed with caller cancellation; a timed-out PATCH retains its exact command and draft for explicit recovery, and only a fresh account-bound read confirms current state.
