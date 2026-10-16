---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
areas:
  - scripts/ops/**
  - scripts/operations/**
  - infra/release/**
  - infra/jena/purge-tdb2.sh
  - tests/qa/fault-recovery/**
  - docs/operations/**
---

# Operations Goal

Status: started by the [program](../program/GOAL.md) on 2026-10-13 15:34 UTC with the
restore, drill and release work that does not depend on the erasure contract. The
erasure proofs start when the [api](../api/GOAL.md) Goal no longer changes the
erasure and recovery contracts; [state.md](state.md) lists the work carried over.

## Outcome

What an operator must be able to do is proved on physical fixtures, not on
doubles:

- Erasure. A person's private copies and personal data are gone from live
  storage, from the search index and from a restored backup, inside the 30-day
  retention window; the proof restores a backup taken before the erasure and
  shows the erased data absent after replay.
- Restore. The stack is rebuilt from backup artifacts alone, on a schedule,
  and serves reads and writes afterwards.
- Deployment preparation. The release image starts with what the code
  imports, and the [production plan](../../operations/deployment.md) is current.

The method's shape holds here too: the outcome is a drill that fails first and
then passes, written before the code that makes it pass, with one reviewer pass
and the attempt cap.

## Cut lines

- No change to an API contract: a drill that needs one asks the api Goal.
- [External conditions](../../operations/external-conditions.md) (hosts, names,
  providers, registrations, legal facts) are the maintainer's list. No task
  solves, prepares for or works around an item on it.
- A finding no drill meets goes to the [later list](later.md).

## Completion

The erasure drill and the restore drill pass on physical fixtures from a clean
checkout, on the schedule the drill plan states, and the release image starts.
