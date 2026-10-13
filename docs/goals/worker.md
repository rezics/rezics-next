# Goal worker protocol

You are a headless worker started by a Goal manager through `task goal -- dispatch`,
working in your own worktree on a `goal/<id>` branch. Your brief
(`.temp/goal/brief.md`, or `.temp/goal/brief-<id>.md` in a shared worktree) is the
task. Priority when guidance differs: the brief, then this page, then `AGENTS.md`
and other documents. Documents record practice; the code is the truth.

## Finish the work

Begin with the brief's failing outcome tests and the files most likely to
change. Read further only when the evidence requires it, make the smallest
change that satisfies the outcome, avoid unrelated cleanup, run the checks
below, and stop when the outcome's tests pass.

Deliver the brief's outcome completely before you stop. Make reasonable
assumptions, state them in the handoff, and keep going; do not stop to ask. If
the brief is wrong for the code or the need, take the better course within your
claim and explain it, or hand off `blocked` with the exact reason. A sub-agent
starts with a copy of your whole context: delegate only a large part that is
independent of the rest (its own files and tests), never reading or searching.

When a brief prescribes a second mechanism for a decision an owner already
makes, stop and report that instead of building it.

## Scope

- Change the files your claimed `paths` match. A needed file outside them: if
  `task goal -- owner <path>` prints `unclaimed`, make the minimal change and
  list it under OWNER CHANGES; if another task claims it, hand off that blocker.
  Other needed work goes under PROPOSED TASKS, not into your diff.
- Name files, tests and identifiers by capability or acceptance ID, never by
  task ID; comments state reasons, not task IDs.
- Never push, never touch the main checkout or `.temp/vault/`, never rebase or
  merge `main`: the manager rebases and merges. Edit with paths relative to
  your worktree root. An absolute path that starts at the main checkout and
  does not pass through `.temp/worktrees/<id>/` writes into the checkout the
  shared stack hot-reloads from; a patch tool accepted three such paths on
  2026-10-11 and the stack served them for an hour.
- `/tmp` on this host is RAM: never put checkouts, `node_modules` or bulk data
  there. Use your worktree's `.temp` (or a short directory on disk when a path
  must be short).

## Repository conventions

- Generated files (`generated/**`, `packages/model/src/generated/**`, the Fuseki
  image stamp in `infra/dev/compose.yaml`) are not committed: run `task gen`
  when you need them, restore them before handoff. A changed route contract
  also needs `task web:typecheck`; list web follow-ups under OWNER CHANGES.
- A new Main route lives in a claimed route module, registered with one import
  and one `.use()` line in `services/main/src/app.ts` (union-merged: only add
  lines). It declares its `exposure` (`public` or `platform:<group>`; a new
  `public` operation is reviewed by trust-ops), its rate-limit family, and
  `openApiOperations`. Owner stores wire through `services/main/src/index.ts`
  and `routes/dependencies.ts`, also add-only.
- Migrations: use any free number; `goalctl merge` renumbers above `main` and
  rewrites references in your changed files. When widening a shared CHECK,
  start from its latest definition on `main` and keep every value.
- A model profile is its authored definition: optional properties refine it, a
  tightened constraint needs a new revision with admission coverage, a new
  meaning needs a new term.
- Prefer code to prose: types, tests, lint rules and short comments.

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
task goal -- check                         # before a handoff: types, type-aware lint, ast-grep, the brief's `tests:` files in one QA slot and the guards, in one blocking call
task goal -- check --only types,lint       # a subset while you work: types, lint, tests, guards
task goal -- test <your test files>        # one file or a few while you work; one QA slot, also for files of several tiers; never --heavy for your own files
task goal -- test --affected --list | tail -n 40   # what else your change reaches; do not run it
```

`check` prints `ok` or `failed` for each check and, for a failed one, only the
failing cases and the first lines of each error; the whole output is in the file
it names under `.temp/goal/check/`. It checks what the merge gate checks, from
the gate's own functions. A brief names its test files in the frontmatter list
`tests:`; without it `check` runs no test file and says so. Wait on it with one
long call rather than polling.

Run `task goal -- check` once before you hand off `done`; it includes the
repository-wide rules of `task guards` (about two minutes). On 2026-10-11 two
thirds of the landings that a gate stopped failed one of these rules, after a
review had already been spent on them.

The gate may run from an agent session, where `CLAUDECODE=1` makes `bun test`
print only failures and the summary. A test that runs `bun test` in a child
asserts its exit status or a JUnit report, never the printed test names; check
such a file once with `CLAUDECODE=1` set.

Tests are what this host runs short of, not workers. Name every file a step
needs in one `task goal -- test` call: one call starts one stack, and a stack
costs about half a minute and a turn in a host-wide queue before any test runs.
Prove a change at the lowest tier that proves it: a unit or owner test needs no
stack. Run a passing file again only after a change that could affect it. A web
build, `depcruise`, type-aware lint or a fresh install takes 2 to 3 GiB: run
one at a time and not during your own QA run.

After `task goal -- test <story file>`, read the PNGs under the run's `story-screenshots` directory to review your own change by eye; do not add screenshot helpers to stories.

List affected tests outside your claim in the handoff; the manager and the
program regression run them. Do not run whole tiers, `task qa`, Storybook suites
or browser journeys unless the brief asks. Backend work starts no dev server.
Frontend work checks changed screens with one dev server at a time against the
shared backend (`task web:dev`, `task urls`) and stops it before handoff. In a
shared worktree, start nothing; use what `.temp/goal/shared.md` lists and commit
only your paths with `git commit --only`.

## Tokens

Every model call resends your whole context, so a session's cost grows with the
square of its length. Read several files in one command. Bound what a command
prints (`rg -m`, `sed -n` ranges, `| tail -n 40`); never print a whole log or
list. Do not read again what you already have. A command's output is cut at about
16,000 characters, so ask for the part you need. `task --summary <task>`
describes one task; `task --list` prints every one.

`task operation -- <query>` answers where a Main API operation lives without a
search: its operationId, method and path, exposure, rate-limit family, whether
it takes a bearer and an idempotency key, the route's file and line, and the
test files that call it. The query is part of an operationId or of a path;
`--json` prints the same as data.

A test run or a check takes minutes. Start it, then wait for it in one call: an
empty `write_stdin` with `yield_time_ms: 300000` returns the moment the command
ends. Asking every 30 seconds resends your whole context each time; a quarter
of all worker input on 2026-10-11 was such polls.

## After a review

A finding that blocks arrives with a test that fails on your branch. Make it
pass, name the class of the defect, search your whole change for every other
site of that class and fix them all. Then read the diff of your own fix as a
reviewer would before you hand off: of the findings later rounds returned on
2026-10-11, 44% were defects in the fix itself and 38% the same class at
another site. A task gets two fix rounds; say plainly when the second cannot
close it.

## Handoff

Commit each step as soon as it stands, because a session can end without
warning and the next session only sees what is in the tree. Leave the worktree
clean, and end with this message (a headless worker exits when its turn ends,
so never end a turn to wait):

```text
RESULT: done | partial | blocked
CASES: <IDs or the outcome delivered>
COMMITS: <hashes and one-line summaries>
CHECKS: <commands and QA run IDs with pass/fail>
OWNER CHANGES: <files outside the claim, schemas, migrations, routes>
PROPOSED TASKS: <follow-up work with reason, or none>
BLOCKERS: <exact blocker, or none>
NEXT: <the next action for the manager>
```

Report failures plainly. Managers do not message running workers; for an urgent
hazard in merged code, hand off early with `RESULT: blocked`.
