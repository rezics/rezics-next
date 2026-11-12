# Practical local host budget

These reviewed drop-ins target the 62.6 GiB coordinator. They are not installed automatically on other hosts.
The user and system managers have separate hierarchies: their similarly named `rezics.slice` units are not a
common parent. The user worker branch gets 28 GiB and the system check branch gets 16 GiB, totaling 44 GiB.
About 18.6 GiB remains for the OS, desktop and remote access. This is practical containment, not strict hardware
isolation. Goal host and verifier must share the worker branch after a controlled, checkpointed restart; until then
the coverage is partial.

Install mappings after checking current usage and reviewing the code guard:

| Source in this directory | Destination |
| --- | --- |
| worker-slice.conf | `~/.config/systemd/user/rezics-workers.slice.d/60-host-budget.conf` |
| control-plane.conf | `~/.config/systemd/user/rezics-goal-host.service.d/90-goal-containment.conf` |
| control-plane.conf | `~/.config/systemd/user/rezics-goal-verifier.service.d/90-goal-containment.conf` |
| maintenance.conf | `~/.config/systemd/user/rezics-goal-maintenance.service.d/60-host-budget.conf` |
| regeneration.conf | `~/.config/systemd/user/rezics-goal-regenerate.service.d/60-host-budget.conf` |
| check-slice.conf | `/etc/systemd/system/rezics-check.slice.d/60-host-budget.conf` |
| cache-maintenance.conf | `/etc/systemd/system/rezics-check-cache-maintenance.service.d/60-host-budget.conf` |

Before lowering either existing slice, read `MemoryCurrent`, `MemorySwapCurrent`, `MemoryHigh`, `MemoryMax`,
`MemorySwapMax` and `ControlGroup` with the matching systemd manager. Refuse lowering if current usage is near
or above the proposed cap, or if swap is in use before setting its allowance to zero. Preserve any pre-existing
destination file before copying. Run each manager's `daemon-reload`, then apply only these slice properties:

```sh
systemctl --user set-property rezics-workers.slice MemoryHigh=24G MemoryMax=28G MemorySwapMax=0
# Run this system-manager command through the established authorized root channel.
systemctl set-property rezics-check.slice MemoryHigh=12G MemoryMax=16G MemorySwapMax=0
```

Maintenance receives its worker-slice membership on its next start with high 1 GiB/max 2 GiB; regeneration
uses high 4 GiB/max 6 GiB because its observed peak was 4.43 GiB. Both are inside the 28 GiB aggregate, not extra
budget. Active oneshots receive their per-unit caps without a forced restart; slice membership changes next start.
The existing cache-maintenance service is bounded at 256 MiB but currently lives in `system.slice`; move it on
its next safe start, without restarting any running check. Until then, allow that additional bounded 256 MiB
outside the 44 GiB sum. No critical OS, display or network service is changed or restarted. No OOM killer is enabled.
The worker launcher reads existing high/hard limits and preserves the operator high value, clamped to the hard max.

Both lanes now share the existing `maxWorkers` cap; `urgentSlots` is a sublimit. The operator can keep a modest
count cap and 18 GiB available-memory floor (`minAvailableMiB=18432`) without introducing new configuration keys.
Working-set reservations and sustained PSI recovery run inside existing admission polling. They pause new starts
without stopping current workers. Per-worker hard ceilings remain safety limits, not initial reservations.

## Observed before application

Read-only inventory: worker slice was about 0.74 GiB with zero swap, high 16 GiB and max 46 GiB; system checks
about 0.15 GiB with zero swap and max 40 GiB. Goal maintenance was inactive and regeneration failed/inactive,
both under user `app.slice` with unlimited memory. Cache maintenance was about 22 MiB, max 256 MiB, under system
`system.slice`. Goal host was about 3.34 GiB in user `app.slice`. Verify these observations again immediately before
applying; they are not a promise about future peaks. The original preparation changed no live values. Applied-state evidence and exact before-config backups live in
the private host-budget delivery folder; verify the effective properties rather than assuming this initial snapshot
is still current.

## Rollback

Restore the saved drop-ins and persistent or runtime `systemd/*.control` property files (or remove only newly
installed files), then reload the corresponding manager. Persistent `set-property` was used during application:
restoring only `60-host-budget.conf` would leave higher-precedence property files in effect. The private application
backup lists every affected file in `files.json` and exact before-properties in `before.json`. Restore those values:

```sh
systemctl --user set-property rezics-workers.slice MemoryHigh=16G MemoryMax=46G MemorySwapMax=infinity
systemctl set-property rezics-check.slice MemoryHigh=infinity MemoryMax=40G MemorySwapMax=2G
```

Restore previous `capacity.json` values from its operator backup. Removing service drop-ins restores their prior
slice on the next start; do not relocate a running oneshot or restart a check to roll back. Re-read current usage
and effective properties. The source change never writes `MemoryMax` or `MemorySwapMax` during worker launch.


## Control-plane coverage and safe activation

The Goal host and verifier share the 28 GiB worker aggregate through `control-plane.conf`. Their observed host peak
was about 17.63 GiB, so leaving them outside would be a substantial gap. A membership drop-in alone does not move
a running service: checkpoint the existing Home branch, uncommitted source and persisted thread/check identities,
then use one controlled owner restart at a safe turn/check boundary. Verify both actual `ControlGroup` values and
that the old app cgroups are absent. The host's `KillMode=process` makes checking old helper processes necessary.
Do not restart existing worker scopes, system check runs or critical OS/display/network services for this move.
Without that verified activation, describe containment as partial. Cache maintenance likewise retains a bounded
256 MiB transition outside the check branch until its next safe activation.

Restore the separate saved host/verifier membership drop-ins and reload the user manager to undo that membership;
it changes back only at another safe restart. The original five-unit budget backup does not contain those later
membership files. Check effective cgroups and properties after rollback, rather than inferring them from drop-ins.
