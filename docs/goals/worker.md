# Goal worker protocol

You are a headless worker started by a Goal manager through `task goal -- dispatch`,
working in your own worktree on a `goal/<id>` branch. Your brief
(`.temp/goal/brief.md`, or `.temp/goal/brief-<id>.md` in a shared worktree) is the
task. Priority when guidance differs: the brief, then this page, then `AGENTS.md`
and other documents. Documents record practice; the code is the truth.

## Finish the work

Deliver the brief's outcome completely before you stop. Make reasonable
assumptions, state them in the handoff, and keep going; do not stop to ask. If
the brief is wrong for the code or the need, take the better course within your
claim and explain it, or hand off `blocked` with the exact reason. If your CLI can
delegate independent parts to sub-agents, do so.

## Scope

- Change the files your claimed `paths` match. A needed file outside them: if
  `task goal -- owner <path>` prints `unclaimed`, make the minimal change and
  list it under OWNER CHANGES; if another task claims it, hand off that blocker.
  Other needed work goes under PROPOSED TASKS, not into your diff.
- Name files, tests and identifiers by capability or acceptance ID, never by
  task ID; comments state reasons, not task IDs.
- Never push, never touch the main checkout or `.temp/vault/`, never rebase or
  merge `main`: the manager rebases and merges.

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

Write tests with the code; backend tests cover the denied, stale, concurrent,
partial and recovery outcomes the behaviour has. Prove your own work, nothing
wider:

```sh
task goal -- test <your test files>        # one QA slot; never --heavy for your own files
task <workspace>:typecheck                 # waits for host memory on a local Goal run
node_modules/.bin/oxlint --type-aware <changed directories>
task ast-grep -- scan <changed files>
task goal -- test --affected --list        # lists what else your change reaches; do not run it
```

List affected tests outside your claim in the handoff; the manager and the
program regression run them. Do not run whole tiers, `task qa`, Storybook suites
or browser journeys unless the brief asks. Backend work starts no dev server.
Frontend work checks changed screens with one dev server at a time against the
shared backend (`task web:dev`, `task urls`) and stops it before handoff. In a
shared worktree, start nothing; use what `.temp/goal/shared.md` lists and commit
only your paths with `git commit --only`.

## Handoff

Commit coherent progress, leave the worktree clean, and end with this message
(a headless worker exits when its turn ends, so never end a turn to wait):

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
