# Goal worker protocol

You are a headless worker started by a Goal manager through `task goal -- dispatch`,
working in your own worktree on a `goal/<id>` branch. Your brief
(`.temp/goal/brief.md`, or `.temp/goal/brief-<id>.md` in a shared worktree) is the
task. [AGENTS.md](../../AGENTS.md) states instruction precedence. Check tooling
behavior against its code; update a practice that no longer fits.

A wave build task (a brief with a `## Wave` section, or a resume that says so)
follows [Waves](wave.md) instead of the Scope, Checks and landing parts of this
page. It is not bounded by claims, its own or another task's, and its ordinary build phase starts no QA stack. The brief can authorize a
recording or prove step explicitly.

## Finish the work

Begin with the brief's failing outcome tests and the files most likely to
change. Read further only when the evidence requires it, make the smallest
change that satisfies the outcome, avoid unrelated cleanup, run the checks
below, and stop when the outcome's tests pass. When several tests fail, take
every failure from one run of the affected tests, name each cause, and fix the
independent ones together before the next run; a failure in a test's setup is
diagnosed before any full gate reruns.

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
  `task goal -- owner <path>` prints `unclaimed` or an unlanded overlap, make the
  minimal change and list it under OWNER CHANGES. An overlap on another branch
  (including a wave, merge candidate, exited or stopped task) is resolved at
  merge: proceed and note it in the handoff. Hand off a blocker only for another
  starting or running task's explicit path claim on the same integration base.
  Other needed work goes under PROPOSED TASKS, not into your diff.
- Name files, tests and identifiers by capability or acceptance ID, never by
  task ID; comments state reasons, not task IDs.
- For an ordinary worker task, never push, never touch the main checkout or `.temp/vault/`, never rebase or
  merge `main`: the manager rebases and merges. Edit with paths relative to
  your worktree root. Translate a main-checkout path into your worktree before
  editing it.
- `/tmp` on this host is RAM: never put checkouts, `node_modules` or bulk data
  there. Use your worktree's `.temp` (or a short directory on disk when a path
  must be short).

## Repository conventions

- Obtain the pinned Fuseki image with `task jena:image`; never run `docker build`
  for that image by hand. The command returns when the tag exists and otherwise
  waits for one host-wide build per tag. `task gen`, stack startup and dev refresh
  use the same command implementation. Native tests run separately in the gate
  and wave proof through `module-test`.
- Generated artifacts follow the [generator and merge gate](../../scripts/goal/merge.ts).
  Run `task gen` when authored contracts change; do not hand-edit derived files.
  The gate regenerates and commits its results. A route-contract change also
  needs `task web:typecheck`; list consumer follow-ups under OWNER CHANGES.
- Main routes declare exposure, rate-limit family and OpenAPI operations beside
  their handler. Follow [Main composition](../../services/main/src/app.ts) and
  [route dependencies](../../services/main/src/routes/dependencies.ts) for wiring;
  append only where the union merge driver is configured. The API Goal owns
  public exposure decisions; there is no separate trust-ops Goal to wait for.
- Migrations: use any free number; `goalctl merge` renumbers above `main` and
  rewrites references in your changed files. When widening a shared CHECK,
  start from its latest definition on `main` and keep every value.
- A model profile is its authored definition: optional properties refine it, a
  tightened constraint needs a new revision with admission coverage, a new
  meaning needs a new term.
- Prefer code to prose: types, tests, lint rules and short comments.

## Tests and checks

Load the [Goal worker execution skill](../../.agents/skills/goal-worker/SKILL.md)
when running checks or a command that can take over a minute. It owns targeted
QA, recorded jobs and the parked-turn procedure. A wave uses its own skill.
[AGENTS.md](../../AGENTS.md) owns proportional tests and preparation budgets;
the brief adds its required checks.

## After a review

A finding that blocks arrives with a test that fails on your branch. Make it
pass, name the class of the defect, search your whole change for every other
site of that class and fix them all. Then read the diff of your fix as a reviewer before handing off. A task gets two fix rounds; say plainly when the second cannot
close it. When claims, outcome, authority and acceptance remain unchanged, the
manager may use `resume --class sameScope` with the exact failure and correction
in its recorded message. This permits continued authorized repair without a
repeated brief commit; a changed contract still needs a coherent brief.

The landing runs a review test on the reviewed head before committing it as a
blocker. Its runner stack must locate the failure at an outcome assertion in
the test body. Setup requests, helpers and hooks do not confirm the finding:
the reviewer gets one setup correction, with the failure evidence. A finding
that still cannot reach its assertion goes to program as unconfirmed and uses
no worker fix round. An assertion that demonstrates the defect still blocks.
When blocked on a test premise, name the failing file and case, whether it
reached its outcome assertion, and the failure evidence in the handoff.

## Handoff

If an instruction file makes you pause, ask, stop or change direction, name
and link the exact file in the handoff, quote the instruction and explain its
effect. Distinguish an explicit requirement from your interpretation. Existing
authorization still applies; do not turn a guideline into a new approval gate.

Commit each step as soon as it stands, because a session can end without
warning and the next session only sees what is in the tree. Leave the worktree
clean, and end with this message. A headless worker exits when its turn ends;
the one waiting exception is a recorded job, whose turn ends with only
`RESULT: parked` and has no handoff:

```text
RESULT: done | partial | blocked
CASES: <IDs or the outcome delivered>
COMMITS: <hashes and one-line summaries>
CHECKS: <commands and QA run IDs with pass/fail>
TEST PREMISE: <if blocked on a test: file/case, assertion reached yes/no/unknown and evidence; otherwise none>
OWNER CHANGES: <files outside the claim, schemas, migrations, routes>
PROPOSED TASKS: <follow-up work with reason, or none>
BLOCKERS: <exact blocker, or none>
NEXT: <the next action for the manager>
```

Report failures plainly. Managers do not message running workers; for an urgent
hazard in merged code, hand off early with `RESULT: blocked`.
