# Remote check input custody

Generic remote source evidence has two separate inventories:

- **Frozen candidate source** is the caller's manifest of regular files and symlinks. Its fingerprint binds each
  root-relative path, file mode, bytes or link target, deleted paths, `HEAD`, and the index tree.
- **Prepared inputs** are the files and symlinks present after frozen install and every declared preparation command.
  The prepared receipt fingerprints their paths, modes, kinds, sizes, and content digests.
- **Producer controls** are exact run-local state owned by remote-check. They are checked at their lifecycle boundary
  and omitted from both semantic inventories.

These categories are not interchangeable. A name alone never grants control ownership, and a caller cannot add a
control path to its candidate manifest.

## Exact producer namespace

The reserved root-relative producer files are:

| Path                               | Producer and lifecycle                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.alive`                           | Upload, admission heartbeat, and run wrapper; empty liveness file before source verification.                                                                       |
| `.remote-check-slot-count`         | Slot admission; bounded positive slot count before source verification.                                                                                             |
| `.remote-check-supervisor`         | Host lifetime monitor; durable host, run, UID, PID, start tick, and process-group identity before source verification.                                              |
| `.remote-check-supervisor.pending` | Temporary durable-write sibling; must be absent at source verification and prepared receipt.                                                                        |
| `bun-runtime-transpiler-cache`     | Pinned Bun runtime cache; may be created by runtime verification before source verification and grows during preparation. This is the sole reserved root directory. |
| `.preparation-started`             | Preparation supervisor; host, run, deadline, and bounded timeout after preparation begins.                                                                          |
| `preparation-install.json`         | Frozen installer; cache classification and package receipt after successful install.                                                                                |
| `.bun-install-complete`            | Installer; empty completion marker after a successful frozen install.                                                                                               |
| `preparation-status.json`          | Preparation or lifetime failure reporting; forbidden at a successful prepared-input boundary.                                                                       |
| `run-lifetime-status.json`         | Host lifetime monitor; terminal timeout report, after preparation evidence.                                                                                         |
| `run-lifetime-status.json.pending` | Temporary durable-write sibling.                                                                                                                                    |
| `command-started`                  | Run wrapper; written after prepared-input evidence.                                                                                                                 |
| `.command-result`                  | Run wrapper terminal result.                                                                                                                                        |
| `.command-result.pending`          | Temporary durable-write sibling.                                                                                                                                    |
| `exit-status`                      | Host lifetime monitor terminal result.                                                                                                                              |
| `exit-status.pending`              | Temporary durable-write sibling.                                                                                                                                    |
| `command-phases.tsv`               | Command phase recorder; command output after prepared-input evidence.                                                                                               |
| `physical-resources.json`          | Host lifetime monitor; terminal resource receipt after the command.                                                                                                 |
| `physical-resources.json.pending`  | Temporary durable-write sibling.                                                                                                                                    |
| `.resource-terminal-ready`         | Lifetime monitor terminal sampling handoff.                                                                                                                         |
| `.resource-terminal-sampled`       | Lifetime monitor terminal sampling acknowledgement.                                                                                                                 |

The implementation owns this list once in `scripts/remote-check.ts`; the source verifier, prepared-input evidence,
installer cache inventory, local manifest preflight, and refreshed-base cleanup derive their exact root paths from it.
Run-local scratch is a separate, explicit set: `.temp/check-host` and `.temp/node-compile-cache`. Existing source and
prepared-input traversal exclusions for `.git`, `.temp`, and `node_modules`, and the source verifier's established
build-output exclusions remain separate from producer ownership. There is no hidden-file or arbitrary basename exception.

## Lifecycle and ownership checks

Admission writes `.remote-check-slot-count`; transport and the run wrapper touch `.alive`. The Python lifetime monitor
then durably writes `.remote-check-supervisor` before it starts the command shell. `refreshBaseScript` runs before
pinned Bun verification and source verification. It copies the uploaded tree to a staging base, removes every exact
producer-control path and the two exact scratch paths from that staging tree, then atomically publishes the base.
Controls therefore remain owned by their run directory and never become reusable candidate content.

Source verification runs before `bun install`. It validates the staged manifest's exact shape and bounds, binds source
paths, modes, bytes or link targets, deleted paths, `HEAD`, and the index tree to the supplied fingerprint, and compares
the actual uploaded file set. It subtracts only the exact producer namespace after validating current `.alive`,
`.remote-check-slot-count`, and `.remote-check-supervisor` ownership and identity. The supervisor identity must match
the current host and run, have the current UID, a positive PID and matching process group, and a numeric start tick.
Control files must be regular, singly linked, current-UID owned, non-writable by group or other, and within their
individual byte bounds. The runtime cache must be an owned, non-writable directory containing only bounded regular
files and directories; links and special files fail closed.

The installer writes `.preparation-started`, `preparation-install.json`, and `.bun-install-complete`. Prepared-input
evidence runs after successful installation and all declared preparation commands, immediately before
`command-started`. At that point it requires the valid supervisor, liveness, slot, preparation, and install controls;
terminal and failure controls are rejected. It excludes the exact producer namespace from the generated-input digest.
All other eligible generated files and symlinks remain in the digest, with a maximum of 50,000 entries and 1 GiB of
content. File reads are no-follow and must retain their observed file identity and size.

Candidate upload paths are validated before workspace transfer, even for legacy calls without generic source evidence.
When a generic source manifest is supplied, it is also validated locally before manifest staging. A source path equal
to, inside, or above a reserved control path fails closed. This prevents candidate bytes from being overwritten by
producer state.
Remote verification repeats path and collision checks as defense in depth. Malformed, foreign, or out-of-stage controls
fail closed; there is no basename-wide control ignore.

Calls that do not request generic source evidence keep their supported native command outcome, declared returns, and
cleanup behavior. When generic evidence is requested, both the fingerprint and per-file manifest are required. The
prepared-input receipt remains physical evidence forwarded by the existing intermediate path; it becomes final only
when the caller settles the complete run.

## Evidence and limits

`scripts/remote-check-inputs.test.ts` executes the actual generated Python source-verification and prepared-input
programs against small private temporary trees. It runs the verifier with the former control subtraction removed to
demonstrate the pre-repair source-set mismatch, then proves that valid controls are accepted while frozen source changes,
control collisions, malformed identity, and generated-input mutations are rejected or reflected in the digest. It also checks production shell order:
source verification, frozen install, declared preparation, prepared-input evidence, then command start.

This fixture does not run systemd, SSH, Docker, a compiler, a real preparation command, process scanning, or signals.
It verifies the generated source logic and its ordering, not physical-host behavior or the cause of any historical
no-check-host 75 result.
