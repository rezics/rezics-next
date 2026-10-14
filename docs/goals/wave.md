# Waves: build, then prove

A wave puts implementation and full-stack verification in separate phases.
Every task in the **build** phase commits to one shared branch, `wave/<n>`, and
starts no stack. The **prove** phase then runs the whole suite on that branch at
a pace the host can carry and fixes what fails. The branch reaches `main` once,
through the ordinary gate.

Why: from 21:49 on 2026-10-13 to 05:23 on 2026-10-14, workers spent 43% of
their input waiting and 5% testing, against 10% editing. A third of all attempts
since launch went to record tasks. Many retries were the host's own congestion:
503s and resets while sixteen QA runs competed for five stacks. One batch run on
one branch replaces hundreds of per-task stack runs.

## A build task

The brief names the work and an area. It has no `tests:` and no `land: auto`.

1. Before editing, if your branch has no commits of its own: `git reset --hard
   wave/<n>` (your brief lives outside git and stays). If it has commits:
   `git rebase wave/<n>`. Program merges `main` into `wave/<n>` from time to
   time, so the pages and briefs you read there are current.
2. Implement. Write the tests that prove it: outcome tests for API rows, unit
   tests, and stories for surfaces. Read the row's existing outcome test as its
   specification. A brief's `paths:` do not limit a build task. Change any file
   the outcome needs, native modules included. Repair from reading the code:
   the run that shows the failure before and the pass after happens in the
   prove phase. When reading leaves two possible causes, repair the more likely
   one, add a test for each, and say which in the handoff. A handoff that only
   adds tests is a build task left unfinished.
3. Run only the checks that need no stack: `task goal -- check --only
   types,lint,guards`, plus `bun test` on unit test files that start no stack.
   Do not run `task goal -- test`, an integration or outcome test, a
   recording, or anything else that starts a QA stack. Those run in the prove
   phase.
4. Commit. Then `git rebase wave/<n>`, run the types check again, and
   `git push . HEAD:refs/heads/wave/<n>`. If the push is refused because
   another task moved the branch, rebase and push again. Resolve conflicts
   yourself; you know your change. If your change touches the model, an API
   schema or a native module, run `task gen` after the rebase and commit what
   it regenerates. Settle a conflict in generated files by running `task gen`
   again, never by hand.
5. Hand off with `RESULT: done`, the commit now on `wave/<n>`, and the test
   files the prove phase must run for your work. Push as often as a piece is
   whole. A task that ends early pushes what compiles and lists what is
   missing.

Never push to `main`, never rewrite `wave/<n>`, and never change another task's
committed work except to resolve a conflict with your own.

## The prove phase

`task goal -- regress --at wave/<n>` runs the suite in batches, and
`task goal -- confirm --at wave/<n> --lanes <QA slots>` runs every outcome
cell against that revision without touching main's confirmation record
(`task goal -- confirm --status --run <id>` shows a run's cells). Before the
first run, run `task gen` on the branch, commit what it changes, and pin the
run to that commit. `task gen` obtains the pinned Fuseki image through
`task jena:image`'s shared implementation; concurrent callers wait for one build
per tag. Never build that image by hand. The Jena regression stage runs the
complete native suite's `module-test` target once at the pinned wave tip, in
addition to the focused native proofs. A regress run holds the heavy QA turn for its
whole length, and build workers' type checks queue behind it. Start one only
when the build tasks have handed off. (2026-10-14: a unit run started at 07:15
held builders' final checks for 50 minutes, and eight confirmation lanes failed
at startup on an unbuilt image.) Each failure
becomes a fix task on the same branch. Its brief carries the failing test and
its output, and a fixer may run that one test on a stack. When the suite is
green, records are captured in one run, and `wave/<n>` merges into `main`
through the gate.
