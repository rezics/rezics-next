---
# No areas until a manager starts this Goal and chooses them.
areas: []
---

# Production readiness

Status: **retiring** (2026-10-07). Its milestones and inherited items were
re-derived from the target architecture and the new first public scope and
moved to [kernel](../kernel/GOAL.md), [trust-ops](../trust-ops/GOAL.md),
[launch](../launch/GOAL.md) and [program](../program/GOAL.md); the program
closes this Goal once each item is in a brief. Below is the history as it stood.

Earlier status: no manager since 2026-10-04, when several Goals began to run at once
and the addresses, relationships and discovery workstream (standing direction 9
until then) became the addresses-discovery Goal, closed on 2026-10-05 and archived on
`archive/goals`.
This Goal holds the rest of M4–M8. Its next manager starts it with
`task goal -- goal start production-readiness --manager <session>`, chooses its
areas and may split it into further Goals where the milestones below run in
parallel; [state.md](state.md) records where the work stands. Numbered
decisions are in the [decision index](../../product/decisions.md); the
[goal page](../../product/goal.md) states the product goal.

History: direction settled on 2026-09-29 and revised by the documentation
discussion that ended on 2026-09-30 (decisions 39–50). The M4–M8 brief drafts in
`.temp/research/briefs-m4` to `-m8` predate that discussion: re-derive briefs
from the current documents and use the drafts only as material. The work before
the restart was wrapped up on 2026-09-30: G-486 merged; G-432, G-433 and G-435
were closed after one more run on GPT-6.1 Sol, their work kept on their
`goal/g-43x` branches for the M5–M6 briefs to salvage; G-536, M4's first task,
is stopped before any change. The frontend-centred Goal before it paused after
M3 at `59a85a96`. Backend phase 1 finished on 2026-09-27: recorded run
`20260927t101230-1616d8`, local tag `goal/backend-phase1`, history on
`archive/goals`. The public about site (G-480 to G-482) presents the direction
meanwhile.

## Outcome

Make REZICS complete and ready for production.

**Complete** means each supported job can be discovered, completed, confirmed,
revisited, recovered and exported through authorized APIs and an accessible
browser experience, on phones as on desktops, at the quality GitHub, Reddit,
Fandom and Notion set for the same job. Their combined inventories are benchmarks,
not scope. The API is the complete experience; the UI simulates it for people;
every capability is accepted through both. The [goal](../../product/goal.md)
states what REZICS is for and how success is judged; the
[product scope](../../product/capabilities.md#first-scenarios) owns the first
scenarios and the longer-term knowledge, creator and distribution direction.

**Ready for production** means deployment to the prepared fleet is operations
work. Deployment is the next phase; the
[deployment owner](../../operations/deployment.md#ready-to-deploy) records readiness.
Intended registration markets are the United States, Taiwan, Singapore, Japan,
South Korea and the EU, subject to the
[market and safety gates](../../operations/trust-and-safety.md#safety-and-legal-readiness).

## Milestones

The manager revises them. A milestone counts only when merged, its checks pass,
its journeys pass through the API and in a real browser against the local stack,
and the `product-audit` skill finds no open P0 or P1 class in its area.

- **M4 Meaning, authority and preservation.** Foundations 6–8 and 13, the
  suitability model, document identity and operation contracts; repair date
  loss, empty saves, public draft covers and private-name publication; the
  catalog gate and the persisted-profile check. Exit: counterexample fixtures
  pass; simple edits keep richer state; denied and revoked operations fail
  correctly; the language and profile guards fail on deliberate regressions.
- **M5 Shared capabilities and safety.** Foundations 9–12 and 14: indexed
  traversal, shared query execution, resumable operations, document recovery,
  scoped grants, reporting, enforcement and appeals, upload clearance,
  principal budgets, the registry and its adapters. Exit: inventories traverse
  past every former bound; a retried operation has one effect; policy holds on
  every channel; pending contributions and legal cases reach real outcomes.
- **M6 The vertical engine, the first scenarios and the first verticals.** The
  [shared engine](../../product/platform-thesis.md), configurable through both
  the API and an administrator UI: capabilities on any admitted resource, a
  served type registry, the relation lexicon and Zones as routed sites, with
  the domain-specific backend paths found in R49 removed;
  then, as configuration on it: the franchise wiki Zone with one-click building
  by holders' agents; library import, sessions and export; series,
  edition and availability tracking; serial drafting, scheduling, reading and
  discussion; VN discovery by release; the Light Novels and ACGN Zones with
  episode tracking on the shared progress foundation; and the LLM index with
  ratings as the engine's proof. Exit:
  paired API and browser journeys pass with ambiguous editions, expired loans,
  mixed formats, non-UI languages, thousand-chapter inventories, revoked
  editors, interrupted exports and two-device progress; the
  [expansion acceptance](../../product/platform-thesis.md#expansion-acceptance)
  passes.
- **M7 Contribution, knowledge and assistance.** Classification and
  corrections, the review lifecycle, subscriptions and inbox, community
  completeness, settings and modes, saved views, the editor and Realm wikis,
  developer onboarding and non-core developer extras, worldbuilding, wiki
  maintenance on new chapters, the agent platform with the first-batch agents, and
  distribution's first scope behind the payment gate. Exit: propose, review, revise, decide, notify and recover work
  end to end; changed candidates invalidate approval; historical wiki rendering
  and export survive dependency changes; replacing an assistant keeps its
  authorized artifacts.
- **M8 Production qualification.** Deployment artifacts, production bootstrap
  and the launch catalogue, timed recovery, security review, email operations,
  legal configuration within the zero-budget decision, safety drills,
  privacy-preserving measurement, real-device and accessibility acceptance,
  and Stripe's approval before any sale. Recognition ships here; points and
  credit follow launch. Exit: no open P0 or P1 class or
  High security finding; launch workloads meet budgets; recovery and takeout
  demonstrated; every supported capability has acceptance evidence; market
  gates and named responders ready.

Counsel, staffing, catalogue supply and device testing start alongside M4.
After M4's contracts settle, language and search, authority and safety, and
documents and operations run in parallel; in M6 the scenarios run in parallel
against the shared contracts.

## Inherited from addresses-discovery

Found while that Goal verified its work, outside its outcome (2026-10-05):

- **Safety-matching outage admission.** `docs/operations/trust-and-safety.md`
  says required safety-matching outages follow their own admission policy,
  but no required-matcher adapter exists; SAFETY04 now covers only the NSFW
  classifier outage. Needed before launch (M8 safety drills).
- **TDB2 compaction procedure.** TDB2 grows between compactions
  (`docs/testing/complexity.md`); bulk Work import cut growth about 45 times,
  but production has no compaction schedule or procedure (M8 operations).
- **Structure composition effects.** Discover classifies outbox events by
  their effect (`services/main/src/modules/discovery/effects.ts`); opaque
  structure changes in `structure/change.ts` and `structure/outbox-event.ts`
  still rebuild Discover scopes conservatively (about 140 s at 10,000 Works).
  Bounded composition membership effects would make them Work-local.

## Inherited from showcase

The showcase Goal delivered [decision 54](../../product/decisions.md#decision-54)
and closed on 2026-10-05 at the maintainer's request before its own
acceptance pass; these remain:

- **Showcase acceptance.** Reseed the shared stack once the full seed
  converges (its showcase step runs last), then review the Games Zone hero and
  a game's Work page at 390 and 1280 px, signed in and out, with labelled art;
  run `task goal -- test --affected 932ada68c` for the showcase merges.
- **Slide accessibility leftovers.** A slide migrated from a v1 banner should
  render the banner's alternative text; the slide title is announced twice;
  the legacy banner helpers in `apps/web/features/realm/adapt.ts` can go.
- **Batched author proofs.** The showcase art batch read
  (`POST /v1/resources/showcase`) still checks private Works' author proofs one
  Work at a time (`access/author-baseline.ts`).
- **Correcting a saved image's NSFW label** from the showcase editors; today
  only new uploads carry the author's adult mark.
- **Logo slots.** A removed logo language still counts toward the eight
  languages a Work may hold.
- **Locale review.** The Realm showcase editor rendered in English from `/ja/`;
  the editors' and kind words' non-English strings need native review.
- **goalctl.** Merging a shared worktree's branch should mark every task on it
  merged (G-1111 and G-1143 had to be closed as cancelled).

## Inherited from write-concurrency

The write-concurrency Goal removed platform-wide write serialization from user
paths (rules in [workload budgets](../../storage/workload-budgets.md#complexity-contracts),
enforced by `scripts/qa/serialization-points.ts`) and held main-wide
regression until it closed on 2026-10-06. These remain:

- **Deployment PostgreSQL.** Production provisioning must grant
  `pg_read_all_stats` to the Access and Content owners (horizon lag gauges)
  and set `max_prepared_transactions=0`; the local compose and init script do.
- **Long migrations.** Content 791 and some later migrations validate or index
  whole tables under exclusive locks; run them in the maintenance window and
  measure them on a production-sized restore first.
- **Row lock upgrades.** The guard refuses shared-then-exclusive upgrades on
  scope gates only; library visibility hit the same deadlock on an Agent row
  (fixed). Alert on `pg_stat_database.deadlocks` and audit other
  share-then-update paths.
- **Seed in operator mode.** Since Zone denials answer 404, the seed cannot
  tell an absent Zone from a denied one when an operator grant failed.
- **Review queue lag.** Review-rank rows keep only their occurrence time, so
  the review horizon reports the oldest writer but not the queue's own age.
- **Test fault injectors.** Several fault injectors and counters still count
  background work; the audit is in the Goal's archived notes. Scope them when
  a test that uses one flakes.
- **Checkbox journeys.** G-1212 made the shared checkbox's input take pointer
  hits; run `g-839-work-levels-edit`, `g-843-catalogue-intake` and `library`
  journeys, which call `.check()` on it and failed before (the last run was
  stopped by host memory pressure).
- **Order-dependent tests.** g-832-lexicon, g-856-position,
  post-search-disclosure, projection-by-frame and growth-search-context pass
  alone but assume a fresh database.

## Completion

The Goal ends when the maintainer stops it, or when M8 passes its exit and the
maintainer agrees. Either way it closes with
`task goal -- goal close production-readiness`, which refuses while anything of
it is left in the tree.

## Constraints

The manager's authority and the maintainer's standing directions are in the
[manager charter](../manager.md). Other documentation records practice
to consult, not rules. The manager runs workers through the
[Goal program](../README.md), and workers follow the
[worker protocol](../worker.md).

The [deferred rollout scope](../../product/capabilities.md#deferred-rollouts) stays
outside this delivery. Code, schemas and tests own executable behaviour; the
linked documents own lasting intent, reasons and operating procedures.
