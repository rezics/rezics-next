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
backend run is named in `docs/plan/README.md#current-state`.

Target ratings (release, realization, occurrence, resource and projection grains) read from
additive components, never from a walk of the raters. Access keeps the head
count, rating count, sum and a 1–10 histogram per (RatingContext, target).
The seal that moves a head moves its target row in
its own transaction (subtract the head's recorded value, add the new one;
withdrawal subtracts only), and the sealed value must match the admitted request
digest. Count and sum are what the histogram says, which the database checks.
A target of at most 100 raters is also verified head by head against its
manifests and must equal its components; a larger one is witnessed by its last
sealed write, which must still be its observation's live head, so a graph that
lost it or rolled back past it makes the read unavailable instead of wrong. Heads
sealed before components existed have no recorded value (SQL cannot read the
graph): they are counted as `unvalued`. A target of at most 100 raters stays
readable, because the head-by-head check recomputes its figures; a larger one is
unavailable until explicit reconstruction or its raters' next revisions record the
values. `task rating:reconstruct -- --env <apps.env> --list` lists the targets that
still need it (`--context` narrows it; `--after-context` with `--after-target`
continue a page). Reads never repair inventory or take an exclusive observation gate.

Standing MainVersion ratings use the same sealed additive-state rule, including
Global ratings, Realm reads, search previews and named Realm/Global synthesis.
Their sparse histogram retains the Context's exact decimal scale. The private
effective-person ledger applies native precedence over merge selections, and
merge, unmerge and source revisions subtract the recorded contribution before
adding its replacement. Up to 100 heads retain full manifest verification; larger
populations read the additive figures and verify a surviving sealed contribution's
live head, receipt, digest and immutable manifest in the same single graph
snapshot as the Context. The graph and manifest byte budgets and deadline are
unchanged. A reader's own slot is an indexed selection, independent of population.
The bounded private inventory still reads at most 101 heads, including its
overflow sentinel; it is not the aggregate's population.

Standing publication follows the affected Work, MainVersion, Context and
retained contribution paths. Before changing the graph identity edge, the
identity owner commits the task's source/survivor Work and MainVersion pair on
an independent Access checkout, even if its journal is inside an outer
transaction. The graph command must still match that bound pair. A completed
fence permits receipt replay, never a new effect when its receipt is missing.
App composition reserves one connection from the
existing Access pool limit for these independently committed fences: the default
ten connections become nine ordinary connections plus one fence connection.
The Access pool owns and closes both lanes. The usual nested-checkout guard
still applies within each lane; a full ordinary pool cannot starve the fence.
Reservation precedes request service and requires a pool limit of at least two.
Only the existing journal's guarded completion, after every owner is exhausted,
marks that fence finished; its cut and revocation evidence remain retained.
Preparation itself is durable, bounded owner work. Before any graph effect,
each page visits at most 100 context, origin, lineage-edge or component entries,
including exhausted probes. A preparing request commits its cursor and refuses
the graph effect; retry resumes that same task. This does not cap the task's
total population or history. New effective origins register against open
transitions through a bounded cursor and hold only their own component while
registration remains pending.
A native rollback or lost graph response holds the affected cuts until that
exact task reconciles. An unrelated Work or a Context with no affected
contribution stays readable. The fence covers detached contributions other than
the one chosen as witness, for both Realm and Global. An inherited witness must
also retain its graph path to the requested Work. Deleting a native head
reselects a surviving contribution with one indexed probe, so a consistent
102-to-101 deletion does not need a later write to become readable.

Grouped dependency counts record each component's effective origins and merge
paths. Immutable path nodes and per-person retained-item bindings distinguish
different histories carried by the same task. A native vote overrides its
inherited selection; undoing that selection's ancestor cannot revoke the native
vote or a later descendant that inherited it. New selection delivery needs one
indexed parent binding and inherits one revocation pointer, independently of
ancestry depth. The owner walks descendants before admitting an unmerge's graph
effect. New descendants inherit that pointer and register cleanup without
rediscovering their ancestors. Completed ancestry remains retained; it is not
aggregated again on a read or an exhausted continuation.
Upgrade reconstructs old paths from retained rating snapshots and refuses
missing/cyclic ancestry or an orphan fence without its identity journal; it
cannot guess an affected pair or silently discard revocation evidence.
The forward migration leaves legacy inherited components held until bounded
historical revocation discovery has established their cut. Pending legacy native
cuts retain their known Work binding while the exact Main Version is recovered.

A source head seal, replacement, deletion or reconstruction CAS refreshes its
native slot and at most one retained projection synchronously. An indexed second
probe records any remaining projections in a durable keyset job; there is no
trigger loop over all survivors. Thus a 100-head reconstruction has at most 200
slot refreshes, including hidden trigger work. Run
`task rating:reconstruct -- --env <apps.env> --refresh-standing-projections`
to resume one page of at most 100 projections; `--context`, `--batch-size` and
`--batches` narrow or bound the work as for reconstruction. Progress stays in
Access, and a new source seal rewinds the cursor atomically. Page replay applies
the same native-precedence/delta function as admission, under the recovery,
authority and source gates. Missing originals remain explicitly unknown. Native
readiness skips origin jobs entirely. Retained readiness uses indexed delivery
frontiers grouped by effective inherited origin; it never compares every native
person's contribution with its head. Already delivered targets remain readable
while later projections wait. An origin-wide frontier is conservative: another
pending person's delivery from the same origin can still hold a mixed component.
Its work is proportional to distinct inherited origins, so constant readiness
work for arbitrarily many distinct origins is not established by this mechanism.
Every page checks current revocation before refreshing a slot, so continuation
cannot reconstruct an undone inherited contribution.

Completed unmerges can leave revoked inherited selections beyond their direct
pair. Preparation records a durable edge/component frontier for every affected
lineage. Completion advances at most 100 metadata units and can release a fully
consistent cut; it stops before a remaining projection deletion. The same
continuation spends at most 100 total units on discovery, exhausted probes,
selection deletion and fence release. Each deletion applies the normal
native-precedence delta. Metadata progress does not increase `refreshed`, which
continues to count changed selections. Affected reads
remain unavailable until their own exact state is consistent; an unrelated cut
does not need this cleanup to finish. The command's `complete` describes the
selected Context's projection jobs and revoked-selection cleanup, and its
`recoveryGeneration` binds that progress to the recovery cut. It does not declare
all standing reads available or finish an identity task.

Each component carries a revision under its existing target gate. Publication
hashes that revision and its local cut revision. Fence registration and release
advance that cut under the same transaction as their membership change; there is
no sorted finished-history aggregate or recursive lineage query on a read.
A task that starts and finishes during a read changes its fence,
including a late commit with a lower transaction id. Unrelated transactions do
not hold publication behind a database-wide snapshot horizon. The recovery
generation invalidates reads across logical restores. The existing statement
timeout and request cancellation budget apply to every read and continuation.
The repeatable-read inventory returns candidates, component and witness in one
SELECT: BEGIN, SET, SELECT, COMMIT per Context, plus one final fence SELECT for
synthesis, preserving the retained nine-statement SQL contract at 100 and 101.
The final fence rechecks every selected Work/Context cut in that one fresh
statement. Neither requests nor head triggers maintain a global publication
counter. The fifteen standing Access relations are explicit authority-cut entries in
`work/access-recovery-coverage.ts`, with their derivation and restore dependencies;
none can be cleared independently to reopen publication.

This uses PostgreSQL's [stable repeatable-read snapshot](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-REPEATABLE-READ),
[AFTER-trigger visibility](https://www.postgresql.org/docs/18/trigger-datachanges.html)
and [indexed ordered limits](https://www.postgresql.org/docs/18/indexes-ordering.html).
Stack-free checks cover owner protocol, adapter call counts and manifest
composition; they do not establish native interruption, trigger fanout, lock
contention or restore correctness. Native work assertions explain the actual
inventory and final-fence SQL and use PostgreSQL's
[nested auto-explain plans](https://www.postgresql.org/docs/18/auto-explain.html)
for lineage trigger/continuation work. Execution receipts must state their pinned
revision and assertions reached. Current-product isolated proof is authorized;
delayed seals and graph-only loss, old retained snapshots, contention and
authenticated corpus/backup restores need their own genuine prerequisites and
evidence. A surviving
witness is not an independent maximum-position seal for all earlier heads.

For standing heads sealed before additive values existed, use
`task rating:reconstruct -- --env <apps.env> --standing --list` and then
`--standing --context <IRI> --target <MainVersion IRI>`. This uses the same bounded
checkpoint procedure below and the aggregate owner's manifest verifier. A page
of inherited slots records values at their original heads and schedules bounded
retained-projection refresh when needed. Finish those projection pages before
claiming publication is ready. No read silently calls an unvalued large
population exact.

`task rating:reconstruct -- --env <apps.env> --context <IRI> --target <IRI>`
runs one bounded batch, retains an atomic checkpoint under
`.temp/rating-reconstruction/`, and resumes on the next invocation. `--batch-size`
is 1–100 and `--batches` is 1–32. Each batch verifies the live heads, receipts,
request digests and immutable manifests within the aggregate's byte budget and
deadline. An indexed slot cursor skips already valued heads; revision CAS and the
unvalued condition make lost-response retries idempotent. A recovery generation
change rejects an in-progress cursor; after reconciliation use `--restart` to
scan the remaining heads from the beginning. Missing or contradictory evidence
fails the batch without moving its checkpoint.

Authority remains `rating:observe:<Context>` for grants, closure, relay and
Discover. Observation registration, claim and seal hold that authority fence
`FOR SHARE` and serialize only on `(Context, target)`; closing the scope and
bumping its epoch keep the exclusive lock, and a write that waits out the 2 s
lock answers 409 `rating_write_busy`, safe to retry with the same key.
Reconstruction acquires the same target gate after holding the recovery fence `FOR SHARE`. Independent targets can seal together,
while recovery closure waits for an in-flight reconstruction to commit. This
uses PostgreSQL's [shared row lock semantics](https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS)
and [indexed ordered pages](https://www.postgresql.org/docs/18/indexes-ordering.html);
the selected database concurrency tests establish the composition, not launch
capacity.

Aggregate evidence is the Context's `contextRevision` and the target components'
`lastAdmissionId` (null for an unrated target). A roll-up returns the same Context
revision and each available member's last admission. `sourcePosition` is an owner
admission witness, including the Context admission when no member has ratings;
it is independent of the dataset's current sequence. Pin the Context revision
and every member's last admission to identify the complete aggregate evidence.
Unrelated writes therefore leave these responses unchanged.

A Context shows a target's mean only from its display threshold, 5 ratings by
default and 10 for the `projection` grain, and a `realm-target-rating-context-v3`
Context may declare its own. Count, sum and histogram always show: with the
histogram the mean is no secret, but a mean from a handful of ratings is not
evidence, and a ranking built on it would be noise.

`POST /v1/rating-rollups` is a derived metric over one RatingContext, not a stored
or cached figure. `pooled` is the sum of the members' sums over the sum of their
counts; `mean-of-means` averages members' means and counts only members at or
above the threshold. The two can rank two roll-ups in opposite order, which is why
the formula, member count, coverage (members at the threshold over members the
question counts) and every member's components travel with the value, and why the
value is withheld below half coverage. A member the caller cannot read, that does
not exist, or has another grain is listed as unavailable with its reason and still
counts in the denominator. A member the Context does not accept is `not-accepted`,
distinct from unavailable, and is left out of the value, that denominator and the
ranking. A v1–v3 Context accepts every member its grain admits. A ranking uses a Bayesian weighted rating, `v/(v+m)·R + m/(v+m)·C`,
whose prior mean C pools only the readable, accepted, verified members named in
that request and weight m is their average ratings per target, never under 50.
Only the prior mean and weight are returned. A ranking lists members from
`max(50, displayThreshold)` ratings, so its means and scores cannot bypass a
Context's threshold. The prior is request-scoped: different selections can
produce different scores. Using the same readable members avoids disclosing
hidden targets through Context totals, and the unused sharded totals are removed
by a forward migration.
Different Contexts, questions, scales or populations are never combined, and no
mean is ever an input.

Materialized rating projections, joined rating search, policy-controlled
backdated entries, cross-context policies beyond the named Realm/Global
synthesis, and physical capacity need separate implementation and qualification.
