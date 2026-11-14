# Explicit code-only launches

[`../scripts/code-only-launch.py`](../scripts/code-only-launch.py) is a Python 3 standard-library entrypoint for an
authorized manager's independent Codex source assignment during an explicitly authorized code-only window. Python 3.9+
and Linux user systemd with cgroup v2 are required. Invoke it from supported source without workspace installs.
Invocation supplies the existing authorization; the manager label
is attribution, not authentication. It does not dispatch native tasks or grant integration, acceptance or check access.

```sh
python3 tools/goal/scripts/code-only-launch.py launch \
  --state "$GOAL_STATE_DIRECTORY" --base /path/to/source-checkout \
  --name independent-source --manager owning-manager --goal owning-goal \
  --pool "$CODE_ONLY_POOL" --brief /path/to/authorized-brief.md \
  --defer-until "$CODE_ONLY_DEFER_UNTIL" \
  --path tools/example/source.py --path tools/example/usage.md
```

Use the reset time from the actual authorization. A past or timezone-less deadline refuses a new launch. The brief and
injected runtime instructions defer tests, typing, lint, builds, installs and verification; resetting the window does
not itself authorize checks or launch another worker. This entrypoint neither enforces arbitrary shell commands nor
creates a recurring scheduler, watcher, timer, wakeup or model consultation.

Settings follow the main-checkout, local-file and state-directory resolution used by `settings.ts`, including its
`GOAL_MAIN_CHECKOUT`, `GOAL_LOCAL_CONFIG` and `GOAL_STATE_DIRECTORY` overrides. The selected `--pool` must uniquely name
a configured Codex pool with an absolute `command`, an absolute `configDirectory`, and a positive
`policy.maxConcurrent`. That pool supplies the executable, `CODEX_HOME`, listener profile and admission cap; the invoking
manager's `HOME` is preserved. The launcher keeps max reasoning effort and Standard/default service tier, defaults to
`gpt-6.1-sol` (`--model` can select the assigned model), and disables delegated agents and web search. No account
configuration, routing, width listener or native task/check records are changed.

Each invocation creates a unique `code-only/<name>-<suffix>` branch and worktree under the configured worktree root
(`--worktree-root` or `GOAL_WORKTREE_ROOT` can override it). The source argument is normalized to its Git checkout root.
Missing worktree-root parent directories are created. Git worktrees share objects; `--no-checkout` followed by
cone-mode sparse checkout materializes each claimed directory or a claimed file's parent neighborhood, plus Git's
root/ancestor files.
New file paths select their parent directory, including a directory yet to be created. Root-level file claims include
only root files rather than selecting the entire tree. Linked reads can use the recorded source checkout. Claims are
literal repository-relative file/directory paths; root, traversal, globs, `.git` and `.temp` claims are refused. A sparse
neighborhood is read context, not permission to edit outside the claims; claims through symlinks are refused. Git
setup/source reads disable hooks and fsmonitor, and worker instructions disable commit hooks during the window.
Neither an old worktree nor its branch is reset or reused; a rerun gets a new ID. Worktrees, brief snapshots, logs and
failure records are retained for handoff.

Admission and every registry/record mutation acquire `<state>/code-only-writers.lock` and then the legacy
`<state>/code-only/writers.lock`. Native identity reads use SQLite's read-only URI and the current-generation projection;
no native migrations, task imports, reservations, releases or physical process scans run. Recorded PIDs are compared by
PID, start ticks as a string, boot ID and process group; zombies and reused PIDs are terminal. Unknown process visibility
or unreadable/malformed ownership state refuses admission. Live native and direct process identities are deduplicated;
their count plus other preparing/queued source records must fit the selected pool's configured concurrency limit before
spawning. Pending setup records hold source claims and admission capacity, but are reported separately from live coding
width. Live and pending source claims cannot overlap; native glob claims conservatively own their literal prefix. An
older direct row without claims must have a retained launch record matching its exact identity. The runner repeats
admission under both locks after checkout and immediately before spawning, excluding its own setup record.

These locks serialize this entrypoint's managers. The native controller remains responsible for its own admission and
root-owned caps; its independent native starts do not coordinate their claims through these locks. The combined count
is an observation at direct admission, not an atomic reservation against future native starts. Do not mix new launches
through the operational prototype with this entrypoint: the prototype does not implement aggregate admission. Already
running prototype identities count and their registry rows survive updates.

All direct services share `rezics-code-only.slice`. The launcher reads the existing finite `MemoryHigh` and `MemoryMax`
limits on that slice and the finite shared safety ceiling on its `rezics.slice` ancestor; it does not set or raise these
properties. Admission uses the existing host and shared-cgroup headroom policy, including `capacity.json`'s configured
`minAvailableMiB`, and refuses when direct use reaches the configured `MemoryHigh`. Root retains ownership of the native
and host safety limits. A persistent completed oneshot anchors the slice; it schedules no work.

`launch` waits for a systemd ready notification after the runner has spawned Codex and published its live identity.
Its JSON output reports the retained record, state, process identity, worktree, service and terminal-log path. The
record retains the configured Main and its `node_modules/.bin/bun` completion runtime alongside the original source
checkout, base, branch and child identity. The writer waits for the child and retains its actual return code. A fast
child exit can report terminal state without ever publishing a writer. Service startup errors retain stderr in
`launchError`; setup errors retain the worktree and record as failed. A confirmed absent/terminal service settles a
failed submission; unreadable service state remains unknown. An interrupted launch client can leave a successfully
submitted independent service running, and never ends a still-live child on the client's behalf.
If the client dies before submitting its service, the setup record holds no writer claim and can be settled once with
`finish` after the exact service is confirmed absent. No automatic retry or worktree deletion follows.

The service owns its process tree with `KillMode=control-group`, no restart, bounded stop/start timeouts and OOM stop.
Signals to the runner terminate and reap its child; runner death is handled by systemd cleanup and one-shot
`ExecStopPost`. A terminal record retains its original identity, Codex exit code when known, and untouched stdout/stderr
log. Service terminal evidence is separate. Loss before a child result records interrupted/unknown exit, never success.
The runner persists terminal execution evidence without removing its writer row. After confirming the original child,
runner and service are terminal, `finish` persists service evidence and calls the exact launch's
`tools/goal/scripts/code-only-completion.py` outside the registry locks. The callback captures tracked changes,
untracked file bytes and the worker's final message even when execution failed or was interrupted. It durably writes
completion evidence first, removes only the matching original writer identity, then uses the configured Main, state and
Bun runtime to request the existing idempotent native handoff to the recorded manager and goal. This handoff is source
and execution evidence; acceptance stays deferred. A callback error leaves the launch record and any completion error
evidence available for recovery by rerunning `finish --record <path>`. Use `--retry-source` to retry a failed source or
worker-message capture. `run` is internal and refuses execution outside its recorded bounded service. The retained
script must stay available until that service's stop hook finishes.

The atomic listener interface is `<state>/code-only-writers.json`:

```json
{"version":1,"writers":[{"id":"source-id","manager":"owner","goal":"goal","phase":"writing","identity":{"pid":123,"start":"456","boot":"boot-id","group":123},"worktree":"/path/to/worktree"}]}
```

Rows can also include `ownedPaths`, `unit`, `profile` and `source`. Only live launched Codex children are published;
the runner is recorded separately. The completion callback removes the original row only after source and worker
handoff evidence is durable. Every later registry mutation also discards confirmed stale identities, leaving unrelated
live or replacement rows intact. File writes use distinct temporary files, fsync and atomic replacement. The existing
listener independently applies `sameProcess` and native-PID dedupe. If the stop hook or callback is interrupted, that
listener still rejects a stale identity; after repairing storage, a manager can settle the exact record with
`finish --record <path>` (or retry source capture with `--retry-source`). It refuses a live child, runner, or
pending/unknown service, never signals a recorded PID, and never infers a missing child exit code from the service's
result. Repeating manual settlement preserves previously recorded service terminal evidence and the callback's
idempotent delivery key prevents a second recipient handoff.

Workers receive these local instructions automatically and run both checkpoints:

```sh
python3 tools/goal/scripts/code-only-launch.py checkpoint --record /path/to/launch-record.json
```

The first edit checkpoint records tracked changes **and untracked owned files**. Later checkpoints retain
`firstSourceAt`, `firstCommitAt`, current head and commits since the base separately from process identity. They reload
under both locks, preserve terminal state and original logs, and never resurrect a writer after exit. These Git
reads capture source; they do not run checks or establish integration or verified admission. A handoff names committed
source, deferred acceptance, related findings and a useful independent next outcome. Launch/terminal identity and
aggregate-count acceptance remain for the verifier after reset.
