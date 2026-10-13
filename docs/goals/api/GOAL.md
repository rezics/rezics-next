---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
areas:
  - model/**
  - packages/model/**
  - packages/document/**
  - services/content/**
  - services/account/**
  - services/main/src/**
  - services/main/tests/**
  - services/main/migrations/**
  - infra/jena/command-module/**
  - scripts/dev/seed/**
  - scripts/load/**
---

# API

Status: resumed by Program on 2026-10-13 after N1 to N4 landed. The latest
[checkpoint](state.md) records proved rows, running work and the decisions
that supersede the earlier wrap-up.

## Decision — checkpoint event, 2026-10-13

Acknowledged `checkpoint:e2c00179-8e6d-485a-bca3-318a3fb82bd5`. Updated
`state.md` from the handled start, G-2076 attempt-three and G-2077 attempt-three
decisions. Program's subsequent acknowledged mail and completed landings
supersede the initial gate holds; preserve those historical decisions and leave
both verified tasks closed. Archived briefs stay archived. This checkpoint
dispatches nothing, starts no watcher and waits for no worker. The durable
inbox has no unacknowledged mail.

## Decision — start event, 2026-10-13

Acknowledged `start:6b527ce2-32fc-4e9f-854c-66bb51e33bd6`. The registered
manager role is enrolled and this turn is claimed. Program's 11:10 UTC resume
decision supersedes the earlier pause: the live ledger confirms all 18 outcome
tasks already running with the updated step-two briefs. Continue that work;
this start event needs no additional dispatch or resume. Task exits and mail
are decided in their own events, in the affected brief; automatic landings
remain subject to the tool's gates. Demonstrated pending cells lead to
implementation only after their evidence and intended persona answers are read.

The inbox has no unacknowledged mail. This event leaves `state.md` for a
checkpoint turn, starts no watcher and waits for no worker.

The [retained checkpoint rebuild](seed-rebuild.md) records preparation evidence
for growth checks.

## Outcome

Every row of the first public scope is proved through the API for each persona,
as the [method](../method.md) defines: outcome tests written first, run through
the public API of a real stack, passing on the shared stack.

The first public scope is the book library, recipes, the VNDB-like and
Bangumi-like catalogues and most Realm and Zone capabilities; third-party blocks
stay closed and community surfaces may lag (maintainer, 2026-10-07). The rows are
in `scripts/qa/cases/launch-coverage.ts`, which the program owns.

This Goal replaces the backend work of three Goals (kernel, trust-ops and the
backend half of launch) and has one manager. Two managers writing the same
modules of `services/main` met in the same files all day on 2026-10-12; one Goal
has no seam there.

## Order of work

1. **Rows without an API proof** (17 of 67 on 2026-10-12): recipe tracking and
   progress; the visual novel hub and its Zone browse; the game hub and its Zone
   browse; Realm boards; the nine Realm closure rows; resuming an interrupted
   export; a thousand-episode inventory.
2. **Rows proved with one persona.** The program's first task files today's
   proofs under the persona they exercise. The personas left `missing` are this
   Goal's work, a vertical at a time, books first.
3. **Shared mechanisms** a row needs, each from a design note the supermanager
   has read, one open task for each mechanism at a time. [state.md](state.md)
   lists the ones in flight when the earlier Goals stopped: production ancestry
   sources for disclosure, the bounded typeahead read, the consumers of an
   incomplete search total, content withdrawal, and the import of public-domain
   recipe structure under decision 55.
4. **The target architecture's contracts** (C2 to C6) continue as mechanism
   work under the same rule, when a row needs one or the maintainer asks.

## Cut lines

- No row's surface, no browser test, no story: that is the [web](../web/GOAL.md) Goal.
- No physical erasure proof, restore drill or deployment step: that is
  [operations](../operations/GOAL.md).
- A defect that no row's persona meets goes to the [later list](later.md).
- Nothing is built for one source or one vertical that the engine could carry
  as configuration ([decisions](../../product/decisions.md)).

## Completion

Every row in scope has a passing outcome test for each persona on the shared
stack, the product audit finds no persona whose row outcome fails, and nothing
of this Goal remains in the tree but what it built.
