---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
areas:
  - apps/web/**
  - apps/accounts/**
  - packages/ui/**
  - packages/zone-sdk/**
  - packages/wiki-toolkit/**
---

# Web

Status: written on 2026-10-12 and not started. The [program](../program/GOAL.md)
starts this Goal's manager when the first vertical's rows are proved by the
[api](../api/GOAL.md) Goal; [state.md](state.md) lists the work carried over.

## Outcome

Every proved row has its surface: the web consumes the row's operations through
the generated client and shows each state the API can answer, on phones and
desktops, in the eight UI locales.

A surface follows a proved row and never leads it. When a screen needs an
operation that is missing or awkward, this Goal asks the api Goal for it; it
does not work around the API in the client (maintainer: APIs own business
operations, the UI consumes them; "api 没问题，storybook 没问题，道理上 web
都不用验证的").

## How a surface is verified

As the [method](../method.md) says: types, unit tests and stories, with each
state (loading, empty, error, pending, populated) a story fed by responses
recorded from the row's outcome tests. No model review of web diffs. One browser
journey for each vertical runs in the program's nightly regression.

The web defects found on 2026-10-12 were all the client not following the API's
contract: a continuation dropped, a `202` shown as done, a read sent without the
member's identity, a cursor built by arithmetic. Each of those classes gets a
rule in the client or a guard (the cursor guard exists), not a browser proof.

Visual quality is judged by eye, from screenshots, as before.

## Cut lines

- No change under `services/`, `model/` or a migration.
- No row whose API outcome is not proved.
- A defect no row's persona meets goes to `later.md` in this directory.

## Completion

Every row in scope has its surface with its stories, each vertical's journey
passes in the nightly regression, and nothing of this Goal remains in the tree
but what it built.
