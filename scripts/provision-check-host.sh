#!/usr/bin/env bash
# Prepares a Debian development host to run checks for scripts/remote-check.ts. Idempotent: it installs only what
# is missing and rewrites the slice only when its limits change. It adds a directory, a slice and a few packages; it
# touches no service that already runs there.
#
#   scripts/provision-check-host.sh <user@address> <ssh identity> <memoryMaxGiB> <cpuQuotaPercent>
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <user@address> <identity> <memoryMaxGiB> <cpuQuotaPercent>" >&2
  exit 2
fi
address=$1
identity=$2
memory=$3
cpu=$4
[[ $address =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]] || { echo "bad address: $address" >&2; exit 2; }
[[ $memory =~ ^[1-9][0-9]*$ ]] || { echo "memoryMaxGiB must be a positive integer" >&2; exit 2; }
[[ $cpu =~ ^[1-9][0-9]*$ ]] || { echo "cpuQuotaPercent must be a positive integer" >&2; exit 2; }
[ -r "$identity" ] || { echo "identity is not readable: $identity" >&2; exit 2; }

bun_version=1.4.3
# The kernel check runs npm-packaged tools (dbmate) whose launcher scripts start with `env node`, and tooling that
# needs node:sqlite; Debian's own Node is too old for it.
node_version=26.8.2
# The browser workspaces (apps/auth, apps/web, packages/ui) drive Chromium through Playwright; the version matches the
# one in their package.json files, and the browser and its system libraries are installed once per version.
playwright_version=1.64.1

ssh -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 "$address" \
  bash -s -- "$bun_version" "$node_version" "$memory" "$cpu" "$playwright_version" <<'REMOTE'
set -euo pipefail
bun_version=$1
node_version=$2
memory=$3
cpu=$4
playwright_version=$5
export DEBIAN_FRONTEND=noninteractive
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

missing=()
for package in git rsync unzip xz-utils curl ca-certificates util-linux; do
  dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
done
if [ "${#missing[@]}" -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
fi

if [ "$(/usr/local/bin/bun --version 2>/dev/null || true)" != "$bun_version" ]; then
  case "$(uname -m)" in
    x86_64) build=x64; grep -q avx2 /proc/cpuinfo || build=x64-baseline ;;
    aarch64) build=aarch64 ;;
    *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  curl -fsSL -o "$work/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/bun-linux-${build}.zip"
  unzip -q "$work/bun.zip" -d "$work"
  install -m 0755 "$work"/bun-linux-*/bun /usr/local/bin/bun
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

mkdir -p /srv/rezics-check/slots /srv/rezics-check/runs /srv/rezics-check/bun-cache /srv/rezics-check/browsers

browsers=/srv/rezics-check/browsers
if [ ! -e "$browsers/.chromium-$playwright_version" ]; then
  PATH=/usr/local/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=$browsers \
    bun x "playwright@$playwright_version" install --with-deps chromium
  touch "$browsers/.chromium-$playwright_version"
fi

slice=/etc/systemd/system/rezics-check.slice
wanted=$(printf '[Unit]\nDescription=REZICS development checks\n\n[Slice]\nMemoryMax=%sG\nCPUQuota=%s%%\n' "$memory" "$cpu")
if [ "$(cat "$slice" 2>/dev/null || true)" != "$wanted" ]; then
  printf '%s\n' "$wanted" > "$slice"
  systemctl daemon-reload
fi
systemctl start rezics-check.slice

sshd_config_dir=/etc/ssh/sshd_config.d
sshd_dropin=$sshd_config_dir/90-rezics-checks.conf
sshd_wanted=$(printf 'MaxStartups 100:30:300\nMaxSessions 64')
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
  if [ "$sshd_changed" -eq 1 ]; then systemctl reload ssh; fi
else
  if [ "$sshd_changed" -eq 1 ]; then
    if [ "$sshd_had_previous" -eq 1 ]; then cp -p "$sshd_backup" "$sshd_dropin"; else rm -f "$sshd_dropin"; fi
  fi
  echo "sshd configuration validation failed; sshd was not reloaded" >&2
  exit 1
fi

echo "chromium for playwright $playwright_version, git $(git --version | cut -d" " -f3), rsync $(rsync --version | head -1 | cut -d" " -f4), node $(/usr/local/bin/node --version), bun $(/usr/local/bin/bun --version)"
systemctl show rezics-check.slice -p MemoryMax -p CPUQuotaPerSecUSec
REMOTE
