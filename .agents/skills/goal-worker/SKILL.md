---
name: goal-worker
description: Run a REZICS Goal worker's targeted checks and recorded jobs, inspect failures, and prepare its handoff. Use during worker execution; wave build/prove work uses goal-wave.
---

# Goal worker execution

The [worker protocol](../../../docs/goals/worker.md) defines authority and handoff.
Follow the brief's check selection. This procedure does not authorize broader QA.

## Tests and checks

Fixtures grant access through `grantFixtureAuthority`; the guard refuses a new direct write.

An outcome test states what one kind of person gets from the public API of a
real stack; it mocks none of our own modules. If your task writes outcome
tests, write one for each persona the brief names and show that each fails on
`main` for the stated reason. If your task implements, make those tests pass
and do not edit them: a test that asks for the wrong thing goes back to the
manager with the reason. Other tests go with the code they cover, at the lowest
tier that proves it. Prove your own work, nothing wider:

```sh
bun <main-checkout>/scripts/goal/goalctl.ts job -- task goal -- check     # before a handoff: types, type-aware lint, ast-grep, the brief's tests and guards
task goal -- check --only types,lint       # a subset while you work: types, lint, tests, guards
bun scripts/goal/goalctl.ts test <your test files>        # one file or a few while you work; one QA slot, also for files of several tiers; never --heavy for your own files
bun scripts/goal/goalctl.ts test --affected --list | tail -n 40   # what else your change reaches; do not run it
```

`check` prints `ok` or `failed` for each check and, for a failed one, only the
failing cases and the first lines of each error; the whole output is in the file
it names under `.temp/goal/check/`. It checks what the merge gate checks, from
the gate's own functions. A brief names its test files in the frontmatter list
`tests:`; without it `check` runs no test file and says so. Run it through
`job` and read the summary when it finishes inline or wakes your session.

Run the recorded check once before handing off `done`; it includes the
repository-wide guards.

The gate may run from an agent session, where `CLAUDECODE=1` makes `bun test`
print only failures and the summary. A test that runs `bun test` in a child
asserts its exit status or a JUnit report, never the printed test names; check
such a file once with `CLAUDECODE=1` set.

Tests are what this host runs short of, not workers. Name every file a step
needs in one `bun scripts/goal/goalctl.ts test` call: one call starts one stack, and a stack
costs about half a minute and a turn in a host-wide queue before any test runs.
Prove a change at the lowest tier that proves it: a unit or owner test needs no
stack. Run a passing file again only after a change that could affect it. A web
build, `depcruise`, type-aware lint or a fresh install takes 2 to 3 GiB: run
one at a time and not during your own QA run.

After `bun scripts/goal/goalctl.ts test <story file>`, read the PNGs under the run's `story-screenshots` directory to review your own change by eye; do not add screenshot helpers to stories.

List affected tests outside your claim in the handoff; the manager and the
program regression run them. Do not run whole tiers, `task qa`, Storybook suites
or browser journeys unless the brief asks. Backend work starts no dev server.
Frontend work checks changed screens with one dev server at a time against the
shared backend (`task web:dev`, `task urls`) and stops it before handoff. In a
shared worktree, start nothing; use what `.temp/goal/shared.md` lists and commit
only your paths with `git commit --only`.

## Tokens

Long contexts increase input per model call. Keep sessions and command output
focused on the decision. Read several files in one command. Bound what a command
prints (`rg -m`, `sed -n` ranges, `| tail -n 40`); never print a whole log or
list. Do not read again what you already have. A command's output is cut at about
16,000 characters, so ask for the part you need. `task --summary <task>`
describes one task; `task --list` prints every one.

`task operation -- <query>` answers where a Main API operation lives without a
search: its operationId, method and path, exposure, rate-limit family, whether
it takes a bearer and an idempotency key, the route's file and line, and the
test files that call it. The query is part of an operationId or of a path;
`--json` prints the same as data.

Use the main-checkout path supplied by dispatch for recorded jobs, while
keeping the working directory in your worktree. Run any command expected to
take over a minute through
`bun <main-checkout>/scripts/goal/goalctl.ts job -- <command…>`, including checks, QA-stack tests and queued
type checks. Declare all remaining checks that need no intervention as one
ordered sequence:

```sh
bun <main-checkout>/scripts/goal/goalctl.ts job --then 'task docs:check' --then 'task goal -- check' -- bun scripts/goal/goalctl.ts test <test-files>
```

The command after `--` runs first, followed by each quoted `--then` command in
order in the same worktree. Each command has its own log and four-hour deadline.
The owner stops at the first nonzero exit, signal, lost executor or timeout,
and wakes the worker once with the failing command and bounded errors. If all
pass, the one wake contains a result and log path for each command. A lost owner
fails the sequence and remaining commands do not start. Plain jobs retain their
existing behavior.

The whole sequence runs inline for up to 20 seconds. Set the tool call's
`yield_time_ms` to exactly `30000` (30 seconds), including an orchestration
wrapper's yield when using one: one call returns the result or `PARKED`, with
no polling. If it finishes, read its result; otherwise it prints `PARKED job:<id>; end your turn with
RESULT: parked`. End that turn immediately with `RESULT: parked`, without a
handoff, polling, reading logs or starting more work. The detached executor keeps
the same command running or queued under its existing admission and, when it
ends, resumes your same session with its exit status, bounded failure lines
and log path. The coordinator pass retries a missed wake or queued admission;
both use the same durable continuation claim, so they cannot wake twice.
Continue from that result; a wake consumes no fix round. A refused wake or the [job runtime](../../../scripts/goal/job.ts)'s wait-limit
failure goes to the Goal manager.

