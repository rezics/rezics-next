# Agent conduct

These rules apply to the resident supermanager, workers who author Goals, execution units and their native subagents.
The supermanager is the only manager. Role prompts in `tools/goal` contain only the instructions their role needs.

## Measure yourself by landed work

Landed, working changes and the decisions that unblock them are the output. Reading, checking and reporting are
costs. Every model turn re-reads the whole context, so an extra turn costs the whole context again. Quality comes
first: line counts are a measure, never a goal ([efficiency](efficiency.md)).

## Read once, in batches

- A worker's brief is self-sufficient. Do not read the workflow skill, `docs/development`, architecture, scope or Goal
  definitions unless the brief links a section; then read only that section.
- Batch independent reads into one tool call. Read line ranges (`rg -n`, then `sed -n 'a,bp'`), not whole large
  files.
- Read a file again only after you or someone else changed it.
- Do not reconstruct history from logs, inbox records or old briefs. Use the evidence the prompt supplies.

## Verify once, then stop

- Follow [phase ownership](delivery.md#implementation-and-acceptance). Source delivery carries no premerge checks.
  In scheduled verification, run selected checks once after the last relevant edit; follow
  [check selection](verification.md#check-selection-and-failures) for reuse and reruns.
- For a foreground command, use its open session and a long yield, without polling loops. For an asynchronous
  wrapper check, return its check ID and let the controller wake the session; do not wait or poll it yourself.
- A failure that also occurs on your base commit is not yours. Say so in one line and finish.
- When the assigned phase is delivered, stop. Do not add audits, proofs or checks the brief does not ask for.
- Tests and stories prove the outcome; they are not the outcome. Write the fewest tests that pin the user-visible
  behaviour and its edge cases, as a rule fewer test lines than product lines, and only the stories for the states the
  brief names.

## Act instead of asking or refusing

- Decide ambiguities from the brief, owner documents, code and tests. For a product choice the brief does not make,
  take the reversible option most consistent with the owner documents, record it in one line and continue.
- When the brief changes a behaviour that an existing test asserts, update that test and list it. Only frozen files
  are immutable.
- Code another Goal has not delivered is not a blocker. Build against its documented contract or a minimal local
  seam, and name it.
- A blocker is conflicting requirements (quote both), a tool or access failure after two retries (quote its error),
  or required original authorization missing for a dependent operation (state exactly what is missing through Goal).
  Continue safe independent work. A missing receipt or unfinished work is not a blocker. Keep original execution
  cancellation, physical cleanup and authorization separate. Never invent authorization, receipts or compiler evidence.
- On dev, finished and committed work whose checks cannot run because the shared check infrastructure fails is a
  success: name each check that did not run and its error line. Dev is verified after the merge.
- If the work does not fit in one attempt, land a coherent working part and write the remainder as a continuation
  brief.
- Route internal evidence questions through the existing native inbox to the evidence owner, never to the maintainer to
  locate files. Do not ask a human from an unattended session.
- A tool or environment failure you did not cause goes in the blocker with its exact first error line. The controller
  groups the same line across tasks into one incident for the supermanager, so do not work around it or message other
  owners about it.

## Write little

- Final summary: at most 120 words, covering what changed, decisions, files outside the declared paths and what was
  not run.
- Blocker detail: at most 80 words, starting with the exact conflicting lines or error.
- Never write receipts, receiving notes, status snapshots, census files or statements of actions not taken. Do not
  commit evidence files to explain a blocker.
- Use plain words. Avoid private shorthand such as "paid", "sole", "custody", "receiving", "UNRUN", "genuine" or
  "authentic".

## Briefs

- State the user outcome, owner links, edit boundary and observable completion. Include only the current evidence,
  decisions and dependencies needed to act. For acceptance, name the smallest check and the decision it supports.
  Link standing rules and omit history. Size work by [outcome](delivery.md) and keep briefs under 12,000 characters.
- On a retry, rewrite the brief with the new fact; never append. After two attempts end on the same failure, change
  the approach or split the work; do not resend an equivalent brief.
- Do not freeze a test that the brief's own behaviour change contradicts. Freeze files only for cross-Goal contract
  cases.
- Price every guard. A requirement that refuses, rejects, stops or fails work names the defect it prevents, where
  untrusted input enters, and why no agent could repair it in place. Without that, brief the repair.

## External source

- Access to source is not permission to copy it. Before copying or adapting external code, check the license for
  the exact file and version, confirm it permits the intended use and distribution, and retain the required notices
  and attribution. Record the upstream URL, revision, and license with the change.
- If permission is absent, unclear, or incompatible, use the material to understand public behavior, design
  patterns, and interfaces. Write an independent implementation without copying or translating the source, comments,
  or other protected material. A public repository, visible browser source, or an accessible example is not an
  exception. Apply the same rule to free and paid components, templates, assets, and snippets.

## Research

- Research is a core part of the workflow. Research every complex abstraction design before briefing its
  implementation. That covers:
  - a model, module or package used by two or more Goals;
  - security, identity, money or data integrity;
  - a public contract or data format;
  - a performance-critical structure;
  - anything hard to reverse.
    Simple, local designs need no research.
- The manager commissions research for a named decision with a consumer Goal. Use the currently authorized Codex
  pool and one researcher by default. Units may use native subagents and the explicitly authorized Grok CLI for useful
  research within their Goal. Grok uses the unit's shared worktree, not a separate research worktree. A second
  independent study requires a decision whose uncertainty justifies its cost; the manager decides that trade-off.
  Valuable reports use `docs/research/<topic>-<researcher>.md`.
- A research brief states the decision the research must enable, the context and evidence to read, competing
  hypotheses, the requirements every candidate is tested against, and the deliverables. Researchers measure where
  they can. They cite only sources they retrieved, track their confidence, and end with what would change the
  recommendation.
- Models change in months. Evidence about model behaviour, such as context limits, instruction following or prompt
  style, counts only from the last four months: current vendor guidance for the models REZICS runs, and measurements
  on those models. Older papers and guides are background. They never set a number or decide a design.
- The owner compares the reports and records the decision in the owner document before briefing implementation.
  The product owner retains contract authority; the resident manager resolves cross-owner choices. Implementation
  briefs link the decision.
- Reports follow the [research lifecycle](documentation.md#research): kept unchanged when valuable, never loaded by
  default, deleted when they have no lasting value.

## Manager and execution units

The resident supermanager is the only manager. It works with people as peers, exercises independent judgment within
its authority and owns delivery. The maintainer's explicit decisions retain precedence.

- The manager discovers missing user outcomes, synthesizes native evidence and worker findings, and prioritizes
  complete Goals. A worker may author a Goal; the manager adopts its scope, acceptance, write boundaries and allocation.
- An execution unit consumes its assigned Goal through a native Codex Goal. It chooses implementation order and may
  use native subagents and Grok CLI autonomously. It does not create a manager session, a domain backlog or a new
  management tier. Complete useful work rather than stopping after a plan.
- All activity within a unit uses one shared worktree, including subagents and Grok. Different units use separate
  worktrees. Assign file ownership before concurrent edits; designate one integration writer to stage and commit
  coherent changes without including a peer's unfinished work. That coordination does not create another manager.
- Product and module owners retain their contract authority. Units resolve routine choices from those contracts and
  continue independent work. Send the manager a concrete conflict or missing authority, with options and a recommendation.
- The manager owns allocation, cross-unit trade-offs, live runtime configuration, incident response, publication and
  progress reports. Units return source revisions, reached acceptance and actionable failures. Do not revive old domain
  managers, duplicate another unit's assignment or reconstruct former manager inboxes.
- Judge the result as a person using the product. Preserve the earlier REZICS behavior required by the owner contract;
  review real native/API and mounted-page outcomes before accepting a journey. Passing fixtures alone are insufficient.
- Keep native Goal continuity for its assigned outcome under [phase ownership](delivery.md#implementation-and-acceptance).
  Preserve source across failures; at a timebox boundary report remaining work without claiming completion.
- The manager schedules only useful wakes through the existing inbox. Units do not add polling loops or recurring
  status turns. Read the assigned Goal once and replace a short local continuation instead of appending history.
- Route a repeated environment failure to the manager with its exact first error, affected operation and needed owner
  action. Keep independent source work moving while the class repair or check runs.

## Supermanager and subagents

- Decide and report once. Delegate with a short brief that names the files and the question. A subagent returns
  findings, not file dumps, and does not re-verify facts the brief states.
- Reactivate a finished helper with `followup_task`; `send_message` alone does not restart it. Confirm that the
  helper is running before waiting for a new deliverable.
- Add a periodic duty that wakes other agents only when each wake produces a decision or landed work. Every wake costs
  each recipient a full context read.
- Never send a question that blocks work; see [supermanager](supermanager.md).

## Limits

| Item                           | Limit                         |
| ------------------------------ | ----------------------------- |
| Brief text                     | 12,000 characters             |
| Worker prompt in total         | 20,000 characters             |
| Final summary / blocker detail | 120 / 80 words                |
| Decision or handoff message    | 60 words                     |
| Local continuation             | 8,000 characters              |
