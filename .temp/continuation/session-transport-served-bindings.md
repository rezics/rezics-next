# Session transport served surface bindings

goal: web
manager: web

Remaining `session-transport` cells in `docs/goals/web.capabilities.md` are the mounted Zone routed-site binding and
the configured TypeList slot binding. The web capability row marks both pending, and its out-of-scope lines name the
owners: semantic's saved-scope, mount, union and routed-site acceptance needs a served-page binding, and search's page
composition plus semantic's Zone routing need a served slot binding.

Land these only when those owners deliver the served bindings. Then bind the shared session transport at each surface:
upload intent and completion, download authorization, and revocation or suspension at the next BFF request, using the
existing personal driver in `apps/web/tests/native/web-personal-driver.ts` and the native `session-transport` cases in
`specs/web-personal-outcomes.test.ts`.

Already on the web branch: the received native attachment publish walk, the Realm reservation key forwarding and the
prepared session cache test. This continuation does not depend on them beyond their presence.
