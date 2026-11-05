# Quality review of the Terra manager period

Reviewed source: `dev` at `d17bf79f0908d473ff1b938671ed4589998a27aa`.
Evidence window: 2026-10-31 18:30:00 UTC through the launch snapshot at
2026-11-01 04:41:35 UTC. All times below are UTC. This is review evidence, not an
adopted product decision or a claim of native verification.

## Judgment

The logs confirm a model-selection failure: twelve manager sessions acquired
`gpt-6.1-terra` turn contexts. No worker session in the specified directories had
a Terra turn context. Product commits made during this interval therefore cannot
be described as Terra-written merely from their landing time. Most implementation
work was done by Sol workers under managers whose model changed between turns.

The most consequential unresolved problems are incomplete default journeys:
public discovery still reaches an unavailable native Source, and identity
retirement still reaches unavailable Library and pending History paths. These
were already known problems before the model change. Terra-period dispatches
continued to deliver components and discover further dependencies rather than
complete those journeys. That falls short of the maintainer's product-first
direction, but the evidence does not establish that Terra introduced the missing
producers or that the new fail-closed components should be reverted.

There are also concrete, narrower quality problems: an adopted feed Context
decision lives only in operating documents while the tracked owner document says
no meaning is adopted; two early Terra managers repeatedly finished unchanged
status turns; and original deliveries needed corrections to query admission and
visible naming/credit controls. Several corrections made during the Terra period
are useful product changes. The raised History ceilings were explicitly
authorized, arithmetically justified and kept bounded; they are not evidence of
evading the architecture.

Recommendation: retain the useful product changes and safety refusals, finish the
missing default compositions, reconcile the Context owner document, and repair
manager model selection and wakeup behavior. There is no evidence for a blanket
revert of commits landed during the Terra interval. Sol-run work in the same
window exhibits the same incomplete-composition and insufficient-first-delivery
problems, as well as repeated machine-evidence bloat.

## Evidence and method

Primary sources used:

- The two specified dated session directories under each of
  `/home/edge/.codex/sessions/` and `/home/edge/.codex-1/sessions/`:
  `2026/10/31/` and `2026/11/01/`. Model attribution comes from
  `turn_context.payload.model`, with `payload.cwd` distinguishing managers in
  `/home/edge/projects/rezics/rezics-next` from workers in
  `/home/edge/projects/rezics/worktrees/`.
- The commit inventory reachable from the reviewed snapshot, equivalent to
  `git log dev --since=2026-10-31T18:30:00Z` at launch: 369 non-merge commits.
  Commit diffs, current default call paths, owner documents and authored tests
  supplied the code evidence. Landing timestamps alone do not identify a model.
- Exact operating sources in the main checkout:
  `.temp/goal/supermanager/resume-20261101.md`,
  `.temp/goal/supermanager/new-slices-20261101.md`,
  modified `.temp/goal/briefs/*.md`, and `.temp/goal/goal.sqlite` opened with
  SQLite `mode=ro`. Inbox citations below identify `manager_inbox.id`; timestamps
  are decoded from `created_at` milliseconds. Brief headings and dispatch
  chronology identify contracts without reproducing task IDs in this document.
- [Architecture](../architecture.md), [scope](../scope.md),
  [development rules](../development/README.md),
  [feature design](../development/feature-design.md),
  [delivery](../development/delivery.md),
  [Goal definitions](../goals/README.md), and the applicable owner documents.

The source repository is [rezics/rezics-next](https://github.com/rezics/rezics-next);
its [LICENSE](../../LICENSE) is GNU AGPL version 3. No external repository was
needed, cloned, installed or executed. Session logs and controller state are local
operational evidence, not upstream design authority. Recommendations below are
changes to this repository's design and implementation, not copied source.

The review inventoried the landed commits and modified briefs, then concentrated
source inspection on default composition, cross-owner authority, disclosure,
History, and visible web corrections. It is not a line-by-line audit of all 369
commits. Mutable operating files were read as evidence; a later live task state
does not retroactively install code in the fixed source snapshot. Subsequent
landings and post-cutoff model contexts are outside this review.

No acceptance command, compiler, native test, browser, build, publication or
controller check was run for this review, as required by the current launch
policy. An authored test, a manager review and a landing are separate facts.

## Exact observed Terra sessions

All twelve sessions below have the main-checkout cwd. They contain 250 Terra
`turn_context` records in total. There are no Terra contexts in the worker cwd
population or in the specified `.codex-1` directories. Repeated contexts and
steered continuations are not necessarily separate completed turns.

The first Terra context is 00:19:36.384, earlier than a rounded 00:20 boundary.
The final Terra-associated model output in these logs is 04:36:15.361. Several
sessions record their next Sol context at 04:37–04:38, so a single assumed
00:19–04:40 interval would be less precise than the records.

Each row gives the first and last observed Terra context, last model-produced
response item under that context (including tool calls), and first following
non-Terra context. The latter is Sol wherever present. A dash means no subsequent
non-Terra context was observed before cutoff, not that the model was still
actively generating. An idle interval does not establish continuous execution.

| Session | Manager                            | First Terra context | Last Terra context | Last associated output | Next Sol context | Context records |
| ------- | ---------------------------------- | ------------------- | ------------------ | ---------------------- | ---------------- | --------------: |
| S1      | semantic                           | 00:20:28.051        | 00:34:45.702       | 00:34:45.563           | —                |              74 |
| S2      | search                             | 00:20:30.509        | 00:29:27.295       | 00:29:27.213           | —                |              67 |
| S3      | control-plane                      | 00:21:52.718        | 00:30:13.332       | 00:30:13.178           | —                |              17 |
| S4      | web                                | 00:20:14.925        | 02:46:30.610       | 02:46:44.237           | —                |              22 |
| S5      | commerce                           | 00:19:36.998        | 03:47:52.788       | 04:35:36.897           | 04:37:44.601     |               9 |
| S6      | content                            | 00:19:39.386        | 03:49:38.487       | 04:35:37.208           | 04:38:45.787     |              14 |
| S7      | accounts                           | 00:19:37.856        | 03:47:52.694       | 04:36:15.361           | 04:37:50.529     |               9 |
| S8      | performance                        | 00:19:36.384        | 03:47:52.906       | 04:35:39.053           | 04:37:44.751     |               6 |
| S9      | search, replacement session        | 00:54:27.211        | 04:00:32.021       | 04:35:39.565           | 04:37:50.497     |               8 |
| S10     | semantic, replacement session      | 00:54:29.419        | 03:47:52.849       | 04:35:37.503           | 04:37:44.218     |               8 |
| S11     | control-plane, replacement session | 03:12:20.086        | 04:14:11.834       | 04:35:51.483           | 04:37:44.779     |               5 |
| S12     | web, replacement session           | 03:12:20.573        | 04:15:23.065       | 04:15:33.587           | —                |              11 |

Log filenames below are relative to
`/home/edge/.codex/sessions/2026/11/01/`. The line pairs locate first/last Terra
contexts; the final number, where present, locates the following Sol context.
Record timestamps, not the local-clock filenames, define the windows.

| Session | JSONL file                                                               | Context lines; following Sol line |
| ------- | ------------------------------------------------------------------------ | --------------------------------- |
| S1      | `rollout-2026-11-01T04-42-40-01a193b3-3eec-77f1-a956-850d4e1ca138.jsonl` | 2950 / 4350; —                    |
| S2      | `rollout-2026-11-01T04-42-41-01a193b3-4345-76b3-8b02-a9f61aa07182.jsonl` | 3115 / 4395; —                    |
| S3      | `rollout-2026-11-01T04-42-48-01a193b3-60a9-7322-ab29-6e5dfe5fd670.jsonl` | 3501 / 4153; —                    |
| S4      | `rollout-2026-11-01T07-00-37-01a19431-8a4f-7d10-9222-5e6c0e0664b3.jsonl` | 2132 / 2904; —                    |
| S5      | `rollout-2026-11-01T07-00-38-01a19431-9182-7681-a016-c42363f20e06.jsonl` | 1034 / 3096; 3567                 |
| S6      | `rollout-2026-11-01T07-00-40-01a19431-95ea-7f72-843b-c3bc9d642bd2.jsonl` | 1494 / 3547; 3978                 |
| S7      | `rollout-2026-11-01T07-00-42-01a19431-a07e-7380-b61c-e744e85f0684.jsonl` | 1598 / 3896; 4263                 |
| S8      | `rollout-2026-11-01T07-31-22-01a1944d-b3c3-7fa1-8d1d-79ba79b9ab89.jsonl` | 663 / 2449; 2844                  |
| S9      | `rollout-2026-11-01T08-29-27-01a19482-dfcb-78a2-8ca0-3caa3332ab93.jsonl` | 357 / 2276; 2644                  |
| S10     | `rollout-2026-11-01T08-34-45-01a19487-bb92-7141-9864-3cfcbbad87a4.jsonl` | 513 / 2692; 3217                  |
| S11     | `rollout-2026-11-01T10-54-08-01a19507-5696-76a2-8a9b-646f171d5902.jsonl` | 595 / 1903; 2182                  |
| S12     | `rollout-2026-11-01T10-54-10-01a19507-5eed-7ab1-8f14-5a76e38079be.jsonl` | 365 / 1177; —                     |

Every listed session first recorded Sol and then one contiguous sequence of Terra
contexts; seven later recorded Sol again. These fields establish the recorded
model selection. They are not an independent attestation of backend execution.

## Findings by severity

### High: manager startup pins Sol, subsequent turn starts do not

At the reviewed revision, [managers.ts](../../tools/goal/src/managers.ts) passes
`model: 'gpt-6.1-sol'` to `thread/start` around line 531. The initial `turn/start`
around line 553 supplies effort but no model. `startWakeTurn` around line 938
starts a turn with only thread ID and input, omitting both model and effort.
The observed Sol-to-Terra transitions show that thread creation did not provide
the intended persistent per-turn selection in this deployment.

This is a concrete controller defect, independent of a judgment about generated
code. It also explains why a fresh replacement manager could begin on Sol and
later use Terra. In contrast, the worker adapter
[agents/codex.ts](../../tools/goal/src/agents/codex.ts) supplies `profile.model`
and `model_reasoning_effort` on each worker invocation.

The brief headed “Keep the manager model and effort at each turn boundary”
already targets this class, but a brief is not the repair: the omission remains
in the reviewed source. Finish that repair across supported initial, resumed and
wakeup turn boundaries, preserving effort as well as model. Do not assume that
active-turn steering has the same API as starting a new turn; cover the actual
supported protocol. No product rollback follows from this finding.

### High: mixed Home is useful partial delivery, not the requested complete journey

The resume direction specifically identifies missing default producers as the
recurring failure class. The scope requires one bounded Home containing public
discovery, Following and Continue, with kind, Space and Context selection.

There is real progress. `896ba9f016` introduces ordinary-server discovery
composition. At the reviewed source,
[default-discovery.ts](../../services/kernel/src/search/default-discovery.ts)
uses the active native release, real registry, public runtime, native Source and
existing durable preparation worker. It passes the actual pool to the Work
client, retains preparation jobs and closes resources. Following activity and
retention, mixed merging and native kind selection are product code, not just a
consumer interface. Relevant landed groups include `b9491c103f`, `80e20f486b`,
`72e6755df7`, `95a7a1f8f7`, `a32b16918f`, `523075b3d3`, `5c7ded7f0c`,
`4e9df33f3d`, `005af24245` and `6db386f5e5`.

However, the default factory still calls
[publicFilterSource](../../services/kernel/src/semantic/public-filter-source.ts).
Its three projection/reduction readers unconditionally return
`unready / metadata_missing` (lines 57–85), and `recordPrivacyReduction` still
throws `AccessUnavailableError('overloaded')` (lines 92–97). A real constructor
and a registered consumer do not supply the missing positive native population.
The default public-discovery journey therefore remains incomplete. This does
not prove every possible retained response fails, nor that fail-closed behavior
is a privacy defect.

[feeds.md](../feeds.md) also explicitly lacks Space and Context query parameters
and records Space as not integrated. The brief “Complete native public-filter
Source and default mixed coverage” is upstream of “Complete scoped search from
the current header to native results”; the latter is upstream of the separately
held review-backed Context slice. Those contracts cannot count as delivered
selection capabilities. Inbox 20993 at 00:30:26 correctly tells Web that only
kind is integrated and claims neither Space/Context nor native acceptance.

Attribution: the Source was already identified as unready in the pre-Terra resume
instruction. The mixed Home and default-composition workers used Sol. Terra
managers inherited and continued the dependency chain; the evidence supports
incomplete outcome and weak dependency closure, not a newly introduced Terra
Source regression. Retain the mixed page and honest preparing/unavailable states;
finish the sole default native Source and scoped path before calling the Home
journey complete. Keep kind/Space/Context as conjunctive candidate selection,
not separate feed sections or browser-only filtering.

### High: identity retirement remains a chain of partial handoffs

The Source terminal work through `55b15fe7d9` and `9c3b96bdde` is not equivalent
to completing the account/History journey. At the reviewed source:

- [library/identity-scope-effects.ts](../../services/kernel/src/library/identity-scope-effects.ts)
  labels its adapter provisional, returns `status: 'unavailable'` from the page
  reader and returns `false` from the seal verifier (lines 46–79).
- [history/agent-identity-inventory.ts](../../services/kernel/src/history/agent-identity-inventory.ts)
  performs real native verification but its final path still returns
  `state: 'pending', native: 'verified'` with
  `agent-identity-sdk-recording-port-unavailable` (line 487). Verifying one
  Source stage does not produce final SDK and receiving closure.

The Terra-period brief chain exposes insufficient dependency preflight. “Complete
the original identity History receiving and SDK retirement composition” was
followed by “Establish the original SDK owner handoff for identity History
retirement,” then “Complete guarded identity History readiness and receiving
closure,” then “Durable original Source authority for identity History
retirement.” The first History continuation could not serialize against the
actual SDK pool; after the SDK producer, the next continuation still lacked a
durable Source authority valid after released retirement and receiving commit.
The Library-verifier integration brief is another genuine dependency, not an
installed positive implementation. Inbox 21173 at 01:41:37 explicitly records
the Library unavailable/false body; the later durable-Source brief records the
remaining durable-handoff refusal.

The SDK delivery `6e38a138e0` / `4b786c84f7` is substantive and worth retaining.
[sdk-retirement-fence.ts](../../services/kernel/src/work/sdk-retirement-fence.ts)
uses the actual current command resources. The checked-in DBOS patch requires
the caller's pool to be the SDK pool and takes the native source-home and writer
locks through the caller transaction. [work/client.ts](../../services/kernel/src/work/client.ts)
accepts a shared pool, so a supported same-pool placement is possible; it is not
accurate to call the guard intrinsically impossible. Conversely, this producer
does not by itself finish the History inventory or Source handoff.

This chain conflicts with the request for complete slices whose real producers
are present. It does not establish unsafe successful retirement: the inspected
paths refuse to claim closure. Retain those refusals and the SDK transaction
guard. Redo the remaining assignment around the actual default positive call
graph, pool placement, durable source transfer, receiving commit and Library
seal together, with the existing owners' explicit boundaries. Do not replace
missing authority with an acknowledgement, cached verdict or permissive stub.

### Medium: Context adoption and the tracked owner contract disagree

Inbox 20808 at 23:42:49 authorizes Content to choose and document a Context
meaning, while shipping kind and actual Space separately first. Inbox 20851 at
23:47:47 reports the choice adopted, referring to the exact operating file
`.temp/goal/content/797-feed-context-owner-decision.md`. Inbox 20865 at 23:54:07
delegates the same retained Source implementation; 20872 registers the held
native successor. These events all precede the first Terra context.

That operating decision defines a Context as an exact rating-question identity
witnessed by a currently readable live review whose opening revision cites that
question. It excludes private votes, grain applicability, score thresholds,
editorial Context and Realm membership. It specifies Subject/thread/reply
membership, same-primary conjunction with kind and Space, and that a Subject's
Space witness and review witness need not be the same thread. Future selection
is request-only `ratingQuestion.id`; it is not claimed as an existing API.

This is a coherent, expressly delegated owner choice. The evidence does not show
that the meaning itself should be reverted. The defect is authority placement:
[feeds.md](../feeds.md), lines 179–184, still says Context has “no adopted native
meaning,” while dependent contracts consume a decision stored under `.temp`.
[Development rules](../development/README.md), lines 27–28, require adoption in
the owning document before dependent briefs; continuations are operating state.

Move the adopted meaning and its precise limits into the tracked owner contract,
clearly distinguishing chosen semantics from unimplemented API and eligibility
readers. Preserve the absence of a selectable placeholder. This is a Sol-period
authority defect carried forward by Terra managers, not evidence that Terra
invented Context or confused it with a Realm.

### Medium: repeated unchanged manager completions consumed turns

S1 records 71 `task_complete` events under Terra between roughly 00:20 and
00:34; S2 records 64 between roughly 00:21 and 00:29. Their late responses
repeatedly report an empty inbox, unchanged dependencies, no producer handoff
and an active Goal. For example, S1 completion records at lines 4315, 4330 and
4345 occur at 00:34:26.564, 00:34:36.031 and 00:34:45.661; S2 lines 4355,
4372 and 4390 occur at 00:29:16.847, 00:29:21.301 and 00:29:27.258.

These are observed completed turns, not tests waiting for slots. They conflict
with the explicit instruction to keep manager turns few and short. Some early
turns in those sessions did useful corrective dispatch and owner coordination;
the finding concerns the repeated unchanged completions. Host-generated Goal
continuations contributed to this pattern, so the logs do not isolate model
behavior from controller wakeup policy.

Repair wakeup coalescing and no-change completion behavior at the controller
boundary, and have managers stop resummarizing unchanged state. Inbox 21006 at
00:32:43 independently raises manager input use, but its aggregate token figure
does not establish Terra's causal contribution and is not used as a model
benchmark here.

### Medium, corrected: edition identity tightened unrelated query admission

The original edition identity group `d303805eb4` / `4c809a9a5b` added identity
composition to Content reads. It also introduced a strict exact-revision query
schema where unrelated query fields had previously been admitted. Inbox 20967
at 00:21:56 identifies that collateral change in `schemas.ts` and `routes.ts`
and the lack of native opt-in coverage. That is a concrete compatibility defect,
not a reason to reject edition identity as a feature.

The Terra Semantic manager dispatched the corrective brief “Preserve Content
read admission and prove edition identity opt-ins.” Sol worker changes in
`d54431a0ea` restore `additionalProperties: true` while constraining the new
`editionIdentity` opt-in, and organize metadata reads behind current authority
checks. `3b555ddb26` moves revision-date reading before the final source fences.
Relevant files are
[content/routes.ts](../../services/kernel/src/content/routes.ts),
[edition-reads.ts](../../services/kernel/src/content/edition-reads.ts),
[edition-subject.ts](../../services/kernel/src/content/edition-subject.ts) and
the existing Content test files extended by that worker.

The test adjustments in `67a80d602f` and `25f48e5581` do not demonstrate weakening
an old acceptance contract: they correct new assertions to use the existing
governance setup/tombstone semantics and compare session-header behavior with
the ordinary response. The source still distinguishes unavailable opt-in
metadata from the permitted ordinary envelope. Inbox 20970 withdraws a separate
execution request and explicitly says authored native tests are unexecuted.

Retain the corrected range. This is a useful control case: Sol implementation
introduced the collateral issue, a Terra manager recognized and briefed a
product correction, and a Sol worker implemented it. Native correctness is not
established by this source review.

### Medium, corrected: initial UI deliveries needed visible completion

The earlier naming group ending at `38c7d2e7bf` already supported native primary
names and deterministic fallback. It did not finish the optional-translation
editing experience. The later brief “Make Zone translations optional” could
have identified this narrower remaining UI gap more accurately instead of
restating the whole native naming capability.

Nevertheless, `ae6c5765af` and `d17bf79f09` make a real correction in
[zones/editor/name-fields.tsx](../../apps/web/src/features/zones/editor/name-fields.tsx):
optional translations are disclosed separately, only present languages get
fields, languages can be added/removed, and validation can reveal the correction
area again on repeated submission. The authored Storybook play checks the
interaction rather than treating server rendering as proof of an effect.
Inbox 21833 at 04:41:12 correctly records that distinction and no executed pass.

Similarly, the qualified-credit group ending at `2d2ba5cfb6` preserved data but
needed readability and heading corrections. `ac00d399ed`, `21c12961c3` and
`0e33fe8a54` preserve essential titles, roles and character links while enabling
wrapping, contextual continuation and directional relation headings in
[qualified-credit.tsx](../../apps/web/src/features/pages/qualified-credit.tsx),
[qualified-relations.ts](../../apps/web/src/features/pages/qualified-relations.ts)
and [cover-list.tsx](../../apps/web/src/features/pages/cover-list.tsx).
The catalogue correction group `3f5487987a` / `112fccb2af` supplies language
removal, focus and compact phone correction controls. These are visible product
changes, not test-only padding.

Retain these corrections. The earlier and later workers recorded Sol, including
workers dispatched during Terra manager turns. This supports a recurring
first-delivery completeness problem across the period, not a Terra-specific UI
regression. Source and authored interaction coverage do not establish that the
current deployed pages have been visually verified.

### Medium, corrected: machine-evidence bloat recurred under Sol work

`35fc1425b7` landed a 54,818-line
`docs/research/daily-step-audit-evidence.json` with the message “wip: leftovers
from attempt 1.” `6661bbf502` removed the machine evidence. A later daily-audit
group through `a7340573eb` again committed a 27,438-line flow JSON under
`tools/goal/reports/`; `4bf37b247f` removed that file too. These counts describe
the introduction diffs; later deletion counts differ after formatting/edits.

Inbox 21006 explicitly notes the recurrence and instructs the audit to stop or
write machine evidence only to the state directory until the class fix lands.
The defect is bulky reproducible operating data in tracked delivery plus weak
artifact routing, not that a research report or meaningful test is inherently
padding. Retain the removals and finish the generator's evidence destination.
This is another Sol-worker control: it cannot be attributed to Terra-generated
product code from the time of its landing.

## Specific decisions and reviews that should not be misclassified

### History ceilings: authorized and bounded, with later costs still to compose

Inbox 21042–21049 records the original same-frame funding conflict and owner
review. The adopted sum is reproduced in
[identity-source-consumer-custody-contract.md](../../services/kernel/src/semantic/identity-source-consumer-custody-contract.md),
lines 143–155 and 246–255:

| Component                                                  | Rows | Points | Statements |  Bytes |
| ---------------------------------------------------------- | ---: | -----: | ---------: | -----: |
| Original Source, binding, directory and local verification |  249 |    249 |         81 | 286720 |
| Account settlement read                                    |   64 |     64 |         20 |  65536 |
| Two Account same-home verifications from Source            |  128 |    128 |         30 | 131072 |
| Two complete History Source checks                         |  136 |    136 |         42 | 147456 |
| Total                                                      |  577 |    577 |        173 | 630784 |

The total uses zero engine requests. It is a conservative composition, not a
claim of minimal cost or successful native execution. Inbox 21081 at 01:01:27
explicitly authorizes the higher fixed bound, requires retaining verifications
and child budgets, and delegates numeric fixed ceilings to the owner.

The resulting
[identity-source-maintenance-config.ts](../../services/kernel/src/semantic/identity-source-maintenance-config.ts)
sets these maxima and independently clamps the preexisting directory envelope
to 100 rows, 200 points, 36 statements and 229376 bytes before splitting it
between its two children. Increasing the parent does not silently enlarge that
child scan. This complies with the architecture's fixed application-work bound.

The later SDK producer adds actual transaction work: each current lock costs
4 rows, 2 points, 4 statements and 8192 bytes; a released observation has its
own cost. Inbox 21333 at 02:45:37 correctly says two additional locks alone
would raise the old baseline to 585/581/181/647168, excluding observations and
new History work. Do not treat 577 as funding an as-yet-unimplemented complete
continuation. Derive the final composition from the actual body when closing
the high-severity retirement finding; do not revert the justified earlier sum.

The architecture clarification `4736cfd8a3`, landed at 23:42:40 before Terra,
also explicitly excludes PostgreSQL multiversion visibility maintenance from
product budgets. Continuing to use ordinary indexed SQL under that direction
is appropriate; reviving superseded engine-visibility accounting would not be.

### Landing authorization, review and deployed evidence remain distinct

Inbox 21110 at 01:15:32 explicitly distinguishes LANDING from integration.
Inbox 21129 at 01:18:59 calls the landed document-union review a source review,
not a gate or native proof. These are accurate limitations, not unsupported
completion claims.

Web's later request in inbox 21780 at 04:21:07 asks for specific foreign-owner
Web tests and only two nonbrowser cases from a UI file. Inbox 21781 at 04:21:21
rejects that exact route as unsupported: registered verification requires the
proper original provenance and a complete original command or permitted
whole-file union. It records no execution and no pass. The partial-file request
was unsuitable for that controller route, but there is no evidence the manager
actually bypassed the gate or falsified results. Future requests should start
with the supported owner/provenance route rather than repeatedly proposing an
unavailable subset.

Web's conditional publication authorization at 01:00:38 (inbox 21072) was not a
publisher receipt. At 02:00:12, inbox 21234 asks for disposition of the missing
receipt rather than authorizing a duplicate. S12's 04:00:33 public build
observation still identifies revision `f1883eed738f8ff36322ffe38ddd0e682b9133fd`,
built on 2026-10-31 at 22:37:01. A successful HTTP response from that artifact
does not verify the later `d17bf79f09` UI. Preserve this deployment evidence gap;
do not convert it into a claim that the current source regressed or passed.

### Infrastructure failures explain part of the delivery gap

Inbox 21312 at 02:33:50 reports eight failed attempts and no worker runs since
about 01:30, with the exact launch error
`process identity changed; refusing to signal reused PID`. Inbox 21359 at
02:57:34 records the single bounded process-recovery dispatch. The brief
“Recover a vanished worker whose leader PID was reused” requires preserving
refusal for surviving or ambiguous groups and never signaling a reused PID.
That is a real launch-safety defect, not a product decision or a reason to
weaken checks.

The later brief “Recover eligible ready work after host restart” separately
targets ready starts/retries not re-admitted after restart. Together with
model selection and continuation wakeups, these controller failures confound
any attempt to infer model coding quality from throughput in this interval.
Queued checks or work awaiting a genuine slot are not counted here as hangs.

## Other reviewed delivery groups

These groups contain concrete default-path or user-facing changes. They should
be retained on the inspected evidence, with their original verification status
preserved. This table is not whole-Goal acceptance or an assertion that every
behavior in each owner area has been audited.

| Area and representative commits                                                                                         | Evidence and disposition                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed Home, Following and kind: `b9491c103f`, `95a7a1f8f7`, `4e9df33f3d`, `6db386f5e5`                                  | Real activity producers, bounded deterministic merging, native kind candidate selection and page consumption. The 30-day/2,000-reference window matches scope; no archive backfill is claimed. Retain, with the missing Source/Space/Context qualification above.                                                                                           |
| Definition catalogue: `a678ead48b`, `64679c6b32`                                                                        | Implements catalogue artifact publication/activation and bounded page traversal. Default discovery still reads `activeRelease`; catalogue producer delivery alone does not establish that all default consumers have escaped the older bounded release. Retain producer; finish its real consumer dependency before claiming the whole upper-bound journey. |
| Batched Subjects: `542a5f2782`                                                                                          | Implements grouped physical reads with a repeatable snapshot, matching the architecture's batched per-database read rule. This is a concrete engine-use improvement, not a new vertical framework.                                                                                                                                                          |
| Collection membership: `d0036d8d4c`                                                                                     | Replaces the 5,000-member stopping behavior with bounded resumable order work. The requirement concerns total finite input, not an unbounded single request; retain that distinction.                                                                                                                                                                       |
| Library and commerce: `8d9652fb42`, `b8d84ee149`, `d0e06a0233`, `807d3dcc15`, `3f383a4c1a`                              | Shelf states, continued reading and purchase/receipt presentation have actual consumer changes. These do not establish the separate identity-scope seal implementation.                                                                                                                                                                                     |
| Account and settings: `bf8fdc07be`, `5a2bd4c68c`, `7667d83424`, `02d7231f38`, `b4a75eb14a`, `f5fd4b0c60`, `13607684a2`  | Concrete phone reflow, deletion/current-identity, consent and settings interaction changes. Retain; neither settings copy nor erasure preflight proves the pending full History retirement path.                                                                                                                                                            |
| Community reading: `6b6227ab1e`, `c3a2ab6475`, `abb5852c8a`                                                             | Moderation evidence and reply context use admitted current context and improve the reader journey. No inspected evidence justifies reverting these as speculative abstraction.                                                                                                                                                                              |
| Shared web presentation: `605d7ac4d8`, `1cfdc4bceb`, `1a3a9c222a`, `80d0344233`, `d893df4117`, `4e82c06ec4`, `50985960` | Portrait/default-cover, filter entrance, header and typography changes correspond to explicit resume and shared-design directions. Keep authored behavior distinct from deployed visual proof.                                                                                                                                                              |
| Storybook MCP: `8dc28baae1`, `16f799c23d`                                                                               | Real developer access/setup change requested first by the resume direction; it is not a claim of product browser verification.                                                                                                                                                                                                                              |
| Landing cleanup: `b538d99e0c`                                                                                           | Preserves the committed landing outcome when worktree cleanup fails, while retaining failed cleanup evidence. Its tests exercise the release/locked-worktree behavior; test volume alone is not evidence of padding.                                                                                                                                        |

## Sol controls and attribution limits

The following exact session evidence provides controls independent of commit
landing timestamps. Files in the first five rows are relative to
`/home/edge/.codex-1/sessions/2026/11/01/`; the last three are relative to
`/home/edge/.codex/sessions/2026/11/01/`.

| Worker contribution                            | Session JSONL                                                            | Recorded Sol context examples                          |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Mixed-feed producer                            | `rollout-2026-11-01T03-02-05-01a19357-2908-7681-af17-bb5ba820718b.jsonl` | 19:02:07.415, 19:12:29.236, 19:27:42.827 on October 31 |
| Home consumer                                  | `rollout-2026-11-01T04-03-03-01a1938e-fbec-7001-ab2c-3658f2264203.jsonl` | 20:03:05.580, 20:13:48.087 on October 31               |
| Kind feed consumer during Terra manager period | `rollout-2026-11-01T08-20-26-01a1947a-9e03-7010-a608-23882ce9643d.jsonl` | 00:20:28.347                                           |
| Edition query/fence correction                 | `rollout-2026-11-01T08-22-40-01a1947c-a575-77d1-a8e2-9bb1f9ea52aa.jsonl` | 00:22:42.145, 00:36:35.769                             |
| SDK transaction fence                          | `rollout-2026-11-01T10-12-20-01a194e1-0e65-76f0-81ec-4073d0aee9aa.jsonl` | 02:12:22.721                                           |
| Credit readability correction                  | `rollout-2026-11-01T12-13-31-01a1954f-f95f-7682-961b-12a3328bde46.jsonl` | 04:13:42.123                                           |
| Catalogue phone correction                     | `rollout-2026-11-01T12-13-30-01a1954f-ed5f-7b03-9783-de2eb736e148.jsonl` | 04:13:42.266                                           |
| Optional Zone translation controls             | `rollout-2026-11-01T12-13-35-01a1954f-ff8e-7b41-87b0-2612b0e942b2.jsonl` | 04:13:47.949                                           |

The controls show both useful and incomplete Sol delivery, including Sol workers
implementing Terra-dispatched corrections. The Context authority split predates
Terra. Default-producer gaps also predate it. The strongest directly observed
Terra-specific concern is repeated manager completion with no changed state;
even there, host continuation behavior is a confounder. These data do not support
a controlled comparison of model defect rates, a conclusion about every Sol
change, or a claim that all defects disappeared when the default changed back.

## Recommended disposition

1. **Finish, rather than revert, the two incomplete compositions.** Public
   discovery needs its positive native Source and then actual scoped/default
   consumers. Identity retirement needs the real Library seal, durable Source
   authority and History/SDK receiving closure in the supported placement.
   Preflight the complete positive default call graph before another brief
   promises completion. Keep existing bounded work and fail-closed states.
2. **Repair the controller class defects.** Pin model and effort at supported
   turn boundaries; coalesce unchanged wakes; complete safe reused-PID and
   restart admission recovery. Do not infer these fixes from the existence of
   their briefs or from a changed host default.
3. **Adopt the already-chosen Context semantics in the tracked owner document.**
   Preserve the distinction between adopted meaning and installed capability,
   including the separate witnesses allowed for a Subject. No new product
   meaning or Context-as-Realm substitution is warranted by this review.
4. **Retain corrected edition admission, optional naming, credits, phone controls
   and justified ceiling changes.** Preserve their unexecuted/deferred native
   and browser obligations. The source review does not authorize a new check
   campaign or claim the deployed build contains these changes.
5. **Keep machine evidence out of tracked reports.** Retain both cleanup commits
   and fix the producing route so the same data is not repeatedly reintroduced.

No currently retained product change is recommended for unconditional reversal
on the inspected evidence. The concrete revert-worthy accidental query
tightening and generated-evidence additions have already been corrected or
removed. Redo the incomplete journey assignments and adoption placement, not
the useful code around them.

Review decisions: the cutoff is the immutable launch snapshot; model attribution
uses context records rather than commit times; incomplete dependencies are not
treated as installed code; a safe refusal is not called successful completion;
and recorded authority/review is not substituted for execution evidence. Only
this report is changed. There are no outside-path edits and no workspace typing
obligation for this documentation-only delivery. The original report-existence
acceptance command and native/browser verification remain deferred under the
current execution policy.
