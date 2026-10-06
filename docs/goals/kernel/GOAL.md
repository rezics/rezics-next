---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
# Migrations are not listed: each task reserves its own numbers. Route files are
# claimed by the task that owns their behaviour. The manager widens areas as briefs land.
areas:
  - model/**
  - packages/model/src/*.ts
  - packages/model/src/address/**
  - packages/document/**
  - services/content/src/**
  - services/content/tests/**
  - infra/jena/command-module/**
  - services/main/src/modules/semantic/**
  - services/main/src/modules/graph/**
  - services/main/src/modules/graph-query/**
  - services/main/src/modules/query/**
  - services/main/src/modules/context/**
  - services/main/src/modules/statement/**
  - services/main/src/modules/relation/**
  - services/main/src/modules/lexicon/**
  - services/main/src/modules/classification/**
  - services/main/src/modules/collection/**
  - services/main/src/modules/composition/**
  - services/main/src/modules/structure/**
  - services/main/src/modules/types/**
  - services/main/src/modules/facets/**
  - services/main/src/modules/target/**
  - services/main/src/modules/work/**
  - services/main/src/modules/realization/**
  - services/main/src/modules/release/**
  - services/main/src/modules/post/**
  - services/main/src/modules/content-publication/**
  - services/main/src/modules/search/**
  - services/main/src/modules/rating/**
  - services/main/src/modules/rankings/**
  - services/main/src/modules/verification/**
  - services/main/src/modules/source/**
  - services/main/src/modules/package/**
  - services/main/src/modules/owner/**
  - services/main/src/modules/outbox/**
  - services/main/src/modules/read-basis/**
  - services/main/src/modules/event/**
  - services/main/src/modules/recipe/**
---

# Kernel

Status: designed on 2026-10-07; [state.md](state.md) records where the work
stands. The [program](../program/GOAL.md) holds main-wide regression, the
contracts board and shared resources.

## Outcome

The core contracts of the target architecture hold in code, so that the other
Goals build on them and a new view or descriptive vertical adds a query, a shape
and a fixture instead of a handler:

- **One current model, standard representation.** SHACL Turtle is the author
  source of graph constraints; the TypeScript SHACL DSL, the append-only accepted
  locks, the generic arbitrary generator and the 18 `-vN` families are gone; exact
  stored artifacts stay immutable. Each block payload versions alone.
- **Local consistency.** No correctness condition depends on a site-wide order:
  `rv:sequence`, the site-wide model generation guard, before/after graph
  positions, the global outbox position and sequence-bound cursors become local
  revisions, dependency tokens and stream-scoped positions (record §10).
- **Bounded reads and writes.** Reviewed SPARQL templates run as data with typed
  parameters, response schemas and access budgets; descriptive writes run as an
  input shape plus an Update template through the existing Jena command
  executor; the population-scale queries in record §10 become seek, increment or
  projection.
- **One representation per meaning.** Catalogue import writes Statement plus
  acceptance, `rv:Claim` folds into Statement, public Type and release relations
  live in the graph, search copies leave the graph for external entity documents,
  receipts move to owner custody with a compact proof in the graph.
- **Jena used as a toolset.** `tdb2.tdbstats` statistics, tuple `VALUES`,
  bounded property paths and CONSTRUCT, RDF Patch for cold differences, and the
  Jena CLI tools wired into Task and CI.

The contracts this Goal owns on the program's board: C0, C2, C3, C4, C5, C6.

## First wave

Drafts from D2 (`.temp/goal-design/raw/D2-goal-decomposition.md`); real IDs come
from `task goal -- new`, and paths narrow to the files before dispatch.

| Draft | Outcome | Engine; depends |
| --- | --- | --- |
| K1 | C0: accepted becomes the current reviewed basis (same change may update or delete); fold `creditedName` into the current occurrence shape | `codex` high |
| K2 | C2 first slice: Post's author source in Turtle, a bounded converter to TS/TypeBox/JSON-LD, one Work-reference block payload shape; an optional field added in the same change needs no new family | `codex-1` xhigh; K1 |
| K3 | Legal data never poisons shared projections (no-token bodies, long CJK, BCP 47 extensions, Organization descriptions); one failing target never blocks another | `codex` xhigh; K1 |
| K4 | C3 first end-to-end path: Work and Context reads and one outbox consumer on local basis; stream scope on positions | `codex-1` xhigh; K1 |
| K5 | A slim real command on Jena (CAS, policy, focused SHACL, receipt) measured in quads, bytes and commit time; define C6 proof retirement: the graph proof retires only after the owner's durable receipt, the exact payload object and reconciliation | `codex` xhigh; K1, K4, trust-ops T1 |
| K6 | C4 first slice: catalogue import writes Statement plus acceptance; speaker separation, bounded acceptance read, PROV export, subject seek; delete the Statement migration (374 lines, 3 operations) | `codex-1` xhigh; K1, trust-ops T1 |
| K7 | C5 first slice: Work versions, adoptions and credits as three SPARQL templates with a shared adapter; a fourth view of the same kind adds only query, schema and fixture | `codex` xhigh; K1, K4, K2 |
| K8 | Collection as `schema:ItemList`; Recipe create/change/read on the existing Composition owner; bounded Structure membership effects instead of conservative Discover rebuilds | `codex-1` high; K1, K2 |

After the first wave: every profile migrated and the DSL deleted; the
classification capability (record §6, B3) with trust-ops' admission; the rest of
the population-scale queries; external search documents; receipt custody; cold
history export; Jena stats and CLI in Task and CI (with the program); a
qualification harness that imports through the API in batches.

## Inherited

- addresses-discovery: Structure composition effects (Discover rebuilds about
  140 s at 10,000 Works) — K8.
- scoped-subjects: Character merge and split through identity correction
  (closed behind a platform gate until it ships; one identity stays the
  default); personal export fence and seek paging (O(N²)); batch readability for
  named roll-ups; a typed, disclosure-safe outcome for hidden identity members.
- First-round review (`.temp/arch-review/README.md`), re-verify before fixing:
  legal content and languages poisoning projections, ranking rebuilt from full
  history, type admission dropping fields, JSON-LD literal versus IRI, distinct
  cardinality, reads that require a quiescent graph, event poisoning, the Facet
  start-up limit, whole-graph relocation, Definition history drift, the
  language-selection cap, and the npm solver re-run on read (return the sealed
  result; re-running is an explicit audit operation).

## Cut lines

No capability-binding framework, operation registry runtime, semantic
fingerprint or SHACL equivalence checker, Zone population descriptor or
universal Tag type; no pre-sharding, database or distributed transaction layer;
no compatibility layer from the unreleased period; no arbitrary SPARQL,
`SERVICE` or Graph Store writes on product paths and no live OWL or `owl:sameAs`
inference; no LinkML or ShEx as a second model source; no RDF Delta or second
history engine. Every Sol brief names the smallest change and what not to build.

## Completion

The outcome holds through the program's regression and the owner checks, the
contracts board shows C0, C2–C6 landed with acceptance, and record §10's
population-scale list is empty. Capacity at 300 and 500 million business
entities is a later Goal (program, Completion).
