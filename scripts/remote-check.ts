#!/usr/bin/env bun
// Runs a command against a copy of a workspace on a development check host, so the check's containers and test lanes
// stay off the machine the agents run on.
//
//   KERNEL_CHECK_REMOTE=<hosts file> bun scripts/remote-check.ts [--cwd <directory>] [--slots <n>] <workspace> -- <command...>
//
// The hosts file is local configuration: { "hosts": [{ name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots }] }.
// The command runs in <directory> (relative to the workspace root, default the root) after `bun install`, inside the
// host's capped systemd slice, and its exit code is this script's exit code. A run holds <n> slots (default 1) on one
// host for as long as it lasts, which is how a heavy run keeps lighter ones from sharing its share of the host.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Host = {
  name: string;
  address: string;
  identity: string;
  memoryMaxGiB: number;
  cpuQuotaPercent: number;
  slots: number;
};

export type RemoteCheck = {
  hosts: Host[];
  workspace: string;
  cwd?: string;
  command: string[];
  slots?: number;
  pollMs?: number;
};

const ROOT = '/srv/rezics-check';
const SLICE = 'rezics-check.slice';
const SLOT_BUSY = 75;

class Aborted extends Error {}

export function readHosts(file: string): Host[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown };
  if (!Array.isArray(parsed.hosts) || parsed.hosts.length === 0) throw new Error(`${file} lists no hosts`);
  return parsed.hosts.map((entry: Record<string, unknown>, index) => {
    const { name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots } = entry;
    // An address starting with a dash would be read as an ssh option.
    if (typeof address !== 'string' || !/^[\w.-]+@[\w.:-]+$/.test(address))
      throw new Error(`host ${index}: bad address`);
    if (typeof name !== 'string' || !name) throw new Error(`host ${index}: name is required`);
    if (typeof identity !== 'string' || !identity) throw new Error(`host ${name}: identity is required`);
    if (typeof memoryMaxGiB !== 'number' || !(memoryMaxGiB > 0)) throw new Error(`host ${name}: bad memoryMaxGiB`);
    if (typeof cpuQuotaPercent !== 'number' || !(cpuQuotaPercent > 0))
      throw new Error(`host ${name}: bad cpuQuotaPercent`);
    if (!Number.isInteger(slots) || (slots as number) < 1) throw new Error(`host ${name}: bad slots`);
    return { name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots: slots as number };
  });
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const sshOptions = (host: Host): string[] => [
  '-i',
  host.identity,
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
];

/** Memory the slice can still use: what the host has available, bounded by the slice's cap less its current use. */
function probeScript(host: Host): string {
  const cap = Math.round(host.memoryMaxGiB * 2 ** 30);
  return `awk -v cap=${cap} 'BEGIN {
  while ((getline line < "/proc/meminfo") > 0) if (line ~ /^MemAvailable:/) { split(line, field, " "); available = field[2] * 1024 }
  getline used < "/sys/fs/cgroup/${SLICE}/memory.current"
  if (cap - used < available) available = cap - used
  printf "AVAILABLE %.0f\\n", available
}'`;
}

/** Takes the first free slot lock and holds it while the connection lives: the lock goes with the session. */
function slotScript(host: Host): string {
  return `mkdir -p ${ROOT}/slots ${ROOT}/runs
i=0
while [ "$i" -lt ${host.slots} ]; do
  exec 9>"${ROOT}/slots/$i.lock"
  if flock -n 9; then
    for run in ${ROOT}/runs/*; do
      [ -d "$run" ] || continue
      if [ -n "$(find "$run" -maxdepth 0 -mmin +60)" ] && ! systemctl is-active --quiet "rezics-check-\${run##*/}.scope"; then rm -rf -- "$run"; fi
    done
    echo "SLOT $i"
    exec cat >/dev/null
  fi
  i=$((i + 1))
done
exit ${SLOT_BUSY}`;
}

/** The wrapper directory comes first on the path, so every `docker` a workspace starts is the one that adds the slice. */
function runScript(id: string, directory: string, cwd: string, command: string[]): string {
  return `export PATH=${directory}/scripts/check-host:/usr/local/bin:$PATH BUN_INSTALL_CACHE_DIR=${ROOT}/bun-cache KERNEL_CHECK_ON_REMOTE=1
cd ${directory} || exit 1
exec systemd-run --scope --quiet --collect --slice=${SLICE} --unit=rezics-check-${id} \\
  sh -c 'bun install --frozen-lockfile && cd "$1" && shift && exec "$@"' sh ${[cwd, ...command].map(quote).join(' ')}`;
}

function cleanupScript(id: string, directory: string): string {
  return `systemctl stop rezics-check-${id}.scope >/dev/null 2>&1
rm -rf -- ${directory}`;
}

/** Tracked and untracked files that exist, without Git's own data, installed packages and local scratch space. */
export function workspaceFiles(workspace: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed in ${workspace}: ${listed.stderr.toString()}`);
  const files = listed.stdout.toString().split('\0').filter(Boolean);
  return [...new Set(files)].filter((file) => {
    const parts = file.split('/');
    if (parts[0] === '.git' || parts[0] === '.temp' || parts.includes('node_modules')) return false;
    try {
      return lstatSync(resolve(workspace, file)).isFile() || lstatSync(resolve(workspace, file)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

type Lease = { host: Host; release: () => Promise<void> };

/** The promise's value, or null once the time is up; the timer never outlives the wait. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
  if (signal.aborted) throw new Aborted();
}

async function availableMemory(host: Host): Promise<number | null> {
  const child = Bun.spawn(['ssh', ...sshOptions(host), host.address, probeScript(host)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const match = output.match(/^AVAILABLE (\d+)$/m);
  return code === 0 && match ? Number(match[1]) : null;
}

/** Tries one of the host's slots; null when every slot is taken or the host cannot be reached. */
async function takeSlot(host: Host): Promise<Lease | null> {
  const holder = Bun.spawn(['ssh', ...sshOptions(host), host.address, slotScript(host)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = holder.stdout.getReader();
  let seen = '';
  while (!/^SLOT \d+$/m.test(seen)) {
    const chunk = await reader.read();
    if (chunk.done) {
      await holder.exited;
      return null;
    }
    seen += new TextDecoder().decode(chunk.value);
  }
  return {
    host,
    release: async () => {
      // Closing stdin ends the remote `cat`, which releases the lock; the kill only covers a stuck connection.
      try {
        await holder.stdin.end();
      } catch {
        // The connection may already be gone.
      }
      if ((await within(10_000, holder.exited)) === null) holder.kill();
      await holder.exited;
    },
  };
}

/** Takes `count` slots on the host or none: a partial take is given back at once. */
async function takeSlots(host: Host, count: number): Promise<Lease | null> {
  const held: Lease[] = [];
  const releaseAll = async (): Promise<void> => {
    await Promise.all(held.map((lease) => lease.release()));
  };
  while (held.length < count) {
    let lease: Lease | null;
    try {
      lease = await takeSlot(host);
    } catch (error) {
      await releaseAll();
      throw error;
    }
    if (!lease) {
      await releaseAll();
      return null;
    }
    held.push(lease);
  }
  return { host, release: releaseAll };
}

async function acquire(hosts: Host[], slots: number, pollMs: number, signal: AbortSignal): Promise<Lease> {
  let announced = false;
  while (true) {
    const memory = await Promise.all(hosts.map(async (host) => ({ host, available: await availableMemory(host) })));
    if (signal.aborted) throw new Aborted();
    const ranked = memory
      .filter((entry): entry is { host: Host; available: number } => entry.available !== null)
      .sort((left, right) => right.available - left.available);
    for (const { host } of ranked) {
      const lease = await takeSlots(host, slots);
      if (lease && signal.aborted) {
        await lease.release();
        throw new Aborted();
      }
      if (lease) return lease;
    }
    if (!announced) {
      console.error('remote-check: every check slot is busy; waiting for a free one');
      announced = true;
    }
    await sleep(pollMs, signal);
  }
}

async function finished(child: ReturnType<typeof Bun.spawn>, signal: AbortSignal): Promise<number> {
  const stop = () => child.kill('SIGTERM');
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    return await child.exited;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export async function remoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<number> {
  const slots = options.slots ?? 1;
  // A host with fewer slots than the run needs can never serve it, so it is not asked and not waited for.
  const hosts = options.hosts.filter((host) => host.slots >= slots);
  if (hosts.length === 0) throw new Error(`No check host has ${slots} slots`);
  const files = workspaceFiles(options.workspace);
  const lease = await acquire(hosts, slots, options.pollMs ?? 5000, signal);
  const { host } = lease;
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const directory = `${ROOT}/runs/${id}`;
  try {
    const sync = Bun.spawn(
      [
        'rsync',
        '-lpt',
        '--mkpath',
        '--from0',
        '--files-from=-',
        '-e',
        ['ssh', ...sshOptions(host)].map(quote).join(' '),
        `${resolve(options.workspace)}/`,
        `${host.address}:${directory}/`,
      ],
      { stdin: new Blob([`${files.join('\0')}\0`]), stdout: 'inherit', stderr: 'inherit' },
    );
    const synced = await finished(sync, signal);
    if (signal.aborted) throw new Aborted();
    if (synced !== 0) throw new Error(`rsync to ${host.name} failed with exit code ${synced}`);

    console.error(`remote-check: running on ${host.name}`);
    const run = Bun.spawn(
      ['ssh', ...sshOptions(host), host.address, runScript(id, directory, options.cwd ?? '.', options.command)],
      { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    );
    const code = await finished(run, signal);
    if (signal.aborted) throw new Aborted();
    return code;
  } finally {
    // The cleanup connection is not tied to the abort signal: it is what undoes an aborted run.
    const cleanup = Bun.spawn(['ssh', ...sshOptions(host), host.address, cleanupScript(id, directory)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    const cleaned = await within(60_000, cleanup.exited);
    if (cleaned !== 0) {
      cleanup.kill();
      console.error(`remote-check: could not remove ${directory} on ${host.name}`);
    }
    await lease.release();
  }
}

function parse(argv: string[]): RemoteCheck {
  const hostsFile = process.env.KERNEL_CHECK_REMOTE;
  if (!hostsFile) throw new Error('KERNEL_CHECK_REMOTE must name the hosts file');
  let cwd: string | undefined;
  let slots: number | undefined;
  const rest = [...argv];
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    const flag = rest.shift();
    if ((flag !== '--cwd' && flag !== '--slots') || rest.length === 0) throw new Error(`Unknown option: ${flag}`);
    const value = rest.shift()!;
    if (flag === '--cwd') cwd = value;
    else {
      slots = Number(value);
      if (!Number.isSafeInteger(slots) || slots < 1)
        throw new Error(`--slots must be a positive integer, received ${value}`);
    }
  }
  const workspace = rest.shift();
  const separator = rest.shift();
  if (!workspace || separator !== '--' || rest.length === 0) {
    throw new Error('Usage: remote-check.ts [--cwd <directory>] [--slots <n>] <workspace> -- <command...>');
  }
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);
  const pollMs = process.env.REMOTE_CHECK_POLL_MS === undefined ? undefined : Number(process.env.REMOTE_CHECK_POLL_MS);
  return {
    hosts: readHosts(hostsFile),
    workspace,
    command: rest,
    ...(cwd === undefined ? {} : { cwd }),
    ...(slots === undefined ? {} : { slots }),
    ...(pollMs === undefined ? {} : { pollMs }),
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  let received: number | undefined;
  for (const [name, number] of [
    ['SIGINT', 2],
    ['SIGTERM', 15],
    ['SIGHUP', 1],
  ] as const) {
    process.on(name, () => {
      received ??= number;
      controller.abort();
    });
  }
  try {
    process.exitCode = await remoteCheck(parse(process.argv.slice(2)), controller.signal);
  } catch (error) {
    if (!(error instanceof Aborted)) console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  if (received !== undefined) process.exitCode = 128 + received;
}
