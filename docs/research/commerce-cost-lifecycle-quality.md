# Commerce financial lifecycle and physical cost review

Reviewed 2026-11-03; refreshed against dev **`1237cd46c4bea1ba795e153a57ff8031dc9b3558`** on retry.
The clean retained report commit was `324025daa073950dcce59d57edbf023c5847f918`, based on that dev commit.
The original source review used `8f63aa396c789f5d6b10b5f65c2edaf24a3d5987`. Comparing it with current dev found
no changes in Commerce source/tests, the cited Commerce and shared lifecycle contracts, the reviewed growth
harness entry points, kernel package/runner, or the three earlier Commerce reports. This comparison does not
certify other shared dependencies. This remains a source and earlier-evidence review, with **no new native
execution or physical measurements**. Commerce Goal clauses 3, 4 and 6 remain unverified on current dev.
Main promotion remains parked; this report registers no promotion proof.

Decision: apply the launch prompt's final minimal-verification override; defer original native acceptance to
integration and retain every unobserved result and cost axis as missing. The decision was sent to the commerce
manager with the required inbox command, which exited `0`. No implementation or continuation was dispatched.

## Authority and evidence limits

The [Commerce Goal](../goals/commerce.md#done-when) requires:

- **Clause 3:** “Fulfilment has one durable effect: buyer-home order, entitlement and named payment evidence change atomically.
   Signed events schedule fresh bound reads; redirects, history and Library presence never authorize use.”
- **Clause 4:** “Creation uncertainty, evidence completeness, immutable movement economics and bounded signature/secret inputs
   satisfy the owner contract. Exact replays have one effect, conflicts reconcile, incomplete evidence never grants
   or restores, and terminal account fences prevent personal-benefit resurrection.”
- **Clause 6:** “Financial erasure/custody and actual physical cost meet their shared owner contracts. Provider eligibility and
   private setup remain external; fixtures do not claim production qualification.”

The sole purchase authority is [Commerce's README](../../services/kernel/src/commerce/README.md), particularly
“Signed ingress, refresh and recovery”, “Historical payment and current entitlement”, “Privacy, lifecycle and
cost”, “Payment path growth cost” and “Cost”. [Shared deletion](../deletion.md#account-erasure) and
[Accounts erasure consumers](../../services/kernel/src/access/README.md#erasure-consumers) own participation,
retention and acknowledgement. Their existing interfaces remain authoritative; no Commerce substitute is proposed.

The final launch policy explicitly forbids acceptance/native/browser/root/worker/remote checks in this attempt.
Consequently there are no current case results, runner UUIDs, assertion exits, timing samples, physical boundaries
or newly generated evidence paths to report. This is a policy deferral, not an infrastructure incident or a pass.
Documentation alone changes no typed workspace; no test file was created or changed, so neither workspace typing
nor a changed-test landing command applies. A typecheck would establish none of the missing outcomes.

The previous landing stopped after successful formatting with “The following paths are ignored by one of your
.gitignore files:” naming `.temp`. On retry, `git add --dry-run -- .temp` reproduced that staging rejection
(exit `1`). This is a controller staging failure, not a Commerce assertion or acceptance result. The commerce
manager received the handoff for the existing controller owner; temporary artifacts remain ignored and excluded.

### Earlier evidence

| Reviewed source | What it establishes | Limit at the bound dev commit |
| --- | --- | --- |
| [Integrated Done-when review](commerce-integrated-done-review.md), 2026-10-28, inspected source `cb7f4b3e9934db49cb817f6f7384ea5ab936cc1f` | Reports historical frozen outcomes: 23 pass, 0 fail, 562 expectations; identifies atomic source writes and missing lifecycle evidence | Historical report, not a current execution. Its cited `.temp/goal/commerce/F140-native-accepted-after-direct-route.log` is not fresh evidence here. The report associates `47d56b806ead2a1ae342fe9c18d70433e60ab103` through a ledger, while explicitly qualifying byte-to-commit binding; no actual process exit was independently recovered here |
| [Refresh recovery review](commerce-session-refresh-recovery-current.md), source `997aefa21d8de4b1f5be8b2d741e28ccc01e5b93`; [independent analysis](commerce-session-refresh-recovery-deep.md) | Explain native admission fencing, DBOS replay/overlap and the need to count dispatcher/provider work | Source-derived schedules and recommendations, not current native failure reproductions; older dependency versions cannot qualify the current pin |
| Current Commerce owner, “Privacy, lifecycle and cost” | Explicitly records unresolved locator/combined-refresh examined-row failures and unproved queue/backlog/fanout/erasure bounds | Does not supply current three-scale samples, exact failing assertion text or run exit; retain these as earlier unresolved findings, not newly observed failures |
| Current owner, “Cost” | Creator Sales and native order-copy/recovery complete composed allowance totals are explicitly unknown | Neither authored cases nor indexed predicates establish physical cost |

No historical claim above is upgraded to current-dev green. No evidence logs, audit manifests or generated bindings
are committed with this report.

## Current suite inventory

Paths below are relative to `services/kernel/`. The inventory covers all seven named growth files, additional
growth assertions outside their names, and the native/financial/shared lifecycle cases needed for the three clauses.
Suite presence means authored coverage; every current execution status in this inventory is **deferred**.

### Three-scale populations and authored ceilings

`S/R/B` below means statements, rows and blocks. Those are declared bounds, never measured values in this review.
For every row, actual S/R/B and request/response bytes at each scale are **missing**. Seeds must be preserved;
the owner contract's 1/8/64 payment-path series does not authorize replacing other suites' explicit scale triples.

| Suite and owned operations | Exact authored scales and seeded population | Authored ceilings / qualification |
| --- | --- | --- |
| `test/commerce/growth-orders.test.ts`: command envelope; authorization; offer creation; offer read/delist; order creation; Checkout/receipt recording; order/Session/transaction reads; decision/settlement; entitlement grant/change/lock/read; entitlement list; order-account lookup; erasure guard | `[1,4,16]` scale units, 500 seed ordinals/unit: **500/2,000/8,000** per population. Offer read/delist also grows unrelated subjects at 256/unit: **256/1,024/4,096**. Multiplicity varies by relation; these are not total row counts | Constant S/R, logarithmic B. Final seed audit limits populations to 16 units plus recorded anchor/run allowance. The “Erasure” operation attempts a forbidden immutable transaction DELETE and expects rejection; it measures a guard, not financial cleanup or participant completion |
| `test/commerce/growth-payouts.test.ts`: royalty recording; statement read/list; lines page; mark paid | Default `[1,8,64]`, 500 ordinals/unit: **500/4,000/32,000**. Recording source history stays at **152 keys**: eight anchors plus 18 batches of eight; each measured recording uses eight fresh keys. Eighteen separate statements support mark-paid runs | Constant S/R, logarithmic B. Limit-20 pages. Seeds include native-shaped command rows and synthetic historical currencies; actor/grant SQL and custom mark-paid authorization are component fixtures, not ordinary Auth/Accounts persona proof or provider eligibility |
| `test/commerce/growth-transactions.test.ts`: named-key settlement and creator recording | Histories **`[1,64,255]`**, with one additional selected movement per scale | Equal captured statement/returned-row summaries; selected transaction read ≤1 row; recording expects four selected queries. A separate ≤257 lookahead probe is excluded from its summary. Regex-filtered successful query capture and `rowCount` do not measure all physical scans, failed prefixes, shared SQL or DBOS |
| `test/commerce/payment-path-growth.test.ts`: signed ingest; reconciliation; settlement; offer price revision | `[1,8,64]` independently for **unrelated orders, provider events, receipts, DBOS workflow history**: 4 operations × 4 populations × 3 scales | Constant S/R, logarithmic B; requires positive measured S/R. Provider-event/workflow histories are SQL-seeded DBOS-shaped rows; they are not authentic completed SDK-history proof. The selected reconciliation uses production work; settlement uses the legacy snapshot port. No provider send/byte counter is declared by this file |
| `test/commerce/checkout-anchor-growth.test.ts`: direct Session, PaymentIntent-derived, known-paid, binding mismatch | **`[64,512,4096]`** unrelated command-created native orders/provider Sessions, per path | Exactly **1 statement, 1 row**; no purchase-order sequential scan. Counted sends **1/2/0/1** respectively; maximum native connections ≤1, connections ≤1. Counted request/response bytes constant; actual backend attribution requested. Printed boundary explicitly excludes composed/queue/retention proof |
| `test/commerce/combined-refresh-growth.test.ts`: production known-order repair and combined paid no-op refresh | **`[64,512,4096]`** separately for native, provider and workflow histories. Workflow decoys go through actual installed SDK enqueue/getResult, bounded batches of 64 | Constant S/R, logarithmic B; SQL request/response bytes constant. Counts: provider sends ≤4, native attempts ≤2, SQL serialization retries ≤0, maximum native clients ≤1, native clients at provider ≤0; provider bytes constant. These describe the fixed healthy paid no-op, not all retry/failure executions |
| `test/commerce/purchase-history-growth.test.ts`: first and deep buyer pages | **`[32,128,512]`**, each ordinal adds selected buyer, same-route peer and foreign-partition buyer native orders; additional paid purchases every eighth ordinal. Cursor depth grows through public signed pages | Two limit-5 reads, each six raw orders: **12 purchase-order rows** total, entitlement rows ≤12, no purchase-order sequential scan; constant S/R, logarithmic B, `indexProbes:18`. No offer SQL. Whole Auth/Access/page composition still needs actual observed samples |
| `test/commerce/order-receipt-financial.test.ts`: captured charge and actual presentment projection | **`[1,8,64]`**, up to **128/1,024/8,192** unrelated observation keys per copied source context, retaining prior keys with `ON CONFLICT DO NOTHING` | Actual `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the selected read: **1 statement, ≤3 rows**, no money-observation sequential scan. Component wrapper executes EXPLAIN and then the read; no end-to-end transport/byte proof |
| `test/commerce/stripe-transport.test.ts`: unrelated provider history | **`[1,4,16]`** other Sessions, each paid/refunded/disputed | Full selected read expects **3 physical sends**, then locator brings cumulative sends to **4**. Despite the case title mentioning sizes, this growth loop has no explicit request/response-byte comparison; bytes at the three scales remain unmeasured |
| `test/commerce/creator-sales.test.ts`, `creator-offers.test.ts`, `subject-offers.test.ts` | Native page/persona/cursor cases; no three-scale growth series identified in these page files | Current owner declares Sales default 20/max 100, ≤101 candidates and ≤256-KiB serialized sales. Full eight-axis composed Sales and copy/recovery totals remain unknown; opening a growth database is not a growth measurement |

The common harness in `test/support/growth.ts` defaults to one warmup and five measured repetitions per scale,
retains repetition costs, relation sizes, seeding cost, statement occurrences and optional backend/counted evidence.
`growth-config.ts` selects listed baseline checks' step rule or the series rule as applicable; retain the admitted
configuration rather than assuming every suite uses the same comparison. `growth-bound.ts` defines default step
slack: rows `max(2,10% of baseline)`, statements zero, blocks `max(4,50% of baseline)`; request/response byte slack
is 10% with zero absolute slack. Logarithmic transitions and `indexProbes` have their own formula. These defaults
are not numeric measured ceilings or permission to change a frozen bound after failure. Series classification
and retry attribution must be retained from the actual runner result.

### Native lifecycle and financial case coverage

| Boundary / personas authored | Current files and cases to retain |
| --- | --- |
| Atomic fulfilment, rollback, exact receipt and reauthorization | `commands.test.ts`, especially “a fulfilment command writes order state transactions and entitlement together in the buyer partition and emits their events”; `store.test.ts`, `schema.test.ts`, `partition-binding.test.ts`, `sql-placement.test.ts` |
| Current claim, stale read, no-op successor, physical retry, SQL retry, result loss and worker death | `checkout-refresh-admission.test.ts`, `session-refresh-user-cases.test.ts`, `default-refresh.test.ts`, `checkout-workflow.test.ts`, `work.test.ts`, `work-bounded.test.ts`, `work-contract.test.ts`, `work-module.test.ts`; retain equal/backward-clock, completed-intent rewind and cooperative-cancellation cases |
| Active, refund-revoked, restored and terminal buyers; genuine Auth T and both lock orderings | `terminal-benefit.test.ts`: grant before T while deletion waits; captured provider bytes before T but account barrier after T; reversal after T; terminal stale-claim CAS; account-share unavailability with actual blocking witness. `default-refresh-terminal.test.ts` uses the actual default worker after Auth deletion |
| Creation uncertainty and association completeness | `creation-attempt.test.ts`, `creation-attempt.ts` consumers in `stripe.test.ts`, `stripe-locator.test.ts`, `checkout-anchor.test.ts`, `checkout-workflow.test.ts`, `settlement.test.ts`, `legacy-refresh.test.ts`; keep lost responses, immutable retries/cutoffs, incomplete/unsupported adverse evidence and late payment separate |
| Immutable movements, royalties, units and external references | `payouts.test.ts`, `payout-mark-paid.test.ts`, `royalty.test.ts`, `money.test.ts`, `money-evidence.test.ts`, `order-receipt-financial.test.ts`, `order-bounds.test.ts`; duplicate/conflicting economics, recording month, missing interpretation, nullable historical units and authorized mark-paid are separate outcomes |
| Financial participant, unused account and historical operator/acting human | `erasure-participant.test.ts`, production `src/commerce/erasure-participant.ts`, `support/erasure-participant-runtime.ts`; terminal worker preserves pending financial status after entitlement cleanup |
| Signed-byte limits, shared capacity, real retries, abandoned operations | `webhook.test.ts`, `stripe-transport.test.ts`, `stripe-caller-deadline.test.ts`, `request-deadlines.test.ts`, `config.test.ts`, `governance.test.ts`; transport includes 4096/4097 containers, 100/10 adverse pages, 256 movements, 256-KiB/+1 output, retry exhaustion and eight physically unsettled slots |
| Ordinary native user outcomes | `outcomes.test.ts` imports `specs/commerce-outcomes.test.ts` via the real `support/outcome-driver.ts`. Retain buyer, same-route other buyer, refunded buyer, anonymous, seller/other seller, creator/other creator, suspended/terminal, authorized/unauthorized repair personas. Native repair uses `order-reconcile.test.ts`; benefit/use and acquisition have `content-edition-buyer-fact.test.ts`, `acquisition.test.ts`, `benefit.test.ts`; buyer pages use `purchase-history.test.ts`, `checkout-return.test.ts` |
| Existing Accounts participation and shared-history coverage | `test/access/erasure-{participant,native,discovery,late-items,coordinator,status-read,consumer-contract}.test.ts`, `erasure-failed-locator-work.test.ts`, `growth-erasure-{native,coordinator}.test.ts`; `test/history/{contracts,family-coverage,command-custody,operational-work,growth-command-custody}.test.ts`; `test/access/live-copy.test.ts` for Commerce sales copy/recovery. These are owner tests, not evidence that Commerce has complete coverage |

No case is skipped or rewritten by this report. Low-level actor/SQL fixtures remain distinct from native account
provisioning, consent, deletion and participant proofs. Provider fixtures replace only the provider boundary;
their existence establishes no Managed Payments approval, seller rights or production qualification.

## Concrete gaps and bounded next work

All proposed work below belongs to the existing owners. These are recommendations to the manager, not queued
continuations. Exact commands for future reproduction are listed in the next section.

### Atomic fulfilment and terminal use: execution missing

Owner clause: “Fresh body locks order, keeps the captured revision/Session through commit and SQL retry, and
atomically changes buyer order, named transactions, entitlement and receipt/outbox.” The same section states:
“Superseded apply rolls back without apply receipt; retry requires new admission/read.”

Current cases author these boundaries, but this attempt has no current native exits. Retain the atomic command,
refresh-admission and session-refresh cases; include effect/receipt state on rollback and exact duplicate replay.
Bounded next brief: commerce runs those existing native cases on the integrated source and fixes only a reproduced
failure class. User outcome: a buyer receives one benefit and payment record, and obsolete work cannot reverse a
newer decision. Likely paths: `src/commerce/{commands,store,settlement,work}.ts` and the three named native case
files. Final protected bytes remain Content/Accounts' existing boundary.

Owner clause: “Terminal buyer T always prevents grant/restore and private reads. Use the real account share barrier
in the same transaction, account before order, reacquired on retry.” Native terminal and default-worker cases are
the reproductions, not a model of a terminal boolean. Bounded next brief: retain both real deletion lock orderings,
refund reversal and availability rollback; measure failure prefixes separately. User outcome: deleting an account
never brings a paid benefit or private receipt back. Likely owners/paths: commerce `commands.ts`, terminal/default
refresh tests, with Accounts owning `shareAccount` and native Auth deletion. No source regression was introduced here.

### Financial erasure: source gap and a specific assertion candidate

Owner clause: “Financial Commerce is separate from Library's erasure participant. It must acknowledge actual
minimized cleanup or no applicable data, never mere dispatch; minimal completion outside workflow history prevents
late resurrection.” Accounts adds: “A participant without a decided expiry stays pending.”

Current `advanceCommerceErasure` physically pages entitlement cleanup (100 keys) and creator-sale minimization,
then records `pending`. It calls native `readHistoryOwnerCoverage`; neither complete shared coverage nor local
emptiness proves foreign financial-role absence. Its registered workflow has no final `acknowledgeErasure` call.
The source's `FINANCIAL_ERASURE_BLOCKER` names unresolved field/purpose/jurisdiction/expiry policy,
receipt/outbox/write-basis/DBOS minimizers, historical delegate/operator locators, provider custody and backups.
`COMMERCE_CUSTODY_BLOCKER` also names producer conversion, receiving custody and sealed coverage.

The first case at `test/commerce/erasure-participant.test.ts:206` expects an unused Bob account to produce
`{outcome:'none',retained:[]}`, `advanceCommerceErasure(...) === 'none'`, and progress phase `none`.
The current implementation never returns `none`; exhausted local pages become `pending`. This is a concrete
source-level assertion mismatch on the **base**, not an observed test failure. Setup might fail earlier; only an
original run can identify its first actual failing assertion. Preserve the original `none` requirement and the
historical acting-human/operator negative case. Never obtain green by acknowledging after empty local inventory.

Bounded next brief, existing commerce producer owner with Accounts shared-history owner: deliver complete native
Commerce role/producer coverage for the unused-account proof and consume Accounts' opaque receiving proof before
enabling a final `none`. User outcome: a person with no applicable financial data gets a truthful completed
Commerce result; uncertain or historical responsibilities remain visibly pending. Likely paths:
`src/commerce/erasure-{participant,proof,history}.ts`/`.sql`, role inventories and native History producer wiring.
Use existing Accounts APIs; do not add a test acknowledgement or infer coverage from missing DBOS rows.

### Financial minimization, retained expiry and external copies: missing

Owner clause: “Minimize offer party data, buyer/target relations and Checkout payloads, entitlement relations,
immutable transaction/royalty source relations and statement payment references except the restricted legally
necessary fields with purpose and expiry.” Shared deletion adds: “Cleanup follows every role the account held:
author, editor, uploader, reporter, buyer, seller, delegate, operator, member and acting human.”

Full financial-field cleanup and expiry are explicitly undelivered in the owner, independently of successful
entitlement cleanup. Money observations have bounded ownership/minimization queries but share the unresolved
financial schedule; immutable guards create no retention exemption. External Stripe metadata/deletion limits and
backups are not closed by native fixtures. There is no current complete measurement of these phases here.

Bounded next brief, commerce with existing Accounts retention/custody owner: inventory exact native fields/roles
and shared receipt/event/write-basis/work locators, adopt the externally resolved schedule in the owning document,
then implement one bounded financial minimization/expiry phase at a time. Keep undecided records pending and test
retention resolution only after actual purge. User outcome: retained financial facts have a stated restricted
purpose/expiry and unrelated private relations disappear. Likely paths: Commerce erasure SQL/progress, money
observation ownership, royalty/statement stores and `src/history/` receiving/minimizers; provider setup stays with
its existing external owner. No schedule or legal retention period is invented by this review.

Shared owner clause: “Missing coverage, pending effects, an incomplete page or failed removal keeps
acknowledgement pending and erasure incomplete; none is never inferred from an empty page or a missing DBOS row.”
The bounded next shared-history brief belongs to **Accounts**, extending current family coverage/receiving and
registered minimizers rather than launching a second Commerce cleanup service. It must preserve open locator work
through cancellation, ERROR, history removal and fork/recovery. User outcome: an erasure status never claims that
copied financial payload has disappeared merely because its workflow ended. Likely paths: `src/history/`,
`src/access/erasure*.ts`, existing History/erasure tests and producer-declared locators.

### Physical cost: all current observations missing; some authored axes absent

Owner clause: “Charge account/order/receipt/outbox probes, partition counter contention, provider work and DBOS
system persistence separately.” Also: “Do not raise allowances or subtract workflow work to disguise them.”
Each operation's original three-scale population and all repetitions must survive the owning run. Current numeric
S/R/B/byte values are missing for every inventory row. Earlier examined-row failures remain unresolved until a
bound current result shows their actual relation, plan, pool/backend, failed prefix and comparison ceiling.

Bounded next brief, existing commerce cost owner, with Performance only for an isolated harness defect: run the
unchanged growth files, retain seed/relation sizes and all statement/plan occurrences, then repair one reproduced
native/DBOS cost class without increasing caps. Cover successful, exact-repeat, conflict, rollback, timeout,
SQL-retry and abandoned-provider prefixes at the same boundary. User outcome: payment and history remain bounded
as unrelated history grows, including failed attempts. Likely paths: Commerce locators/queries/work composition;
`test/support/growth-{capture,cost,report,attempt-index}.ts` only if independently reproduced attribution is faulty.

Missing instrumentation is separate work: the transaction-history suite's filtered `rowCount` summary cannot
replace physical examined rows; payment-path growth has no physical provider byte/send series; the transport
history loop checks sends but not bytes. Add observation through the existing native pools/official SDK transport,
without changing assertions or injecting successful dependencies. Reuse current transport tests to observe retries
through physical settlement. Native request/response bytes, provider bytes, occupancy and DBOS persistence are
different axes and must not be substituted for one another.

Owner clause for Sales/copy: “The eight accounting axes are the actual composed `candidateKeys`,
`identityMetadataRows`, `nativeRows`, `nativePoints`, `witnessKeys`, `statements`, `bytes`, and `emptySeeks`”.
It further states: “Complete end-to-end totals are explicitly unknown; no new funded parent allowance is claimed.”
Bounded next brief, existing commerce Sales/copy owner plus Accounts' child readers: expose actual child costs
and retain failed empty seeks, rejected lookahead, role fanout, inverse enrollment and rollback/repeat work in the
invoking frame. Likely paths: `creator-sales.sql`, native sales source/receiver/work wiring and existing
`test/access/live-copy.test.ts`. All eight measured values and complete ceilings remain missing; a 101-row or
256-KiB local page cap does not fund the composed operation.

The provider physical ceilings remain the owner contract's **20-second maximum shared deadline**, **256-KiB
body**, **16-KiB headers and aggregate input strings**, **two network retries**, **111 logical reads** maximum,
total sends ≤ logical maximum × `max(2,1+retries)`, shared logical-maximum × 256-KiB byte budgets, **eight unsettled
provider operations**, **eight refresh bodies**, **256 named native transactions** with 257-key lookahead,
**4096 nested containers**, depth **16** and **256 fee details**. They are authored local limits, not measured
current values or provider population guarantees. Preserve shorter caller deadlines and capacity until physical
settlement; cancellation does not erase charged work.

## Supported reproduction and result classification

The supported runner is the kernel package's `check` script, `scripts/check.ts`; explicit file arguments select
the existing native entry points. The following are **future integration commands**, issued from the worktree
root with normal check placement. Every command's current exit and evidence path is **absent: not invoked**.
There is no runner failure before assertions, assertion failure, passing case or flakiness observed this attempt.

```sh
bun run --cwd services/kernel check test/commerce/growth-orders.test.ts test/commerce/growth-payouts.test.ts test/commerce/growth-transactions.test.ts
bun run --cwd services/kernel check test/commerce/payment-path-growth.test.ts test/commerce/checkout-anchor-growth.test.ts test/commerce/combined-refresh-growth.test.ts test/commerce/purchase-history-growth.test.ts
bun run --cwd services/kernel check test/commerce/commands.test.ts test/commerce/checkout-refresh-admission.test.ts test/commerce/session-refresh-user-cases.test.ts test/commerce/terminal-benefit.test.ts test/commerce/default-refresh-terminal.test.ts
bun run --cwd services/kernel check test/commerce/erasure-participant.test.ts test/commerce/money-evidence.test.ts test/commerce/order-receipt-financial.test.ts test/commerce/stripe-transport.test.ts
bun run --cwd services/kernel check test/commerce/outcomes.test.ts test/commerce/payouts.test.ts test/commerce/payout-mark-paid.test.ts test/commerce/order-reconcile.test.ts
```

These selections do not replace the remaining inventoried component or Accounts-owned suites. The existing
Accounts owner retains its erasure/History/live-copy integration campaign. No direct `bun test` invocation,
environment-unset placement override, schema edit, live processor call or modeled backend was used here.

For integration, retain the command, checked source commit, actual process exit, runner UUID and returned artifact
paths alongside original case output. Keep each scale's seeds, relation sizes, statement text/hash and occurrence,
pool/backend, examined/removed rows and loops, buffers, request/response bytes, counted boundaries, retries and
discard/failure prefixes. A missing profile or omitted axis remains missing even when case assertions pass.
An infrastructure error before cases belongs to its existing environment owner with the exact first error line;
it is neither a failed product assertion nor permission for a speculative repair. An intermittent assertion needs
the runner's retained rerun history before classification as flaky. No flakiness is inferred from old reports.

## Primary-source patterns and recommendation

The following reference clones were read only as source data; nothing from them was installed, built or run.
Both were already present under `/home/edge/projects/rezics/rezics-next/.reference/`; their reuse is registered in
that directory's `INDEX.md`.

| Primary source, pin and licence | Inspected file / finding | Consequence for this stack |
| --- | --- | --- |
| [PostgreSQL source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/access/nbtree/nbtsearch.c), `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`, PostgreSQL License (`COPYRIGHT`) | Local `.reference/library-shelf-maintenance/postgres/src/backend/access/nbtree/nbtsearch.c:160-225`: child-page descent and right-sibling correction after splits | Indexed keys do not establish constant buffers; retain actual plans/blocks at the declared populations |
| [PostgreSQL 18 EXPLAIN documentation](https://www.postgresql.org/docs/18/using-explain.html), PostgreSQL documentation licence | Output rows differ from rows examined; planner costs omit client transmission/serialization | Measure examined work and bytes independently; returned `rowCount`, LIMIT and estimated width cannot certify physical cost |
| [DBOS installed-version source](https://github.com/dbos-inc/dbos-transact-ts/blob/627990fc59619d3584ce88511ab546bc7483f4b9/src/system_database.ts), `627990fc59619d3584ce88511ab546bc7483f4b9`, MIT (`LICENSE`) | Local `.reference/native-scheduler-funded-design/dbos-transact-ts/src/system_database.ts:2702-2740` deletes workflow input/output/operation outputs/status transactionally; `:3088-3122` copies checkpoint output during fork. `src/client.ts:644-655` exposes supported deletion | Removing a status row is insufficient payload cleanup; forked checkpoints are separate copies. Use Accounts' exact locators/receiving protocol and supported DBOS methods, after native obligations settle |
| [Official DBOS steps documentation](https://docs.dbos.dev/typescript/tutorials/step-tutorial), documentation consulted without copying implementation | Recovery resumes completed checkpoints; configured step retries and timeouts are independent of the native Commerce transaction | Keep native account/revision/receipt fences and measure actual DBOS work; a workflow result alone certifies neither atomic fulfilment nor erasure |

The shared pattern is that logical identity, durable progress and physical payload/work are separate observations.
For REZICS's Bun/TypeScript, PostgreSQL, DBOS and official Stripe SDK stack, the manager can adopt a two-part next
campaign: first run original native outcomes with real Accounts fixtures; then retain full three-scale physical
observations for the exact admitted operations, including failures and repeats. Keep financial schedule/custody
unknowns explicit and reuse Accounts' native participant/coverage/retention interfaces. These are recommendations
for owner adoption, not imported code, a changed financial contract or a new completion claim.

The sole write outside the declared report path is the permitted shared `.reference/INDEX.md` update, registering
these two primary-source reuses. No product source, package manifest, lockfile, frozen outcome or generated binding
changed. Original acceptance and all runtime/physical measurements remain deferred to integration.
