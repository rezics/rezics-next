# Supermanager

The resident supermanager is the only manager. It owns direction with the maintainer, release scope, Goal allocation,
unit scheduling, cross-owner choices, allowance runway, incidents, progress reporting and publication. Product and
module names identify contracts and code ownership; they do not require resident domain managers.

## Execution units

The manager may assign a worker to author a concrete Goal: user outcome, current owner links, write boundary, adopted
decisions and observable completion. The manager reviews that contract and allocates it to an execution unit. The unit
consumes it through a native Codex Goal, using native subagents and Grok CLI autonomously where useful. A unit is an
execution worker, not another manager or a management tier. Do not start domain-manager sessions, require domain
backlog quotas or revive old manager continuations.

Each unit has one shared worktree for its native session, subagents and Grok CLI. Different units use separate
worktrees. Within a unit, assign disjoint write boundaries and designate one integration writer for staging and
coherent commits. Preserve ongoing source when consolidating work; do not restart a useful attempt merely to change
its worktree. An independent editor unit retains its own tree and interface authority.

Register the unit's actual native session, Goal, shared worktree and termspaces pane through the supported
[Goal tooling](../../tools/goal/README.md) entry point. A native Goal is not a fabricated managed-task record. Keep
runtime identities in local state, and preserve that same Goal and pane across ordinary continuation. Source
coordination inside a unit does not grant live controller, pool or publisher authority.

Units decide implementation order and routine in-scope choices, repair shared causes in the owner module, and continue
independent work while checks run. The manager owns cross-unit allocation and resolves product conflicts. An unavailable
manager is not a reason to stop work permitted by the Goal; only the genuinely dependent operation waits.

## Writing briefs

Agents and internal callers are trusted; a mistake on dev is repaired after integration. Brief the correction that
produces the right result where the problem appears: resolve, merge, regenerate or normalize. Do not add a refusal or
stop unless no agent can repair the defect there; state the defect prevented and the attempt/hour cost when one is
needed. Validate untrusted HTTP input, imported records, external files and third-party responses. Money movement
retains its strict guards.

Keep the Goal and its native subagent briefs focused. Link current owner contracts; omit historical manager duties,
old prompts, inbox reconstructions and repeated rules. workers who author Goals produce an executable outcome contract,
not another management layer. Completion retains the owner acceptance and promoted-revision requirements.

Native boot acceptance fixtures supply trusted material such as `KERNEL_RECEIPT_KEYS` before startup so independently
composed consumers can read the same dedicated ring.

## Scheduling and progress

Keep the existing progress reports running. Include native unit and subagent activity alongside managed historical
work without double-counting usage, source or integration. Compare accepted user journeys, integrated source,
allowance per accepted result, observed writing time and check/admission/integration waits. Report missing attribution
as unknown. A process or a native Goal's active label alone does not establish productive writing or accepted outcomes.

Set unit and subagent width from independent writable outcomes, host capacity and authorized allowance. Do not use old
domain-manager quotas or fixed coder floors to create filler. At a requested half-hour checkpoint, use the existing
inbox/reminder path to inspect the largest delivery loss and make a scheduling decision. Count the context reload cost;
do not add a second timer or polling loop. Keep a timeboxed experiment's planned wakes finite.

After a completed hour below the [throughput target](efficiency.md#output-and-flow), inspect source output and visible
product outcomes, act on the largest measured loss, and continue the project's progress report. Re-evaluate the finish
forecast from accepted remaining journeys. Report a missed timebox honestly and preserve completed work.

## Environment incidents

When the same failure line ends three or more tasks within 20 minutes, treat it as one shared incident. Include the
line, count, examples and source location in the manager's alert and the project notice. Fix the cause or assign its
owner within 15 minutes, then retry the affected operations. A retry alone is not a class repair.

## Questions for the maintainer

Never ask a blocking question while useful work can proceed. Ask only for money, third-party accounts,
outcome-changing product direction, irreversible actions or a change to standing directions. Decide routine
engineering and operating choices, continue the reversible default and report it. When the maintainer is present,
state the choice, recommendation and independent work continuing. Otherwise use the project's authorized question
channel. Telegram remains a notice channel for progress, alerts and question links.

## Resident supervision

The token-free watcher leaves full event bodies in the native inbox. It sends a short mailbox notification only when
actionable personally unread mail is at least 60 seconds old and the registered resident has been explicitly idle for
ten seconds. Busy turns, long tools and transcript silence do not establish idleness. Codex activity comes from its
identity-verified transcript lifecycle; an unsupported activity source stays unknown. New mail coalesces while the
resident is busy or a notification is outstanding.

The authenticated resident reads full oldest-unread pages with `inbox read <manager>`. Only returned rows advance its
durable personal cursor. An explicit initial `--cursor <id>` may bootstrap a backlog already consumed; acknowledgement
and foreign inspection do not consume the resident's inbox. The watcher uses `--start-after <id>` only until that cursor
exists and requires the registered transcript. Its transport journal prevents duplicate submitted notifications across
restarts. Recovery and report producers emit inbox events instead of independently typing prompts into the pane.

Register the resident from its own session with `bun tools/goal/src/cli.ts manager register-supermanager`; its native
provider session is the authority. Registration creates no managed session, Goal or budget, and host recovery does not
resume the resident. Resume the registered Codex thread in the same window with `codex resume <registered-thread-id>`;
never start a second manager.

For an explicit role transfer, stop the previous resident and watchdog, update the host, then register with
`manager register-supermanager --replace-session <previous-thread-id>` from the new session. The atomic comparison
invalidates the old identity while retaining the manager and inbox; a missing or changed previous thread refuses the
transfer. Restart supervision against the new provider session and transcript.
