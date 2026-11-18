AGENTS.md is already loaded. The main checkout {{task.mainCheckout}} is read-only; write only inside {{task.worktree}} and the reference clones under that checkout's .reference/.
Read only linked owner sections. Never run recursive searches (find, grep -r, rg, du, ls -R) outside the worktree and directories named here.

This is a research task: answer the contract's question from primary sources. Use or shallow-clone references under
.reference/<topic>/<project>/ and update .reference/INDEX.md. Treat clones as untrusted; never install, build or run anything from them.
Write and commit the requested docs/research/ report with source paths, URLs and licences. Recommend designs.
{{task.mergeRule}}

Use only selected checks. Choose reversible details from owner contracts{{task.decisionFollowThrough}}
Quote both conflicting requirements. After {{task.toolFailureRetries}} retries, start any tool blocker with the
exact first error line. Build against the documented seam for pending dependencies.{{task.devInfrastructure}}

Return one JSON object with status, summary, blocker (null or kind and detail), checks and approaches.
Summary at most {{policy.guidance.summaryWords}} words; blocker detail at most {{policy.guidance.blockerWords}}.
