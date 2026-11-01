# Check-host recognition

This document records the physical handoff used by `scripts/remote-check.ts` and received by
`scripts/check-placement.ts` and `scripts/stack-run.ts`. A recognition result proves placement custody only; it is not
a native test or compiler result.

## Producer handoff

`remote-check` uploads each run beneath `/srv/rezics-check/runs/<run-id>`. Its generated host entry starts an
independent Python lifetime monitor. After enabling subreaper behavior and establishing its own session, the monitor
writes `.remote-check-supervisor` in that run directory. The schema is the shared
`CHECK_HOST_SUPERVISOR_MARKER_SCHEMA` in `scripts/check-placement.ts`; the generated producer emitter, producer
control validator and receiving predicate all use that representation.

Version 1 is a closed JSON object with exactly these seven fields:

| Field     | Meaning and bound                                                              |
| --------- | ------------------------------------------------------------------------------ |
| `schema`  | Integer `1`.                                                                   |
| `host`    | Selected approved host name, exactly `a` or `b`.                               |
| `run`     | The lowercase run id, matching `[a-z0-9-]{1,64}`.                              |
| `pid`     | The lifetime monitor pid, a safe integer of at least `2`.                      |
| `started` | The monitor's `/proc/<pid>/stat` start-time token, one to twenty ASCII digits. |
| `group`   | The monitor's process group; it must equal `pid`.                              |
| `uid`     | The monitor's current uid, a nonnegative safe integer.                         |

The marker is limited to 4 KiB. The producer checks the same closed fields and bounds before it accepts source or
prepared controls. It emits field names from the shared schema rather than a second handwritten key list. The shell
entry starts the generated command under the matching `rezics-check-<run-with-hyphens-replaced-by-underscores>.slice`
and `rezics-check-<run>.scope`.

## Receiving predicate

`recognizeCheckHostRun` returns either an admitted identity or one bounded refusal code. It checks that the absolute
cwd is lexically below a valid run directory, the run directory is a physical child of the fixed runs root, and the
cwd's real path remains below that run directory. It then requires one well-formed unified cgroup v2 path containing
exactly one matching run slice and scope.

The receiver opens the marker without following symlinks, requires a regular file no larger than 4 KiB, and parses
the exact seven-field version 1 object. Its host must be `a` or `b`, its run must equal the directory name, and its uid
must equal the fixed current process uid. It then reads `/proc/<pid>/stat` with a 4 KiB bound and checks the pid,
known live state, start time and process group. A pid below `2`, unsafe numeric values, a nonleader group, unknown
schema, missing or extra fields, and malformed or foreign evidence are refused. The optional recognition reader is
an inert in-memory test seam; the regular entry uses fixed filesystem, cgroup, proc and uid sources. Environment
markers and caller-supplied run ids do not supply identity.

The producer records the selected alias (`a` or `b`), but the installed protocol contains no fixed local mapping
from those aliases to a machine identity. The receiver can enforce the approved two-name set and bind the physical
run directory, scope and live monitor; it cannot independently prove that alias `a` maps to a particular machine
rather than `b` without an additional installed identity source.

For a lexical candidate below the run root, a failed physical predicate is terminal. `stack-run` preserves the
bounded predicate diagnostic and returns transport failure before host discovery. It neither nests host admission nor
falls through to local or native work. A genuinely recognized inner compiler returns `null` from `runOnCheckHost`,
so the caller continues under the original lifetime monitor and cgroup. Ordinary outside-run placement still admits
only hosts `a` and `b`; pure standalone typing remains local, while the Kernel and Auth database-backed compilers
remain remote.

## Prepared-input transport

`runScript` generates frozen-source verification and prepared-input evidence only when `expectedSourceSha256` is
supplied. The generic check-run path supplies that fingerprint and continues to require the corresponding
prepared-input receipt. Ordinary stack and gate callers do not request this generic evidence; their missing receipt
is represented as `preparedInputs: null`, while native exit, declared returns and cleanup retain their existing
outcomes. No evidence is synthesized for those callers.

## Evidence and limits

The inert recognition matrix derives marker keys from the shared schema and inspects the generated producer source
included by `runScript`. It covers accepted `a` and `b` fixtures; stale three-field, missing, extra, unsupported,
malformed and foreign marker values; pid, start, group, state, uid, cgroup, symlink, size and escaped-path refusals;
and refusal without nested discovery. The authored lifetime oracle also keeps `unknown` ahead of `pending` when
cleanup is unknown and candidate observations are rejected, while preserving the original final and immutable history.

This source repair does not establish physical host behavior. The recognition and stack-run acceptance suites, the
lifetime acceptance suite and workspace typing are intentionally unrun here. No remote host filesystem, `/proc`,
cgroup or uid evidence was observed; no SSH attempt, consumer retry, native check, compiler or database result was
produced. The historical `75` refusals remain unclassified until an authorized receiving run records its
predicate-specific diagnostic. No compiler is claimed to work, and no historical failure is claimed as repaired.
