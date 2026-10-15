# Private plans and scheduled actions

Proposal for program review, 2026-10-15. This decides the smallest Scheduled
extension behind competitor-coverage finding B05. It proposes ownership and
semantics; it adds no contracts, scope rows, operations or implementation.

The intended loop is capture–plan–shop. Recipe capture already exists;
[actionable Collections](actionable-collections.md) decides entries, runs and
shopping derivation. Planning adds a private time and optional finite recurrence
to an intention, cancellation, a durable notification due action and export.
Meal plans, reading-club meetings, return reminders and release/airing calendars
configure this capability. They do not acquire separate calendar owners.

## Existing owners and the proposed extension

The [capability thesis](../product/platform-thesis.md) already names Scheduled
and Event/Activity/Action. That vocabulary is broader than current behavior:

| Owner and present evidence | Reuse | Addition and reason |
| --- | --- | --- |
| Main Event: [time validation](../../services/main/src/modules/event/time.ts), [interval projection](../../services/main/src/modules/event/schema.ts), [routes](../../services/main/src/routes/events.ts). Observations distinguish planned/actual, civil dates/instants, precision and known/unknown/open endpoints; observation/query exposure is `platform:events`. | Event identity, exact time/evidence revisions, temporal interpretation and selected dependency fences. | Private schedule definitions, occurrence exceptions and their operational indexes in the same Main Event capability. Gated catalogue observations cannot serve ordinary private planning or establish public airing-calendar parity. |
| Activity execution: [private consumption sessions](../../services/main/src/modules/session/contract.ts), [state transitions](../../services/main/src/modules/session/state.ts) and [store](../../services/main/src/modules/session/store.ts). A planned session is a private attempt with date precision and pinned selections. | Existing attempt identity, ownership, progress and terminal-state rules when a plan refers to that activity. | A scheduling association to that attempt, without treating its dates or `planned` status as an executable timer. There is no general recurrence/due-action implementation in this owner to reuse. |
| Collection: [ordered entries](../contracts/structure.md) and the [decided run design](actionable-collections.md). Runs/ingredient derivation remain a decision awaiting their contracts and proof. | Stable entry occurrences, entry-set/source pins and separate run-scoped actions. | A plan can reference an entry and an optional exact run. A different dinner can select a new run without copying or editing the recipe, shopping checks or reader progress. Scheduling does not implement the pending run design. |
| [Notification owner](../../services/main/src/modules/notification/README.md), [notification policy](../contracts/notifications.md). Durable recipient items, delivery rows, leases, current disclosure, provider idempotency and uncertain-result lookup already exist. | Intake dedupe, inbox, preferences, endpoint ownership, recipient checks, delivery worker and recovery fence. | Register a private Scheduled subject reader and a due-action producer; add current schedule/recipient eligibility to dispatch and inbox disclosure. Existing readers do not establish this eligibility today. |
| [Committed events/jobs](../contracts/events-and-jobs.md), [export readers](../../services/main/src/modules/export/readers.ts) and [Access](../contracts/identity-and-access.md). | Owner receipts/outboxes, resumable work, recovery generations, exact export selections and current authorization. | Scheduled selections and an iCalendar adapter. Neither timers, exporting nor possession of a resource IRI grants authority. |

Main Event owns schedule meaning and occurrence revisions. Activity and
Collection retain their respective execution state. Propose private PostgreSQL
schedule custody in Main, colocated with notification intake in Access's
database so a schedule gate, due disposition and intake can commit together.
Database placement does not transfer grant authority to Event: Access remains
the only grant writer. Private dates, recipient identities and exceptions stay
out of public RDF, catalogue events and shared Collection metadata. The semantic
mapping is available through authorized reads/export. Public Event observations
remain in their current custody; a private plan only references them.

This placement is an addition to the existing Event owner, not a new service or
calendar ledger. Content sessions and graph references still cross transactions:
use their exact revisions and selected disclosure witnesses, returning unavailable
if a witness cannot be established. Do not pretend colocation makes those owners
one transaction. Recovery must fence generation publication and deliveries until
their retained receipts and erasure/disclosure obligations reconcile.

## Meaning, occurrence identity and configuration

Use [schema:Event](https://schema.org/Event) for an occurrence and
[schema:Schedule](https://schema.org/Schedule) for its repeating definition.
Schedule supplies frequency, count, date bounds, day selection, exception dates
and an IANA timezone. Associate a recurring Event series through
[schema:eventSchedule](https://schema.org/eventSchedule); its time lives on the
Schedule, avoiding a second start/end definition on the series Event. A
nonrecurring Event has its own start/end. Distinguish a series, an occurrence of
it and the Activity/Action it concerns. A planned occurrence does not assert
that the activity happened.

Reuse the Collection note's `schema:Action` mapping for runs and entry actions;
retain [PROV Activity](https://www.w3.org/TR/prov-o/#Activity) for performed
process/provenance. Do not turn a private intention into a performed PROV
activity or restart a finished consumption session when its reminder fires.
No new calendar class, recurrence language or status vocabulary is proposed.
Occurrence keys, generation fences and due receipts are owner bookkeeping;
future semantic relationships must be justified in their owning schema rather
than invented here. Schema.org alone does not supply concurrency or authority.

| Configuration | Bound objects and effect |
| --- | --- |
| Weekly meals | Private Scheduled occurrences reference Collection entry occurrences and, when chosen, exact cooking runs. Shopping uses the Collection/Recipe procedure over an explicitly selected set of meals; moving dinner neither recalculates stock nor transfers checks. |
| Reading-club meeting | An Event references the book and an authorized meeting-plan entry. Sharing the meeting does not expose participants' private reading attempts or grant access to the book. Invitations/RSVP wait for a demonstrated need. |
| Return reminder | A private Event records when to revisit a readable resource or entry. Its due action opens that target through the normal read path; it does not invent read-position or note storage. |
| Release/airing calendar | A selection of admitted, evidenced Event observations supplies the calendar. A person's reminder refers to the selected occurrence revision. A known broadcast date does not establish release availability, region, platform, language or entitlement. |

A public source correction marks a bound private plan as needing reconciliation;
it does not silently change the person's time. The owner explicitly adopts the
new source revision or retains the personal intention with its old source pin
identified. Missing/unreadable evidence cannot be rendered from a stale copy.

## Time, recurrence and cancellation

Keep the entered local date/time, named IANA zone, resolved instant and timezone
rules version used by the active generation. A zone is not a numeric offset;
weekly local dinner time stays local across offset changes. Display timezone is
separate from occurrence timezone. A date-only occurrence remains a civil date;
it needs an explicitly chosen local reminder time before a due instant exists.
Unknown/open endpoints retain their Event meaning and cannot trigger a guessed
midnight notification. A precise personal reminder about an unknown date is a
separate intention, not new source evidence.

Use [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html) (September 2009),
especially §§3.3.5, 3.3.10, 3.8.4.4 and 3.8.5: timezone-qualified DTSTART,
RRULE with COUNT or inclusive UNTIL (not both), EXDATE and RECURRENCE-ID.
DTSTART counts; excluded dates do not add replacements. Invalid/nonexistent
generated instances are skipped; a repeated local time selects the first
occurrence. A moved instance retains its original recurrence identifier.
Schema.org and this RFC were checked on 2026-10-15; they support interchange
meaning, not this proposal's capacity, authority or delivery guarantees.

For this first cut, admit daily, weekly and monthly recurrence with positive
interval, weekly day selection or monthly day-of-month selection, one local
start time, explicit week start, and a finite end. Reject unsupported rule parts
without approximating them. Reject nonexistent explicit start/move times and
explain the gap; preview ambiguous explicit times using the first occurrence
rule before saving. This is a deliberate admission restriction beyond the
RFC's interpretation of explicit gap times. Finite presets are sufficient for
weekly menus and club series. Sub-day recurrence, arbitrary rule combinations,
floating times and implicit forever-renewal are outside the proposal.

Propose at most 512 generated occurrences per admitted series and a last
occurrence within two years of its start, including moved replacements. A
COUNT rule whose valid instances exceed that horizon is refused, never
truncated. These are reviewable admission budgets, not measured capacity or a
limit on the number of plans. They bound both emitted occurrences and search
for valid candidates. Changing timezone rules rebuilds only affected schedules
through bounded continuations; until reconciliation, affected due actions are
held rather than sent using an unqualified stale instant.

An occurrence's identity is the series identity plus its original local
recurrence identifier; a one-off has its own stable identity. Moving changes
its effective time, not its identity. Cancel one instance by exception, or
cancel the series by advancing its cancellation fence. Keep tombstones needed
for replay and export. Editing an existing series preserves unaffected keys;
changing its recurrence basis creates an explicitly linked replacement series
and fences the old future. Carry forward completed due-action dispositions so
replacement cannot quietly notify twice for the same adopted intention.

Only an occurrence or the whole series can be moved/cancelled in the first
cut. A future-tail change can be expressed as an explicit replacement; it is
not an ambiguous silent rewrite of history. Schedule changes use expected
heads and immutable command receipts. A lost-response retry replays its
receipt under current authority; different intent with the same key conflicts.
Omitted optional state is preserved; removing recurrence or a reminder is an
explicit decision, not an accidental consequence of a simple time edit.

## Bounded reads and durable work

Choose finite, staged occurrence indexing rather than expansion on reads or
one timer per recurrence. A committed definition starts preparing; resumable
work evaluates candidates into a private generation, retaining a checkpoint
and exception/source pins. Publish it only after verifying complete coverage
and the due-work handoff. Capacity exhaustion is an explicit pending/refused
outcome, never a successful prefix. An edit fences the superseded generation
immediately; its replacement can remain preparing. Cancellation needs no
walk through all occurrences to become effective.

The following are proposed fixed work budgets for later executable contracts
and measurements, not established performance results:

| Path | Bounded neighbourhood |
| --- | --- |
| Direct definition/occurrence read | One selected definition, one exact occurrence/exception and at most 16 exact referenced-owner dependencies; separately continue exception lists and large Collection/provenance data. No expansion or repair. |
| Timeline/list read | At most 50 indexed occurrence candidates for one authorized principal/selection and finite window, then exact head, grant and source checks per candidate. Cursor advances over examined candidates, even when none can be disclosed. No refill scan, offset pagination or full-inventory count. |
| Recurrence preparation/reconciliation | At most 32 candidate periods/instances per activation, with a fixed rule-size/byte/deadline budget and a persisted next position. The two-year horizon bounds an empty or sparse rule too. Never restart at DTSTART on each page or catch-up tick. |
| Due sweep | At most 32 indexed due-action candidates plus 32 expired leases. Each touches one occurrence, its current schedule/reminder head, one recipient and bounded exact disclosure inputs. No plan scan, recurrence evaluation or group-member expansion. |
| Export, sharing index maintenance and cleanup | Bounded, checkpointed pages with current authority and revision checks; no request constructs the whole account calendar or bulk rewrites every old row. |

Maintain indexes for principal/window occurrence reads, selected series keys,
and due time/state. Shared visibility needs a resumable per-principal index,
with explicit preparing coverage; do not discover every shared plan through a
query-time join over all grants. Stale generation or revoked-grant candidates
consume the candidate budget and are hidden; continuation must still progress.
An incomplete index reports unavailable/preparing rather than an empty calendar.
Exact whole-calendar counts are not implied. Index seeks may have ordinary
tree-depth cost; rows hydrated and recurrence/disclosure work remain bounded
independently of total plans, recipients and recurrence history.

Every due action is durable before its generation is ready. It references the
occurrence and reminder identity, current selected recipient and authority basis,
time/head revisions, recovery generation and retry disposition. A timer merely
wakes a sweep. Lease tokens and fences prevent a late worker from committing
over a move, cancellation or restore. A crash after intake but before ACK retries
the same logical source event. The notification owner's intake dedupes it.
Do not put schedule revision into the logical due identity: a move must not
become a second notification. New generation rows recover prior dispositions.

First-cut due actions only notify; they never execute arbitrary Collection
bindings, start runs, purchase ingredients or publish content. Each reminder
names one current native recipient who has consented to receive it and can
currently read the scheduled intention and its required references. Sharing a
plan does not subscribe everyone. More recipients create explicit reminder
subscriptions through bounded pages, not unbounded fan-out in one sweep.

Admission must refuse a due binding that requires traversing a whole Collection
or more dependencies than its fixed budget. Bind an exact entry/run reference
and its bounded disclosure basis instead. Continuations have bounded token and
response sizes and bind principal, selection, generation and authority; hidden
candidate identities cannot leak through them. Expired leases and retryable
failures move through indexed, backoff-controlled queues so a poison head does
not force a sweep to search until it finds successful work.

The producer and notification reader both check the schedule/occurrence fence,
recipient selection/consent, Access authority, erasure, references and channel
preferences. Recheck at intake, inbox reads and external send admission; a
pinned subject revision alone is insufficient. Use one schedule/action gate
for edits, cancellation, recipient replacement and send admission. Its current
Access-local decision and notification disposition commit together. A denied
reference suppresses disclosure; an unavailable owner holds the action for
retry rather than asserting permanent denial. Already queued items for a
revoked recipient become concealed, and their pending sends ineligible.

For an eligible recipient the goal is one durable inbox item per logical due
action, with optional permitted channel deliveries under that same item. The
action fires when its inbox intake commits under the due-action gate, even if
the recipient has not opened it or external delivery has not started. A move
or recipient replacement before that commit preserves the logical action and
changes its pending due work; afterwards the command reports already fired.
It may suppress remaining delivery but does not automatically schedule another
item for a new time or person. A fresh reminder then requires explicit intent.
Notification delivery IDs remain provider idempotency keys; unknown ACKs use
lookup/reconciliation before resend. This is not an exactly-once claim about
arbitrary external providers. A move, cancellation or revocation before external
send admission makes the old queued delivery ineligible; its terminal disposition
does not reopen the fired logical action.

Cancellation/revocation linearizes against send admission. If cancellation wins,
no new send can start. If admission wins, report the already-started/uncertain
delivery honestly: a provider call cannot be retracted. An in-flight send must
settle or reconcile before a replacement recipient can receive this action.
Do not claim successful cancellation of a send already in flight. Authority is
current at the dispatch gate; later revocation cannot recall disclosed bytes.
Late callbacks do not reopen terminal deliveries. Startup reconciles recovery
fences and retained erasures before dispatch; backlog is paged, never dropped
or synchronously expanded after downtime.

## Per-persona authority

Read, edit/cancel, sharing administration, reminder management, run checking
and export are distinct authorities. Hidden private identities are concealed;
a readable plan with insufficient command authority yields denial. Current
authority is checked on continuation, receipt replay and artifact download.

| Persona | Allowed outcome | Boundary to prove |
| --- | --- | --- |
| Signed-out visitor | Read separately published, qualified Event/calendar facts. | Private plans, occurrences, reminder metadata, runs and exports concealed; commands require authentication. Current gated Event routes do not yet deliver that public calendar outcome. |
| Signed-in stranger | Same public facts; create/read/change/cancel/export their own private plans and opt into their own reminders. | Cannot discover another person's private schedule, assign themselves its due actions or impersonate its owner. |
| Member with an explicit plan grant | Read the disclosed shared plan and sources; manage their own opted-in reminders. A separate editor grant permits moves/cancellation; a Collection run grant permits the decided checks. | Realm membership alone grants nothing. Plan-read does not grant plan-edit, run-check, source-read, sharing administration or export. Revocation blocks subsequent reads and sends. |
| Author/plan owner | Create/adopt time, move/cancel, manage permitted sharing, create own reminders and export the authorized selection. | Cannot subscribe an unconsenting recipient, bypass source rights, edit public Event evidence through private planning or overwrite someone else's private attempt. Owning a recipe does not reveal cooks' plans. |
| Realm moderator without a plan grant | Existing public reads and moderation under its ordinary jurisdiction. | No private schedule/recipient/export access, peer reminders or plan edits through moderator status. |
| Platform operator without a plan grant | Existing operational health/recovery tools with bounded non-content diagnostics. | No private plan, time, recipient or export read/edit authority through platform status; `platform:events` is not a private-plan grant. |
| Integrating client / delivery worker | A delegated client acts within the person's current scopes/grants. The worker leases admitted due work and invokes the notification owner under a narrow service identity. | Neither becomes a person, reads the account inventory freely, grants access or writes another owner's execution state. |

## Export and leaving

Extend existing exact-selection export machinery with an authorized native
snapshot containing times/zones, source and Collection/run references, finite
rules, exceptions, cancellations, stable occurrence keys and due dispositions.
Export a selected series or traverse an account selection in bounded pages;
pin revisions and recheck access per page and download. A changed selection
requires restart/reconciliation, not a mixed-revision file. Retained artifacts
are private and revocable through the owner; already downloaded copies cannot
be recalled. Never embed recipient addresses, push tokens, grants or another
person's private Activity/check history in a plan export.

Offer iCalendar VEVENT output with stable UID, DTSTART/TZID, finite RRULE,
EXDATE, detached moved/cancelled RECURRENCE-ID instances and revision SEQUENCE;
retain cancellation information and timezone definitions for the selected
finite span. Mark private exports private, while treating that marker as a
hint rather than access control. One date-only airing stays a DATE; unknown
availability is absent with an explicit loss/missingness report, never a
fabricated all-day event. Native output retains that distinction in full.
Private native reference/run semantics that iCalendar cannot represent require
the same loss report. Do not report a lossy adapter as a complete native backup.

Export does not create a calendar subscription or transfer notification
authority. Optional local alarms require explicit user choice and an explanation
that the calendar client controls them; otherwise export without alarms so the
same intention does not silently notify in two systems. Calendar/Reminders sync
and import are later adapters against these owners, not alternate authorities.

## Alternatives and review evidence

A Work date or Collection label has no private occurrence identity, cancellation
or due disposition. Extending consumption-session dates would mix execution
history with planning and exclude other kinds of Event. A vertical meal/calendar
service duplicates Event, entry, authority and delivery ownership. Query-time
RRULE expansion grows with series age and inventory. Forever pre-expansion
cannot terminate. A rolling horizon is credible for indefinite series but adds
coverage renewal and missed-window failure modes; the selected finite first cut
accepts bounded storage and preparation delay instead. A standalone scheduler
or broker would not resolve current recipient authority or provider uncertainty.

The remaining uncertainties are composition and cost, not whether a library can
parse RRULE. Select an existing maintained recurrence implementation only after
checking the admitted subset, DST behavior and checkpointability; this note
adds no dependency or measured capacity claim. Program review must accept or
revise the finite admission budgets and private-state placement before contracts.

The falsifier for the later contract/outcome step is:

| Scenario | Required observation |
| --- | --- |
| Dinner at 18:00 America/New_York weekly from 2026-10-25 for four occurrences. Move the 2026-11-01 dinner to 19:00; cancel 2026-11-08. | Local times survive the DST transition: the first dinner is 22:00Z and the moved dinner is 2026-11-02 00:00Z. The moved occurrence keeps its original key; the cancelled one has no due notification. Run identities/checks and recipe content stay unchanged. |
| Weekly reminder crossing the 2026 spring gap and autumn fold, plus explicit edits into a gap. | Generated gap instances are skipped, fold instances occur once, explicit invalid edits are refused, and the finite rule's count/end semantics survive export. |
| Queue due work for A, then revoke A and consent/select B before inbox intake. Race a stale worker, move and cancel; separately revoke after intake and lose a provider ACK. | Only current eligible B receives one logical due item when not cancelled; replay creates no duplicate. After intake, A's revoked item is concealed and pending sends are suppressed; the action reports already fired instead of notifying B automatically. Cancellation winning send admission starts no send. An already-started/uncertain send is reported and reconciled before any explicitly new reminder. |
| Known day-precision airing observation, unknown availability, and a private reminder at an explicitly chosen local time. | Calendar preserves the known date and unknown availability independently. A personal reminder proves neither platform availability nor an exact broadcast instant; native/iCalendar exports preserve or explicitly report the distinction. |
| Many plans and old revisions, a mostly hidden page, sparse monthly rules, downtime, erasure and restore. | Query plans/counters demonstrate the fixed candidate neighbourhood on reads, preparation, sweeps, cleanup and export. Empty disclosed pages retain progressing continuations; no scan repairs or silently completes an incomplete calendar. |

Each persona above needs public-API observations of allowed and refused work,
including stale heads, replay, source loss and export. Fault tests must cover
the cross-owner witness and notification gate, not mock them. Numeric budget
qualification needs retained large-population fixtures, native storage plans,
deadline/byte counters and competing edits; no such experiment is run here.
The later UI must make timezone, finite end, move/cancel scope, preparing state
and in-flight delivery outcome understandable, preserve advanced saved state
and complete the same actions through those APIs. This static decision review
does not establish a human journey, public calendar readiness or competitor
replacement parity. This step hands only this proposal to program review;
contracts, persona rows, proof, implementation and surfaces follow separately.
