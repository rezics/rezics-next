# State

The manager's checkpoint for [this Goal](GOAL.md); live tasks:
`task goal -- status`.

| Field | State (2026-10-05 01:00 CST) |
| --- | --- |
| Done | S1 decisions 51–53 (058c74fe3). G-1067 identity links and credited names, G-1065 projections, G-1066 additive rating components, thresholds and roll-ups (sharded per-Context totals), each regenerated on merge; shared stack on Fuseki `a79b73c254cd` with migrations through 1055. Half-week Claude cap lifted (34d42a207). |
| Running | G-1071 (Sol) projection pages, frame filters, canonicity and variant-kind seeds; G-1074 (Sol) projection grain for ratings, reviews and discussion, v4 accepted subject types and frame dimensions, Global-owned questions, relay target branch. |
| Waiting | G-1072 (Sonnet) character pages: variant families, units, titles, credited names, withheld means; Claude dispatch is restricted while the week projects past 95%. Verification: rezics-next-1c's full pass on 5b1b4a8f5 plus fault/recovery covers G-1065–G-1067; failures in our areas come back to us. |
| Next | Fixtures task for the eight acceptance cases and the first Global questions (after G-1071 and G-1074 close); frontend for projections (rate in episode/match, projection page, roll-up and ranking views, continuity switch); export (Web Annotation, DQV). |
| Proposed | Per-target admission scope for target ratings (the per-Context scope gate serializes seals); batch readability check for roll-ups in `modules/target`; reconstruction job for legacy targets above 100 raters; `projection:write` OAuth scope; projections of merged subjects. |
| Cut lines | Character merge and split stay with production-readiness (identity merge is Works-only); distinct-collector family counts dropped. |
| Coupling | rezics-next-1c classifies rating and projection events in Discover (`projection.create` and non-MainVersion targets are irrelevant); relay field for target ratings is `target`. Migrations: main's highest Access file is 1060; G-1074 holds 1065–1069. |
