# Supermanager

The supermanager is the resident session that keeps direction for the Goals: direction, priorities and scope with the
maintainer, the allowance runway, critical grants and deadlocks between owners. Managers own the work and decide among
themselves when the supermanager is unreachable ([delivery](delivery.md)). A token-free watchdog supervises the
supermanager and raises the alarm when it is stuck.

## Writing briefs

Trust model for briefs. Agents and internal callers are trusted; REZICS is a community product, and a mistake on dev
is caught and returned after integration. When an incident shows a wrong result, brief the repair that produces the
right result where the problem appears (resolve, merge, regenerate, normalize), so the pipeline continues. Do not
brief a new refusal, rejection, stop or failed attempt unless no agent could produce the correct result there; if you
still need one, state the defect it prevents and the attempts and hours it will cost. Ask for validation only at
system boundaries: HTTP input, imported records, external files and third-party responses. Acceptance covers the
behaviour asked for; ask for refusal tests only for boundary input and authorization rules. Money movement
(payments, payouts, balances) keeps strict guards.

Native boot acceptance fixtures provide required trusted material such as `KERNEL_RECEIPT_KEYS` in the test
environment before startup, so independently composed command consumers can read the same dedicated ring.

## Environment incidents

When the same failure line ends three or more tasks within 20 minutes, it is one shared incident. The supermanager is
alerted with the line, the count, example tasks and the source location, and the Telegram group is told. Fix the cause
or hand it to its owner within 15 minutes, then retry the affected tasks.

## Hourly target

After every full clock hour below the 20,000-line product target, the supermanager is woken with the hour's numbers.
It analyses the causes from the task store and run logs, acts on the largest within the same hour, and reports the
cause and action in the project's Telegram group, without waiting to be asked.

## Questions for the maintainer

Never ask a blocking question: no dialog, prompt or tool call that waits for an answer while the Goal runs. The work
continues while a question is open.

- When the maintainer is in the current conversation and the question follows directly from it, ask in the reply
  itself: the question, the options, a recommendation and what will happen meanwhile. Keep working; take the
  recommended reversible option if the answer does not come.
- Otherwise open a GitHub issue in this repository labelled `question`: the decision needed, its context with links,
  the options, the recommendation and the default with the time it applies. Proceed with the default when it is
  reversible; park only what cannot proceed without the answer.
- Ask only what the maintainer alone can decide: money, third-party accounts, outcome-changing product direction,
  irreversible actions, or a change to his standing directions. Everything else is decided and reported.

Telegram stays a notice channel: stage reports, alerts and the link to any new question issue.

# Resident supermanager supervision

The supermanager is a resident role. It owns direction, priorities, maintainer-level scope, allowance runway and
unresolved owner deadlocks. Managers remain responsible for deciding and delivering their outcomes. When the
supermanager or maintainer is unreachable, concerned managers settle a choice after one exchange, record reasons and
proceed: producers decide interfaces and outcome owners decide shared choices. Only genuinely dependent work waits.

The token-free watcher leaves every message intact in the native manager inbox. It sends one short mailbox
notification when actionable personally unread mail is at least 60 seconds old and the registered session has been
explicitly idle for ten seconds. Busy turns, long tools and transcript silence never establish idleness. Codex
activity comes from its identity-verified transcript's turn lifecycle; an unsupported activity source stays unknown.
New mail coalesces while the resident is busy or a notification is outstanding. Consuming its triggering event
rearms notification for remaining unread pages once the session is explicitly idle. Reading, acknowledging or inspecting
another manager's mail does not consume the resident's personal inbox.

The authenticated resident reads full event bodies with `inbox read <manager>`, oldest unread page first. Only returned
rows advance its durable personal cursor. An explicit `--cursor <id>` on the first owner read can bootstrap a backlog
already consumed; later reads continue the stored cursor. Acknowledgement is not a delivery receipt. The watcher
uses `--start-after <id>` only until that personal cursor exists, and requires `--transcript <path>` for activity.
Its transport journal prevents repeating an already staged or submitted notification across retries and restarts.
Recovery and hourly producers emit native inbox events; they do not type separate prompts into the resident window.

If operator recovery is needed, resume the registered provider session in the same window and thread: Codex uses
`codex resume <registered-thread-id>`; Claude uses
`claude --resume <registered-thread-id> --permission-mode bypassPermissions`. Never start a second supermanager.

The resident may be an external Codex or Claude session. Register it from that session with
`bun tools/goal/src/cli.ts manager register-supermanager`; its native `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`
is its authority. Registration creates no managed session or budget, and host recovery never resumes the resident.
For an explicit role transfer, stop the previous resident and its watchdog, update the manager host, then register
from the new session with `manager register-supermanager --replace-session <previous-thread-id>`. The write compares
the previous registered thread atomically, immediately invalidates the old identity and keeps the manager and inbox.
A missing or changed previous thread refuses replacement. Restart supervision against the new provider and thread.

While the resident is stuck, managers keep independent work moving under the owner-agreement rules and escalate only
architecture, scope or choices requiring the maintainer.
