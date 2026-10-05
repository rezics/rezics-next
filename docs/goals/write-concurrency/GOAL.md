---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch). Migrations are not listed:
# each task reserves its own numbers. The manager widens them as briefs land.
areas:
  - services/main/src/modules/content-sequence.ts
  - services/content/src/projection-cursor.ts
  - services/main/src/modules/notification-producers/**
  - services/main/src/modules/feed/**
  - services/main/src/modules/realm-directory/**
---

# Write concurrency

Status: started on 2026-10-05 by the maintainer, manager `rezics-next-be`.
[state.md](state.md) records where the work stands.

## Outcome

Independent writes never wait on each other, and ordered consumers still never
miss an event:

- **No platform-wide write lock on user paths.** No user-facing write takes a
  row, counter or constant lock key shared by unrelated targets: a reading
  progress save, a vote, a comment, a join or a review on one target does not
  wait for a write on another. Deterministic tests show it by holding one
  writer's transaction open while an unrelated write commits.
- **Ordered consumers stay complete.** Outboxes, producer logs and projection
  fences keep at-least-once, no-skip consumption, across concurrent commits and
  across restore, without a gap-free counter taken by writers.
- **No network I/O under a shared lock, no write locks on reads.** No
  transaction that holds a shared row waits on Account, Fuseki or another HTTP
  call; GET paths take no write locks and run no projection rebuild inline.
- **Bounded waits.** Every application connection has a bounded lock wait and
  idle-in-transaction time.
- **No regression.** A check refuses a new singleton row, gap-free head or
  constant lock key on a write path unless it is listed with its reason.

The research behind this Goal, with the inventory of 19 serialization points,
measurements and sources, is in
`.temp/research/global-write-serialization-2026-10-05.md`.

## Pattern

Writers append a plain row stamped with `pg_current_xact_id()` (`xid8`), an
identity id and the owner's data epoch; nobody updates a head row. A consumer
reads, in one statement, rows whose transaction is older than
`pg_snapshot_xmin(pg_current_snapshot())`, ordered by `(epoch, xid, id)`, so a
transaction that commits late can stall it but never be skipped. Where
downstream contracts need contiguous positions, one sequencer assigns them to
rows below the horizon; only the sequencer takes the position lock. The epoch
leads the key because a logical restore does not carry the transaction counter.
Long writing transactions anywhere in the cluster stall consumers, so waits
are bounded and lag is observable.

## Cut lines

Must ship: Content writes (progress, sessions, drafts, comments, publications,
replies, media), votes and the feed, the notification producer log, Realm
joins and directory reads, judgment, rating, shelf and review fences, bounded
waits and the guard. Deferred: operator, startup and recovery locks, the
intentional Open Library rate gate, and the Jena command endpoint's single
dataset sequence (one TDB2 writer).
