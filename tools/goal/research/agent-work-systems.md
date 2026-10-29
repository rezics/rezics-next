# Agent work systems and useful delivery

Evidence collected on **2026-10-30**. The inspected main and worktree base were both
`89a0156bc6b170056fae10f5d3444250c6512b3d`. This is research evidence for the Goal product;
the [README](../README.md) and adopted contracts continue to own its operating protocol.
External designs below are recommendations to implement in Bun, TypeScript, SQLite and Git, not code to copy.

## Recommendation and measure

Keep the manager/worker hierarchy, durable state, deterministic landing and separate verification/promotion.
Improve **brief readiness, model-free waiting, check reuse and complete user journeys** before increasing worker width.
Factory's milestone validation is the closest product-level analogue; Google's bounded migration pipeline and
Meta's executable evidence are stronger templates for judging delivered work than agent conversation volume.
Cursor's scaling experiments are evidence against long agent-held coordination locks, but do not establish that
REZICS should remove its integration checks. These comparisons and the ranking below are **inferences**.

Measure `useful outcomes verified on main / allowance consumed`, by comparable task cohort and provider/window.
A useful outcome is an accepted behavior, with a reproducible journey or maintenance result, still present on main
after the agreed observation window. Count it once across retries, replacements and prerequisite tasks.
Record dev landings and main promotion separately. Do not equate lines, commits, task completions or benchmark solves
with useful delivery. Track check-host occupancy, queue age and human/manager review time as additional constraints.

Allowance percentage points from different accounts, providers and reset windows are not interchangeable currency.
Use each shared allowance key once; report input/cache/output tokens and dollars or credits separately where known.
Attribute manager, consultation, validation and unsuccessful work as well as the winning worker. Unknown spend stays
unknown. A dormant process can occupy resources without consuming model tokens; elapsed waiting is not a model bill.

## What REZICS already does

The following claims come from the pinned source, not an assumption that all advertised features are deployed:

| Stage                    | Existing implementation                                                                                                                                                                                                                                                                                                                        | Remaining opportunity inferred from the comparison                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan and size            | [briefs.ts](../src/briefs.ts) parses kinds, declared paths, estimates, dependencies and acceptance; [frozen.ts](../src/frozen.ts) protects acceptance inputs. [failures.ts](../src/failures.ts) uses a 2× estimate tolerance for scope classification.                                                                                         | Validate native contracts and one useful outcome before freezing a brief; line/file estimates alone do not establish readiness.                                                                                            |
| Dispatch and context     | [tasks.ts](../src/tasks.ts), [launch.ts](../src/launch.ts) and [worker-commands.ts](../src/worker-commands.ts) create isolated worker sessions and prompts; dependencies and durable retry intents survive driver loss. [allowance.ts](../src/allowance.ts) respects shared allowance keys, reserves, freshness and burn limits.               | Supply a compact, revision-specific context packet; avoid repeated native-contract discovery and speculative prerequisite chains.                                                                                          |
| Wait and recover         | [settle.ts](../src/settle.ts) awaits worker exit without a model. [managers.ts](../src/managers.ts) steers/resumes persisted sessions; Codex managers are instructed to sleep, other managers to use inbox wait. [watch-or-poll.ts](../src/watch-or-poll.ts) uses filesystem notifications with timer fallback.                                | Worker tool/check waits remain a distinct boundary; model-free controller waiting does not prove workers stop issuing repeated wait calls. Timer fallback outside the model is not the expensive polling under discussion. |
| Verify and integrate     | [merge-train.ts](../src/merge-train.ts) rebases isolated candidates, handles specified mechanical conflicts and derived outputs, checks acceptance, affected and sibling tests, distinguishes baseline failures, and updates refs with expected heads. [defaults.json](../defaults.json) enables dev landing checks and batches of up to four. | Preserve the checked revision and environment identity so identical checks can be reused safely; do not propose batching as though it were absent.                                                                         |
| Shared work              | [workspace.ts](../src/workspace.ts) and the README already support opt-in shared module worktrees, trailer attribution and combined-candidate checks.                                                                                                                                                                                          | Evaluate these separately from isolated workers. A shared branch's throughput does not establish independent task correctness or ownership.                                                                                |
| Recover failures         | [failures.ts](../src/failures.ts) and [job.ts](../src/job.ts) distinguish spec/scope, environment, pool, stalled, repeated assertion, consultation and fix-round outcomes. Repeated matching environment failures stop; retry intents and orphan recovery are durable.                                                                         | Improve causal evidence and retry budgets rather than inventing a new generic retry loop. Setup, timeout and nonzero worker exit can all classify as environment, so that label alone is not a root cause.                 |
| Verify after integration | [dev-verifier.ts](../src/dev-verifier.ts) checks a captured dev revision, advances dev-verified, retries infrastructure failures up to twice and attributes regressions. [promotion.ts](../src/promotion.ts) and [completion.ts](../src/completion.ts) separate promotion and completion evidence.                                             | Add a small number of cross-owner journey receipts to this existing structure; retain broad final checks.                                                                                                                  |
| Account                  | [records.ts](../src/records.ts), [usage.ts](../src/usage.ts), [flow.ts](../src/flow.ts) and [report.ts](../src/report.ts) record attempts, readings, phases and flow alarms.                                                                                                                                                                   | Validate phase coverage and deduplication before claiming exact savings; extend current telemetry rather than build a second dashboard/store.                                                                              |

### Baseline and its limits

The task supplied three operational observations: **75% of attempts failed or were superseded in an hour**,
**89–95% of running time waiting for check slots**, and **16% of model calls spent re-waiting**.
Treat those as the maintainer's supplied observations with their original scopes, not newly reproduced measurements.
The checked-in [delivery report](../reports/delivery-efficiency-20261029.md) does **not** establish those three exact
aggregate percentages. Its evidence cutoff is October 29 14:28:33 UTC; its whole-period and 48-hour cohorts differ
from an hourly snapshot. In particular, it explicitly leaves the complete check-slot phase split unidentifiable.
Its example of 2h24m waiting in 2h36m is consistent with a severe bottleneck, but is not an aggregate estimate.
This distinction resolves the contract's attribution ambiguity without discarding the supplied warning signals.

The report does establish 2,142 landed tasks, of which 1,057 recorded landing commits were on main; 2.21 attempts
per landing overall; 1.94 landings per observed allowance point in the recent 48 hours versus 2.43 overall;
818 environment outcomes overall and 599 overlapping the recent window; and 358 own-pass claims followed by
landing rejection. Its inferred allowance allocation assigns only 31.7% of recent observed spend to success.
Those figures motivate prevention and integration quality, while its missing provider/manager accounting prevents
an exact total waste bill. The report also identifies real user-journey composition gaps despite many landings.

## Comparison method

Each profile covers planning/sizing and context; waiting and recovery/retries; verification, integration/conflicts
and human decisions; then accounting and results. **Not documented** means not established by the cited material,
not that the product lacks the capability. Remote asynchronous execution, an in-process `await`, session persistence
and durable suspend/resume are different properties. None implies zero model calls during a slow check.
Historical papers evaluate their published configuration; current source snapshots are identified separately.
Vendor deployments and demos are first-party observations, not controlled comparisons with REZICS.

### OpenHands

- **Plan/context:** the SDK provides agents, conversations, workspaces and delegated tasks; it is not itself the
  entire scheduling product. Its README explicitly assigns scheduling/webhooks/run history to OpenHands automation.
  Task prompts and scoped tools specialize delegates; there is no universal issue-sizing rule in these files. [OH-S](https://github.com/OpenHands/software-agent-sdk/tree/641e161178cb934f38afcbe603125950611d1668)
- **Wait/recover:** file-backed events/state support reload; pause, stuck, budget and iteration stops are explicit.
  The inspected `TaskManager.start_task` runs a delegate synchronously, can resume its conversation, retains partial
  output on non-finished stops, and rolls delegate metrics into the parent. This is not evidence of a durable
  scheduler suspending every slow shell command. Repetition detection and API retry handling are separate. [OH-S](https://github.com/OpenHands/software-agent-sdk/tree/641e161178cb934f38afcbe603125950611d1668)
- **Verify/integrate/review:** sandboxed tools and evaluation harnesses execute code; confirmation policies can gate
  actions. A finished conversation is not a tested merge. Repository conflict resolution, post-merge checks and human
  merge policy require an application above this SDK; no default train policy is established here. [OH-S](https://github.com/OpenHands/software-agent-sdk/tree/641e161178cb934f38afcbe603125950611d1668), [OH-P](https://arxiv.org/html/2407.16741v3)
- **Cost/results:** the SDK records token/cost metrics and per-run budgets. The older platform paper reports CodeAct
  with Claude 3.5 Sonnet at **26.0% SWE-bench Lite**, **$1.10 average cost** in its 300-instance, no-hint table.
  That historical benchmark is neither the current SDK's delivery yield nor a multi-agent advantage claim. [OH-P](https://arxiv.org/html/2407.16741v3)

### SWE-agent

- **Plan/context:** one issue becomes a repository-level repair episode; templates supply the issue, demonstrations
  and tool observations. Its agent-computer interface limits noisy navigation/edit feedback. Multi-attempt search
  is configurable; this is not a many-worker product roadmap decomposer. [SW-S](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5), [SW-P](https://arxiv.org/html/2405.15793v3)
- **Wait/recover:** execution awaits environment commands with timeouts. Format, command, context, cost and runtime
  failures have distinct handling. `RetryAgent` resets the environment between attempts and reduces the next attempt's
  budget to what remains; reviewer/chooser policies bound attempts. No durable external check-queue resumption
  or automatic Git conflict policy is established by these components. [SW-S](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5)
- **Verify/integrate/review:** the worker can execute tests and submit a patch; benchmark evaluation supplies the
  external correctness oracle. Review/selection can choose among attempts, but submission is not a human-approved
  merge or a post-integration check. Those are responsibilities of its host workflow. [SW-S](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5), [SW-P](https://arxiv.org/html/2405.15793v3)
- **Cost/results:** model statistics and per-instance/total limits make unsuccessful search visible. Retry selection
  can incur additional review/choosing cost, so its attempt cap is not always an all-inclusive spend cap.
  The original GPT-4 Turbo experiment resolved **12.47% of 2,294 SWE-bench tasks**; this is historical single-issue
  evidence, not current production throughput. [SW-S](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5), [SW-P](https://arxiv.org/html/2405.15793v3)

### Devin

- **Plan/context:** official guidance recommends pre-scoping with Ask Devin, explicit success criteria, native
  examples, prepared environments and independent parallel sessions. Its rule of thumb is tasks within about three
  human hours, splitting longer work. Session Insights flags large sessions and repeated setup/assumption issues. [DV-G](https://docs.devin.ai/essential-guidelines/when-to-use-devin)
- **Wait/recover:** current usage documentation says waiting for replies/tests consumes only the small VM component;
  sleeping consumes no usage and a message wakes the session. Current default idle sleep is 30 minutes, five for
  Lite/API sessions with stated exceptions. This establishes sleep/wake behavior, not the internal test-await
  implementation. Insights classifies recurring problems; a universal automatic retry cap is not published there. [DV-U](https://docs.devin.ai/admin/billing/usage), [DV-G](https://docs.devin.ai/essential-guidelines/when-to-use-devin)
- **Verify/integrate/review:** Devin can exercise apps in a browser, produce PRs, and use review/Auto-Fix for CI and
  review feedback. Users inspect CI and approvals. These sources do not specify a universal merge-conflict algorithm
  or post-merge gate; repository policies still matter. [DV-G](https://docs.devin.ai/essential-guidelines/when-to-use-devin)
- **Cost/results:** enterprise ACUs and self-serve quota/credits meter work; actions and VM time contribute. Insights
  supports session-level comparison. Cognition's November 2025 report claims **67% PRs merged versus 34% previously**,
  4× faster problem solving and 2× resource efficiency. Cohort/task changes and vendor reporting prevent treating
  these as causal or portable REZICS gains. [DV-U](https://docs.devin.ai/admin/billing/usage), [DV-R](https://cognition.com/blog/devin-annual-performance-review-2025)

### Factory Missions

- **Plan/context:** assertions precede bounded features and milestones. A runner starts fresh workers with feature
  specs; shared artifacts retain research. Worker and validator models are configurable. [FA-A](https://factory.com/news/missions-architecture), [FA-D](https://docs.factory.com/missions/planning)
- **Wait/recover:** targeted fix features repeat validation; blocked missions return to the user. Command-level
  suspend/resume, transient retry budgets and conflict handling are not established. [FA-A](https://factory.com/news/missions-architecture)
- **Verify/integrate/review:** fresh scrutiny agents review implementations/trajectories; user-testing agents exercise
  combined milestone work against assertions. Human decisions occur during planning and blockage. Exact-merge-revision
  and post-deployment checking are not established. [FA-A](https://factory.com/news/missions-architecture), [FA-D](https://docs.factory.com/missions/planning)
- **Cost/results:** planning exposes cost/duration. A published Slack-clone mission took **16.5 hours**, **778.5M tokens**
  (744.9M cached reads); validation used **37.2% of runtime**, with **21 fix features** and 2–4 validation rounds per
  milestone. This is one example, not a transferable validator-spend target. [FA-A](https://factory.com/news/missions-architecture), [FA-D](https://docs.factory.com/missions/planning)

### GitHub Copilot coding agent / cloud agent

- **Plan/context:** issue/PR/repository context and custom instructions seed asynchronous work. The documentation now
  distinguishes Actions-based sessions from newer cloud sandboxes, including session continuity across clients.
  It does not publish a universal task-size threshold or a roadmap-level partitioning policy. [GH-A](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github)
- **Wait/recover:** a remote session continues independently of the user's client. Agent Merge watches selected PR
  blockers and starts work on failed Actions workflows or merge conflicts. This is an event-triggered repair surface;
  the internal wait loop, failure taxonomy and retry caps are not documented by these pages. [GH-A](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), [GH-M](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests)
- **Verify/integrate/review:** agents run tests/linters and offer review; users inspect changes and workflow outcomes
  before merge. Agent Merge preserves review and repository merge requirements. Actions approval behavior depends on
  configuration. These sources do not establish a general post-merge verification service. [GH-A](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), [GH-M](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests), [GH-R](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output)
- **Cost/results:** GitHub meters model/token usage in AI credits; automation sessions also bill Actions minutes
  separately. Older premium-request descriptions are not today's universal billing rule. Current surface docs report
  faster cloud-sandbox execution in initial testing without a numeric effect or comparable landed-work denominator.
  No measured useful-delivery/allowance improvement is established. [GH-A](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), [GH-B](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)

### OpenAI Codex cloud tasks

- **Plan/context:** official OpenAI documentation describes a published, reusable environment with prepared tools,
  repositories and access; each new task gets isolated working state. Existing tasks retain their own files while
  new tasks use republished setup. The cited cloud pages do not mandate a planner hierarchy or task-size limit. [CX-C](https://learn.chatgpt.com/docs/cloud), [CX-E](https://learn.chatgpt.com/docs/environments/cloud-environments)
- **Wait/recover:** tasks continue while the client sleeps, and saved state supports continuing existing work.
  Cloud execution does not establish whether each test wait suspends the model or how backend transient retries
  are classified/capped. The open-source Codex CLI is not source for the proprietary cloud scheduler. [CX-C](https://learn.chatgpt.com/docs/cloud), [CX-E](https://learn.chatgpt.com/docs/environments/cloud-environments), [CX-S](https://github.com/openai/codex/tree/124e4e5bfad4c84162d28d06a02ba28b2cd23c4a)
- **Verify/integrate/review:** cloud tasks can run project tools and present results for review; the environment setup
  itself is tested before publication. These pages do not guarantee exact-head conflict handling, compulsory
  post-integration tests or automatic safe promotion; maintain repository-level checks. [CX-C](https://learn.chatgpt.com/docs/cloud), [CX-E](https://learn.chatgpt.com/docs/environments/cloud-environments)
- **Cost/results:** current official pricing distinguishes plan limits, token-based credits and API-key billing;
  token/cache composition and model affect cost. The cloud documentation supplies no controlled landed-work rate.
  Prepared environments are a plausible way to reduce setup failures, but their REZICS allowance benefit remains
  an experiment, not a published percentage. [CX-$](https://learn.chatgpt.com/docs/pricing)

### Claude Code subagents and Claude Agent SDK

- **Plan/context:** subagent descriptions route specialized tasks with scoped tools and separate contexts; forks
  inherit conversation history, ordinary delegates start fresh. SDK definitions permit model/turn/spend controls.
  Neither is a mandatory repository-wide feature decomposition or sizing policy. [CL-A](https://code.claude.com/docs/en/sub-agents), [CL-D](https://code.claude.com/docs/en/agent-sdk/subagents)
- **Wait/recover:** foreground agents block the parent; background agents return completion/failure notifications.
  SDK sessions support explicit-ID resume and forks. API errors surface failure detail and partial results where
  available. These are usable primitives; application state must still durably associate an external check with
  a resumed attempt. Do not substitute repeated model status requests for notifications. [CL-A](https://code.claude.com/docs/en/sub-agents), [CL-S](https://code.claude.com/docs/en/agent-sdk/sessions)
- **Verify/integrate/review:** tool permissions and hooks constrain work; review agents can be specialized. Running a
  reviewer does not enforce tests or merge correctness. The cited SDK has no universal conflict-resolution or
  post-merge train; applications own those gates and human approval boundaries. [CL-A](https://code.claude.com/docs/en/sub-agents), [CL-D](https://code.claude.com/docs/en/agent-sdk/subagents)
- **Cost/results:** SDK cost docs warn that top-level `usage` excludes delegates whereas result cost/model usage include
  them; resumed cumulative totals and repeated message IDs need careful treatment. Budget/reset scopes matter.
  No controlled multi-agent delivery gain is reported by these docs. Adopt correct accounting and compact return
  artifacts before assuming additional reviewers are economical. [CL-$](https://code.claude.com/docs/en/agent-sdk/cost-tracking)

### Cursor background / Cloud Agents and scaling experiments

- **Plan/context:** Cloud Agents get dedicated VMs with repository, dependencies and access, and work independently.
  Cursor's separate scaling experiment used recursive planners, focused workers and a cycle judge, after flat
  self-coordination failed. Experimental shared-branch behavior is not a guarantee of the Cloud Agents product. [CU-C](https://cursor.com/help/ai-features/background-agents), [CU-X](https://cursor.com/blog/scaling-agents)
- **Wait/recover:** client closure does not stop cloud work. The experiment reports agent-held locks reducing twenty
  agents to two or three effective workers, brittle ownership and the need for fresh starts. Command-level durable
  sleep and a fixed transient retry policy are not established. [CU-C](https://cursor.com/help/ai-features/background-agents), [CU-X](https://cursor.com/blog/scaling-agents)
- **Verify/integrate/review:** Cloud Agents test and attach videos/screenshots/logs to PRs for inspection. The experiment
  removed an integrator bottleneck and let workers handle conflicts. It reports CI/early checks for a migration still
  needing review, so it does not justify eliminating REZICS's train, exact revision checks or promotion. [CU-C](https://cursor.com/help/ai-features/background-agents), [CU-X](https://cursor.com/blog/scaling-agents)
- **Cost/results:** current pricing exposes shared usage pools and model-dependent additional usage. The scaling post
  reports trillions of tokens, a browser exceeding a million lines and a **25× video-rendering improvement** merged
  in one experiment, without a useful-landings-per-token denominator. Large output is not a cost-efficiency result. [CU-$](https://cursor.com/docs/account/pricing), [CU-X](https://cursor.com/blog/scaling-agents)

### Aider

- **Plan/context:** a human steers change requests; selected files plus a graph-ranked, token-budgeted repository map
  provide signatures and related context. This is a context-selection pattern, not an autonomous dispatch hierarchy. [AI-M](https://aider.chat/docs/repomap.html), [AI-S](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)
- **Wait/recover:** shell/test execution blocks in the local workflow rather than a documented durable queue.
  Edit/lint/test feedback can trigger bounded reflections (three in the inspected coder). Git commits and undo support
  recovery; dirty-file handling separates existing changes. No multi-worker merge-conflict or post-merge policy is
  supplied by this local coding loop. [AI-S](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)
- **Verify/integrate/review:** automatic linting is enabled by default; automatic tests are opt-in and require a test
  command. The human still inspects edits/commits and controls integration. Copying an edit-test loop without its
  configuration would overstate verification coverage. [AI-T](https://aider.chat/docs/usage/lint-test.html), [AI-S](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)
- **Cost/results:** the coder tracks model cost; the public polyglot benchmark has **225 exercises in six languages**
  and reports correctness/cost by configuration. Those bounded editing results inform model trials, not production
  merging efficiency. Keep first-pass success separate from success after feedback/repair. [AI-S](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c), [AI-B](https://aider.chat/docs/leaderboards/)

### Google's internal migration and review systems; Jules critic

- **Plan/context:** Google's migration toolkit takes targeted file/line locations and prompts, expands context using
  symbol dependencies, and filters already-migrated files. Internal review-comment resolution conditions edits on
  comments and code. Both make a narrow, grounded work unit rather than delegate vague ownership. [GO-M](https://research.google/blog/accelerating-code-migrations-with-ai/), [GO-R](https://research.google/blog/resolving-code-review-comments-with-ml/)
- **Wait/recover:** migration validation feeds build/test errors into edit repair. The publications do not specify a
  durable command-wait implementation, generic retry cap or merge-conflict algorithm. Treat these as unspecified,
  rather than infer orchestration guarantees from Google's scale. [GO-M](https://research.google/blog/accelerating-code-migrations-with-ai/), [GO-R](https://research.google/blog/resolving-code-review-comments-with-ml/)
- **Verify/integrate/review:** migration tooling emits changes that pass unit tests, then engineers review and roll out.
  Comment-resolution suggestions are applied by authors. Jules' published 2025 critic separately reviews generated
  changes and returns issues to the builder; that publication describes a one-shot critic, not a tool-using test
  oracle or the internal migration pipeline. None establishes a universal post-merge gate. [GO-M](https://research.google/blog/accelerating-code-migrations-with-ai/), [GO-R](https://research.google/blog/resolving-code-review-comments-with-ml/), [GO-J](https://developers.googleblog.com/en/meet-jules-sharpest-critic-and-most-valuable-ally/)
- **Cost/results:** one migration workstream reports **80% of landed code modifications AI-authored** and an engineer-
  estimated **50% total time reduction**. Review suggestions cover about 50% of relevant comments above the chosen
  confidence threshold, with **40–50% of previewed edits applied**. Neither is a token/allowance accounting result;
  engineers' targeting and review remain part of total delivery cost. [GO-M](https://research.google/blog/accelerating-code-migrations-with-ai/), [GO-R](https://research.google/blog/resolving-code-review-comments-with-ml/)

### Meta's SapFix/Sapienz, TestGen-LLM and Catching JiTTests

- **Plan/context:** SapFix starts from a localized crash, using reverts, learned templates or small mutations.
  TestGen-LLM improves existing tests. JiTTests targets risky diffs with parent/child code, inferred intent and
  execution evidence. These are bounded maintenance/review units, not a general multi-agent product planner. [ME-S](https://engineering.fb.com/2018/09/13/developer-tools/finding-and-fixing-software-bugs-automatically-with-sapfix-and-sapienz/), [ME-T](https://arxiv.org/html/2402.09171v1), [ME-J](https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/)
- **Wait/recover:** SapFix tests candidates and tries alternative repairs. TestGen filters candidates; JiTTests uses
  overnight spare capacity. The publications do not specify durable suspend/resume, a shared retry budget or a
  cross-agent conflict protocol. Spare-capacity review would need separate admission from scarce blocking checks. [ME-S](https://engineering.fb.com/2018/09/13/developer-tools/finding-and-fixing-software-bugs-automatically-with-sapfix-and-sapienz/), [ME-T](https://arxiv.org/html/2402.09171v1), [ME-J](https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/)
- **Verify/integrate/review:** TestGen filters for building, reliable passing and increased coverage. JiTTests seeks
  executable parent/child behavior differences and filters false positives with rule-based assessment plus judges.
  Humans judge intended behavior; SapFix tracks approvals and lands accepted patches. A failing differential test
  alone does not prove a regression when behavior intentionally changes. No universal post-merge gate is stated. [ME-S](https://engineering.fb.com/2018/09/13/developer-tools/finding-and-fixing-software-bugs-automatically-with-sapfix-and-sapienz/), [ME-T](https://arxiv.org/html/2402.09171v1), [ME-J](https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/)
- **Cost/results:** TestGen's Instagram evaluation reports **75% build**, **57% reliable pass**, **25% coverage increase**;
  its separate test-a-thon reports **73% of recommendations accepted**. Meta's October 29, 2026 JiTTests post reports
  **60% true positives**, **589 engaged engineers** and **74 serious privacy bugs caught** in H1 2026. These denominators
  differ; they cannot be multiplied into a delivery rate. No all-in model-cost denominator is published there. [ME-T](https://arxiv.org/html/2402.09171v1), [ME-J](https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/)

### Measured multi-agent research: ChatDev, MetaGPT and AgentVerse

These studies demonstrate mechanisms under specific models/tasks. They do not show that an organization with a
check-slot bottleneck should add agents. The present ChatDev main is DevAll 2.0; inspect its retained `chatdev1.0`
branch for the older software-company implementation, rather than attribute the old paper's results to 2.0.

| System     | Planning, context, waiting and recovery                                                                                                                                                                                                                                                      | Verification, integration, conflict and human boundary                                                                                                                                                                                                              | Accounting and measured outcome                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatDev    | Role-paired phases decompose design/coding/testing/documentation; phase prompts and shared chat environment pass artifacts. Composed phases bound review/test cycles. Chat logs support inspection; durable external-check suspension and a general transient retry cap are not established. | Review dialogue and executable testing feed code changes; optional Git management records versions and a Human configuration admits a reviewer. Dialogue agreement is not Git conflict resolution. No production merge train or post-merge gate is established.     | Paper v5 reports **0.88 executability**, **0.3953 composite quality** on SRDD, and averages of **148.2148 seconds / 22,949.445 tokens**. These are task-generation metrics, not deployed features or whole-team spend. [CD-S](https://github.com/OpenBMB/ChatDev/tree/31fd994416a251ecdeb1f0a73c329271743bfb56), [CD-P](https://arxiv.org/html/2307.07924v5)                                                                |
| MetaGPT    | SOP roles exchange requirements/design/task artifacts through subscribed messages. Async roles and serialized team/context permit recovery; team rounds and investment budget bound work. These primitives do not establish durable suspension of an external check.                         | Code review and execution feedback refine output; human requirements start the process. The inspected team/role files do not define production Git conflict arbitration, compulsory post-merge verification or human merge review.                                  | Cost manager tracks tokens/prices and team budget. Paper reports **85.9% HumanEval / 87.7% MBPP pass@1**, plus **5.4 percentage points MBPP gain** from execution feedback. Benchmark functions and selected SoftwareDev examples do not establish repository landing yield. [MG-S](https://github.com/FoundationAgents/MetaGPT/tree/11cdf466d042aece04fc6cfd13b28e1a70341b1f), [MG-P](https://arxiv.org/html/2308.00352v6) |
| AgentVerse | Recruitment, collaborative decision, execution and evaluation repeat with feedback. Context includes task, roles, previous plan and advice; async steps and a turn bound are visible. The inspected loop is not a durable check scheduler.                                                   | Execution rules can run code tests; evaluators return score/advice and can cause another round. Score thresholds are not a frozen repository acceptance contract. No production conflict handling, post-merge gate or standard human approval point is established. | `get_spend` sums agents. Paper Table 2 reports GPT-4 HumanEval **83.5% CoT / 87.2% solo / 89.0% group**. It also reports harmful incorrect peer feedback in some GPT-3.5 reasoning tasks. More discussion is not uniformly better. [AV-S](https://github.com/OpenBMB/AgentVerse/tree/f90c4bd9680fdd3bcff8c52c9170911a59b23478), [AV-P](https://arxiv.org/html/2308.10848v3)                                                 |

## Patterns and differences that matter

1. **Bound work by a verifiable outcome and stable context.** Factory's assertion-to-feature mapping, Google's file/
   dependency targeting, Devin's small sessions and Aider's ranked map converge here. REZICS already has briefs;
   improve their inputs and semantic completeness, without splitting every dependency into another ticket.
2. **Put mechanical lifecycle transitions outside the model.** SDK event/state primitives, remote sessions and
   GitHub's watched blockers offer different implementations. Only Devin's usage page explicitly establishes the
   cited test-wait billing behavior. REZICS's own exit/inbox mechanisms are already close; extend the worker/check
   boundary and measure calls, not just whether a process is nominally asynchronous.
3. **Verification needs independence and executable evidence.** Factory separates builders from fresh validators;
   Meta filters test candidates; Google feeds actual compiler/test failures back. An LLM review is a hypothesis
   generator, while acceptance and regression checks remain the oracle. Review only valuable risks to avoid a new
   allowance/check bottleneck.
4. **Integration is a separate correctness event.** Most public coding products end at a proposed PR; papers often
   end at a patch or benchmark result. REZICS already goes further with a train, verifier and promotion. Keep that
   advantage and record exactly what was checked; local green does not certify a rebased combined candidate.
5. **Failures need both classes and evidence.** SWE-agent's bounded search, OpenHands' explicit stop reasons and
   Devin's issue timelines favor actionable recovery. REZICS already classifies failures; distinguish a healthy
   queue wait from a timeout and preserve the causal command/fingerprint instead of repeatedly relaunching workers.
6. **Count all work and preserve denominators.** Factory's cache-heavy token breakdown, SDK delegate-accounting
   caveats and Meta's filter funnels show why raw tokens, runtime and accepted suggestions answer different questions.
   None of the sources establishes a universal best model, worker count or reviewer fraction for REZICS.

## Ranked adoption tasks

The following **gain ranges are planning hypotheses**, not measurements read in a source, and are not additive.
They describe relative useful-main-outcomes/allowance lift in the affected cohort, assuming equal outcome quality.
They include the ongoing cost of the new mechanism; development payback must be measured separately.
Ranking weighs local loss evidence, plausibility, implementation allowance and confidence. Sizes are one bounded
worker task unless explicitly split; managers should turn each into a frozen executable acceptance contract.

| Rank / expected gain / size                                                | Concrete adoption and evidence                                                                                                                                                                                                                                                                                                                                                                                                  | Acceptance experiment and what to measure                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 / **10–25%**, medium confidence / small                                  | **Brief readiness and context packet.** Add one manager pre-dispatch checklist/artifact: native contract revisions, relevant files/tests, one observable outcome, prerequisite availability and intended integration check. Validate references mechanically; manager resolves semantic uncertainty. Trial on one existing journey. Inspired by GO-M, DV-G, AI-M and the delivery report's contract losses.                     | Five to ten comparable briefs; record setup/discovery calls, spec/scope stops, attempts/outcome and total manager+worker allowance. Require fewer readiness failures and no rise in missing behavior. Keep optional retrieved context capped; do not paste the whole repo into every prompt.                                                                                                   |
| 2 / **3–15%**, medium confidence / two small tasks                         | **A durable worker-check wait boundary.** First persist check request/attempt/revision/command, queue/acquire/exit and output location using existing process/SQLite conventions. Then resume the owner on completion with exit status and bounded failure evidence; no model status loop. Preserve queue tickets and legitimate long waits. CL-S, OH-S and DV-U are primitives/evidence, not a ready-made REZICS scheduler.    | Crash/restart and duplicate-completion tests; one request yields one logical terminal result and stale completion cannot certify a newer commit. Long queued check causes zero repeated model wait calls and no false watchdog stall. Compare total allowance and check-host residency. Do not add a compatibility script merely because old watchdog wording names one absent from this base. |
| 3 / **3–15%**, low-to-medium confidence / medium                           | **Versioned check receipts and conservative reuse.** Extend existing records with exact commit/tree, command, environment/toolchain, dependency/schema identity and exit status. Reuse only identical proven inputs; invalidation on any relevant change is mandatory. Start with one deterministic check family. Local own-pass/landing mismatch is the local evidence; existing train caches/batching are the starting point. | Tests reject stale revision, changed environment and changed dependencies; duplicate identical check runs fall. Measure occupied slot-minutes/useful outcome and post-integration regressions. Do not skip combined-candidate acceptance, broader affected coverage or promotion merely because an earlier worker passed.                                                                      |
| 4 / **5–20%**, low-to-medium confidence / small pilot                      | **One cross-owner milestone with a fresh user-testing validator.** Map existing worker acceptances to a single journey assertion and validate its combined dev-verified result; report unmet assertions to the integrating manager as targeted fixes. Reuse the existing verifier/promotion. FA-A and the delivery report support this, rather than a permanent reviewer per worker.                                            | One already-started journey reaches main with a browser/API receipt. Track dependency count, review/fix allowance, dev-to-main delay and failures first found after promotion. Stop expanding the pilot if validation consumes allowance without finding consequential gaps.                                                                                                                   |
| 5 / **2–8%**, medium confidence / small                                    | **Evidence-based retry admission.** Extend existing retry intents with cumulative same-cause cost, prior command/fingerprint and evidence of changed conditions. Notify the owner once for stable repeated failures; retry transient transport separately within its existing cap. SW-S and OH-S support bounded recovery; REZICS already stops matching environment failures.                                                  | Tests cover queue wait, changed conditions, duplicate restart and exhausted repair budget. Reduce unchanged-command retries and superseded allowance without suppressing successful transient recovery. Keep spec-conflict decisions with managers and preserve original evidence.                                                                                                             |
| 6 / **1–6%**, low confidence / small                                       | **Risk-targeted executable review pilot.** On a few high-risk changed behaviors, ask a fresh reviewer for a reproducible regression probe against base and candidate, then classify intentional changes with the owner. Use spare review capacity separately from blocking checks. ME-T/ME-J and GO-J support evidence filtering; no blanket reviewer or mutation campaign.                                                     | Run proposed probes on base/candidate and check reproducibility. Record consequential defects caught, false positives, review/check cost and escaped regressions. Require findings to justify their cost before broadening; do not modify frozen tests.                                                                                                                                        |
| 7 / **0–5% initially**, low confidence / small                             | **Role/configuration trials using delivered outcomes.** Use current routing experiment support to compare a cheaper worker configuration for a narrow class while keeping acceptance fixed. Count retries, consultations, manager effort, caching and rate-limit effects. FA-D, AI-B and AV-P support controlled role trials, not selecting a model from an unrelated leaderboard.                                              | Matched or randomized cohorts, identical acceptance and observation window; report useful-main outcomes/allowance with uncertainty. Roll back on worse regression rate or integration yield. Do not infer subscription allowance multipliers from API token prices.                                                                                                                            |
| Enabler, before interpreting any lift / **no direct gain claimed** / small | **Complete the phase/accounting receipt.** Audit and fill gaps in existing flow/usage records: enqueue, acquire, process start/end, checked revision and cumulative-versus-incremental usage. Join unsuccessful and manager work to the outcome once. Delivery-report limitations and CL-$ justify this prerequisite.                                                                                                           | At least 95% of new attempts have nonoverlapping reconstructible phases; duplicate/resumed usage is not double-counted. Missing observations remain explicit. Produce one cohort report with no invented historical wait or spend.                                                                                                                                                             |

For interpretation: eliminating 16% of calls would at most give `1 / (1 - .16) = 1.19×` call efficiency if all calls
cost the same and outcomes stay fixed. They do not necessarily cost the same, so this is **not** a 19% allowance
forecast. Similarly, reducing a 75% failure share to 65% would change success count from 25 to 35 per 100 attempts
at fixed attempt cost, a hypothetical 1.4×; outcome definitions and replacement work could invalidate that model.
An 89–95% queue share establishes a latency concern, not a recoverable allowance fraction. Record slot service time
and completion rates before deciding whether admission, check deduplication or capacity is the binding constraint.

Do not adopt a new swarm framework, a flat agent-written locking file, an unconditional extra critic, wholesale
shared worktrees or more worker width on this evidence. These are decisions to defer, not claims that they can never
help. The highest-value immediate work is a small readiness/wait/receipt pilot with measured useful delivery.

## Primary sources and provenance

All URLs were read on the evidence date. Web documentation and papers are cited as copyrighted evidence; no blanket
open-source licence is assumed for their prose, figures or product backends. The code licences below apply only to
the inspected repositories. No cloned project was installed, built or executed. `.reference/INDEX.md` in the main
checkout records the reusable clones; paths below are relative to that explicitly permitted reference directory.

| Key  | Primary source and precise reading location                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OH-S | [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk/tree/641e161178cb934f38afcbe603125950611d1668), `agent-work-systems/openhands-sdk`, **MIT**, `LICENSE`. Read `README.md`, `openhands-sdk/openhands/sdk/conversation/{event_store,state,stuck_detector}.py`, `impl/local_conversation.py`, `openhands-tools/openhands/tools/task/{definition,manager}.py`, and `openhands-sdk/openhands/sdk/llm/utils/{metrics,retry_mixin}.py`. |
| OH-P | [OpenHands platform paper, v3](https://arxiv.org/html/2407.16741v3), architecture/delegation and software-engineering evaluation table.                                                                                                                                                                                                                                                                                                         |
| SW-S | [SWE-agent](https://github.com/SWE-agent/SWE-agent/tree/3ea751c087f32b16e039a2233dd6eefecef325d5), `agent-work-systems/swe-agent`, **MIT**, `LICENSE`; `sweagent/agent/{agents,models,reviewer}.py`, especially `RetryAgent`, `InstanceStats` and retry-loop configurations.                                                                                                                                                                    |
| SW-P | [SWE-agent paper, v3](https://arxiv.org/html/2405.15793v3), ACI, evaluation setup and results.                                                                                                                                                                                                                                                                                                                                                  |
| DV-G | Devin [task guidance](https://docs.devin.ai/essential-guidelines/when-to-use-devin) and [Session Insights](https://docs.devin.ai/product-guides/session-insights).                                                                                                                                                                                                                                                                              |
| DV-U | Devin [usage, waits and sleep](https://docs.devin.ai/admin/billing/usage).                                                                                                                                                                                                                                                                                                                                                                      |
| DV-R | Cognition [annual performance review, 2025](https://cognition.com/blog/devin-annual-performance-review-2025).                                                                                                                                                                                                                                                                                                                                   |
| FA-A | Factory [How Missions Work](https://factory.com/news/missions-architecture), architecture and single-mission telemetry.                                                                                                                                                                                                                                                                                                                         |
| FA-D | Factory [planning and validation](https://docs.factory.com/missions/planning) and [configuration reference](https://docs.factory.com/missions/reference).                                                                                                                                                                                                                                                                                       |
| GH-A | GitHub [Copilot on GitHub and Mobile](https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github), including the October 28, 2026 experience distinction. Older agent-about URLs now redirect here.                                                                                                                                                                                                                         |
| GH-M | GitHub [Agent Merge](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/watch-and-fix-pull-requests).                                                                                                                                                                                                                                                                                                              |
| GH-R | GitHub [review output](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/review-copilot-output).                                                                                                                                                                                                                                                                                                                  |
| GH-B | GitHub [usage-based billing](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing) and [automation billing](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-automations), distinguishing model/token credits from Actions minutes.                                                                                                                     |
| CX-C | Official OpenAI documentation: [Codex Cloud](https://learn.chatgpt.com/docs/cloud).                                                                                                                                                                                                                                                                                                                                                             |
| CX-E | Official OpenAI documentation: [cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments).                                                                                                                                                                                                                                                                                                                            |
| CX-$ | Official OpenAI documentation: [pricing and usage](https://learn.chatgpt.com/docs/pricing).                                                                                                                                                                                                                                                                                                                                                     |
| CX-S | [Codex CLI](https://github.com/openai/codex/tree/124e4e5bfad4c84162d28d06a02ba28b2cd23c4a), reused `agent-token-efficiency/codex`, **Apache-2.0**, `LICENSE`; `README.md` distinguishes the local CLI. This clone does not disclose the cloud scheduler.                                                                                                                                                                                        |
| CL-A | Anthropic [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), foreground/background, context, resume and API errors.                                                                                                                                                                                                                                                                                                           |
| CL-D | Anthropic [Agent SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents).                                                                                                                                                                                                                                                                                                                                                           |
| CL-S | Anthropic [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), continue/resume/fork and persistence.                                                                                                                                                                                                                                                                                                                             |
| CL-$ | Anthropic [SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), subagent inclusion, message deduplication and resumed/reset total scopes.                                                                                                                                                                                                                                                                               |
| CU-C | Cursor [background/Cloud Agents](https://cursor.com/help/ai-features/background-agents); older `/background-agent` docs redirect to the documentation home.                                                                                                                                                                                                                                                                                     |
| CU-X | Cursor [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents), failed coordination designs, planner/worker experiment and its limits.                                                                                                                                                                                                                                                                                 |
| CU-$ | Cursor [pricing](https://cursor.com/docs/account/pricing), usage-pool and additional-usage accounting; no fixed price assumed here.                                                                                                                                                                                                                                                                                                             |
| AI-S | [Aider](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c), reused `agent-token-efficiency/aider`, **Apache-2.0**, `LICENSE.txt`; `aider/coders/base_coder.py`, `aider/repo.py`, `aider/repomap.py`.                                                                                                                                                                                                              |
| AI-M | Aider [repository map](https://aider.chat/docs/repomap.html).                                                                                                                                                                                                                                                                                                                                                                                   |
| AI-T | Aider [linting and testing](https://aider.chat/docs/usage/lint-test.html).                                                                                                                                                                                                                                                                                                                                                                      |
| AI-B | Aider [polyglot benchmark](https://aider.chat/docs/leaderboards/).                                                                                                                                                                                                                                                                                                                                                                              |
| GO-M | Google Research [Accelerating code migrations with AI](https://research.google/blog/accelerating-code-migrations-with-ai/), targeting, validation and case-study outcomes.                                                                                                                                                                                                                                                                      |
| GO-R | Google Research [Resolving code review comments with ML](https://research.google/blog/resolving-code-review-comments-with-ml/), internal DIDACT workflow and application rates.                                                                                                                                                                                                                                                                 |
| GO-J | Google Developers [Jules critic](https://developers.googleblog.com/en/meet-jules-sharpest-critic-and-most-valuable-ally/), published August 12, 2025.                                                                                                                                                                                                                                                                                           |
| ME-S | Meta Engineering [SapFix and Sapienz](https://engineering.fb.com/2018/09/13/developer-tools/finding-and-fixing-software-bugs-automatically-with-sapfix-and-sapienz/), localization, repair alternatives, validation and human approval.                                                                                                                                                                                                         |
| ME-T | Meta authors [TestGen-LLM paper, v1](https://arxiv.org/html/2402.09171v1), filtering and industrial evaluations.                                                                                                                                                                                                                                                                                                                                |
| ME-J | Meta Engineering [Catching JiTTests at full scale](https://engineering.fb.com/2026/10/29/security/catching-bugs-before-they-land-jittestings-human-on-the-loop-approach-at-full-scale/), targeted generation, evidence filtering and reported outcomes.                                                                                                                                                                                         |
| CD-S | [ChatDev 1.0](https://github.com/OpenBMB/ChatDev/tree/31fd994416a251ecdeb1f0a73c329271743bfb56), `agent-work-systems/chatdev`, **Apache-2.0**, `LICENSE`; `chatdev/{chat_chain,chat_env,composed_phase,statistics}.py`, `CompanyConfig/Default/ChatChainConfig.json`. Also read current `README.md` at `a2ea4a263cebe9a7abd01ee3b5b0bf95698ed328` to distinguish DevAll 2.0.                                                                    |
| CD-P | [ChatDev paper, v5](https://arxiv.org/html/2307.07924v5), SRDD evaluation Tables 1–3 and limitations.                                                                                                                                                                                                                                                                                                                                           |
| MG-S | [MetaGPT](https://github.com/FoundationAgents/MetaGPT/tree/11cdf466d042aece04fc6cfd13b28e1a70341b1f), `agent-work-systems/metagpt`, **MIT**, `LICENSE`; `metagpt/team.py`, `metagpt/roles/role.py`, `metagpt/utils/cost_manager.py`, `metagpt/actions/{write_code_review,run_code}.py`.                                                                                                                                                         |
| MG-P | [MetaGPT paper, v6](https://arxiv.org/html/2308.00352v6), SOP/execution feedback and benchmark results.                                                                                                                                                                                                                                                                                                                                         |
| AV-S | [AgentVerse](https://github.com/OpenBMB/AgentVerse/tree/f90c4bd9680fdd3bcff8c52c9170911a59b23478), `agent-work-systems/agentverse`, **Apache-2.0**, `LICENSE`; `agentverse/environments/tasksolving_env/basic.py`, `rules/executor/code_test.py`, `agentverse/agents/tasksolving_agent/role_assigner.py`, `agentverse/llms/openai.py`.                                                                                                          |
| AV-P | [AgentVerse paper, v3](https://arxiv.org/html/2308.10848v3), Table 2 and incorrect-feedback analysis.                                                                                                                                                                                                                                                                                                                                           |

## Research decisions

- Treat the contract's `tools/goal/research/agent-work-systems.md` as the canonical report; the
  [research catalogue entry](../../../docs/research/agent-work-systems.md) links here without duplicating evidence.
- Compare the main revision available at inspection, rather than infer deployment from a moving checkout or inspect
  unrelated workers' live state. No live production database or other workers' processes were needed for this study.
- Preserve the supplied hourly warning metrics but distinguish them from the checked-in report's actual cohorts and
  explicit phase/accounting uncertainty. Recommendations remain hypotheses until a controlled local trial.
- Read open-source implementations and first-party publications; proprietary backend details that are not published
  remain unknown. Learn mechanisms and implement native designs; do not transplant source or paper evaluation claims.
- No accepted specification topic is migrated from rezics-next-discussion; this report introduces evidence and proposed
  experiments, so no second authoritative specification or discussion-page replacement is created.
