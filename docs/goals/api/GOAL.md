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

The [checkpoint](state.md) records retained decisions. Use the ledger for live
tasks and the scope registry for pending persona cells.

The [retained checkpoint rebuild](seed-rebuild.md) records preparation evidence
for growth checks.

## Outcome

Every row of the first public scope is proved through the API for each persona,
as the [method](../method.md) defines: outcome tests written first, run through
the public API of a real stack, passing on the shared stack.

The first public scope is the book library, recipes, the VNDB-like and
Bangumi-like catalogues and most Realm and Zone capabilities; third-party blocks
stay closed and community surfaces may lag. The rows are
in `scripts/qa/cases/launch-coverage.ts`, which the program owns.

One API manager owns the shared backend modules so authority and contract
changes do not split across competing owners.

## Order of work

Use `task goal -- planning api` to find pending cells. Work a vertical at a
time, with outcome specifications before implementation. Shared mechanisms need
a reviewed design note and one open task per mechanism. Continue target
architecture work when a scoped row requires it or it is explicitly requested.
The [checkpoint](state.md) records retained prerequisites.

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
