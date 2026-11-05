# Critical-path attempts: Source coverage and creator sales

The repeated failures have different causes. The Source producer has repeatedly delivered more retained machinery
without closing its positive repair-to-ACK-to-serving path. Creator sales has been repeatedly relaunched against
unchanged infrastructure or landing failures, with two intervening contract corrections. Another implementation
retry is not the remedy for creator sales' current generated-declaration refusal.

This is an evidence review, not an adoption or a native feasibility certificate. The database snapshot is
**2026-11-01 07:46:26 UTC**, through worker event 22108. Source attempt 6 was running; creator-sales attempt 18 had
returned source success and was in landing. Scoped search was ready by this snapshot, following an explicit
parallel-implementation amendment. None of these lifecycle states establishes installed, positively verified code.

## Evidence and limits

The investigation read the controller database through SQLite `mode=ro`, the saved brief variants, every available
run, each completed attempt's evidence files, and both recorded creator-sales landing logs. It also read the
repository architecture, owner contracts and relevant source at the retained commits. It did not run the investigated
implementations, their generators or their checks, and changed no operational state.

Evidence labels below resolve without putting live task identifiers in this document:

| Label      | Controller record or primary source                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S          | Task whose current brief title is `Complete native Source, mixed repair and bounded default coverage`; stored manager/Goal is Search, with Semantic design authority. |
| C          | Task whose current brief title is `Complete creator sales and native live-copy receiving together`; manager/Goal is Commerce.                                         |
| S*n*, C*n* | `worker_attempts` for that task and attempt _n_: JSON `logPath`, `evidencePath`, times, result and failure fields.                                                    |
| Run        | `.temp/goal/runs/<resolved-task-key>/<n>.jsonl`; line references are one-based JSONL records.                                                                         |
| Evidence   | `.temp/goal/evidence/<resolved-task-key>/<n>/{contract.md,diff.patch,failure.json,approaches.json}`.                                                                  |
| Brief      | `.temp/goal/briefs/<resolved-task-key>*.md`; use the attempt's saved `contract.md` for historical attribution, not the latest queued brief.                           |
| Database   | Main checkout's `.temp/goal/goal.sqlite`: `worker_tasks`, `worker_attempts`, `worker_events`, `landing_queue`, and `flow_events`.                                     |
| L1, L2     | Main checkout's `.temp/goal/landing-4193.log` and `.temp/goal/landing-4879.log`, respectively; both read in full.                                                     |

All `.temp/goal/` paths in this report refer to the main checkout's controller state, not this report's worktree.
To recover the exact private paths, select `worker_tasks.body` by the two titles above, then join its `id` to
`worker_attempts.task_id` and `worker_events.task_id`. For example, the title predicate can be
`json_extract(body,'$.brief.markdown') LIKE '%# Complete native Source, mixed repair and bounded default coverage%'`.
Read the returned attempt's `logPath` and `evidencePath` literally. No recursive search of other worktrees is needed.

Important limits:

- S6 had no terminal result or completed evidence directory. C12 had no evidence directory, exit code or worker
  result; its two-line run contains only thread/turn start. Neither absence supplies an inferred test failure.
- `failure.json` manifests mechanically label a “first failing command” even when the worker stopped for unfinished
  implementation or a static conflict. C18's manifest even embeds its success result under failure prose while its
  `failure` is null. Actual command exits, worker results and landing outcomes take precedence over that label.
- The request's 06:00–08:00 UTC zero-output window extends beyond this snapshot. For 06:00–07:46:26, `flow_events`
  records two integration events for the same control-plane model/effort-boundary change and no product integration.
  This supports no recorded product integration in that interval, not a measured whole-product journey ledger or a
  claim about the remaining minutes to 08:00.
- These are all 6 Source and 18 creator-sales attempts present for the named tasks. Older attempts mentioned inside
  inherited briefs belong to predecessor work and are not silently counted again.

## Every Source attempt

Times are UTC. End times below are worker-attempt endings, not integration or native-proof times. “Other” means
unfinished assigned implementation where no contradictory specification or terminal tool failure was established.

| Attempt | Start → end                      | What happened and why it ended                                                                                                                                                                                                                                                                                                                                                             | Classification and evidence                                                                                                                       |
| ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Oct 31 23:12:32 → 23:24:47       | Retained source at `5232f28af8`; kernel typing exited 0. Stopped on a source-level counterexample: 65 invisible pending-index entries could exceed a contract charging engine MVCC visibility against 64 examined rows. Account maintenance, page root and default regression were also incomplete.                                                                                        | **Unclear/changing brief:** cost-model conflict, not a measured native failure. S1 result/evidence; run line 67; worker event 21793.              |
| 2       | Oct 31 23:46:16 → Nov 1 01:04:09 | After the architecture correction, added Account writer maintenance, native enrollment, repair provenance and a default regression through `2402a31cc6`. Intermediate compiler errors were repaired; final typing exited 0. Population observations still returned `metadata_missing`; baseline/window seals, Account repair, contiguous ACK and the shared page root remained unfinished. | **Other: incomplete implementation.** S2 result/diff; final compiler at run line 546; event 21885.                                                |
| 3       | Nov 1 04:13:34 → 05:06:49        | Added original enrollment receipts, immutable baseline chains, independent late-baseline obligations and resumable preparation through `7d267fb3b5`. Final typing exited 0. Creation/change closure, mixed repair and ACK were still incomplete; all-home Account sweeps and repeated coverage probes remained.                                                                            | **Other: incomplete implementation.** S3 result/diff; run line 537; event 22022.                                                                  |
| 4       | Nov 1 05:24:06 → 06:05:56        | Added Account repair inputs, independently routed claim epochs, retained writer effects and receipt verification through `d6208efb3c`. Fixed migration timestamp/rollback and SQL binding errors; final typing exited 0. Terminal window verification, actual ACK, population observation and the page root remained unfinished.                                                           | **Other: incomplete implementation.** S4 result/diff; run line 469; event 22052. Earlier compiler failures were repaired, not the terminal cause. |
| 5       | Nov 1 06:13:06 → 06:47:24        | Added native creation-retention pins, original-window/event replay and mixed repair resumption through `d5cba050b1`. Recovered a check-host transport failure and obtained final compiler exit 0. Still explicitly missing terminal sealing, verified complete successor, original Source verification/contiguous ACK, bounded serving and retirement.                                     | **Other: incomplete implementation.** S5 result/diff; run line 319; event 22068.                                                                  |
| 6       | Nov 1 06:51:43 → open            | Run records retained repair-chain/checkpoint work, controls and accounting through observed commit `cc8c3946b3`. Compiler exit 0 is recorded at line 350. Its messages still describe unfinished ACK, population observations and page-root bodies.                                                                                                                                        | **Open, not a lost or completed attempt.** S6 run; event 22071. Do not infer a terminal outcome from a compiler pass.                             |

S2–S5 explicitly report unfinished work, not four newly discovered specification contradictions. Each retained useful
source. Their evidence patches grew from 66 files / 5,515 added lines at S2 to 83 files / 7,127 added lines at S5;
these are cumulative patch counts, not delivered outcomes or disjoint productivity totals. S3 and S4 each built
real prerequisites while repeatedly leaving the same serving/ACK closure open.

The cost-model issue was substantively resolved before S2: the saved S2 contract and
[architecture](../architecture.md) exclude the database engine's internal multiversion visibility work from
application row budgets. They still forbid application-level all-home scans. The invisible-entry counterexample
is therefore historical evidence of the earlier brief conflict, not a current reason to stop.

## Every creator-sales attempt

| Attempt | Start → end                | What happened and why it ended                                                                                                                                                                                                                                                                                                                                               | Classification and evidence                                                                                                                                               |
| ------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Oct 30 21:10:46 → 21:37:18 | Added the private route/DTO, source admission, projection, recovery and erasure work through `b21cde571a`; kernel/client typing eventually passed. The permitted live receiver remained unavailable. Landing later rejected `packages/client/src/kernel/commerce/creator-sales.d.ts` after regeneration.                                                                     | **Landing conflict/control-plane refusal**, not failed product verification. C1 result; kernel/client run lines 238/248; event 16045; L1.                                 |
| 2       | Oct 31 22:35:45 → 22:39:39 | Preserved/composed source at `bc0682c6aa` / `24282bf570`, including native creator-home fencing. Client typing passed. Kernel compiler preparation exited 70 because downloaded Bun did not match the pinned package-manager version.                                                                                                                                        | **Environment/control-plane failure.** C2 run lines 85/88; evidence; event 21643.                                                                                         |
| 3       | Oct 31 22:42:13 → 22:43:56 | Committed `8ca007e4c4`, allowing missing-provenance generations to remain pending while later locators progress. Reused the recorded Bun failure because current instructions prohibited rerunning it.                                                                                                                                                                       | **Environment/control-plane failure**, with useful source work. C3 result/run; event 21655 `stale-tool-blocker-retry`.                                                    |
| 4       | Oct 31 22:43:58 → 22:44:31 | Confirmed clean `8ca007e4c4`; no new source or check. Returned the same recorded Bun mismatch and no-rerun constraint.                                                                                                                                                                                                                                                       | **Environment/control-plane repetition.** C4 run/result; event 21660.                                                                                                     |
| 5       | Oct 31 22:44:43 → 22:45:05 | No new changes/checks; same compiler-preparation evidence and prohibition.                                                                                                                                                                                                                                                                                                   | **Environment/control-plane repetition.** C5 run/result; event 21662 `stale-tool-blocker-retry`.                                                                          |
| 6       | Oct 31 22:45:06 → 22:45:32 | No new changes/checks; same recorded exit 70.                                                                                                                                                                                                                                                                                                                                | **Environment/control-plane repetition.** C6 run/result; event 21666.                                                                                                     |
| 7       | Oct 31 22:45:43 → 22:47:00 | No new changes/checks; same recorded exit 70.                                                                                                                                                                                                                                                                                                                                | **Environment/control-plane repetition.** C7 run/result; event 21673 `stale-tool-blocker-retry`.                                                                          |
| 8       | Oct 31 22:47:01 → 22:47:11 | No new changes/checks; final no-rerun policy explicitly took precedence over retry instructions.                                                                                                                                                                                                                                                                             | **Environment/control-plane repetition.** C8 run/result; event 21675.                                                                                                     |
| 9       | Oct 31 22:47:23 → 22:47:33 | No new changes/checks; same instruction conflict and old compiler evidence.                                                                                                                                                                                                                                                                                                  | **Environment/control-plane repetition.** C9 run/result; event 21677 `stale-tool-blocker-retry`.                                                                          |
| 10      | Oct 31 22:47:35 → 22:47:47 | No new changes/checks; same instruction conflict and old compiler evidence.                                                                                                                                                                                                                                                                                                  | **Environment/control-plane repetition.** C10 run/result; event 21679.                                                                                                    |
| 11      | Oct 31 22:47:59 → 22:48:14 | No new changes/checks; same instruction conflict and old compiler evidence.                                                                                                                                                                                                                                                                                                  | **Environment/control-plane repetition.** C11 run/result; event 21682 `stale-tool-blocker-retry`.                                                                         |
| 12      | Oct 31 22:48:15 → 22:48:19 | Controller recorded `stopped`; run contains only thread and turn start, with no result, command or evidence directory.                                                                                                                                                                                                                                                       | **Other: stopped before observable work.** Event 21684 and C12 record. The record does not establish who stopped it or why.                                               |
| 13      | Nov 1 04:13:35 → 04:15:04  | Recorded unresolved live-copy authority in `446dc53bf1`. The brief said Accounts had no callable live-copy producer and required a native-contract selection; existing erased-artifact receipts could not authorize a live foreign business-row write.                                                                                                                       | **Dependency not available; design gap.** C13 contract/result; event 21978. This was a real missing authority, not an owner-review-only wait.                             |
| 14      | Nov 1 05:11:06 → 07:07:35  | The replacement contract assigned the complete source-hold/receiver-gate body, Commerce and Library wiring, recovery and erasure. Implemented through `6f93052d7f`; final kernel typing passed. Stopped because frozen creator-sales fixtures still positively wrote without holds/gates and changed active epochs without the newly required admission. Tests were not run. | **Unclear/changing brief:** selected safety contract versus frozen fixture setup. C14 run line 994, evidence; event 22081. Static conflict, not an executed test failure. |
| 15      | Nov 1 07:09:45 → 07:23:53  | Explicit owner amendment allowed fixture adaptation; added native receiving fixtures and truthful fenced-home recovery at `3672a86829`. Kernel typing exited 0. Landing again rejected the same generated declaration after normal derived output/formatting.                                                                                                                | **Landing conflict/control-plane refusal.** C15 run lines 146/162; event 22092; L2. Consultation additionally failed with `E2BIG: argument list too long` at event 22093. |
| 16      | Nov 1 07:33:20 → 07:36:01  | Read the recorded landing refusal; preserved `3672a86829`. No new source/check. Contract prohibited generated-file edits or bypassing the refusal.                                                                                                                                                                                                                           | **Environment/control-plane repetition of landing failure.** C16 run/result; event 22099.                                                                                 |
| 17      | Nov 1 07:36:03 → 07:39:59  | Same head and recorded typing result; no new source/check. Returned the unchanged generated-output reconciliation requirement.                                                                                                                                                                                                                                               | **Environment/control-plane repetition of landing failure.** C17 run/result; event 22101 `stale-tool-blocker-retry`.                                                      |
| 18      | Nov 1 07:40:00 → 07:41:08  | Returned source success for unchanged `3672a86829`, explicitly separating it from controller preparation and native/privacy/whole-feature proof. A new landing request exists; its outcome was null at the snapshot.                                                                                                                                                         | **Source handoff, not another failed implementation and not installed delivery.** C18 result/run; event 22104; `landing_queue` row 4882.                                  |

C2–C11 are ten attempt records around one observed compiler-preparation failure, not ten newly executed broken
compilers. C4–C11 contain no new implementation or check. The stopped C12 is separate. Similarly, C16–C18 did not
repair source between the repeated landing refusal and the eventual source handoff.

L1 and L2 both end with `Change had no effect on dev: packages/client/src/kernel/commerce/creator-sales.d.ts`.
They show dependency installation, controller-derived generation and formatting before that refusal, with no
subsequent compiler invocation. The generic retry manifest's typecheck label does not change the failing stage.
The later landing spent 555,474 ms of recorded host time before returning that preparation outcome; this is not
evidence of a 555-second product test failure.

## The repetition classes and prevention

| Repeating class                                            | What the records support                                                                                                                                                                                                                                                           | What would have stopped recurrence                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source's large prerequisite chain without positive closure | S2–S5 finish typing while naming the same still-missing ACK/population/root outcomes. Briefs carry roughly 58–64 thousand characters; the latest estimates 11,000 lines / 85 files. These observations support a task-shaping problem; they do not prove a model capability limit. | Keep one integrating Source owner, but make the next concrete body and its finite exit explicit. Review positive default-path closure between substantive continuations; remove inherited contradictory instructions. Do not accept a larger prerequisite diff or a compiler pass as closure.          |
| Stale-tool retry versus a no-rerun instruction             | Repeated `stale-tool-blocker-retry` events launch workers that return the exact recorded Bun error while forbidden to re-execute it. C4–C11 make no change. C16–C17 repeat the same pattern around generated-output ownership.                                                     | Route the exact failure to its infrastructure/controller owner and suppress unchanged worker relaunches until that cause or launch authority changes. Compare failure fingerprint, committed source and launch policy before dispatch. A larger retry allowance does not repair this loop.             |
| Generated output treated as lost authored source           | L1 and L2 reject the identical generated path despite meaningful handwritten changes. The control-plane throughput brief also names this exact classification defect and the shared generated-file classification seam.                                                            | Controller reconciles derived artifacts on its real candidate, preserving authored-change attribution, frozen/integrity checks and whole-tree no-effect detection. A regenerated declaration equal to dev must not by itself discard meaningful source. Do not ask the product worker to hand-edit it. |
| Missing cross-home safety design discovered after dispatch | C13's saved brief explicitly has no live-copy producer. C14 replaces the narrow read assignment with the actual native source-hold/terminal-gate implementation.                                                                                                                   | Consumer-first preflight must trace the first positive default delivery through source release, receiver commit and deletion. Select and assign the missing ordinary producer with its consumer before promising the view. An unavailable adapter is honest, but does not complete the journey.        |
| Frozen fixture setup not reconciled with a new guard       | C14 cannot preserve both direct positive unguarded writes and mandatory hold/gate admission. C15 requires an explicit owner amendment to adapt setup.                                                                                                                              | Before dispatch, the acceptance owner reconciles the fixture with the newly adopted guard while preserving its privacy, cursor, lifecycle and replay assertions. Implementation workers must not weaken frozen tests to escape a conflict.                                                             |
| Bloated/duplicated operating input                         | C15's consultation launch returns `E2BIG`; repeated briefs retain large historical bodies and several supersession layers.                                                                                                                                                         | Pass consultation input by a supported bounded transport; keep the current brief concise and link historical evidence. The error proves argument-size failure, not the exact contributing field or a model failure.                                                                                    |

There is no evidenced repeated terminal native-verification-failure class here. Intermediate migration, SQL and
TypeScript errors were real, then fixed within their attempts. S5's transport failure was recovered. Check-slot
waiting inside a live compiler command is queue time, not evidence that the worker was stuck. The main current
losses are incomplete implementation closure and control-plane relaunch/landing behavior.

These repairs align with [delivery preflight](../development/delivery.md#brief-preflight) and the existing
[third-attempt incident rule](../development/efficiency.md#operating-discipline). This report neither changes those
rules nor claims their repairs have been implemented or verified in a later hour.

## Design judgement

### Source: retain one maintained index and finish its caller

[Architecture](../architecture.md) calls for one authority, bounded neighbourhoods, ordinary indexed SQL and
bounded resumable preparation. The selected Source design fits that shape: native writer-local pending obligations,
asynchronous bounded reverse enrollment, original registration-local summaries, immutable covered/start cuts,
and a contiguous ACK backed by actual Source and Search repair. It avoids synchronous per-definition fanout and
putting a 4,096-home sweep in each query.

That complexity addresses real requirements in [filtered lists](../filtered-lists.md#cost): exact negatives,
current reductions, original/terminal authority, retained cuts and mixed Account/Subject currentness. An ACK that
clears pending while erasing evidence of a change after the old cut would be incorrect. So would simply deleting
Account validation. The baseline across all logical homes belongs in resumable preparation, not request-time scans.

The selected one-page coverage root is a simplification of repeated checks, not an optional second engine. The
Search delegation identifies start/final checks per refill, `readStatus` plus direct Source final in disclosure,
and repeated status checks in public finalization. One real root must retain every child execution and perform the
final observation after disclosure work. It cannot merely skip checks or reset accounting per refill.

The implementation is **unfinished and operationally over-expanded**, rather than demonstrated to require a new
architecture. At this report's base, `public-filter-source.ts` still contains unavailable projection/population
bodies and `public-filter-source-binding.ts:validateAccounts` iterates 4,096 homes in batches of 100. At retained
`d5cba050b1`, population serving still refuses without completed native metadata and the all-home validator remains.
Those are concrete missing closures, not reasons to add another Source, receipt authority or generalized platform.

Cut from the critical implementation:

- Superseded MVCC-meter requirements, active-XID/visibility primitives and global-barrier proposals. The current
  architecture already excludes engine-internal visibility maintenance from product budgets.
- Historical full briefs and repeated recovery instructions from the active input; retain their immutable evidence
  by link. Put adopted behavior in owner contracts rather than an accumulating launch narrative.
- Additional grammar, picker, question-Context and UI work from the Source owner. Keep the existing public ABI;
  these consumers can implement against it concurrently.
- Repeated per-round coverage probes and Account-head sweeps, **only as** their complete maintained-summary/root
  replacement becomes operative. Preserve per-hit original/terminal/current authority checks and exact budgets.

Do not cut original baseline/window proof, delayed-writer safety, actual contiguous ACK, complete child closure,
unknown-state refusal or bounded retirement. No recorded native run proves the selected whole design's final cost
or concurrency behavior; the recommendation is to finish its selected minimal mechanisms, not certify them.

### Creator sales: the read is small; safe foreign delivery is the real body

The [Commerce owner contract](../../services/kernel/src/commerce/README.md#private-creator-sales-history) specifies
a small private own-account history: `GET /v1/commerceSales`, `commerce_sale:list`, default 20 / maximum 100,
captured monetary terms, historical settlement, signed viewer/operation/query/home-epoch keysets and
`projectionState:'ready'|'preparing'`. It deliberately excludes buyer identity, usage telemetry, payout availability,
cross-currency totals and current entitlement claims. Keep this interface; no richer accounting system is needed.

The foreign creator-home write is not made safe by creator-local authorization after releasing the buyer home.
The C13 owner decision explains why erased-artifact receiving receipts do not supply live-copy authority. The C14
selected design instead uses durable holds on the relevant personal-role accounts until the exact receiver effect
has an immutable applied/cancelled result, followed by exact hold consumption. Deletion sees unresolved native
holds; delayed replay encounters the terminal receiver gate. This extends the existing Access lifecycle pattern
using ordinary single-home transactions rather than inventing a privileged principal or cross-partition write.

The shape is justified by the chosen deletion/non-revival contract. The evidence does **not** establish mathematical
minimality of every table or prove the implementation's races. At `3672a86829`, actual
`access/live-copy.ts` exposes staging, role admission, native admission observation, receiver gate, terminal result
and consumption bodies; Commerce and Collection-to-Subject listing use that mechanism. These are committed source,
not native runtime proof. The report base still lacks the creator-sales module/generated binding, consistent with
the owner's explicit unavailable frontend adapter.

Cut new product expansion and repeated worker recovery, not the native safety mechanism:

- No payout/refund-finality dashboard, buyer selector, new permission engine, UI redesign or second Commerce projection.
- No parallel live-copy coordinator, generic proof registry or reuse of erased-artifact authority for living rows.
- Keep unrelated Library expected-effects/current-seal work and final Auth/History retirement out of the sales
  delivery closure claim. They have distinct producers and still-missing proofs. Preserve the Library live-copy
  integration already required by this assignment; do not remove it to manufacture completion.
- Preserve the exact generated-declaration refusal for controller reconciliation. Source worker retries cannot fix
  a controller-owned candidate-preparation rule they are prohibited from editing or bypassing.

## Concrete finish plan

These are proposed changes for the managers to adopt; this research attempt did not dispatch or steer workers.

1. **Close the controller cause independently of product code.** Preserve the creator-sales source at
   `3672a86829` and the two original landing outcomes. Have the existing control-plane owner reconcile regenerated
   declarations using the shared generated-file classification. Its focused real-Git regression should cover
   meaningful authored changes plus a declaration that normal generation makes equal to dev, while still refusing
   genuinely lost authored changes and a genuinely ineffective whole candidate. Do not relaunch Commerce unchanged
   to investigate the same refusal. C18's pending landing request is not evidence that reconciliation has happened.

2. **Let the current Source attempt reach its real result.** Do not start a duplicate producer or verifier over
   the same bodies. If a substantive continuation is needed, replace the active narrative with owner links, retained
   head, exact unfinished functions and the two ordered outcome checkpoints below. Preserve the current ABI and
   authority/budget assertions. Current execution allows changed-workspace typing; original native proof stays a
   distinct later obligation.

3. **First Source checkpoint: one complete native repair and genuine ACK.** Finish `repairNative` terminal
   creation/change-window sealing, `readRepairStep`'s independently verified complete successor, and `settle`'s
   original Source verification plus actual Search settlement/contiguous ACK. Cover Subject, Account and independently
   routed claim tuples, empty/late home enrollment and p+1 arriving after a captured interval. Reuse retained pages,
   receipts and preparation jobs. Native Source receipt verification must not depend cyclically on the Search
   settlement that consumes it. The authorable oracle is: complete real repair permits only its captured prefix;
   newer work and old changed cuts remain blocked. A new receipt brand or terminal boolean is not this outcome.

4. **Second Source checkpoint: one useful default page.** Replace all-home Account validation with the maintained
   indexed population observation, then thread the same actual coverage root through capture/resume, refills,
   own-row/current disclosure and finalization. Count the fixed metadata and all dispatched/failed work inside the
   existing two-observation / `64 + 2*(behind + changed homes)` allowance and whole-page limits. Complete close/retire
   recovery with retained obligations. The default-composition regression must exercise the installed factory and
   three readers, not an injected ready adapter. Source success requires both checkpoints; do not declare the first
   an independently delivered public Source or move the remainder to an unnamed prerequisite.

5. **Deliver creator sales' existing source, then bind the actual consumer.** Retain the owner-authorized C15
   fixtures and production guards. Controller preparation/generation must expose the actual operation and generated
   client. Commerce/Web can prepare the existing BFF adapter replacement, operation registration and matching
   `commerce_sale:list` consent configuration now against the closed interface. Enable the supported binding only
   when it is really installed; unmounted scopes still refuse. Keep current preparing/empty/denied distinctions.
   Do not restart implementation merely because native proof remains deferred.

6. **Keep the deferred proof obligations explicit.** Later combined verification must demonstrate actual default
   sale delivery/private creator read, duplicate/delayed/cancel/crash replay, same-route other-creator isolation,
   deletion before/after hold/gate commits, source epoch/incarnation/restore handling and bounded recovery. Source
   additionally needs its original concurrent reduction/repair/ACK/cut, all-home enrollment, default-page privacy
   and cost controls. Existing frozen acceptance is retained; the report does not waive or execute it. Typing and
   authored regressions cannot substitute for native, interface or promoted-revision evidence.

For task shaping, retain **one** Source implementation/integration owner and **one** shared live-copy implementation;
split independent consumers and controller repair, not interface-only producer tasks. The already-held Source
verifier overlaps the Source functions above and should not become a concurrent second implementation.

All recorded investigated attempts use `gpt-6.1-sol/high`. There is no comparative model experiment here. Keep that
profile for creator-sales integration work; its current obstacle is controller behavior. If Source needs a further
substantive continuation, a concise fresh context at `gpt-6.1-sol/xhigh` for the exact ACK/root closure is a reasonable
manager experiment, not an evidence-backed speed claim. Record whether it closes the named outcomes. Do not spend
another model turn merely restating an unchanged tool blocker, and do not interrupt S6 to change its effort.

## Parallel work and genuine dependencies

“Proceed” below means implement complete owned source against an agreed literal interface. It does not mean fake a
ready producer, remove final currentness checks, or claim a positive integrated journey from a dependency's lifecycle
state. Installed capability requires an actual `sourcePresence: "present"` / `precondition: "satisfied"` receipt;
this investigation did not obtain such fresh receipts for the dependent launches.

| Work                                            | What can proceed concurrently                                                                                                                                                                                                                                                                                     | What really must wait for a producer or combined proof                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped search and header journey                | Shared parser/resource operands, Collection/Library/Realm/Zone/Agent route/header/BFF wiring, current eligibility and cancellation against the unchanged Source factory and existing default discovery. The current scoped-search brief explicitly permits this now; its lifecycle was **ready** at the snapshot. | Useful native scoped results require actual Source readers, population/repair/ACK/root closure and current resource witnesses. A readable scope label is not membership authority.                                                                                                                                                                                                 |
| Content mixed feed                              | Preserve delivered kind selection and independent ready Continue/Following/discovery states. Implement owned Space/carrier and review-question candidate witnesses, choices, cursor/reset semantics and feed admission against agreed scoped interfaces.                                                          | Space results need the real current carried Realm/Zone and scoped Source. Question Context needs live readable review/opening-citation witnesses and actual choice admission; its future literal is not an installed API. The held review-Context brief still lists scoped search as an edge: manager must adopt any parallel scheduling change rather than assume it disappeared. |
| Web Home                                        | Existing single renderer, Kind+Space controls, current choice loading, locale/phone/keyboard behavior, request cancellation and stale-response retirement can be prepared with the settled consumer seams. Current scoped brief explicitly records concurrent Home preparation.                                   | Native positive Space/Context membership and final browser/native evidence need the actual producers. No browser-side filtering, Space-to-Realm ID cast, placeholder directory or duplicate Home feed. Preserve existing usable lanes when another source is preparing.                                                                                                            |
| Creator sales page/BFF                          | Replace the known unavailable port with code consuming the agreed DTO/generated route, preserving private no-store credentials, genuine empty versus preparing and existing money display. Prepare consent/registration changes. The page already exists.                                                         | Enablement depends on the real mounted operation, generated binding and native default delivery; do not register an unmounted scope or infer buyer access/royalties from settlement.                                                                                                                                                                                               |
| Source repair verifier successor                | Review exact original receipt/read/verify signatures and authored cases against the current Source ABI.                                                                                                                                                                                                           | Its held brief targets the same `public-filter-source-binding.ts` repair/settle bodies now assigned to S. Resolve ownership sequentially; do not dispatch overlapping implementations or fabricate complete-window custody.                                                                                                                                                        |
| Semantic Library-verifier composition           | Calculate the exact SQL footprint and per-axis nested work from actual committed producer bodies; prepare the bounded owner integration and unknown-SQL refusal.                                                                                                                                                  | Its actual dependencies are the separate Library expected-effects/frontier/seal producer and durable original identity-Source authority, both recorded stopped. Creator-sales success alone supplies neither. Final receiving/fence accounting must use their actual bodies.                                                                                                       |
| Accounts Auth-dependent witness retirement      | Implement/review independent native predicates, current-proof plumbing and authored negative/refusal cases where the agreed producer ABI suffices. Preserve old witnesses while authority is unknown.                                                                                                             | Actual destructive retirement needs current Auth receiving closure/restore incarnation held through the destructive commit, plus each witness's real dependencies. Its held brief names a **different stopped Auth receiving producer**; it is not directly held on either investigated task. Historical `copies-erased` alone is explicitly insufficient.                         |
| Account deletion across Commerce/Library copies | Prepare consumer integration, inventory and bounded cleanup against the selected hold/gate result interfaces.                                                                                                                                                                                                     | Positive foreign personal-copy writes and terminal deletion need genuine native holds, receiver terminal results and exact consumption. Root/History/physical-copy closure and the independent Library seal remain separate; no blanket Accounts-retirement ACK follows from the sales row.                                                                                        |
| Other Content native-proof queue                | These held suites cover Realm lifecycle, media, moderation, notifications, ratings and retention with their own declared dependency chain. Plan/scoped source work independently.                                                                                                                                 | The inspected database does not put their direct edges on these two tasks. Do not attribute their whole queue to Source or creator sales without tracing each real prerequisite; proof execution also remains governed by current execution policy.                                                                                                                                |

The critical distinction is **implementation parallelism versus positive runtime dependence**. The scoped-search
amendment already makes that distinction explicitly; its dispatch state changed from held to ready during the
investigation. This report did not cause that transition. Content's review-question feed, Source retirement,
Library custody and Auth witness destruction still need their own exact native authorities. A single broad
“waiting on the two tasks” label obscures those different dependencies.

## Primary-source references

Repository sources are licensed under [GNU AGPL version 3](../../LICENSE); links below identify the current owner
contracts. Retained source observations use `git show <commit>:<path>` from this worktree, not another worker's
mutable checkout. Private controller artifacts are operational evidence with no separate redistribution grant
established here; this report paraphrases them and publishes no credentials or allowance data.

- [Architecture](../architecture.md), [filtered lists](../filtered-lists.md), [feeds](../feeds.md),
  [mixed Home delivery](../goals/web.md#mixed-home-delivery), [Accounts](../accounts.md),
  [Commerce](../../services/kernel/src/commerce/README.md#private-creator-sales-history) and
  [delivery efficiency](../development/efficiency.md) own the durable requirements used in the judgement.
- Source API/binding: `services/kernel/src/semantic/public-filter-source-contract.ts`,
  `public-filter-source-binding.ts`, `public-filter-source.ts`; Search's
  `public-filter-consumer.ts`, `public-filter-custody.ts`, `disclosure/discovery.ts`, `public-runtime.ts` and
  `service.ts`. Compare report base `1b6aeac855` with retained `d5cba050b1` and the S6 run's observed commits.
- Selected Source authority, read in main controller state:
  `.temp/goal/semantic/public-filter-cut-maintenance-design-20261101.md`,
  `.temp/goal/semantic/public-filter-account-maintenance-addendum-20261101.md`,
  `.temp/goal/semantic/source-repair-ack-disposition-20261101.md`,
  `.temp/goal/accounts/search-new-slices-owner-delegation-20261101.md` and
  `.temp/goal/search/source-cut-ack-maintenance-delegation-20261101.md`.
- Creator-sales source: at `6f93052d7f`, `services/kernel/test/commerce/creator-sales.test.ts` lines 137–148,
  185–195 and 381–386 establish the old fixture setup. At `3672a86829`, inspect
  `services/kernel/src/access/live-copy.ts`, `live-copy-work.ts`, `live-copy-erasure.ts`,
  `services/kernel/src/commerce/creator-sales*.ts` and `services/kernel/src/library/listing.ts` with C15's patch.
  These source reads support the design description, not a claim that the guards have passed native tests.
- PostgreSQL's own pinned source explains the historical visibility issue:
  [`indexam.c`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/access/index/indexam.c#L656),
  [`nodeIndexonlyscan.c`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/executor/nodeIndexonlyscan.c#L125)
  and [`nodeLimit.c`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/executor/nodeLimit.c#L32).
  Index iteration can skip entries lacking a snapshot-visible heap tuple; LIMIT operates on returned subplan tuples.
  This explains the original counterexample but does not overturn REZICS's subsequently adopted cost definition.
  Licence: [PostgreSQL License / COPYRIGHT](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/COPYRIGHT).
  Reused main `.reference/library-shelf-maintenance/postgres` via read-only `git show` at
  `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89`; its existing `public-filter-native-cut-current` INDEX entry records
  that revision/licence. No clone, install, build, execution or reference-index mutation was needed.

Across these sources, the recurring useful pattern is the same: retain one original authority, make bounded progress
from original native records, keep unproved state explicit, and connect the actual default caller to the producer.
The recommendation is to finish those two concrete paths while letting independent consumers proceed, and repair
the controller classes that repeatedly spend attempts without changing either source or the failing precondition.
