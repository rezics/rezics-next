# Rating owner decisions

A RatingContext identifies the question, target, population, scale and cadence.
Sharing a semantic Context or the same numeric range does not combine questions.
Changing a question creates another RatingContext; changing the experience
reduction changes its separate policy head. This keeps old observations tied to
the meaning under which they were admitted. MainVersion, release, translation
and exact software/model version are separate target grains; their populations
cannot be silently rolled together.

Standing, daily and experience slots represent different intentions. Standing
asks for one current opinion, daily uses the server's civil day, and experience
uses a client-retained occasion marker bound to the private Access principal.
The marker identifies an intentional evaluation; it does not prove that an
external event happened. The private binding prevents persona changes from
creating extra votes. Global standing uses a separate population and scale.
Imported aggregate scores remain source statistics, without invented native
observations or principals.

A daily period uses the first valid instant of a civil day and calendar addition
for its end. Twenty-four-hour UTC arithmetic changes the question at DST gaps
and overlaps. Retained observations keep their exact admitted bounds when the
server's timezone database changes.

The policy implementations live in `experience-reduction.ts` and `synthesis.ts`.
Their tests preserve separate denominators and scales. Owner manifests, current
heads, receipts and the Access inventory determine whether an aggregate is
complete. A missing or mismatched owner record makes it unavailable. A zero
contributor result is `no-data`; it is not evidence loss. The selected fixtures
measure adapter calls and bytes. They do not qualify native Jena operator work,
hot-head contention or deployment capacity.
Bulk aggregate fixtures do not qualify the interactive writes they bypass.
Pre-inventory Contexts need explicit reconstruction before these reads can claim
completeness. A matching rollback of both owners outside an authenticated
recovery cut is not independently detected by the aggregate; matching inventory
alone is not a valid restore proof. The selected graph-loss fixture does not
qualify the production signed owner-cut release gate.

The standing, daily, experience, Global and release profile definitions live in
`model/definitions/`; the exact admission and read contracts live in this owner
module. RATE01–09 are declared in `scripts/qa/cases/ratings-and-event-time.ts`;
`scripts/qa/coverage/rate*.ts` names the complete-case tests. The recorded
backend result lives in `docs/plan/qualification.md`.

Materialized rating projections, joined rating search, policy-controlled
backdated entries, cross-context policies beyond the named Realm/Global
synthesis, and physical capacity need separate implementation and qualification.
