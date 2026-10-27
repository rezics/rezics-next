# Direct routing to the development check hosts

Research checked on 2026-10-28. The local route and FlClash observations below
were measured on 2026-10-27 at about 21:20 UTC. This report recommends a setup;
it does not change the workstation, NetworkManager, FlClash, or mihomo settings.

## Recommendation

Install exact `/32` routes for the listed check-host addresses in Linux's main
table, via the current DHCP gateway on `enp67s0`. The existing priority-9001
rule sends non-DNS traffic to `main` before priority 9002 looks in the FlClash
table 2022. It suppresses only route results with a prefix length of zero or
less. A `/32` route therefore selects the physical link for SSH (TCP port 22)
before the TUN-table rule. The Linux `ip-rule(8)` manual defines
`suppress_prefixlength` as rejecting route results at that length or shorter;
the local rule uses `suppress_prefixlength 0`.
[ip-rule(8)](https://man7.org/linux/man-pages/man8/ip-rule.8.html)

For a quick, temporary check, the maintainer can install the two routes
directly. For a lasting setup that also handles a changed DHCP gateway, the
proposed `check-host-route.ts apply` command should install a small,
root-owned NetworkManager dispatcher hook. The hook reapplies only the
managed `/32` routes when the physical link comes up, is reapplied, or receives
a new DHCPv4 lease. This is narrower than changing FlClash's handling of all
private addresses, and it is independent of FlClash's generated core YAML.

This choice uses the workstation's existing route policy rather than adding a
new policy rule. It must be verified after application: the intended route
lookup is through `enp67s0`, SSH must succeed, and the server must see the
home egress address as its peer. A successful TCP connection alone does not
prove that it bypassed FlClash.

## Measured state

The hosts file contains `a` at `159.195.83.211` and `b` at `159.195.212.125`.
The address field includes the login name; the host route uses only the IP.
The file's identity fields and identity files were not read.

The current route lookup to `159.195.212.125` is via `198.18.0.2 dev FlClash
table 2022`, with TUN source `198.18.0.1`. The main-table default is via
`192.168.0.1 dev enp67s0`, and the active NetworkManager profile is
`Wired connection 1`. The supplied policy rule order puts the non-DNS main
lookup at priority 9001 ahead of the TUN-table lookup at priority 9002.

FlClash is in global mode with TUN auto-route enabled, gvisor stack,
strict-route off, and private-route bypass off. The generated config currently
has `find-process-mode: always` and an empty route-exclude list; the stored TUN
override list is empty and the `scripts/` directory is empty. The generated
`config.yaml` is output, not the durable settings source. FlClash's source
builds the core configuration from stored preferences and profile data in
[`lib/common/task.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/common/task.dart).

## Options

| Option | Root needed | Reboot | FlClash restart | DHCP gateway change | Live connections | Undo |
| --- | --- | --- | --- | --- | --- | --- |
| `ip route replace` host route in `main` | Yes, normally `sudo`/`CAP_NET_ADMIN` | No; kernel-only state | Yes, normally; FlClash manages its TUN table and policy rules | No, if the route names the old gateway | The change is immediate. New flows use the direct route; existing sessions to that host may be rerouted or reset. | `ip route del` for the exact `/32`, gateway, device, and table. |
| NetworkManager `ipv4.routes` host route with an explicit gateway | Yes, to edit the profile | Yes | Yes | No. A route with `192.168.0.1` as next hop will not follow a later DHCP gateway change. | `device reapply` attempts to update the active device without deactivating it; target-host sessions may still change path. Verify the route. | Remove the same route with `-ipv4.routes`, then reapply. |
| NetworkManager dispatcher-managed host routes | Yes once, to install/remove root-owned hook and state | Yes; the hook recreates routes on link activation | Yes; FlClash does not own the main-table host routes | Yes, if the hook re-reads the currently applied gateway on `dhcp4-change` and updates the routes | A route change can affect live sessions to those hosts. Apply between check runs. | Run the tool's `remove`; it deletes only routes with its reserved metric/protocol and removes its own hook/state. |
| Mihomo `tun.route-exclude-address` (or FlClash's TUN route-exclude override) | No root to save the FlClash preference; applying TUN still needs the privilege FlClash already uses | Yes, when saved in FlClash settings | Yes, when saved in FlClash settings and applied to the active profile | Yes; excluded destinations fall back to the current main-table route | Rebuilding/restarting TUN can disrupt active sessions. | Remove the two prefixes from the FlClash override and apply the profile. |
| FlClash “Bypass private addresses” | No root to toggle in the app | Preference persists | Preference persists | Uses the current main route | Changing TUN routing can affect active flows | Toggle it off again. It does not cover these public addresses. |
| FlClash profile override script | No root to edit the app script; the TUN runtime still needs its existing privilege | Persists with the script and profile attachment | The script is evaluated again when FlClash rebuilds the profile config | Can follow the main route if it writes a TUN exclusion | Profile/config reload may disturb active flows | Detach the script or remove its route setting. |
| Mihomo `DIRECT` rule or an SSH-only destination-port exclusion | Usually no root for the config/rule; TUN remains privileged | Depends on where the rule is stored | Depends on FlClash profile regeneration | Depends on its TUN policy | Can reroute active flows; a port exclusion would affect SSH to every host | Remove the rule/exclusion. Not recommended here. |

### Immediate and NetworkManager commands

The current measured gateway and interface give these immediate commands. They
are examples for the present DHCP lease; do not retain `192.168.0.1` as a
future gateway without checking it.

```sh
sudo ip -4 route replace 159.195.83.211/32 via 192.168.0.1 dev enp67s0 table main
sudo ip -4 route replace 159.195.212.125/32 via 192.168.0.1 dev enp67s0 table main
ip -4 route get 159.195.83.211 ipproto tcp dport 22
ip -4 route get 159.195.212.125 ipproto tcp dport 22
```

The expected result names `dev enp67s0` and `via 192.168.0.1`; after gateway
NAT, the remote host sees the home's public egress address, not the workstation
LAN address `192.168.0.103`.

To store the routes in the active NetworkManager profile, the equivalent
profile edits are:

```sh
sudo nmcli connection modify "Wired connection 1" +ipv4.routes "159.195.83.211/32 192.168.0.1"
sudo nmcli connection modify "Wired connection 1" +ipv4.routes "159.195.212.125/32 192.168.0.1"
sudo nmcli device reapply enp67s0
```

`ipv4.routes` accepts a destination and optional next hop; `+` adds an entry
instead of replacing the list. NetworkManager documents `device reapply` as an
attempt to update changes on the active connection, and its device API says
Reapply updates/reconfigures the device without deactivating it. It is the
least disruptive way to apply route-only profile changes, but it is an
attempt, not a guarantee that every property was accepted. Verify SSH policy
routing with `ip -4 route get <host> ipproto tcp dport 22`, not a query without
port metadata; the local priority-9001 rule has a destination-port selector.
Avoid `nmcli connection up` for this change unless a full profile reactivation
is acceptable.
[NetworkManager nmcli manual](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nmcli.html),
[NetworkManager Reapply API](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/gdbus-org.freedesktop.NetworkManager.Device.html),
[IPv4 settings](https://www.networkmanager.dev/docs/api/latest/settings-ipv4.html)

The profile route is persistent across reboot and FlClash restart, but its
configured next hop is static. If DHCP changes the gateway, that route still
points to the old next hop. A missing gateway on an IPv4 route means a direct
on-link route, not “use the current default gateway”, so omitting the next hop
is not a safe substitute for a public destination.

To remove the two example profile entries:

```sh
sudo nmcli connection modify "Wired connection 1" -ipv4.routes "159.195.83.211/32 192.168.0.1"
sudo nmcli connection modify "Wired connection 1" -ipv4.routes "159.195.212.125/32 192.168.0.1"
sudo nmcli device reapply enp67s0
```

The `ip route` form is useful for a quick trial and is lost at reboot. A
FlClash restart normally leaves this `main`-table route alone, but an
interface/profile reconfiguration can replace unmanaged routes. To remove a
temporary route, delete the same tuple with `sudo ip -4 route del ...`.

### FlClash and mihomo settings

Mihomo documents `tun.route-exclude-address` as excluding custom subnets when
`auto-route` is enabled. A minimal core-config form is:

```yaml
tun:
  route-exclude-address:
    - 159.195.83.211/32
    - 159.195.212.125/32
```

For FlClash desktop, set these under **Settings → Advanced configuration →
Network → TUN → Route exclude addresses** in the global TUN override. Mihomo
passes the entries to sing-tun, whose `BuildAutoRouteRanges` subtracts them
from the ranges routed through the TUN. Given this host's policy rules, the
excluded SSH destination then falls through to the later main-table lookup.
This is source behavior combined with the measured rule order; verify the
TCP/22 route lookup after applying. FlClash
stores the override through its app settings and serializes selected TUN
override keys into the profile config. Its English labels state that network
TUN override entries replace corresponding profile settings, while a
profile-specific TUN override takes precedence over network settings. Check
the active profile for an explicit `route-exclude-address` override; if one
exists, clear it or set the same two prefixes there. Do not hand-edit the
generated `config.yaml`: FlClash rebuilds it from preferences and the active
profile.
[FlClash `network.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/views/config/network.dart),
[`tun.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/views/config/tun.dart),
[`task.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/common/task.dart),
[`intl_en.arb`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/arb/intl_en.arb)

The FlClash **Bypass private addresses** switch adds the built-in private,
loopback, and multicast route exclusions. Its own UI help describes that
scope. The two check hosts are public IPv4 addresses, so enabling this switch
does not bypass them. Do not widen the bypass to all addresses.

FlClash scripts are profile-attached JavaScript files. The profile setup code
reads the selected script and evaluates it while preparing that profile's
config. This can express a custom `tun` value, but it is profile-specific and
duplicates an existing TUN override. The observed scripts directory is empty.
The global TUN override is the simpler app-managed setting if choosing the
FlClash path instead of the host route. Neither this report nor the proposed
tool should edit FlClash's generated YAML or preferences directly.
[FlClash `setup.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/providers/actions/setup.dart),
[`profile.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/providers/state/profile.dart),
[`scripts.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/views/config/scripts.dart)

A Mihomo `IP-CIDR,...,DIRECT` rule changes proxy selection, not whether the
kernel sends a packet through the TUN. Also, `mode: global` selects the
GLOBAL proxy rather than evaluating routing rules, so a new rule is not the
right bypass here. The TUN route exclusion and a main-table route operate at
the layer needed for a direct socket path.
[Mihomo operation-mode docs](https://wiki.metacubex.one/en/config/general/),
[Mihomo TUN docs](https://wiki.metacubex.one/en/config/inbound/tun/)

## Patterns across the sources

- Persistent settings belong in the owning control plane: FlClash's saved
  preferences/profile data or NetworkManager's connection profile. Their
  generated YAML and current kernel routes are runtime output and should be
  checked after applying a change.
- Route selection and proxy selection are separate layers. The TUN exclusion
  and a more-specific main-table route affect which interface carries a
  packet; a `DIRECT` proxy rule only affects proxy selection and is bypassed
  by global mode.
- A safe change has a narrow scope and a verification path. These sources
  support exact host prefixes, explicit route lookup inputs, and checking the
  effective runtime state instead of assuming a saved setting applied.

## Proposed `check-host-route.ts`

The small tool should treat the host list as the only source of destinations.
For each entry, it reads only `hosts[].name` and `hosts[].address`, extracts
and validates the IPv4 literal from the address, and creates a `/32`. It must
never read the `identity` field or open an identity file.

```sh
bun tools/goal/scripts/check-host-route.ts plan --hosts /home/edge/projects/rezics/rezics-next/.temp/goal/remote-check-hosts.json
sudo bun tools/goal/scripts/check-host-route.ts apply --hosts /home/edge/projects/rezics/rezics-next/.temp/goal/remote-check-hosts.json
bun tools/goal/scripts/check-host-route.ts verify --expected-peer <home-public-ip> --hosts /home/edge/projects/rezics/rezics-next/.temp/goal/remote-check-hosts.json
```

`plan` is read-only. It prints the normalized hosts, current DHCP gateway,
physical interface, the TCP/22 route lookup, and the route changes it would
make. It refuses ambiguous or missing physical default routes and any
unexpected pre-existing route for a target.

`apply` is the one command the maintainer runs with `sudo`. It installs a
root-owned, non-group-writable state file containing only the validated host
IPs plus a small executable under
`/etc/NetworkManager/dispatcher.d/`. The dispatcher handles `up`,
`reapply`, and `dhcp4-change` for the selected physical interface. It
re-reads the currently active gateway (not a possibly stale queued event
value), then runs the equivalent of `ip -4 route replace <host>/32 via
<current-gateway> dev <interface> table main` for each managed host. It removes
only its own routes on `down` or when the active gateway is missing, and logs
that it could not install a direct route. NetworkManager documents these
dispatcher actions, the `IP4_GATEWAY` variable, and warns that queued scripts
may run after later events; re-reading live state avoids installing an
obsolete gateway. `apply` also runs this reconciliation once immediately, so
the maintainer does not need to wait for a network event after installation.
[NetworkManager dispatcher manual](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/NetworkManager-dispatcher.html)

The helper should use a reserved metric and route protocol for its routes,
check for conflicts before installation, validate every input as an IPv4
literal, and use argument arrays rather than shell interpolation. The root
state and hook must be owned by root and not writable by group or other, as
NetworkManager requires for dispatcher scripts. That makes the route setup
survive reboot and subsequent DHCP gateway changes without modifying the
NetworkManager profile or FlClash settings. Re-running `apply` refreshes its
stored host set if the hosts file changes.

`verify` needs no root. For every target it checks the route using
`ip -4 route get <host> ipproto tcp dport 22` for the physical device and
current gateway, then opens an SSH probe with proxy commands/jumps disabled.
The route query includes TCP port 22 so it matches the host's priority-9001
rule. A manual probe for host `a` is:

```sh
ssh -o BatchMode=yes -o ProxyCommand=none -o ProxyJump=none root@159.195.83.211 \
  'printf "%s\n" "$SSH_CONNECTION"'
```

OpenSSH documents `SSH_CONNECTION` as the four client/server address and port
fields for the connection; the first field is the peer address that sshd
accepted. The tool should compare it with the operator-supplied
`--expected-peer` home egress address and correlate the probe timestamp and
SSH client port with a matching source-address entry in the host's sshd
journal. Missing or mismatched log evidence is not a pass, even if SSH exits
successfully. The local `ip route get` source is the LAN address; after
gateway NAT, the sshd peer is the public home egress address.
[OpenSSH `ssh(1)`](https://man.openbsd.org/ssh),
[OpenSSH `ssh_config(5)`](https://man.openbsd.org/ssh_config)

The control plane's check-host probe should record both the host name and
sshd-observed peer IP, and pass only when the observed address matches the
configured direct home egress address. If a future route change sends SSH
through FlClash again, sshd sees the proxy exit address instead; that mismatch
marks the bypass as gone even if a connection happens to succeed. Keep the
expected direct egress address explicit so a changed home WAN address does
not silently turn into a false pass.

`remove` requires sudo. It removes the dispatcher file and its root-owned
host list, and deletes only routes with the tool's reserved metric/protocol.
Plan and verify remain available without root afterwards. The hook, rather
than periodic polling by the workstation user, maintains routes on boot and
gateway change.

## `find-process-mode`

Set FlClash's **Find process** control to off at **Settings → General →
Connection**. Mihomo defines `always` as matching every connection and `off`
as never matching processes. In its source, `always` invokes the process
lookup helper; `off` clears that helper. Global mode selects the GLOBAL proxy
without evaluating rule matches, so process lookup is not needed for route
selection in this setup. The observed several-core process lookup is a good
reason to disable it. The tradeoff is that FlClash loses process names for
connection display and any feature that depends on process metadata.
[Mihomo process-mode docs](https://wiki.metacubex.one/en/config/general/),
[FlClash `general.dart`](https://github.com/chen08209/FlClash/blob/7fd417fb9a9a277c6a9339a8ac87f907df7c25f7/lib/views/config/general.dart),
[FlClash `tunnel.go` in the pinned Mihomo source](https://proxy.golang.org/github.com/metacubex/mihomo/@v/v1.19.33.zip)

FlClash exposes this as a persistent app-level toggle (currently `always`),
and its config builder writes the saved value to the generated
`find-process-mode` field. Change it in the app; do not patch `config.yaml`,
because the next generated config will overwrite that edit. The FlClash UI
offers `always`/`off`; Mihomo also documents `strict`, but the UI toggle in
the pinned FlClash source does not expose it.

## Risks and undo

- A direct route deliberately bypasses the proxy for these two public hosts.
  It exposes only those `/32` destinations to the physical network path.
- Applying or changing a route can move traffic for a live SSH/rsync session.
  Pause check jobs, apply, then run route, SSH, and sshd-peer verification
  before resuming the workers.
- A one-time `ip route` command does not persist. A NetworkManager profile
  route persists but pins its next hop. The dispatcher design adds a small
  root-owned integration point; keep it limited to the active physical
  interface and the validated host list.
- A FlClash route exclusion is a viable simpler alternative if the maintainer
  prefers an app setting over a root dispatcher. Save it in the global TUN
  override, account for any profile-level override, and verify the generated
  config after restart. Do not combine both approaches without a reason.
- The check must fail closed when `ip route get` selects `FlClash`, when SSH
  fails, or when the server-observed peer is not the expected home egress.

To remove the temporary `ip route` entries, delete each `/32` with its exact
gateway, device, and `table main`:

```sh
sudo ip -4 route del 159.195.83.211/32 via 192.168.0.1 dev enp67s0 table main
sudo ip -4 route del 159.195.212.125/32 via 192.168.0.1 dev enp67s0 table main
```

For the NM profile alternative, remove each matching `ipv4.routes` entry and
reapply. For the recommended dispatcher setup, run
`sudo bun tools/goal/scripts/check-host-route.ts remove`. For the FlClash
alternative, remove both prefixes from its TUN route-exclude setting and apply
the profile.

## Sources and provenance

Primary documentation and source were read; no source code was copied into
this report. The reference snapshots are in the ignored main-checkout
`.reference/check-host-direct-route/` directory and are listed in
`.reference/INDEX.md`.

- FlClash source snapshot: `flclash/lib/views/config/network.dart`,
  `lib/views/config/tun.dart`, `lib/views/config/general.dart`,
  `lib/common/task.dart`, `lib/providers/actions/setup.dart`,
  `lib/providers/state/profile.dart`, and `arb/intl_en.arb`; commit
  `7fd417fb9a9a277c6a9339a8ac87f907df7c25f7`; GPL-3.0 (`LICENSE`).
- Mihomo source snapshot: `mihomo/github.com/metacubex/mihomo@v1.19.33/config/config.go`,
  `listener/sing_tun/server.go`, `tunnel/tunnel.go`, and
  `component/process/find_process_mode.go`; commit
  `3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8`; GPL-3.0 (`LICENSE`). The
  source archive is pinned by the Go module proxy at
  [v1.19.33](https://proxy.golang.org/github.com/metacubex/mihomo/@v/v1.19.33.zip).
  The GitHub URL currently resolves to an unrelated Python data-model project,
  so that project was excluded from Mihomo findings.
- sing-tun source snapshot: `sing-tun/tun_rules.go`,
  `redirect_iptables.go`, and `redirect_nftables_rules.go`; commit
  `a128d0c3c8001e041725fa67ff3b521502298f17`; GPL-3.0 (`LICENSE`). Its
  `BuildAutoRouteRanges` removes configured excluded prefixes from the
  auto-route ranges. [Pinned source](https://github.com/MetaCubeX/sing-tun/blob/a128d0c3c8001e041725fa67ff3b521502298f17/tun_rules.go).
- Mihomo official configuration docs:
  [TUN](https://wiki.metacubex.one/en/config/inbound/tun/) and
  [general/process matching](https://wiki.metacubex.one/en/config/general/).
  The documentation source snapshot is
  `meta-docs/docs/config/inbound/tun.en.md`, commit
  `2a6ba6b04a9eecdbe5c88c4e4a09776659c0878b`; no repository license file was
  present in that snapshot.
- NetworkManager official docs:
  [nmcli](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nmcli.html),
  [IPv4 settings](https://www.networkmanager.dev/docs/api/latest/settings-ipv4.html),
  [device Reapply](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/gdbus-org.freedesktop.NetworkManager.Device.html),
  and [dispatcher](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/NetworkManager-dispatcher.html).
- iproute2 source snapshot: `iproute2/man/man8/ip-route.8.in` and
  `iproute2/man/man8/ip-rule.8.in`, commit
  `d1341d07788e8148ce209107813861321a1fb690`; GPL-2.0 (`COPYING`). The
  referenced manual pages are [ip-route(8)](https://man7.org/linux/man-pages/man8/ip-route.8.html)
  and [ip-rule(8)](https://man7.org/linux/man-pages/man8/ip-rule.8.html).
- OpenSSH manual pages: [`ssh(1)`](https://man.openbsd.org/ssh) documents the
  server-provided `SSH_CONNECTION` endpoint fields;
  [`ssh_config(5)`](https://man.openbsd.org/ssh_config) documents the proxy
  settings used to disable configured jump/proxy commands for the probe.
