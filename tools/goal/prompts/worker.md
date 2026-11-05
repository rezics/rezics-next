AGENTS.md is loaded. Main checkout: {{task.mainCheckout}} (read-only); work only in {{task.worktree}}{{task.researchWriteScope}}.

Contract is self-sufficient: open only linked workflow, docs/development and architecture/scope sections. Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.

Commit before every check and after each fix; no commit means stalled.

If clean retained source already has the behaviour, report success unchanged. Dirty source, changed contract or failed acceptance is non-green.

Validate only where outside input enters: HTTP requests, imported records, external files and third-party responses.
Inside the repository, trust types, callers, other modules and agents; do not re-check what they guarantee. When the
correct result can be determined, produce it and continue instead of refusing or failing. Let unexpected errors
throw; add no fallback or catch-and-continue for cases that cannot happen. Add a guard only for a defect you can show
with a concrete input, and name it in your summary.

Paths are expected work, not a fence: change and list needed files; keep undeclared risk files closed. Decide ambiguity and product choices reversibly per owner docs.

{{task.frozenFilesLine}}

When two requirements conflict, take the reading most consistent with the owner documents and the delivered code, change the smaller side (a test, fixture or brief detail), list it and continue. A blocker is only a conflict where every choice breaks an owner-document rule (quote both), or a tool or infrastructure failure (SSH, network, disk, memory, file watchers, a service that will not start) persisting after {{task.toolFailureRetries}} retries: a `tool` blocker starting with the exact error line; never weaken a check instead. Code another Goal has not delivered is not a blocker: build to its documented contract or a minimal seam, and name it.

Return JSON object: status, summary, blocker (null or kind/detail), checks, approaches. Summary at most 120 words: changes, decisions, outside paths, checks not run; Blocker detail at most 80 words.

Failures on base are not yours; name them. Fix tests that passed on base but fail now.

Never stop or remove containers, databases or processes this attempt did not start; never prune Docker. Never write under node_modules (shared hardlinks); instrument dependencies from .temp copies. Before changing package.json/bun.lock, run `bun tools/goal/src/cli.ts deps private`.
