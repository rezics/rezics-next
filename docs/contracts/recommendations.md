# Recommendation and ranking generations

## Current profile and intended scope

The deployed [ranking basis](../../services/main/src/modules/recommendation/ranking.ts)
counts admitted latest rating slots per declared public, Realm or personal
population. Exact Context definition/selection and preference revisions are
separate dependencies. Popularity cannot authorize a candidate, establish
classification truth, infer a person's interpretation from reading or liking,
or promote an interpretation to Global meaning. Imported aggregates do not
become native votes.

[Generation state](../../services/main/src/modules/recommendation/derived-generation.ts)
pins source positions, validates before activation and fences stale workers.
The ranking worker coalesces bounded signal batches and checkpoints progress;
one synchronous global exact counter is outside this profile.
Reads use deterministic score/IRI order, bounded positive and zero-score
windows, current disclosure checks and generation-bound cursors. Missing
active ranking has no fallback in this profile. [Recommendation acceptance](../../scripts/qa/cases/recommendations.ts)
separates generation, disclosure and skew/load evidence.

## Further profiles

Additional content/activity signals, source aggregates or time decay require
their own declared population, counting and score policy. They must preserve
semantic meaning independently of preference ordering and private delivery
exclusions. Erasure or revocation must stop affected delivery immediately and
recompute asynchronously. No profile may present an incomplete page as exact
or mix orders after a stale cursor. Cursor dependencies include Context and
disclosure; retention must bound old generations and preserve replay needs.
