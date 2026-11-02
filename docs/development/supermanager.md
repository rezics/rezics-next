# Supermanager

The supermanager is the resident session that keeps direction for the Goals: direction, priorities and scope with the
maintainer, the allowance runway, critical grants and deadlocks between owners. Managers own the work and decide among
themselves when the supermanager is unreachable ([delivery](delivery.md)). A token-free watchdog supervises the
supermanager and raises the alarm when it is stuck.

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

A watchdog script supervises this resident session without model tokens. It treats the supermanager as stuck when a
manager's question or blocker has had no reply for 30 minutes and the session transcript has not changed for 30
minutes.

Recover in this order, stopping as soon as it responds:

1. The watchdog types a one-line note into the resident window naming the waiting items.
2. After ten more minutes without activity, it alerts the project's Telegram group with the resume command.
3. Whoever answers the alert restarts the session in that same window and registered thread with
   `claude --resume <registered-thread-id> --permission-mode bypassPermissions`. Never start a second supermanager.

While the resident is stuck, managers keep independent work moving under the owner-agreement rules and escalate only
architecture, scope or choices requiring the maintainer.
