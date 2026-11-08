# Practical local host budget

These reviewed drop-ins target the 62.6 GiB coordinator. They are not installed automatically on other hosts.
The user and system managers have separate hierarchies: their similarly named `rezics.slice` units are not a
common parent. The user worker branch gets 28 GiB and the system check branch gets 16 GiB, totaling 44 GiB.
About 18.6 GiB remains for the OS, desktop, remote access and Goal control plane, rather than an assertion of
strict hardware isolation. Goal Home and the existing Goal host remain in `app.slice` and are not restarted.

Install mappings after checking current usage and reviewing the code guard:

| Source in this directory | Destination |
| --- | --- |
| worker-slice.conf | `~/.config/systemd/user/rezics-workers.slice.d/60-host-budget.conf` |
| maintenance.conf | `~/.config/systemd/user/rezics-goal-maintenance.service.d/60-host-budget.conf` |
| regeneration.conf | `~/.config/systemd/user/rezics-goal-regenerate.service.d/60-host-budget.conf` |
| check-slice.conf | `/etc/systemd/system/rezics-check.slice.d/60-host-budget.conf` |
| cache-maintenance.conf | `/etc/systemd/system/rezics-check-cache-maintenance.service.d/60-host-budget.conf` |

Before lowering either existing slice, read `MemoryCurrent`, `MemorySwapCurrent`, `MemoryHigh`, `MemoryMax`,
`MemorySwapMax` and `ControlGroup` with the matching systemd manager. Refuse lowering if current usage is near
or above the proposed cap, or if swap is in use before setting its allowance to zero. Preserve any pre-existing
destination file before copying. Run each manager's `daemon-reload`, then apply only these slice properties:

```sh
systemctl --user set-property --runtime rezics-workers.slice MemoryHigh=24G MemoryMax=28G MemorySwapMax=0
# Run this system-manager command through the established authorized root channel.
systemctl set-property --runtime rezics-check.slice MemoryHigh=12G MemoryMax=16G MemorySwapMax=0
```

Maintenance and regeneration receive their worker-slice membership on their next start, each bounded at 2 GiB.
The existing cache-maintenance service is bounded at 256 MiB but currently lives in `system.slice`; move it on
its next safe start, without restarting any running check. Until then, allow that additional bounded 256 MiB
outside the 44 GiB sum. No critical OS, display or network service is changed or restarted. No OOM killer is enabled.
The worker launcher reads existing high/hard limits and preserves the operator high value, clamped to the hard max.

Admission and pressure handling are a following increment. Until shared-lane admission is deployed, the existing
capacity keys can conservatively limit each lane to two starts (`maxWorkers=2`, `urgentSlots=2`), with a 18 GiB
available-memory floor (`minAvailableMiB=18432`). Changing admission does not stop existing workers. Do not describe
this transitional lane split as an already deployed combined reservation guarantee.

## Observed before application

Read-only inventory: worker slice was about 0.74 GiB with zero swap, high 16 GiB and max 46 GiB; system checks
about 0.15 GiB with zero swap and max 40 GiB. Goal maintenance was inactive and regeneration failed/inactive,
both under user `app.slice` with unlimited memory. Cache maintenance was about 22 MiB, max 256 MiB, under system
`system.slice`. Goal host was about 3.34 GiB in user `app.slice`. Verify these observations again immediately before
applying; they are not a promise about future peaks. No live values were changed while preparing this increment.

## Rollback

Restore the saved drop-ins (or remove only the newly installed files) and reload the corresponding manager.
Restore the previously observed runtime properties:

```sh
systemctl --user set-property --runtime rezics-workers.slice MemoryHigh=16G MemoryMax=46G MemorySwapMax=infinity
systemctl set-property --runtime rezics-check.slice MemoryHigh=infinity MemoryMax=40G MemorySwapMax=2G
```

Restore previous `capacity.json` values from its operator backup. Removing service drop-ins restores their prior
slice on the next start; do not relocate a running oneshot or restart a check to roll back. Re-read current usage
and effective properties. The source change never writes `MemoryMax` or `MemorySwapMax` during worker launch.
