# Landing more work per Codex token

Research snapshot: 2026-10-27, 10:24:02 UTC. Repository baseline:
`c3f516082184e2ed6d9f76702c110eb75d32a7a1`. This report is evidence for a future
control-plane decision; it does not change routing, worker instructions, or acceptance.

The largest opportunity is reducing unsuccessful work and long read/check loops.
In the completed Codex-winning cohort, **51.99% of tokens went to attempts other
than the landing attempt**. Repository-reading results dominate newly introduced
visible text. Shortening the worker prompt helps, but removing its inline result
schema would save at most about **0.28% of replayed raw tokens** in this sample.
Do not turn every task's reasoning down or compact every conversation earlier.

## Measurement and reproducibility

All production data was read only. A single SQLite read transaction captured
`worker_tasks`, `worker_attempts`, and `worker_records` from
`/home/edge/projects/rezics/rezics-next/.temp/goal/goal.sqlite`. Session sources were
`~/.codex/sessions/**/*.jsonl` and `~/.codex-1/sessions/**/*.jsonl`; attempt streams
were the `logPath` files under the main checkout's `.temp/goal/runs/`.
Analysis scripts, frozen extracts, and aggregates remain in this worktree's
`.temp/agent-token-efficiency/`; they are temporary, not a new production tool.

The database contained 1,529 tasks and 2,532 attempts across all CLIs. Tasks were
1,225 integrated, 97 merged, 109 cancelled, 40 held, 29 landing, 28 running, and
one stopped. The attempt observation period starts 2026-10-24 at 23:36:32 UTC.
There were 1,867 ended Codex attempts; 1,854 had a matching rollout and 1,847 had
nonzero usage. The remaining 20 also had zero recorded tokens: missing telemetry
is not proof that they consumed nothing. Running attempts are excluded.

The primary cohort consists of the **992 integrated/merged tasks whose current
landing attempt used Codex**, and their preceding Codex attempts: 1,725 attempts,
of which 1,711 have usage. All 992 winners have usage. Sixteen additional landed
tasks had Codex attempts but finished through another CLI; their Codex spend is
excluded from this cohort and included in the wider ended-attempt totals below.
Non-Codex predecessors, managers, external services, and unrecorded consultations
are outside the token totals. There were no `consultation-completed` events by
the snapshot, so no completed consultation usage could be added.

Reproduction rules:

1. Read JSON `body` fields keyed by task and attempt. A winner is the task's
   `currentAttempt` when its state is `integrated` or `merged`, not a successful
   worker exit or a `pending-gate` record. Include its earlier attempts even when
   their outcome is stopped, gate-failed, or superseded.
2. Join `attempt.session` to a rollout filename's session suffix, falling back
   to the attempt stream's `thread.started.thread_id`. Read only events inside
   `[startedAt, endedAt]`; pre-start cumulative counters establish a baseline.
   One resumed session belongs to two attempts, so never charge its lifetime
   total to each attempt.
3. Sum `token_usage_record.payload.usage` once per `response_id` per attempt.
   All 1,847 nonzero sessions have this ledger. Count top-level records only:
   `compacted.latest_token_usage_record` repeats an already recorded response.
   For sessions lacking this ledger, difference monotonic
   `event_msg.token_count.info.total_token_usage`, ignoring duplicate snapshots.
4. Set `I = input_tokens`, `C = cached_input_tokens`, `U = I - C`,
   `O = output_tokens`, `R = reasoning_output_tokens`, and raw tokens `T = I + O`.
   `C` is part of `I`; `R` is part of `O`. Do not add either twice. All observed
   cache-write fields are zero; that does not establish API billing policy.
5. Aggregate complete histories by task class and **winning model** for the
   class/model table. Nineteen predecessor attempts used a different model from
   the winner. Thus this table describes landed histories, not isolated model
   benchmarks. Use actual attempt model/effort for the effort comparison.

**An accounting defect matters here:** the event-message counters miss usage
present in the response ledger, notably compaction. In the primary cohort the
ledger adds 56,236,386 input tokens over those counters. Of these, 55,119,088
are identifiable compaction input. A resumed attempt's database input record
also includes 4,422,070 tokens from its predecessor. Use response IDs and
intervals before optimizing from `report.ts` totals. These are observations and
recommendations; this research makes no executable accounting change.

## What the completed work consumed

The cohort consumed **8,321,685,002 raw tokens**: 8,276,457,058 input and
45,227,944 output. Input comprised 8,038,076,288 cached and 238,380,770 uncached
tokens: **97.12% cached**. Reasoning accounted for 25,437,620 output tokens,
56.24% of output. Per landed task this is **8.389M raw**, **240,303 uncached
input**, and **45,593 output** tokens.

There were 733 nonwinning attempts including the 14 without usage; the 719 with
usage consumed **4,326,034,621 raw tokens (51.99%)**, including 125,007,044
uncached input and 22,311,033 output. Their recorded outcomes were 514 stopped,
186 gate-failed, 17 superseded, and two previously passed. Previous passes can
be displaced; calling every nonwinner a model failure would be incorrect.
The cohort used 1.74 ended Codex attempts per landed task, rather than assuming
the approximate 1.6 in the brief applies to this slice.

The wider 1,847 measured ended Codex attempts consumed 10,571,334,509 raw tokens.
Of these, 62.20% were outside the 992 current winning attempts. This includes
cancelled work, other-CLI winners, and predecessors of still-open tasks; it is a
snapshot of sunk expenditure, **not** a mature failure rate. The difference from
the primary cohort is 2,249,649,507 tokens and must remain visible operationally.

In the table, M means million tokens and k means thousand. Every row includes
Codex predecessors of its landed tasks. Counts without telemetry are excluded
from A, the measured-attempt count. There are no mechanical tasks in this sample.

| Task class     | Winning model |   A | Landed tasks | Raw M/task | Uncached input k/task | Output k/task |
| -------------- | ------------- | --: | -----------: | ---------: | --------------------: | ------------: |
| claim          | gpt-6.1-sol   | 793 |          381 |      8.237 |                 248.8 |          42.1 |
| claim          | gpt-6-luna    | 157 |           87 |     22.923 |                 631.3 |         122.1 |
| implementation | gpt-6-luna    | 462 |          310 |      7.399 |                 203.9 |          44.9 |
| implementation | gpt-6.1-sol   |  27 |           21 |      7.393 |                 155.5 |          31.7 |
| interface      | gpt-6-luna    |  78 |           43 |      8.372 |                 188.3 |          40.4 |
| interface      | gpt-6.1-terra |  17 |           13 |      8.912 |                 196.9 |          18.5 |
| specification  | gpt-6.1-sol   | 125 |          105 |      1.140 |                  55.0 |           9.4 |
| research       | gpt-6.1-sol   |  14 |           14 |      2.819 |                 172.7 |          23.2 |
| research       | gpt-6.1-terra |   1 |            1 |      0.537 |                  41.4 |           5.5 |
| bulk-text      | gpt-6-luna    |  12 |            8 |      2.173 |                 106.3 |          23.8 |
| critical-path  | gpt-6-luna    |  25 |            9 |      9.684 |                 271.2 |          55.4 |

These historical cohorts differ in task size, time, retry position, and routing
version. They cannot establish equal-quality causal savings from switching
models. The one Terra research result is particularly insufficient.

Raw tokens also differ from money and subscription allowance. Current standard
API prices per million input/cached-input/output tokens are Sol $2/$0.10/$10,
Luna $0.10/$0.01/$0.50, and Terra $1/$0.05/$5.
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra) document these
rates. They are not measurements of our subscription bill. Log actual tier,
cache writes, account allowance, and eventual landing before monetizing savings.

## Repository reads versus instructions

Rollouts do not expose a billed-token origin map or the cached subrange for each
file. An exact split of billed input into prompt and repository content is not
recoverable. We instead counted **new visible inbound text**, once per response
item, with `tiktoken 0.14.0` / `o200k_base`. This is a consistent text-size proxy,
not a verified tokenizer for the three deployed model IDs. It excludes hidden
instructions, assistant prose/reasoning, generated tool arguments, and duplicate
`session_meta`/`world_state` descriptions. Tool definitions are serialized JSON.

For tool outputs, associate `call_id` with its function/custom-tool call. Mark a
read when its arguments contain `rg`, `cat`, `sed`, `head`, `tail`, `ls`, `find`,
`wc`, `pwd`, or read-only Git operations. Put calls also containing test/build,
install, patch, file-write, Git mutation, clone, or download operations in a
separate mixed bucket. This lexical classifier is approximate: batched shell
output has no per-command provenance, and truncated results cannot reveal the
original file's size. Neither tool-step counts nor a request's full input delta
should be presented as repository-reading tokens.

| Introduced inbound text     | Proxy tokens | Share of measured inbound text |
| --------------------------- | -----------: | -----------------------------: |
| Repository-read batches     |  121,842,876 |                         77.79% |
| Mixed read/other batches    |    8,465,456 |                          5.40% |
| Other tool results          |   10,291,977 |                          6.57% |
| Developer instructions      |    7,022,586 |                          4.48% |
| Tool definitions            |    4,488,022 |                          2.87% |
| Task briefs                 |    2,816,619 |                          1.80% |
| Worker wrapper prompt       |      813,676 |                          0.52% |
| Other user/environment text |      888,645 |                          0.57% |

The denominator is 156,629,857 introduced text tokens, not the 8.276B replayed
input tokens. Median initial request input was 18,456; median wrapper size was
389 proxy tokens, versus 1,150 for the brief. Brief p90/p95/max were
3,346/4,374/11,584. Older prompts affect these medians: wrapper medians were 385
on CLI 0.163.0 and 663 on 0.164.0. This research invocation's current wrapper is
1,029 and its brief 382; do not assume today's wrapper caused all historical cost.

Per-session medians show that this is not only a few giant file dumps. Each
percentage below uses that session's measured inbound-text denominator; medians
need not sum to 100%. “Prompt” here combines wrapper and brief, excluding the
separately measured developer instructions and tool definitions.

| Class          | Measured sessions | Median repository-read share | Median prompt share |
| -------------- | ----------------: | ---------------------------: | ------------------: |
| claim          |               950 |                       81.12% |               2.26% |
| implementation |               489 |                       69.83% |               2.67% |
| interface      |                95 |                       59.11% |               3.37% |
| specification  |               125 |                       83.10% |               3.20% |
| research       |                15 |                       75.46% |               1.05% |
| bulk-text      |                12 |                       74.23% |               3.71% |
| critical-path  |                25 |                       58.25% |              11.91% |

There were 47,004 read batches and 3,022 mentioning `AGENTS.md`. Their combined
batch output was 12.584M proxy tokens, **not** all instruction text. The current
root instructions are only 312 tokens. Identical full read-call text repeated
within a session produced just 104,680 output proxy tokens; this narrow lower
bound does not justify claiming most reads were duplicates. Supplying focused
entry points and avoiding broad file dumps are larger hypotheses to test.

## Context, compaction, and retry evidence

There were 97,275 response-ledger requests, median 36 per measured attempt,
p90 122, p95 176, maximum 1,186. Peak request input was median 82,620,
p90 161,757, p95 200,089, maximum 214,337.

There were **303 compactions in 218 attempts** (12.74% of measured attempts).
Those attempts consumed 50.31% of cohort raw tokens. Compaction requests alone
used 55,119,088 input, 4,093,440 cached input, and 1,028,299 output tokens.
Their **51,025,648 uncached input tokens are 21.41% of cohort uncached input**,
despite being only 0.67% of raw tokens. First ordinary requests after compaction
added another 1,623,223 uncached input tokens across 303 observations. Lower
cache reuse at compaction is a material cost; the logs do not prove compaction
caused the long sessions.

[`launch.ts`](../../tools/goal/src/launch.ts) and
[`defaults.json`](../../tools/goal/defaults.json) set fast service, a 4,000-token
tool-output limit, 160k auto-compaction for non-Luna models, 200k for Luna, and a
500k context override only when the model name includes `sol`. Terra currently
takes the non-Luna compaction branch. Observed effective context windows across
the wider measured sample were 475,000, 828,400, and 258,400; historical settings
and model limits differ from today's defaults. All 2,014 observed thread-settings
events in the primary cohort specified `priority`; this is requested client
state, not an independently verified invoice tier.

[`evidence.ts`](../../tools/goal/src/evidence.ts) already keeps session transcripts
out of bundles and passes the **directory path**, not the full patch, into a
retry prompt. Preserve this. Of the measured cohort's attempts, 737 were retry
ordinals; only 183 prompts contained the current literal evidence-pointer phrase.
Older prompt forms prevent interpreting the difference as 554 missing bundles.

The 1,683 extant evidence directories associated with measured attempts contain:

| Artifact        | Median proxy tokens |    p90 | Maximum |
| --------------- | ------------------: | -----: | ------: |
| contract.md     |               1,138 |  3,344 |  11,583 |
| failure.json    |                   1 |    212 |   4,606 |
| approaches.json |                 176 |    996 |  21,898 |
| diff.patch      |               6,703 | 26,956 | 970,625 |

These are archive sizes, not measured retry ingestion. Winning attempts also
have directories. In particular, dumping every patch or re-reading every copied
contract is not necessary. JSON `reportedApproaches` currently accepts strings
without the length caps applied to legacy text handoffs in
[`records.ts`](../../tools/goal/src/records.ts).

## What primary sources establish

OpenAI's [reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning)
describes effort as a quality/token tradeoff, with adaptive reasoning even within
an effort level. Sol supports low through max and defaults to medium, but does
not support none. The [model-selection guide](https://developers.openai.com/api/docs/guides/model-selection)
recommends comparing representative inputs and verification outcomes, then
varying effort while holding the model fixed. A lower price or effort label is
not evidence of lower cost per accepted result.

The [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
requires matching eligible prefix boundaries. For GPT-5.6 and later, implicit
caching uses message boundaries; explicit breakpoints can protect shared static
content. `prompt_cache_key` is optional accounting separation, not a required
routing optimization. The minimum visible cacheable prefix is 1,024 tokens.
API retention controls are `prompt_cache_options.ttl` (30m/12h), with write
charges; older-model retention recipes should not be copied blindly. Compaction
can break reuse. Stabilize useful instructions and append changing material;
do not pad prompts simply to chase a cache-hit percentage.

OpenAI's [compaction guide](https://developers.openai.com/api/docs/guides/compaction)
describes state-preserving reduction, including opaque server compaction items.
Its API options are not automatically Codex CLI settings. The
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents `model_auto_compact_token_limit`, `model_context_window`,
`tool_output_token_limit`, and threshold scope `total` versus `body_after_prefix`.
Increasing the advertised window is not a token reduction by itself.

The [Codex speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed)
states that Fast mode uses included allowance at 2.5 times Standard, and purchased
credits/Enterprise pay-as-you-go at twice Standard. Switching service is therefore
a possible **allowance** saving with zero raw-token saving. The
[API Fast guide](https://developers.openai.com/api/docs/guides/fast-mode) describes
a premium and shared limits. [API Flex](https://developers.openai.com/api/docs/guides/flex-processing)
trades latency/availability for lower pricing; do not assume our authenticated
Codex pools expose Flex just because the API does.

### Established coding-agent implementations

Reference checkouts are shallow, were read only after cloning, and were never
installed, built, or run. Paths below are relative to
`/home/edge/projects/rezics/rezics-next/.reference/agent-token-efficiency/`.
The shared `.reference/INDEX.md` records their full revisions and licences.

| Project and pinned revision                                                                                                               | Primary source paths and findings                                                                                                                                                                                                                                                                                                                 | Licence                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| [OpenAI Codex, 124e4e5bfad4c84162d28d06a02ba28b2cd23c4a](https://github.com/openai/codex/tree/124e4e5bfad4c84162d28d06a02ba28b2cd23c4a)   | `codex/codex-rs/core/src/compact.rs`: compaction constructs replacement history, records usage, and tracks windows. `codex/codex-rs/core/src/compact_retained_tool_outputs.rs`: explicitly retained tool outputs share the history budget and can be dropped whole. `codex/codex-rs/core/src/config/mod.rs`: exposes context/output controls.     | Apache-2.0, `codex/LICENSE`     |
| [Aider, 5dc9490bb35f9729ef2c95d00a19ccd30c26339c](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)        | `aider/aider/repomap.py`: ranks symbols and searches for a map fitting a token budget. `aider/aider/history.py`: summarizes older messages while retaining recent context. `aider/aider/coders/base_coder.py`: separates instructions, history, repo map, read-only files, edited files, and current messages; adds provider-aware cache headers. | Apache-2.0, `aider/LICENSE.txt` |
| [OpenCode, 86976449c40d48f2731553a024f74552593d1764](https://github.com/anomalyco/opencode/tree/86976449c40d48f2731553a024f74552593d1764) | `opencode/packages/core/src/session/compaction.ts`: preserves recent context beside a structured checkpoint, keeps the normal prefix for summary cache reuse, reserves headroom, and progressively clips tool output when oversized. `opencode/packages/schema/src/config/compaction.ts` defines configuration.                                   | MIT, `opencode/LICENSE`         |

The shared patterns are bounded relevant context, separating stable instructions
from changing work, retaining recent actionable state, and accounting for the
summary itself. Adopt these designs in the TypeScript/Bun control plane. Do not
copy their files, constants, or provider-specific cache headers. Public OpenAI
documentation is cited as documentation, not as an open-source licence grant.

## Concrete changes to evaluate

The numerical savings below are **conditional planning estimates**, not observed
intervention effects. Keep every existing acceptance, integration, and promotion
gate. Do not add these estimates together: less reading, shorter sessions,
different effort, and fewer retries overlap.

| Change and repository location                                                                                                                                                                                                                                                                                                                                                                                     | Expected saving calibrated to this sample                                                                                                                                                                                                                                                                                                                                                                 | Quality condition                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record unique response-ledger usage, compaction responses, actual model/effort, and origin-proxy version in `records.ts`/`report.ts`.                                                                                                                                                                                                                                                                              | Zero direct saving; restores 56.236M missing input in this cohort and prevents optimizing the wrong denominator.                                                                                                                                                                                                                                                                                          | Reconcile response IDs and resumed intervals against existing logs before changing accounting.                                                                                                          |
| Keep the result contract through `--output-schema`; replace its repeated inline JSON schema in `workerPrompt` with a short return instruction. Keep authority, risk boundaries, base-failure handling, and commit/check requirements.                                                                                                                                                                              | The literal schema is 237 proxy tokens. Removing it saves at most 23.054M replayed input, 23.2k/task or 0.28% raw, before accounting for the short replacement and compaction.                                                                                                                                                                                                                            | Preserve all result fields and blocker definitions in the enforced schema and instruction.                                                                                                              |
| Put common instructions before changing worktree paths, brief, and retry pointer; preserve useful message boundaries. Keep inherited MCP servers disabled as `launch.ts` already does.                                                                                                                                                                                                                             | Credit zero new cache saving until measured: input is already 97.12% cached. Converting 10% of the remaining 238.381M uncached input to cache reads would shift 23.838M tokens to cheaper processing, with zero raw-token reduction.                                                                                                                                                                      | Confirm boundaries and cache-write behavior in the installed CLI. Do not invent a CLI cache-TTL flag or expect identical prefixes alone to guarantee hits.                                              |
| Give briefs a soft 1,500-token budget; link exact owning spec sections, acceptance commands, fixtures, and entry points. Exempt information needed to disambiguate the contract.                                                                                                                                                                                                                                   | Capping measured briefs at 1,500 would remove 916,858 introduced tokens; multiplying each reduction by its request count gives a replay ceiling of 66.783M, 67.3k/task (0.80% raw). Actual saving is smaller when compaction drops text or detail must stay.                                                                                                                                              | Never trim test names, behavioral distinctions, risk areas, or required references to meet a quota.                                                                                                     |
| Add a small retry manifest in `evidence.ts`: unchanged contract reference, base/head and worktree status, exact first failing command/assertion and bounded output, current diff stat/paths, approaches tried, unresolved hypothesis, and environment/base-failure evidence. Keep full logs and patch on disk. Bound approaches to about 400 tokens and failure excerpts to about 800, with pointers for overflow. | Already passing a directory means zero automatic saving from merely keeping it. Avoiding one full median patch dump removes about 6.7k introduced tokens from an affected retry; archive p90 is 27.0k. If better handoffs eliminate 20% of nonwinner token spend, the cohort saves 865.207M raw, 872.2k/task (10.40%). This is a target, not an observed retry effect.                                    | Retain exact failures and recoverable full evidence; cap summaries rather than destroying evidence. Do not restart completed implementation without checking the branch.                                |
| In routing, pilot Luna high instead of max on bounded implementation/interface work. Keep Sol medium for specification and Sol high for complex claims/research. Pilot Luna medium for bulk text and low for genuinely mechanical tasks. Keep high on unresolved cross-module/critical work; escalate on a concrete failed hypothesis.                                                                             | Halving all observed reasoning output alone saves only 12.8k/task (0.15% raw). Historical implementation Luna high/max burdens were 2.920M/9.174M raw per landed task; interface 4.508M/16.377M. Gaps of 6.253M and 11.869M/task are experiment ceilings, not forecasts. Bulk-text reasoning was 15.1k/task, so halving it saves 7.6k directly. No mechanical baseline exists: budget zero proven saving. | Vary effort with model, inputs, acceptance, and task-size bands held fixed. The old high/max cohorts are not matched; more thinking may reduce expensive rereads and retries.                           |
| Use Sol high as the raw-token candidate for claims; retain Luna as the implementation cost candidate. Keep Terra high as a bounded interface/research trial, with source/citation review for research. Do not broadly reroute critical work from this small sample.                                                                                                                                                | Claim winning histories differ by 14.686M raw/task (64.1%) in favor of Sol; implementation differs by only 0.006M/task between Sol and Luna. Terra interface used 0.539M more raw/task than Luna, so credit no raw saving there. One Terra research task supports no general saving forecast. Luna's lower token prices can reverse the monetary preference for claims.                                   | Use assignment-time model cohorts including all fallback costs and failures; winning-model averages alone cannot justify switching.                                                                     |
| Keep current 160k/200k compaction thresholds and context overrides as the control; make future thresholds explicit by model rather than testing `includes('luna')`/`includes('sol')`. Retain 4k general tool output while requesting smaller scoped outputs. Pilot fewer compactions only on sessions that repeatedly compact.                                                                                     | Twenty percent fewer compaction requests, at observed average size, would remove about 10.205M uncached input and 11.229M raw including output, before additional replay/rereads. Credit zero net saving until measured; raising thresholds increases retained history and lowering them incurs more summary/cache cost.                                                                                  | Preserve acceptance state, pending checks, changed files, and next action. Keep headroom for tools/output. Do not globally switch threshold scope or shrink the context window as a proxy for trimming. |
| Supply a bounded path/symbol map for declared files and direct dependencies in the brief; use `rg` names before bounded line reads, summarize passing checks, and request only changed diagnostics. Avoid re-reading injected root `AGENTS.md` when its path/digest matches; still discover applicable nested instructions.                                                                                        | Ten percent less read-batch output is 12.184M fewer introduced proxy tokens, 12.3k/task before replay. Skipping all 3,022 root-sized instruction reads has a ceiling near 0.943M introduced tokens; the mixed batch total is not the saving. Exact repeated-read output offers only 0.105M directly evidenced tokens.                                                                                     | Do not preload whole directories, suppress failing diagnostics, or skip newly relevant files. Verify index entries against the attempt base and invalidate after edits.                                 |
| Make service tier selectable per task, with Standard as the allowance-efficiency trial and Fast retained for latency-sensitive critical work.                                                                                                                                                                                                                                                                      | Zero raw-token reduction. If all measured priority traffic actually received Fast and the documented included-allowance multiplier applies, Standard would use 40% of that allowance, a 60% reduction. Purchased-credit comparison is 50%. These are conditional policy calculations, not observed allowance savings.                                                                                     | Confirm tier support and actual processing/allowance telemetry; slower work must still finish within task limits. Do not silently substitute API Flex.                                                  |

The earliest practical sequence is to fix measurement, simplify duplicate prompt
material, improve retry manifests, and target excessive reads. Then run the
existing claim/interface cost experiments with assignment-time accounting and
separate effort experiments. Adopt a routing change only when it improves the
complete landed-task denominator without worsening acceptance or escaped defects.

For each arm record all started tasks, first-attempt acceptance, eventual landing,
nonlanding/cancelled expenditure, retries, uncached/cached/output/reasoning usage,
compaction usage, wall time, and promotion regressions. Stratify by class, estimate
size, routing version, and base. Keep open tasks right-censored rather than
declaring them failures or omitting their spend. Start with at least 30 completed
tasks per arm as a screening floor, report uncertainty, and continue sampling
when rare defects or sample imbalance prevent a quality conclusion. Require
unchanged gates plus review of landed behavior; passing a cheap existence test
does not establish that a research report's citations or recommendations are sound.

## Interpretation decisions and scope

“Landed” here means integrated/merged, not necessarily already promoted to main;
promotion regressions remain an independent quality measure. Missing usage is
reported separately. Cached input is counted once. Origin shares are visible-text
proxies, and savings are ceilings or explicit conditional targets. Historical
model/effort differences are observational. No acceptance or owning specification
was changed, and no new product decision is asserted by this report.

The only persistent writes outside the report are the required reference clones
and their lines in the main checkout's `.reference/INDEX.md`; these preserve
auditable primary sources. All temporary analysis stays inside this worktree.
