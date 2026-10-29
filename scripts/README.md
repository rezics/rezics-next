# Scripts

## Check hosts

A check host is a Linux machine reached over SSH. It runs a disposable copy of a checkout.
It needs systemd, cgroup v2 accounting, Docker and an SSH account with permission to manage them.
Checks share the capped `rezics-check.slice`. A loopback host uses this same protocol on the caller's machine.
Runs share the host's package cache through hardlinks. A run that writes into an installed package in place fails and
its cache entry is removed. Patch a dependency through `patchedDependencies` in `package.json`, never at run time.

This section owns the operational rules. The implementation is in [remote-check.ts](remote-check.ts),
[stack-run.ts](stack-run.ts), [stack-lease.ts](stack-lease.ts),
[provision-check-host.sh](provision-check-host.sh) and the [Docker wrapper](check-host/docker).
Their adjacent tests exercise placement, admission, accounting and cleanup.

| Check        | Placement                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker       | Classes weighted at least 2 GiB run on check hosts first when `KERNEL_CHECK_REMOTE` names a readable hosts file; lighter classes run locally under the memory lease. `--local` forces local placement. A remote transport failure is logged and retried once locally under the lease; command failures are not retried. Hosts marked `fallback: true` run non-gate checks only when no other host can start them. |
| Kernel       | `bun run --cwd services/kernel check [files...]` selects files locally, then sends that plan to a host. An empty affected selection stays local. `bun run --cwd services/kernel typecheck` runs here with an existing `DATABASE_URL`; otherwise it places the command on a check host and creates its throwaway migrated database there. With no answering host it creates that database locally.                 |
| Auth service | `bun run --cwd services/auth check [files...]` places the database, compiler and test work through `stackRun`.                                                                                                                                                                                                                                                                                                    |
| Browser      | The isolated runners in `apps/auth` and `apps/web` use the shared placement layer. The web check returns its browser report. UI browser tests in `packages/ui` also run on hosts as part of the remote gate.                                                                                                                                                                                                      |
| Landing gate | Root `bun run check` splits all workspace checks into two duration-balanced remote groups when `KERNEL_CHECK_REMOTE` names a readable file. The lighter group also runs the control-plane gate.                                                                                                                                                                                                                   |

The gate requests four slots per group by default (`GATE_REMOTE_SLOTS` overrides this).
It partitions eligible hosts between groups when at least two qualify by configured slot count.
Otherwise both groups use the original hosts file. Admission still checks actual slice capacity.
`GATE_CONCURRENCY` controls workspace concurrency inside each group. Group results return to `.temp/gate/`.

`stack-run.ts` uses a nonempty `KERNEL_CHECK_REMOTE` first. Otherwise it looks for the readable shared file
`<main checkout>/.temp/goal/remote-check-hosts.json`. An unreadable explicit path does not use that fallback.
Once a host answers, a busy run queues. Later probe silence does not send it back locally.
With no answering host, it runs locally and explains placement on stderr.
A run already under `/srv/rezics-check/runs/` executes there without another placement.
The caller's environment is not copied to the host; callers must pass required values in the command. A client renews each run’s `.alive` file every 60 seconds; the next host run stops a run whose file is older than 10 minutes before taking a slot. Each run has a 3-hour default deadline, configurable with `--max-ms <n>`; expiration stops the run slice, prints the deadline and exits with code 124, distinct from transport failure code 75.

Runs that keep files stay local unless they declare workspace-relative return paths.
A person can also choose `REZICS_STACK_REMOTE=off` or inherit `REZICS_STACK_SLOT` to stay local.
These two overrides do not apply to workers with a nonempty `GOAL_TASK_ID`.
`KERNEL_CHECK_ON_REMOTE` and `REZICS_STACK_LEASE` do not decide shared stack placement.
The root gate has its own placement rule: it uses the explicit hosts file and suppresses remote recursion with
`KERNEL_CHECK_ON_REMOTE`.

### Hosts file

`KERNEL_CHECK_REMOTE` names local JSON configuration. It must contain a nonempty `hosts` array:

```json
{
  "hosts": [
    {
      "name": "check-small",
      "address": "root@check.example",
      "identity": ".secrets/server/check-small/operator-ed25519",
      "memoryMaxGiB": 10,
      "cpuQuotaPercent": 800,
      "slots": 4,
      "processorsPerSlot": 2
    }
  ]
}
```

| Field               | Meaning                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | Nonempty host name used in logs and gate targeting. Use distinct names.                                                                                                                                          |
| `address`           | SSH destination in `user@host` form. It identifies the machine, not a resource limit.                                                                                                                            |
| `identity`          | Nonempty path to the caller's SSH private key. SSH uses only the specified identity and batch authentication.                                                                                                    |
| `memoryMaxGiB`      | Positive memory limit in GiB. Admission uses this for capacity when slice memory cannot be read. Provision the slice with the matching value.                                                                    |
| `cpuQuotaPercent`   | Positive CPU quota; 100 means one processor. This is the admission fallback when slice `cpu.max` is unreadable or unlimited. Provision the matching quota.                                                       |
| `slots`             | Positive integer ceiling on concurrent slot units, including the express slot. This does not change systemd limits.                                                                                              |
| `processorsPerSlot` | Positive finite processor count required per slot. Defaults to 2.                                                                                                                                                |
| `fallback`          | Optional boolean. Non-gate checks prefer hosts without this field or with `false` whenever one can start now. A `true` host is selected when no other host can start the run; gate placement ignores this field. |

Editing JSON alone does not resize the slice. Provisioning takes memory and CPU values as arguments.

### Admission and queueing

Each slot requires the host's configured `processorsPerSlot` (default **2**) and **2.5 GiB**. For each answering host, compute:

```text
C = min(configured slots, floor(slice memory / 2.5 GiB), floor(slice processors / processorsPerSlot))
O = max(0, C - 1)        ordinary capacity
G = max(0, O - 1)        gate capacity
```

Slice processors are the quota divided by the period in `cpu.max`.
Slice memory is `memory.max`; configured values supply the fallbacks above.
Admission also needs 2.5 GiB of current memory headroom for each requested slot.
Headroom is `max(0, memory.max - memory.current)` in the shared slice.
When slice memory cannot be read, it uses the machine's `MemAvailable` instead.
Load average is probed but never ranks a host or limits admission.
Slots reserve admission capacity. They do not impose a separate CPU or memory cap on each run.

One slot is express capacity. Only a non-gate, one-slot run with an explicit estimate of at most
120,000 ms qualifies. It takes an ordinary slot first, then express if needed.
Long and unestimated runs cannot take express. Estimates classify runs; they do not stop overruns.
With memory headroom, express lets short work proceed while ordinary work is full.
There is no FIFO queue or enforced 120-second deadline for remote runs; `--estimate-ms` classifies slot eligibility only.

A waiting gate holds a host's `gate-wait.lock` over SSH. While that marker is held, non-gates may occupy
at most `O - G` ordinary slots (one when `O` is positive). Short runs may still take express.
This reservation uses the host's full gate capacity, even if the gate requests fewer slots.
The gate itself uses ordinary slots only. Its request is reduced to the largest answering host's `G` if needed.
No host with positive `G` is an error, so gates need capacity of at least three.

The gate's drain wait is bounded by the remaining lifetime of the original slot holders on its reserved host,
plus probing and acquisition overhead. Later non-gate arrivals cannot fill the reserved capacity.
This assumes the holders finish, the host stays reachable and enough memory headroom becomes available.
It is not a fixed wall-clock timeout. The bound starts when the gate obtains its marker;
competing gates may first wait for that marker.

Multi-slot requests take all slots together on one host or take none.
The host-wide `reserve.lock` protects only the atomic take. A waiting non-gate holds no slots or reservation.
Ordinary requests are capped at half the smallest eligible answering host's capacity, rounded down,
with a minimum cap of one and a further ceiling at its ordinary capacity.
Hosts with no ordinary capacity are excluded if any ordinary-capable host answers.
An excessive request fails before waiting; lower the run's concurrency and slot request.

Hosts rank by resource-backed free slots, then by measured memory headroom.
Single-slot acquisition first prefers hosts without a waiting gate.
Free slots account for held locks, express eligibility, gate reservations and memory headroom.
Admission retries races against other callers. The default probe interval is five seconds;
`REMOTE_CHECK_POLL_MS` overrides it.

### A run's life and measurements

1. Acquire the slot locks and hold their SSH session for the run's lifetime.
2. Rsync existing tracked and unignored untracked files into `/srv/rezics-check/runs/<run-id>`.
   Omit Git metadata, `node_modules` and root `.temp` files.
   Uploads use zstd compression when both rsync endpoints support it, and checksum against the host's
   `/srv/rezics-check/bases/current` tree so unchanged files are copied on the host. A missing base means a full upload.
   After upload, a base older than 30 minutes is refreshed from the run tree and `current` switches atomically;
   older runs can keep reading the previous tree. Bases older than two hours are removed during host cleanup, except
   for the current base.
3. Run `bun install --frozen-lockfile` at the copied checkout root, then the command in its requested directory.
   `BUN_INSTALL_CACHE_DIR=/srv/rezics-check/bun-cache` shares downloaded packages across runs.
   `BUN_RUNTIME_TRANSPILER_CACHE_PATH=<run-directory>/bun-runtime-transpiler-cache` isolates runtime transpilation.
   Chromium uses the shared `/srv/rezics-check/browsers` installation.
4. Execute inside a transient `rezics-check-<run-id>.scope` in a nested per-run slice under `rezics-check.slice`.
   The slice name replaces run-ID hyphens with underscores. `REZICS_CHECK_SLICE` names that slice.
   Remote runs set `REZICS_STACK_LEASE=off`; remote admission has already reserved their slots.
5. Copy declared return paths back before cleanup, including after command failure. Missing paths are logged and skipped.
   Output streams to the caller. The command's exit code becomes the caller's exit code.

The run puts its Docker wrapper first on `PATH`. It adds `--cgroup-parent=$REZICS_CHECK_SLICE` to
`docker run`, `docker create`, `docker container run` and `docker container create`.
It also adds `rezics.check.run=$REZICS_CHECK_RUN` labels. Other Docker commands pass through.
The wrapper finds the real Docker later on `PATH`, so a preceding test shim can call it without recursion.
The run and its containers therefore share accounting and the parent slice's resource limits.

Worker processes also put the worktree's `scripts/check-host` wrapper first on `PATH` when it exists. It places worker
containers in `rezics-check.slice` and labels them `rezics.worker.attempt=<task>/<attempt>`; settlement removes only
containers with that attempt label. Remote runs do not receive worker identity and retain their run label and cleanup.

Stderr reports `remote-check: slot wait`, `rsync`, `bun install` and `command`, each with seconds and host name.
The `rsync` line also includes the bytes sent from rsync statistics. If zstd is unavailable, the run reports that it
uses rsync's default compression. Returned outputs add `rsync back`. Slot wait includes probing and acquisition;
rsync measures the upload.
Rsync exit code 24 is accepted for uploads and returned outputs, with the number of vanished files logged.
When cgroup counters are readable, the run also prints:

```text
remote-check: run used 12.000 CPU seconds over 3.000 s (4.00 cores), peak memory 1024 MiB on check-small
```

CPU seconds come from the run slice's `cpu.stat` `usage_usec`. Average cores divide CPU seconds by wall time
from install start through command completion. Peak memory comes from `memory.peak`.
These include the run's containers and installation, but exclude upload and admission wait.

Finally, cleanup stops that run's scope, removes only its labelled containers with their associated volumes,
stops its slice and deletes its directory. It then releases the slot locks.
Signals also take this cleanup path. A failed cleanup connection leaves a warning.
Before taking a slot, the stale-run sweep also removes directories older than 60 minutes
whose corresponding scope is inactive and whose `.alive` file is absent or older than 10 minutes; a run without
that file keeps this directory rule for compatibility with older clients. It uses the same run-specific cleanup.
Never prune Docker or remove another active run's resources.

Both remote admission and the local stack lease append waits to `GOAL_CHECK_WAIT_FILE` when set.
They append positive elapsed-millisecond increments, each at most 60,000, while waiting and on exit from the wait.
The first timer fires after about 100 ms, then every minute; retry loops also flush elapsed time.
The silence monitor can account for queued time before the check starts. Recording is best effort.
Without the variable, neither records wait hints. Installation and execution time are not queue waits.

Local stack admission is separate: FIFO tickets and `flock` locks under `/tmp/rezics-stack-lease` span worktrees.
Its capacity is `max(1, min(floor(logical processors / 8), floor(total GiB / 7.5)))`.
`REZICS_STACK_SLOTS` overrides capacity; `REZICS_STACK_LEASE_DIR` overrides the directory, but `TMPDIR` does not.
Inherited `REZICS_STACK_SLOT` or `REZICS_STACK_LEASE=off` skips acquisition.
Waits have no timeout. Stderr reports held slots and tickets ahead every minute, then acquisition time.

### Provisioning

Run from the checkout, with a root SSH account or equivalent privileges:

```sh
scripts/provision-check-host.sh root@check.example .secrets/server/check-small/operator-ed25519 10 800
```

The script detects Debian-family or Fedora/RHEL-family systems from `/etc/os-release`.
It installs missing Git, rsync, archive, download, certificate and locking tools with apt or dnf.
It installs pinned Bun and Node versions under `/usr/local` when their versions differ.
It installs the pinned Playwright Chromium once per version in the shared browser directory.
Debian uses Playwright's `--with-deps`; Fedora installs Chromium without that apt-based dependency step.
Docker and any remaining browser system libraries must already be available.
It removes the two old shared Bun runtime transpiler caches and creates the check directories.
It writes `MemoryMax` and `CPUQuota` into `rezics-check.slice`, reloads systemd when needed and starts the slice.
Rerunning with the same settings avoids rewriting unchanged configuration.

For this machine as a loopback host, choose a name and use its key only over loopback:

```sh
mkdir -p .secrets/server/loopback
ssh-keygen -t ed25519 -f .secrets/server/loopback/operator-ed25519
sudo install -d -m 0700 /root/.ssh
{ printf 'from="127.0.0.1,::1" '; cat .secrets/server/loopback/operator-ed25519.pub; } |
  sudo tee -a /root/.ssh/authorized_keys >/dev/null
scripts/provision-check-host.sh root@127.0.0.1 .secrets/server/loopback/operator-ed25519 10 800
```

Ensure key-based loopback SSH already works, including host-key trust. Add `root@127.0.0.1` to the hosts file.
The resource numbers above are examples; choose limits that leave room for the machine's other work.
The script recognizes `127.0.0.1`, `::1` and `localhost` as loopback destinations.
It still provisions tools, caches, browsers and the slice. It leaves sshd configuration unchanged,
and does not validate or reload sshd on loopback. Existing root-login and authentication policy stays in force.

For other destinations, `/etc/ssh/sshd_config.d/90-rezics-checks.conf` sets `MaxStartups 100:30:300`
and `MaxSessions 64`. These allow parallel connection starts and multiplexed sessions.
An optional fifth argument supplies comma-separated IPv4/IPv6 CIDRs for `PerSourcePenaltyExemptList`.
Use the check callers' source networks. Without that argument, existing exemption lines in this drop-in survive.
Every supplied CIDR is validated before connecting. Other old drop-in contents are replaced.
The script runs `sshd -t` before reloading `ssh.service` on Debian or `sshd.service` on Fedora.
Validation failure restores the previous drop-in and does not reload sshd.

### Adding, resizing and removing a host

Start with a small slice and slot count. Allow at least two effective slots for ordinary runs and three for gates.
Provision it, add its entry and run representative kernel, auth, browser and gate checks.
Read the per-run CPU seconds, average cores and peak memory lines, including container usage.
Measure complete runs on a quiet slice and repeat with the intended mix of concurrent checks.

Choose concurrent runs so their measured core demand fits the slice's processors and their memory peaks fit its memory.
For similar one-slot runs, start with the smaller of `floor(slice processors / measured cores per run)`
and `floor(slice GiB / measured peak GiB per run)`, leaving headroom for variation.
Then respect the hard admission ceiling of two processors and 2.5 GiB per slot.
Include express capacity when setting `slots`; ordinary concurrency is one lower.
Use multiple slots for heavier runs and keep their requests within the non-gate cap.
Increasing `slots` beyond slice capacity adds no usable capacity.

Drain runs before reducing limits. Reprovision changed memory or CPU limits and update the matching JSON fields.
To remove a host, delete its entry once its runs have drained. Do not stop other workers' checks.

### Comment disagreements

- `RemoteCheck.gate` says a gate can use all but one host slot. `rankHost` and `acquire` cap its request at `C - 2`:
  one slot remains ordinary capacity and one is express. The oversized-gate log also says only one slot is left free.
- The remote module header promises a short run waits at most one short run per host.
  The code reserves express capacity, but has no FIFO ordering, duration enforcement or unconditional time bound.
  The 120,000 ms value is an estimate threshold.
- The remote module header describes gate progress without qualifications.
  The implemented reservation bounds draining after marker acquisition; it does not bound competing-marker waits,
  unreachable hosts, nonterminating holders or insufficient memory headroom.
