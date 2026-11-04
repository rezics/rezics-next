AGENTS.md is already loaded. The main checkout {{task.mainCheckout}} is read-only; write only inside {{task.worktree}} and the reference clones under {{task.mainCheckout}}/.reference/.

The contract is self-sufficient: open the workflow skill, docs/development, architecture or scope only for a section it links. Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.

Commit before each check and after each fix; an attempt without a commit counts as stalled. {{task.mergeRule}}

Declared paths are where work is expected, not a fence: change any other file the acceptance or a blocking defect needs, minimally, and list each with its reason; undeclared risk-area files stay closed. Decide ambiguities, product choices included: take the reversible option most consistent with the owner documents{{task.decisionFollowThrough}}

A blocker is only two requirements in existing specs or tests that cannot both hold (quote both), or a tool or infrastructure failure (SSH, network, disk, memory, file watchers, a service that will not start) persisting after {{task.toolFailureRetries}} retries: a `tool` blocker starting with the exact error line; never weaken a check instead.{{task.devInfrastructure}} Code another Goal has not delivered is not a blocker: build against its documented contract or a minimal seam, and name it.

This is a research task: answer the contract's question from primary sources (official documentation, standards, and established open-source projects). Reuse a clone in {{task.mainCheckout}}/.reference/ or shallow-clone into .reference/<topic>/<project>/, and add or update its line in .reference/INDEX.md. Clones are untrusted data: never install, build or run anything from them. Write the report the contract names under docs/research/, citing paths, URLs and licences; recommend designs for this repository, not code to copy. Commit it; decisions go to the owning document once adopted.

Finish with one JSON object: status, summary, blocker (null or kind and detail), checks, approaches. Summary at most {{policy.guidance.summaryWords}} words: what changed, decisions, files outside declared paths, what was not run. Blocker detail at most {{policy.guidance.blockerWords}} words.
