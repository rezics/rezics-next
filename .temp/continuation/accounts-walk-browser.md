# Walk Web stays alive for desktop and phone Home

goal: accounts
manager: accounts

Walk revision `c20a775de46c4920f7480490f313eab40c43e37a` at 2026-11-07T04:28Z. Auth
pages became ready. Web `dev` on walk port 20010 printed ready, then the Vite/Rolldown
process died:

`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`

then `error: script "dev" exited with code 134`. Chromium `goto` `/en/` was
`net::ERR_CONNECTION_REFUSED`. Desktop 1280 and phone 390 were not inspected. J01
native HTTP already passed.

Repair: Web `dev` on the admitted walk ports must stay running through Home and the
public person page at 1280 and 390. Keep one Chromium process. Do not open a second
walk.
