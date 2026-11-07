# Software opening completes on the walk Auth host

goal: accounts
manager: accounts
owner: Accounts
reuse: SDK e18, Auth c883

Walk revision `50d6ddce544ba428e2f64de731703520790f5d9c` at 2026-11-07T06:40Z.
Organization create, owner transfer, rename and personal delete passed
(J06–J08, J18). Website Kernel bearer is accepted.

J09: `POST /account-operations` `{kind:automated}` then
`POST /operator-sessions/open` timed out at 18431ms (`The operation timed out.`).
A previous round on this handle completed the same opening in 7127ms with
outsider open HTTP 403. Finish automated create and outsider-denied operator
open on this walk Auth host. Do not add a new denial envelope.
