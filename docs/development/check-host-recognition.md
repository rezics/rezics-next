# Check-host recognition

This document records the physical handoff used by `scripts/remote-check.ts` and received by `scripts/stack-run.ts`.
It covers check placement and transport only; a recognition result is not a native test or compiler result.

## Producer handoff

`remote-check` uploads each run beneath `/srv/rezics-check/runs/<run-id>`. Its generated host entry starts the
independent Python `lifetime` monitor. After enabling subreaper behavior and establishing its own session, the monitor
records `.remote-check-supervisor` in that run directory with exactly its PID, `/proc/<pid>/stat` start time and
process group. The monitor remains alive while the command is active and supervises the command independently of
the SSH caller.

The monitor starts the generated shell in a new session. That shell invokes `systemd-run --scope` with slice
`rezics-check-<run-id-with-hyphens-replaced-by-underscores>.slice` and unit
`rezics-check-<run-id>.scope`. The inner compiler's cgroup therefore has the matching scope as a path component in
the unified `0::` entry of `/proc/self/cgroup`. The cgroup identifies the admitted run; the marker identifies its
separate live lifetime monitor. The inner compiler's process group does not need to equal the monitor's process
group.

## Receiving predicate

`recognizeCheckHostRun` returns either an admitted identity or one bounded refusal code. It checks that the supplied
absolute cwd is lexically below a valid run directory, that the run directory is a physical child of the runs root,
and that the cwd's real path remains below that run directory. It then checks the unified cgroup scope, reads the
supervisor marker as a no-follow regular file bounded to 4 KiB, and reads the named process stat bounded to 4 KiB.
The marker has exactly the producer's three fields. PID, start time and group must be valid; the process stat must
identify that PID, show a known live state, and match its start time and process group. Missing or malformed evidence
fails closed. `isCheckHostRun` remains a boolean wrapper for existing callers.

The refusal codes are deliberately finite: path and directory confinement, cgroup availability/format/scope,
marker availability/regularity/size/content, and supervisor availability/state/start/group each have separate
reasons. For a candidate below the run root, `stack-run` logs only the bounded reason code, for example:

```text
stack-run: kernel typecheck physical run recognition refused (supervisor-start-mismatch)
```

The regular `stack-run` entry uses the fixed filesystem/proc reader. Its optional recognition dependency is an
in-memory test seam; it does not write host state and is never selected from environment or host configuration.
Environment flags, copied host configuration and caller-provided run IDs do not satisfy the physical predicate.

An admitted run returns `null` from `runOnCheckHost`, so the caller continues inside the current cgroup and lifetime
monitor without another host selection or slot admission. A refusal follows ordinary host discovery, which filters
to hosts `a` and `b` and fails closed if neither can be used. It never turns a heavy command into local work. Pure
compiler/typecheck commands stay local when the classifier proves them independent of native resources; Kernel's
`services/kernel/scripts/typecheck.ts` prepares a throwaway compiler database and runs Reylo external code and
construction, so it remains a remote stack command even though its package script is named `typecheck`.

## Prepared-input transport

`runScript` generates frozen-source verification and prepared-input evidence only when
`expectedSourceSha256` is supplied. The generic check-run path supplies that fingerprint and continues to require
the corresponding prepared-input receipt. Ordinary stack and gate callers do not request this generic evidence;
their missing receipt is represented as `preparedInputs: null`, while the native exit, declared returns and cleanup
retain their existing outcomes. No evidence is synthesized for those callers.

## Evidence and limits

The two compiler refusals recorded by the receiving notes report an inner `no check host is configured` result after
remote dependency preparation. Those notes do not identify which physical predicate failed. The generated producer
protocol and the receiving predicate are now exercised together through a read-only in-memory fixture for both
approved host names. A separate fixture reproduced and fixed a false acceptance where a lexical run path resolved
outside its run directory. That false acceptance is not evidence that it caused either historical refusal. No
historical host run, consumer retry, original acceptance, or native compiler success is claimed here; the
predicate-specific runtime diagnostic is available for the next authorized physical receiving run.
