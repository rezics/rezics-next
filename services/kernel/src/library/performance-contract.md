# Progress session operations

The existing Progress and Continue descriptors retain their native session commands and response contracts.
An operation declaration describes work; it supplies neither owner authority nor evidence of execution.
Native owner admission still precedes receipt lookup. A completed mutation receipt and its current presentation
are independent: failure to present current source evidence cannot erase or acknowledge a mutation.

## Journal command identity

`patchSessionJournal` retains the principal, command kind, request key, session ID and normalized patch, including
the expected journal revision. Its receipt input retains the public `admission: null` member. Private import
admission identity never enters that digest. Consequently changing an import review cannot change the identity
of an already acknowledged journal command. A different patch with the same key remains a conflict.

Private admission runs inside the fresh mutation transaction after the session lock and owner check. Failure
rolls back the mutation and creates no successful receipt. Replay returns the original result under current
owner authorization without reasserting an obsolete import review or overwriting later journal edits. Private
admission does not grant public command authority.

Decision: retain the public journal digest shape and exclude private admission identity; two causal additions to
the existing native session suite cover replay after a later clear and rollback followed by retry.

## Operation derivation boundary

Closed session plans must compose preparation, original and current profile reads, owner/partition fences,
receipt replay, shelf head/activity, mutation, triggers, History and terminal presentation work through the
existing native ports. Keep logical results, examined rows, points, serialized bytes and engine requests as
separate axes. SQL-only terms can declare zero engine requests; nested native calls need their own declarations.
The ordinary session/unit/change limits remain default 20 and maximum 100; owner discovery remains maximum 50.
Raw sentinels and discarded candidates consume work and retain their original keyset frontier. No declaration
permits refill, account-history scans, cap increases or a second native admission.
