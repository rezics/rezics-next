---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
areas:
  - apps/web/**
  - apps/accounts/**
  - packages/ui/**
  - packages/zone-sdk/**
  - packages/wiki-toolkit/**
---

# Web Goal

The [checkpoint](state.md) records retained task decisions. Start surfaces after
their API rows are proved; use live ledger status instead of the former pause.

## Outcome

Every proved row has its surface: the web consumes the row's operations through
the generated client and shows each state the API can answer, on phones and
desktops, in the eight UI locales.

A surface follows a proved row and never leads it. When a screen needs an
operation that is missing or awkward, this Goal asks the api Goal for it; it
does not work around the API in the client.

## How a surface is verified

Use the [method](../method.md)'s types, unit and recorded-story gate.
Only states admitted by the operation need stories; pending requires a 202. No model review of web diffs. One browser
journey for each vertical runs in the program's nightly regression.

Enforce continuation, pending-result, identity and cursor contracts through
client types and guards. A test should prove those contracts rather than mirror
a small reversible edit.

Visual quality is judged by eye, from screenshots, as before.

## Cut lines

- No change under `services/`, `model/` or a migration.
- No row whose API outcome is not proved.
- A defect that no row's persona meets goes to the [later list](later.md).

## Completion

Every row in scope has its surface with its stories, each vertical's journey
passes in the nightly regression, and nothing of this Goal remains in the tree
but what it built.
