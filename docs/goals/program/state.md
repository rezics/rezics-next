# Program checkpoint

This page retains decisions and
unverified obligations; it is not an operational run log.

Waves 1 to 3 are on main, and the operations, api and web Goals are closed.
Main's confirmation passed all 408 launch cells on 2026-10-16, and every
shared-capability exception in the inventory is repaired. The api and web Goals'
deferred findings, and the api Goal's retained-population checkpoint rebuild
procedure, are archived on `archive/goals` with their Goals. That rebuild is
still blocked before a fresh checkpoint; it gates growth checks only, not any
row. Every program task has landed, and main's final confirmation at `eedd958e26`
passed all 408 launch cells on 2026-10-16 with none failed or not run. The
completion criteria are met. On 2026-10-17 the maintainer decided that a
published section list's public entries are visible and searchable for
anonymous visitors, each filtered by its own visibility, and that external
conditions do not hold the close. With that change on main, the final
confirmation at `72efe4353b` passed all 408 cells with none failed or unrun,
and the program closed.

Efficiency readings on 2026-10-16: 13.16 M worker input per main landing for
03:00–15:00, 7.65 M after the gate, harness and watcher repairs landed
(15:45–19:00), and 3.57 M while closing (19:00–22:00). Failed landing surface
gates fell from six to none. The largest remaining cost was discovering stale
test premises one run at a time, so workers now fix independent failures from
one run together. Six catalogue cells went unrun twice because Fuseki was
OOM-killed: pooled stacks kept its tmpfs storage across leases. Storage is now
reclaimed when a run releases its stack, and a full confirmation of that change
passed 408 cells with none failed or unrun. The 12-hour reading
at 01:15 on 2026-10-17 was 5.76 M per landing. Its largest avoidable cost was a
returned round on that repair: a ranking run that crossed midnight UTC read an
empty current-day bucket, and the failure was taken for the storage change's
regression. Ranking acceptance now shares one QA bucket clock across source and reads,
and such a failure is now attributed to a branch only when it repeats there.
Main and Accounts no longer reset a slow request's socket: request deadlines
answer with HTTP errors. Main's confirmation at `b3fe1c57d9` on 2026-10-17
passed all 408 cells with none failed or unrun. The 12-hour reading at 04:26
was 7.47 M per landing, and 4.14 M for the repairs after 01:15. Its largest
avoidable cost was goalctl's dispatch tests starting real model sessions
through the machine's account settings; tests are being isolated from them.

The supermanager handles program tooling and steers the delivery Goals'
remaining tasks directly.

## Deferred findings

The [unverified tooling backlog](later.md) retains the unresolved leads from the
former run journal. Load it only when investigating or briefing that class of
fault; it supplies no current stop or retry instruction.
