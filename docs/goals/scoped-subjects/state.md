# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-04) |
| --- | --- |
| Done | Goal created; addresses-discovery released `services/main/src/modules/rating/**` (e1cfd475e); S1 decisions 51–53 in their owners (058c74fe3); half-week Claude cap lifted (34d42a207). |
| Running | Wave 1 on Sonnet: G-1065 projections, G-1066 additive ratings, thresholds and roll-ups, G-1067 identity links and credited names. Scout maps in `.temp/manager/scoped-subjects/scout/`. |
| Next | Merge order G-1065, G-1066, G-1067 (migrations 1050–1059). Wave 2: projection grain for ratings, reviews and discussion with Global-owned target Contexts (needs G-1065, G-1066; outbox classification with rezics-next-1c); statement normalization, projection page and continuity filter (needs G-1065); canonicity definitions; acceptance fixtures; then Sonnet frontend for entity, family, unit, title and projection pages, scoped rating and roll-ups, continuity switch; export last. |
| Cut lines | Character merge and split stay with production-readiness (identity merge is Works-only); distinct-collector family counts dropped. |
| Coupling | New rating events or actions need entries in Discover's outbox classification (`services/main/src/modules/discovery/**`, addresses-discovery's area): send the brief to rezics-next-1c first; keep the g-1063 cost tests and `/health/rating-ready` and `/health/discovery-ready` green. |
