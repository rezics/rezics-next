# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-04) |
| --- | --- |
| Done | Goal created; addresses-discovery released `services/main/src/modules/rating/**` (e1cfd475e). |
| Running | Read-only scouts of ratings, the semantic core and the web app (`.temp/manager/scoped-subjects/scout/`). |
| Next | S1 decisions in their owners, then the S2–S4 backend briefs and the S6 frontend briefs. |
| Coupling | New rating events or actions need entries in Discover's outbox classification (`services/main/src/modules/discovery/**`, addresses-discovery's area): send the brief to rezics-next-1c first; keep the g-1063 cost tests and `/health/rating-ready` and `/health/discovery-ready` green. |
