# Agent conduct

These rules apply to every agent in this repository: Codex workers and managers, the Claude supermanager and Claude
subagents. Role prompts in `tools/goal` repeat the parts that apply to each role.

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

- After your last edit, run the check the brief names and the tests in the files you changed, once each. Rerun only
  after a relevant edit.
- Wait for a long command in one call with a yield of at least 300 seconds. Never poll faster, and never use sleep
  loops, `ps` or `pgrep` to wait.
- A failure that also occurs on your base commit is not yours. Say so in one line and finish.
- When the acceptance condition holds, stop. Do not add audits, proofs or checks the brief does not ask for.
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
- A blocker is only one of these: two requirements that cannot both hold (quote both), or a tool or access failure
  that persists after two retries (quote the error line). Missing authority, a missing receipt and unfinished work
  are not blockers.
- On dev, finished and committed work whose checks cannot run because the shared check infrastructure fails is a
  success: name each check that did not run and its error line. Dev is verified after the merge.
- If the work does not fit in one attempt, land a coherent working part and write the remainder as a continuation
  brief.
- Never ask a human from an unattended session.
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

- A brief states the outcome in user terms, owner links, what done means and the decisions already made. Size the work
  by its outcome ([delivery](delivery.md)); keep the text under 12,000 characters.
- Leave out history. Prohibitions must not outweigh instructions.
- On a retry, rewrite the brief with the new fact; never append. After two attempts end on the same failure, change
  the approach or split the work; do not resend an equivalent brief.
- Do not freeze a test that the brief's own behaviour change contradicts.

## Managers

- A manager synthesizes what its workers report (results, decisions, conflicts, duplicated or missing work across
  tasks) and turns it into decisions and the next briefs. Workers do not read other workers' tasks; the manager reads
  them once for all.
- Your outputs are ready briefs and decisions. Keep at least eight ready briefs in your Goal's backlog.
- Do not sleep or poll. End the turn; the controller wakes you on an inbox event.
- Send only decisions, questions and handoffs: one message per decision, at most 60 words. Never send
  acknowledgements, receipts, status reports or lists of things you did not do.
- Read your brief and continuation once per session. Keep the continuation under 8,000 characters and replace it
  rather than append to it.
- Act on every stopped task within an hour: retry with a rewritten brief, split it or cancel it.
- A shared environment problem goes to the supermanager as one `blocker` with the exact error line when its fix needs the
  main checkout or the live control plane, or when its owner has not fixed it within 15 minutes. Owners fix or escalate;
  they do not forward an environment problem to another manager.

## Supermanager and subagents

- Decide and report once. Delegate with a short brief that names the files and the question. A subagent returns
  findings, not file dumps, and does not re-verify facts the brief states.
- Add a periodic duty that wakes other agents only when each wake produces a decision or landed work. Every wake costs
  each recipient a full context read.
- Never send a question that blocks work; see [supermanager](supermanager.md).

## Limits

| Item                           | Limit                         |
| ------------------------------ | ----------------------------- |
| Brief text                     | 12,000 characters             |
| Worker prompt in total         | 20,000 characters             |
| Final summary / blocker detail | 120 / 80 words                |
| Manager message                | 60 words; at most six an hour |
| Manager continuation           | 8,000 characters              |
| Wait interval                  | at least 300 seconds          |
