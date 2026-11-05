# Board slow mode

Content owns the posting interval, eligibility times, moderator exemptions and the setting command. Web shows that
policy beside writing and offers the setting to an admitted moderator. Mute, block, penalties and watch are out of
scope.

## Units

The native interval is any whole second from `0` (off) through `86400`, default off.
Decision: retain preset choices `0`, `30`, `60`, `300` and add the current nonpreset value to the controls; do not expose free-text changes yet. It covers successful new threads and replies by
one account on one board. Edits are not limited. Failed writes and receipt replays do not start a cooldown. Current
board-curation authority exempts the moderator; Web never invents that exemption locally.

## Eligibility display

New-thread and reply composers show the current interval and the caller's next permitted attempt when native policy
discloses them. A 429 `Retry-After` on submit is native refusal authority and updates the displayed time. Countdown
copy is display guidance: reaching the shown time never proves permission, never submits, and never starts a retry
loop. Send and Retry stay explicit actions so the browser clock does not gate or bypass native policy. Waiting keeps
the unsent draft and existing departure protection. Uncertain submits keep the original command identity.

## Private caller retirement

Eligibility and setting reads are private to the mounted source, selected thread and parent, locale, credential mode,
signed-in viewer, CSRF token and component lifetime. Account or session generation changes, route/source or selection
replacement, locale or credential-mode changes, and unmount retire in-flight work. Returning to a route starts a new
visit key, so late results cannot populate the returning visit. An uncertain setting command retains its original
sender, CSRF token, credential mode, interval, scope and idempotency key for an explicit same-command retry.

Decision: slow-mode visits consume the shared browser session observation and reader address lease; equal session
replacement, fetching and invalidation retire the original visit, including transitions batched before React renders.
Current inspection cannot acknowledge an original command. Source-object replacement still requires the caller's
original source identity in addition to its selection scope.

## Native refusal recovery

A cooldown refusal keeps the draft and shows the native retry time. The person explicitly resubmits when they choose
to; native policy may still refuse. Unavailable eligibility is an honest status with a manual retry, never a
speculative allowed or empty wait. Denied setting admission hides the editor. An unknown setting command retries the
exact original sender, credentials, key and interval. A definitive conflict requires an explicit current-state review
before a new intent. Browser clocks never grant sending authority.

## Board reading after a setting

An applied interval change reconciles the current board reading without repeating the setting command. Slow mode does
not increment Content's pin revision; the current cursor remains usable unless a separate pin change invalidates it.

## Remaining producer binding

Web binds the installed `KernelClient.boards({ id }).slowMode` methods and their response DTO directly.
The declaration is `packages/client/src/kernel/content/routes.d.ts` at declaration head `3c86494744`.
Only a valid original PUT body with the requested interval acknowledges the command. A malformed or opposite successful
body remains unknown; no GET follows PUT to infer acknowledgement. Point readers preserve pending independently of
countdown advice. Reads reject missing fields, wrappers and aliases instead of inventing an off policy.

Reference observations: `legacy-final:apps/web/features/feed/reply-composer.tsx` preserves a draft and reply parent
across refusal; `/home/edge/projects/rezics/rezics/apps/web/features/following/components/follow-button.tsx` separates
status failure from mutation pending and opens explicit settings. These were source comparisons, not rendered parity.
