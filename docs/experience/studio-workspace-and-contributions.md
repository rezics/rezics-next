# Studio, contributions and editing

## Workspace outcomes

Studio shows the selected Agent's admitted work, drafts, contributions, review
requests and publication selections. Visiting Studio does not confer creator or
owner authority. Search and navigation use bounded owner/context queries.

Studio's selected Agent is a [workspace layer](../contracts/identity-and-access.md#acting-identity-layers)
kept in its route. It starts from the session Agent, and switching it, for example
to manage a writer Agent's Works, leaves the signed-in session Agent unchanged.
Studio reads and commands act as the Studio Agent, including publishing, which
takes precedence over task publishing defaults. Another tab may open Studio for
a different Agent without interfering.

## Editing and adoption

Keep the Work/Main Version, independent contribution and currently selected
publication visible where they affect an action. Editing a translation does not
edit its source; adopting it does not transfer contributor control. Two same-language
alternatives remain usable. Preview pins the intended state and context.

## Conflicts and recovery

Autosave/private draft, shared editing and publication are distinct outcomes.
Expected-head conflict preserves local input and enables compare/retry/explicit
merge. Staged imports show progress, unresolved correspondence and cancellation.
Restoring a structure explains that referenced content is not recursively restored.

## Acceptance

Qualify create/publish/read, multi-language contribution, stale draft, denied
adoption, failed media processing, exact historical comment, interrupted import
and switching the Studio Agent without changing the session Agent.
Ordinary UI edits must preserve advanced relation/Filter/selection state.
