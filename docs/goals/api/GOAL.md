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

Status: written on 2026-10-12 and not started. The [program](../program/GOAL.md)
starts this Goal's manager after its first three tasks land; [state.md](state.md)
lists the work carried over from the Goals it replaces.

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
- A defect that no row's persona meets goes to `later.md` in this directory.
- Nothing is built for one source or one vertical that the engine could carry
  as configuration ([decisions](../../product/decisions.md)).

## Completion

Every row in scope has a passing outcome test for each persona on the shared
stack, the product audit finds no persona whose row outcome fails, and nothing
of this Goal remains in the tree but what it built.
