# Supermanager

The supermanager is the resident session that keeps direction for the Goals: direction, priorities and scope with the
maintainer, the allowance runway, critical grants and deadlocks between owners. Managers own the work and decide among
themselves when the supermanager is unreachable ([delivery](delivery.md)). The performance Goal supervises the
supermanager and recovers it when it is stuck.

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

Performance is the efficiency owner and supervises this resident session. Its
[30-minute reviews must act](delivery.md). Treat the supermanager as stuck when a manager's question or blocker has
had no reply for 30 minutes, a stall alarm has had no action for 15 minutes, its window shows a pending dialog/question,
or its Claude process is gone. Use the registered resident session and its actual terminal window, rather than starting
a second session or guessing a process identity.

Recover in this order, stopping as soon as it responds:

1. Send an inbox message identifying the stuck item.
2. After ten minutes, inspect the resident window with `tmux capture-pane -p -t "<resident-window>"`. If a dialog,
   menu or question is pending, send Escape with `tmux send-keys -t "<resident-window>" Escape`, then type the one-line
   note `Recovered by performance: <reason>. Continue the Goal.` and Enter.
3. If the Claude process is gone, restart it in that same window and registered session using
   `claude --resume <registered-thread-id> --permission-mode bypassPermissions`, then send the same note.
4. Report what happened and what was done in the project's Telegram group.

Never interrupt a visibly active tool call less than 30 minutes old. While the resident is stuck, keep independent
work moving under the owner-agreement and efficiency rules. Escalate only architecture, scope or choices requiring
the maintainer. Recovery does not authorize a duplicate publication, process adoption or bypass of physical custody.
