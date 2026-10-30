#!/usr/bin/env bash
# Prepares a development host to run checks for scripts/remote-check.ts. Idempotent: it installs only what
# is missing and rewrites the slice and sshd drop-in only when their settings change. It validates sshd before reloading
# it, and preserves existing penalty exemptions unless a replacement CIDR list is supplied.
# The optional penaltyExemptCIDRs argument is a comma-separated list of IPv4 or IPv6 addresses with prefix lengths.
#
#   scripts/provision-check-host.sh <user@address> <ssh identity> <memoryMaxGiB> <cpuQuotaPercent> [penaltyExemptCIDRs]
#
# Loopback host setup:
#   mkdir -p .secrets/server/<name>
#   ssh-keygen -t ed25519 -f .secrets/server/<name>/operator-ed25519
#   sudo install -d -m 0700 /root/.ssh
#   { printf 'from="127.0.0.1,::1" '; cat .secrets/server/<name>/operator-ed25519.pub; } | sudo tee -a /root/.ssh/authorized_keys >/dev/null
#   scripts/provision-check-host.sh root@127.0.0.1 .secrets/server/<name>/operator-ed25519 <memoryMaxGiB> <cpuQuotaPercent>
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "usage: $0 <user@address> <identity> <memoryMaxGiB> <cpuQuotaPercent> [penaltyExemptCIDRs]" >&2
  exit 2
fi
address=$1
identity=$2
memory=$3
cpu=$4
penalty_exemptions=${5-}
[[ $address =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]] || { echo "bad address: $address" >&2; exit 2; }
[[ $memory =~ ^[1-9][0-9]*$ ]] || { echo "memoryMaxGiB must be a positive integer" >&2; exit 2; }
[[ $cpu =~ ^[1-9][0-9]*$ ]] || { echo "cpuQuotaPercent must be a positive integer" >&2; exit 2; }
[ -r "$identity" ] || { echo "identity is not readable: $identity" >&2; exit 2; }

valid_ipv4() {
  local octet
  local -a octets
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a octets <<< "$1"
  for octet in "${octets[@]}"; do
    [[ $octet =~ ^(0|[1-9][0-9]{0,2})$ ]] && (( 10#$octet <= 255 )) || return 1
  done
}

valid_cidr() {
  local ip=${1%/*} prefix=${1##*/} groups group head maximum=32 compressed=0
  local -a parts
  [[ $1 == */* && $prefix =~ ^[0-9]{1,3}$ ]] || return 1
  if [[ $ip == *:* ]]; then
    maximum=128
    if [[ $ip == *.* ]]; then
      valid_ipv4 "${ip##*:}" || return 1
      ip=${ip%:*}:0:0
    fi
    if [[ $ip == *::* ]]; then
      groups=${ip#*::}
      [[ $groups != *::* ]] || return 1
      head=${ip%%::*}
      groups=$head${head:+${groups:+:}}$groups
      compressed=1
    else
      groups=$ip
    fi
    [[ $groups != :* && $groups != *: && $groups != *::* ]] || return 1
    IFS=: read -r -a parts <<< "$groups"
    for group in "${parts[@]}"; do [[ $group =~ ^[0-9a-fA-F]{1,4}$ ]] || return 1; done
    if (( compressed )); then (( ${#parts[@]} < 8 )) || return 1
    else (( ${#parts[@]} == 8 )) || return 1; fi
  else
    valid_ipv4 "$ip" || return 1
  fi
  (( 10#$prefix <= maximum ))
}

if [ "$#" -eq 5 ]; then
  remaining=$penalty_exemptions
  while :; do
    entry=${remaining%%,*}
    valid_cidr "$entry" || { echo "bad penalty exemption CIDR: $entry" >&2; exit 2; }
    [[ $remaining == *,* ]] || break
    remaining=${remaining#*,}
  done
fi

bun_version=1.4.4-canary.20261027.1
bun_revision=a0cc096ce8ceed48cfefbdd2d97aa3f905b8be6b
# The kernel check runs npm-packaged tools (dbmate) whose launcher scripts start with `env node`, and tooling that
# needs node:sqlite; Debian's own Node is too old for it.
node_version=26.8.2
# The browser workspaces (apps/auth, apps/web, packages/ui) drive Chromium through Playwright; the version matches the
# one in their package.json files, and the browser and its system libraries are installed once per version.
playwright_version=1.64.1
loopback=0
case "${address#*@}" in
  127.0.0.1|::1|localhost) loopback=1 ;;
esac

printf -v remote_command '%q ' bash -s -- "$bun_version" "$node_version" "$memory" "$cpu" "$playwright_version" "$penalty_exemptions" "$loopback" "$bun_revision"
ssh -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$address" "$remote_command" <<'REMOTE'
set -euo pipefail
bun_version=$1
bun_revision=$8
node_version=$2
memory=$3
cpu=$4
playwright_version=$5
penalty_exemptions=${6-}
loopback=${7-0}

. /etc/os-release
host_os_id=${ID:-unknown}
host_os_like=${ID_LIKE:-}
case " $host_os_id $host_os_like " in
  *" fedora "*|*" rhel "*)
    package_manager=fedora
    sshd_service=sshd.service
    ;;
  *" debian "*)
    package_manager=debian
    sshd_service=ssh.service
    export DEBIAN_FRONTEND=noninteractive
    ;;
  *)
    echo "unsupported operating system ID '$host_os_id'" >&2
    exit 1
    ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

missing=()
if [ "$package_manager" = fedora ]; then
  for package in git rsync unzip xz curl ca-certificates util-linux bash; do
    rpm -q "$package" >/dev/null 2>&1 || missing+=("$package")
  done
  rpm -q python3 >/dev/null 2>&1 || missing+=(python3)
  if [ "${#missing[@]}" -gt 0 ]; then
    dnf install -y "${missing[@]}"
  fi
else
  for package in git rsync unzip xz-utils curl ca-certificates util-linux bash; do
    dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
  done
  dpkg -s python3 >/dev/null 2>&1 || missing+=(python3)
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
  fi
fi

# Dependency preparation uses Linux subreaper custody and pidfds to stop only its owned installer tree.
python3 -c 'import ctypes, os, signal; assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"); assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0; fd = os.pidfd_open(os.getpid()); os.close(fd)'

# Canary --version omits the prerelease; compare the immutable build revision.
if ! /usr/local/bin/bun --eval 'process.exit(Bun.revision === process.argv[1] ? 0 : 1)' "$bun_revision" 2>/dev/null; then
  case "$(uname -m)" in
    x86_64) build=x64; grep -q avx2 /proc/cpuinfo || build=x64-baseline ;;
    aarch64) build=aarch64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  curl -fsSL -o "$work/bun.tgz" "https://registry.npmjs.org/@oven/bun-linux-${build}/-/bun-linux-${build}-${bun_version}.tgz"
  tar -xzf "$work/bun.tgz" -C "$work"
  install -m 0755 "$work/package/bin/bun" /usr/local/bin/bun
fi

if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$node_version" ]; then
  case "$(uname -m)" in
    x86_64) build=x64 ;;
    aarch64) build=arm64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  curl -fsSL -o "$work/node.tar.xz" "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${build}.tar.xz"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$work/node.tar.xz" -C /usr/local/lib/nodejs
  ln -sfn "/usr/local/lib/nodejs/node-v${node_version}-linux-${build}/bin/node" /usr/local/bin/node
fi

legacy_transpiler_caches=(
  /root/.bun/install/cache/@t@
  /srv/rezics-check/bun-cache/@t@
)
for cache in "${legacy_transpiler_caches[@]}"; do
  rm -rf -- "$cache"
done
echo "removed legacy Bun runtime transpiler caches (if present): ${legacy_transpiler_caches[*]}"

mkdir -p /srv/rezics-check/slots /srv/rezics-check/runs /srv/rezics-check/bun-cache /srv/rezics-check/browsers

browsers=/srv/rezics-check/browsers
if [ ! -e "$browsers/.chromium-$playwright_version" ]; then
  if [ "$package_manager" = fedora ]; then
    PATH=/usr/local/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$browsers \
      bun x "playwright@$playwright_version" install chromium
  else
    PATH=/usr/local/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$browsers \
      bun x "playwright@$playwright_version" install --with-deps chromium
  fi
  touch "$browsers/.chromium-$playwright_version"
fi

slice=/etc/systemd/system/rezics-check.slice
wanted=$(printf '[Unit]\nDescription=REZICS development checks\n\n[Slice]\nMemoryMax=%sG\nCPUQuota=%s%%\n' "$memory" "$cpu")
if [ "$(cat "$slice" 2>/dev/null || true)" != "$wanted" ]; then
  printf '%s\n' "$wanted" > "$slice"
  systemctl daemon-reload
fi
systemctl start rezics-check.slice

if [ "$loopback" -eq 1 ]; then
  echo "provision: loopback host, sshd left unchanged"
else
  sshd_config_dir=/etc/ssh/sshd_config.d
  sshd_dropin=$sshd_config_dir/90-rezics-checks.conf
  sshd_wanted=$(printf 'MaxStartups 100:30:300\nMaxSessions 64')
  if [ -n "$penalty_exemptions" ]; then
    sshd_exemptions="PerSourcePenaltyExemptList $penalty_exemptions"
  elif [ -e "$sshd_dropin" ]; then
    # Reading errors must abort provisioning rather than silently discard an exemption.
    sshd_exemptions=$(awk 'tolower($1) == "persourcepenaltyexemptlist" { print }' "$sshd_dropin")
  else
    sshd_exemptions=
  fi
  if [ -n "$sshd_exemptions" ]; then sshd_wanted=$(printf '%s\n%s' "$sshd_wanted" "$sshd_exemptions"); fi
  sshd_changed=0
  sshd_had_previous=0
  sshd_backup=$work/90-rezics-checks.conf
  if [ "$(cat "$sshd_dropin" 2>/dev/null || true)" != "$sshd_wanted" ]; then
    install -d -m 0755 "$sshd_config_dir"
    if [ -e "$sshd_dropin" ]; then
      cp -p "$sshd_dropin" "$sshd_backup"
      sshd_had_previous=1
    fi
    sshd_candidate=$(mktemp "$sshd_config_dir/.90-rezics-checks.XXXXXX")
    printf '%s\n' "$sshd_wanted" > "$sshd_candidate"
    chmod 0644 "$sshd_candidate"
    mv -f "$sshd_candidate" "$sshd_dropin"
    sshd_changed=1
  fi

  if sshd -t; then
    if [ "$sshd_changed" -eq 1 ]; then systemctl reload "$sshd_service"; fi
  else
    if [ "$sshd_changed" -eq 1 ]; then
      if [ "$sshd_had_previous" -eq 1 ]; then cp -p "$sshd_backup" "$sshd_dropin"; else rm -f "$sshd_dropin"; fi
    fi
    echo "sshd configuration validation failed; sshd was not reloaded" >&2
    exit 1
  fi
fi

echo "chromium for playwright $playwright_version, git $(git --version | cut -d" " -f3), rsync $(rsync --version | head -1 | cut -d" " -f4), node $(/usr/local/bin/node --version), bun $(/usr/local/bin/bun --version)"
systemctl show rezics-check.slice -p MemoryMax -p CPUQuotaPerSecUSec
REMOTE
