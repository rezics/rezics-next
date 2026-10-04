# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05) |
| --- | --- |
| Done | Every outcome in GOAL.md and the 10-03 additions, merged through G-1089: addresses, routers, Follow/Join/notifications, Discover, pickers; API cost work (Home, Realm, search, long works, writes, Discover/rating projections G-1063/G-1064/G-1070); verification fixes G-1069 (SAFETY04), G-1073 (Account recovery ledger), G-1086/G-1087 (shared command-race helper), G-1089 (racing semantic changes answer 409); QA isolation guards. Final checks: browser 96/96, Storybook 1,970 + 271, unit 672/672, fault/recovery 69/69, integration 15/16 batches at 830b71552. |
| Running | Wrap-up (maintainer, 2026-10-05). The main-wide regression duty went to scoped-subjects; this manager's last full pass (final16 at c47152d97) is finishing as handover material, and an attribution run checks whether G-1089 caused g-629 and g-1059 (both fail at c47152d97). |
| Next | If the attribution clears G-1089: send scoped-subjects the final16 results, remove this Goal's row from the root GOAL.md and run `task goal -- goal close addresses-discovery`. If it implicates G-1089: fix that first, with one task. |
| Proposed | Composition membership effects in `structure/change.ts` and `structure/outbox-event.ts` (opaque changes still rebuild Discover conservatively); an operating procedure for TDB2 compaction (`docs/testing/complexity.md` mentions growth between compactions without one). Planned after G-1064 (agreed with scoped-subjects, 2026-10-04): classify target-rating events in `discovery/effects.ts`. A `com.rezics.rating.observation-changed.v1` for a target rating carries `target` (the receipt's `rv:target`, possibly a projection) and no `work`/`main`; Work-owned grains (release, realization, occurrence) also carry `target`. A rating is Work-local only if it changes an aggregate that Discover or the global MainVersion rating projection reads; all other ratings are irrelevant (advance the position); unknown actions still rebuild. The relay generic-target branch is scoped-subjects' work. |
