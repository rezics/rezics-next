# Activity duration and estimates

Activity duration estimates are deferred beyond the first launch. Contracts
and counterexamples do not supply handlers, storage, admission profiles or a GUI.
The intended job is to choose an activity that fits the available time;
percentage, chapters and completion alone cannot answer it.

## Existing owners and the decision

Read before choosing this boundary:

- [Session contracts](../../services/main/src/modules/session/contract.ts),
  [store](../../services/main/src/modules/session/store.ts) and
  [routes](../../services/main/src/routes/sessions.ts) retain private attempts,
  exact selections, imprecise dates and versioned, idempotent changes. They have
  no elapsed-effort measurement. A `media-time` locator is a position in media,
  not time spent consuming it; date subtraction includes idle time.
- [Progress](../../services/main/src/modules/progress/store.ts) and
  [completion](../../services/main/src/modules/progress/completion.ts) own
  locators and completion effects. Duration neither sets progress nor invents
  completion. A completed session can have an unknown duration.
- [Observation admission](../../services/main/src/modules/rating/observation-admitted.ts),
  [rating decisions](../../services/main/src/modules/rating/README.md) and
  [target aggregates](../../services/main/src/modules/rating/target-aggregate.ts)
  already retain immutable observation revisions, receipts and qualified
  populations. Target components avoid scanning every rater. Their current
  1–10 score scale, principal slots and histograms are rating-specific; there
  is no admitted general duration operation to call today.
- [Exact quantities](../../model/definitions/value-exact-v1.ttl) retain number
  lexicals and unit IRIs. [Library export](../../services/main/src/modules/library-export/bundle.ts)
  already traverses private session rows with owner-bound continuations.

Reuse Observation/metric/procedure meaning, exact quantities, session identity,
Access admission and the existing aggregate inventory/seal pattern. Add a
duration Observation profile and cohort components within those owners, rather
than another telemetry service. Do not widen the rating score scale or put
duration in a progress locator. The proposed contracts live beside the
[session owner](../../services/main/src/modules/session/duration-contract.ts)
and [aggregate owner](../../services/main/src/modules/rating/duration-contract.ts).

The native slot is one observation per private session. Corrections retain the
slot and replace its immutable head; another intentional run uses another
session. Its metric and immutable procedure identify what was measured. A
procedure specifies the method/playstyle, finish criterion, excluded idle time
and unit conversion. Main-story and completionist procedures are distinct
DefinitionRefs, never localized free text used as a join key. Platform is a
qualified resource IRI. An explicitly unspecified platform is its own null
cohort, never all platforms. The target must be one exact selected session
Resource; release revisions remain pinned by the session selection. A Work
cannot silently receive a release's measurements.

## Measurement, estimate and disclosure

Admit a self-reported total of active elapsed seconds for that run. This is an
assertion under the named procedure, not verified gameplay telemetry. `known`
uses an exact nonnegative decimal lexical, at most 18 integral and 6 fractional
digits; `unknown` carries null and the unit. Zero is allowed only when explicitly
reported. There is no timer or automatic date/locator conversion in this cut.
The initial output unit is `http://qudt.org/vocab/unit/SEC`; incompatible units
or procedures are rejected, not guessed. Other time units can be converted by a
later admitted procedure while retaining the original quantity.

An observation is private by default in product flows; the command requires an
explicit contribution choice. `public-aggregate` grants use of the measurement
in public cohort statistics, never publication of its session, identity, dates,
raw observation or evidence links. `private` and `withdrawn` contribute nothing,
including no missingness count. Ordinary membership, moderation and platform
authority grant no own-person access to someone else's session or export.
No raw public duration-list operation is proposed. Small public cohorts disclose
the opted-in statistic and its count; this cut makes no anonymity or differential
privacy claim. Public aggregate consent must explain that a one-run estimate can
reveal the contributed value.

Each exact (target, metric, procedure, platform) cohort counts the latest opted-in
observation per session, not distinct people. Replays do not add a run. Classify
each contributed run exactly once: non-finished session as `incompleteCount`,
finished with unknown duration as `unknownDurationCount`, or finished with known
duration as `sampleCount`. Their sum is `eligibleCount`. Incomplete known time is
retained privately but excluded from the finish estimate. An unknown run is not
zero. A revision to session state reclassifies the contribution before a current
read can succeed. Existing terminal-session rules remain in force; changing a
duration result or withdrawing its contribution does not reopen a finished run.

The disclosed estimator is `arithmetic-mean-finished-known-v1`: exact sum of
seconds divided by sample count, with rational numerator/denominator strings.
Decimal output lexicals use no redundant leading or trailing zeros.
No samples returns `no-data` and null, including when missing or incomplete
runs exist. One sample may yield an estimate with count one. This descriptive
mean is not a promised completion time, a median, a confidence interval or a
remaining-time prediction. There is no prior borrowed from other cohorts.

Each cohort component also keeps an additive fixed log-scale histogram of
finished known durations. Corrections and withdrawals subtract exactly, and
reads remain one component row per cohort. Return the median bucket interval
next to the exact mean and counts, naming the bucket scheme and resolution;
adjacent bounds have a ratio no greater than 1.25. Prove a cohort where one
outlier moves the mean but not the median interval.

Source-reported aggregates stay in Source custody with source revision,
retrieval date, reported procedure, unit and sample count. The query selects
retained source aggregate IRIs explicitly and returns each alongside native
statistics, never as invented sessions or weighted into the native mean. Missing
source fields remain null with named missingness. A source mapping must pin the
exact requested cohort; a broad platform/playstyle statistic cannot masquerade
as a narrower match. Unmatched selected sources are a 422, hidden or missing
ones a non-disclosing 404. This cut adds no ingestion operation or provider
adapter. Source retention/admission remains the existing Source owner's job.

## Bounded neighbourhood and failure contract

The query names 1–16 distinct exact cohorts and 0–16 source aggregates, with at
most 16 source results per cohort. The response preserves cohort request order;
source results sort by source IRI. No discovery, wildcard, release-family join,
per-reader scan or hidden full-cohort reconstruction occurs on an interactive
read. This is request selection, not a cap on stored runs or catalogue size.

Following the target aggregate pattern, a read touches one metric/procedure
definition, one sealed component row and one last-write witness per cohort,
plus its selected sources and a recovery/disclosure fence recheck. Use a total
10-second deadline and 512 KiB response/evidence budget; more evidence produces
503 rather than a partial figure. These are proposed admission budgets, not
measured capacity. The implementation must demonstrate constant owner reads
at large population sizes and bounded native storage work, rather than merely
counting adapter calls. A retained component generation and opaque cohort
revision identify provenance without exposing private admission/session IDs.
Global sequence changes must not change unrelated cohort responses.

Sealing a correction subtracts the recorded old contribution and adds the new
one under old/new cohort gates in canonical order; only those cohorts advance.
Session state changes, privacy withdrawal, erasure and target disclosure changes
use the same eligibility invalidation. Access owns admission/disclosure;
Content owns private sessions. A stale, missing or unsealed cross-owner witness
returns 503, not a stale aggregate. Recovery keeps the old generation unavailable
until a bounded resumable rebuild verifies a replacement. Reads never repair
inventory. Implementation must qualify crash/retry and revocation composition;
the present rating implementation does not prove this new composition.

Capture checks the caller's own Person, session version, observation head,
readable selected target and admitted metric/procedure. The command's same-key,
same-intent retry returns the original receipt without another contribution;
different intent is 409. A changed session version or head is 409 with current
private state only for its owner. Replacing a measurement is a full command;
null head creates only when absent. Unknown is a result, not withdrawal.

## Reuse across tasks and alternatives

For a book, the same run and unit measure elapsed reading under a named edition
and reading procedure. For a recipe, the same mechanism measures active
preparation or total elapsed cooking under distinct procedures and exact recipe
targets. Neither requires a domain branch. A derived reading pace needs an
admitted amount/read-unit numerator and a named ratio metric; duration alone
cannot infer pages per hour or remaining chapters. Recipe serving-size or
equipment adjustments likewise need explicit cohorts/procedures. These are
extensions of the same observation and component boundary, not claims proved
by the games row.

Rejected alternatives: session date subtraction includes breaks; percentage or
chapter conversion assumes a pace; extending 1–10 rating histograms corrupts
scale and population; a game-only timer duplicates admission and disclosure;
query-time scans make work proportional to every contributor; pooling imported
means invents native evidence. Exact medians would require another bounded
order-statistic mechanism, so the first cut chooses additive mean components.

The [2017 SOSA/SSN Recommendation](https://www.w3.org/TR/2017/REC-vocab-ssn-20171019/)
distinguishes feature of interest, observed property, procedure and result. It
supports the semantic separation here, not the selected estimator or access
policy. [DQV's 2016 Note](https://www.w3.org/TR/2016/NOTE-vocab-dqv-20161215/)
separates a metric and its measurement/provenance; it does not make elapsed
duration a rating score. These sources were checked on 2026-10-15. The choice
of additive mean and public opt-in runs is this proposal's deduction.

## Review and falsification

`games/play-duration-estimates` declares six pending persona cells. Its public
API test requests four platform/procedure combinations on exact releases, keeps
incomplete and unknown runs out of the denominator, corrects one observation,
checks unrelated cohorts byte-for-byte, exports procedure/unit and rejects
foreign private reads/writes/exports. Current Main has neither duration capture
nor duration query routes; each persona must reach an HTTP failure for that
missing capability, not fail during unrelated fixture preparation.

The owning contracts must include both the mean and median-interval requirements
before implementation.
Implementation must make these tests pass without changing them, and add owner
proof for migration, seal recovery, state/privacy reclassification, source/native
separation and bounded large-population reads. No visual surface is changed or
qualified in this step. The later surface must explain sample count, unknowns,
procedure and the limits of a fit estimate; API success alone proves no human
usability result.

The launch registry has no duration-estimate row. Restore the deferred
`games/play-duration-estimates` outcome specification from commit `9764891737`
with the implementation brief, incorporating the median requirement before
proving its persona outcomes. The earlier unsupported-route probe established
no correction, export or disclosure behavior.
