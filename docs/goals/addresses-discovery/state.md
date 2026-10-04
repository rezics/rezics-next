# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-04) |
| --- | --- |
| Done | Wave 1 (G-937 addresses, G-938 relationships, G-939 discovery reads, G-940 migration order and Zone presentation cost, G-941 shared picker, styled controls and account menu), wave 2 (web routers and links, sidebar and relationship controls, Discover and pickers, Space visibility and listing), their UI and the cost-model performance work through G-1063. |
| Running | G-1064: Discover reads through G-1063's versioned entries keep bounded seeks (concept-page, discovery-projection, Work cards, the `g-1011` order dependence and the lexical `popular()` sort it found). The full pass at `189cce0d1` in `.temp/verify` (batches 2–4 failed on G-1063 fallout; 5 passes) started before the heavy-QA lock. |
| Next | On G-1064's exit, resume it with `g-1033-discovery-refresh` (forces a scope due but G-1063's priority lane claims another; fails alone), then merge. Rerun batches 2–4 and any later failures with `--heavy`; `g-1025-timeline` and `g-1038-compound-write` were order failures fixed by `4efda68a2` (owner-schema droppers isolated). Rename `g-1064*` test files to capability names before `goal close`. Finish the report in `.temp/`. |
| Proposed | Composition membership effects in `structure/change.ts` and `structure/outbox-event.ts` (opaque changes still rebuild Discover conservatively); an operating procedure for TDB2 compaction (`docs/testing/complexity.md` mentions growth between compactions without one). |
