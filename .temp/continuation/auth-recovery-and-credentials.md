# Recovery token and credential replace on the walk stack

goal: accounts
manager: accounts
owner: Auth c883

Walk revision `5b3cf6755af0d3058f41eb7577624d22d304507b` at 2026-11-07T00:25Z. J02 already passed
native sign-in, session review and revoke.

J03: `POST /recovery/start` returned HTTP 200 with no token and no delivery handle. The walk stack
has no external mail. Repair: put a deterministic recovery token in that start acknowledgement on
the local stack so `POST /recovery/complete`, new-password sign-in, and old-password/old-session
refusal can run.

J04: `POST /credential-effects/stage` with the management client and `account:update` returned HTTP
403 `{error:credential_effect_denied, effect_status:not_applied}`. Repair: password replace through
the installed credential-effect path after fresh step-up for that client, then session review of
the new credential. Do not add a walk-side bypass.
