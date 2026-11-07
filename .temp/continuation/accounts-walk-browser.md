# Walk Web starts on deferred Vite

goal: accounts
manager: accounts

Walk revision `5b3cf6755af0d3058f41eb7577624d22d304507b`. After native HTTP, `dev-stack.ts web` on
walk port 20010 failed:

`AssertionError [ERR_ASSERTION]: Unexpected error: no match for module: typebox/type`

then `No such module ".../elysia/dist/type/typebox/type"`. Web was not ready after ten minutes.
Desktop 1280 and phone 390 were not inspected. Auth pages had become ready.

Repair: Web `dev` on the admitted walk ports must start so J01 Home, J12 public pages and J17
Settings can be opened. Keep one Chromium process. Do not open a second walk.
