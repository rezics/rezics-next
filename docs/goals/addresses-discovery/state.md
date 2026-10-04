# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-04) |
| --- | --- |
| Done | Wave 1 (G-937 addresses, G-938 relationships, G-939 discovery reads, G-940 migration order and Zone presentation cost, G-941 shared picker, styled controls and account menu), wave 2 (web routers and links, sidebar and relationship controls, Discover and pickers, Space visibility and listing), their UI and the cost-model performance work through G-1063. |
| Running | G-1064: Discover reads through G-1063's versioned entries keep bounded seeks, and three related integration failures. A full integration pass at `189cce0d1` runs in `.temp/verify`. |
| Next | Merge G-1064; rerun concept-page, discovery-projection, Work cards and the discovery files, plus failures from the full pass; finish the report in `.temp/`. |
| Proposed | Composition membership effects in `structure/change.ts` and `structure/outbox-event.ts` (opaque changes still rebuild Discover conservatively); an operating procedure for TDB2 compaction (`docs/testing/complexity.md` mentions growth between compactions without one). |
