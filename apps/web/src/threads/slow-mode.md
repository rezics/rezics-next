# Board slow mode

Content owns the posting interval, eligibility times, moderator exemptions and the setting command. Web shows that
policy beside writing and offers the setting to an admitted moderator. Mute, block, penalties and watch are out of
scope.

## Units

The interval is `off` (`0`), `30`, `60` or `300` seconds, default off. It covers successful new threads and replies by
one account on one board. Edits are not limited. Failed writes and receipt replays do not start a cooldown. Current
board-curation authority exempts the moderator; Web never invents that exemption locally.

## Eligibility display

New-thread and reply composers show the current interval and the caller's next permitted attempt when native policy
discloses them. A 429 `Retry-After` on submit is native refusal authority and updates the displayed time. Countdown
copy is display guidance: reaching the shown time never proves permission, never submits, and never starts a retry
loop. Send and Retry stay explicit actions so the browser clock does not gate or bypass native policy. Waiting keeps
the unsent draft and existing departure protection. Uncertain submits keep the original command identity.

## Private caller retirement

Eligibility and setting reads are private to the mounted board, signed-in viewer, CSRF token and component lifetime.
Session replacement, board change and unmount retire in-flight work. Late results cannot restore a retired visit or
write into a replacement caller. Setting commands keep the original idempotency key while the outcome is unknown.

## Native refusal recovery

A cooldown refusal keeps the draft and shows the native retry time. The person explicitly resubmits when they choose
to; native policy may still refuse. Unavailable eligibility is an honest status with a manual retry, never a
speculative allowed or empty wait. Denied setting admission hides the editor.

## Remaining producer binding

Web calls `KernelClient.boards({ id }).slowMode` `GET`/`PUT` when that generated resource exists. Until Content
installs it, the seam returns unavailable and does not invent an endpoint or a successful native body.
