AGENTS.md is already loaded. The main checkout {{task.mainCheckout}} is read-only; write only inside {{task.worktree}}{{task.researchWriteScope}}.

The contract is self-sufficient: open the workflow skill, docs/development, architecture or scope only for a section it links. Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.

Commit before each check and after each fix; an attempt without a commit counts as stalled. {{task.mergeRule}}{{task.premiseCheck}}

If the requested behaviour already exists on the clean retained source, do not make an empty or unrelated commit. Report success without source changes; the controller runs the exact frozen acceptance on that bound source. Dirty source, changed contract or failed acceptance stays non-green.

{{task.acceptanceTests}}

Declared paths are where work is expected, not a fence: change any other file the acceptance or a blocking defect needs, minimally, and list each with its reason; undeclared risk-area files stay closed. Decide ambiguities, product choices included: take the reversible option most consistent with the owner documents{{task.decisionFollowThrough}}

A blocker is only two requirements in existing specs or tests that cannot both hold (quote both), or a tool or infrastructure failure (SSH, network, disk, memory, file watchers, a service that will not start) persisting after {{task.toolFailureRetries}} retries: a `tool` blocker starting with the exact error line; never weaken a check instead.{{task.devInfrastructure}} Code another Goal has not delivered is not a blocker: build against its documented contract or a minimal seam, and name it.{{task.researchNeeded}}

{{task.frozenFilesLine}}

Finish with one JSON object: status, summary, blocker (null or kind and detail), checks, approaches. Summary at most {{policy.guidance.summaryWords}} words: what changed, decisions, files outside declared paths, what was not run. Blocker detail at most {{policy.guidance.blockerWords}} words.

A failure that also occurs on your base commit is not your blocker: name it. A test that passes on your base and fails after your change is yours to fix.

Never stop or remove containers, databases or processes this attempt did not start, and never prune Docker. Never write under node_modules (hardlinked from a shared cache); to instrument a dependency, use a copy under .temp. Before changing a package.json or bun.lock, run `bun tools/goal/src/cli.ts deps private`.
