# Account operations reach Kernel on the walk Auth host

goal: accounts
manager: accounts
owner: Accounts
reuse: SDK e18, Auth c883

Walk revision `5b3cf6755af0d3058f41eb7577624d22d304507b` at 2026-11-07T00:25Z. Approve/execute of
organization create (J06), rename (J08), software agent (J09) and delete (J18) returned HTTP 503
`{error:account_operation_denied, effect_status:not_applied}`. J07 and J12 wait on J06. Same first
cause as managed-accounts-seeded-walk check `fe93067b-b74a-41fb-8f73-88d70dd89801`.

Auth host documents that both account-operation routes answer that 503 when `accountOperations` is
absent. Repair: bind the Kernel account-operation and work receiver on the deferred walk Auth host
(Kernel HTTP served from that host) so those four commands apply, then membership/role, owner
transfer, software opening and terminal erasure continue. SDK e18 owns funded invocation exports
used by those operations. Do not add a new denial envelope.
