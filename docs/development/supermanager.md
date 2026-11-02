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
