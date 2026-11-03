#!/usr/bin/env bun
import { defaultPolicy, type ControlPolicy } from '../src/policy.ts';
import * as fs from 'node:fs';
import { isIPv4 } from 'node:net';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const STATE = '/etc/rezics-check-host-route.json';
export const HOOK = '/etc/NetworkManager/dispatcher.d/90-rezics-check-host-route';
// Stable route ownership marker; Linux interface widths, IPv4 masks/ports and permissions are protocol constants.
export const METRIC = 42722;
const DEVICE = /^[a-zA-Z0-9_.:-]{1,15}$/;
type Host = { name: string; address: string; ip: string; identity?: string };
type State = { device: string; addresses: string[] };
type Route = {
  dst?: string;
  gateway?: string;
  dev?: string;
  protocol?: string | number;
  metric?: number;
  type?: string;
  nexthops?: unknown;
  flags?: string[];
};
export type Result = { code: number; stdout: string; stderr: string };
export interface FileSystem {
  read(path: string): string;
  exists(path: string): boolean;
  lstat(path: string): { isFile(): boolean; uid: number };
  secure(path: string): void;
  writeRoot(path: string, data: string, mode: number): void;
  remove(path: string): void;
}
export interface Dependencies {
  policy?: ControlPolicy;
  run(argv: string[]): Promise<Result>;
  files: FileSystem;
  uid(): number;
  print(line: string): void;
}

function ipv4(value: unknown): string {
  if (typeof value !== 'string' || !isIPv4(value)) throw new Error(`Invalid IPv4 literal: ${String(value)}`);
  return value;
}

export function readHosts(value: unknown, identityPath?: (identity: unknown) => string): Host[] {
  const hosts = (value as { hosts?: unknown })?.hosts;
  if (!Array.isArray(hosts) || !hosts.length) throw new Error('hosts must be a nonempty array');
  return hosts.map((host) => {
    // Identity data is selected only by verify, which treats it as a file path.
    const { name, address } = host;
    if (typeof name !== 'string' || !name.trim() || /[\r\n\x00]/.test(name)) throw new Error('Invalid host name');
    if (typeof address !== 'string' || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[^@\s]+$/.test(address)) {
      throw new Error(`Invalid address for ${name}`);
    }
    return {
      name,
      address,
      ip: ipv4(address.split('@').at(-1)),
      ...(identityPath ? { identity: identityPath(host.identity) } : {}),
    };
  });
}

function checkedIdentityPath(value: unknown, d: Dependencies): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Identity must be an absolute file path');
  let info: ReturnType<FileSystem['lstat']>;
  try {
    info = d.files.lstat(value);
  } catch {
    throw new Error(`Identity path is not an accessible regular file: ${value}`);
  }
  if (!info.isFile() || info.uid !== d.uid()) {
    throw new Error(`Identity path must be a regular file owned by the current user: ${value}`);
  }
  return value;
}

function readState(d: Dependencies): State | undefined {
  if (!d.files.exists(STATE)) return undefined;
  d.files.secure(STATE);
  const state = JSON.parse(d.files.read(STATE));
  if (
    typeof state.device !== 'string' ||
    !DEVICE.test(state.device) ||
    !Array.isArray(state.addresses) ||
    !state.addresses.length
  ) {
    throw new Error('Invalid managed route state');
  }
  return { device: state.device, addresses: [...new Set<string>(state.addresses.map(ipv4))] };
}

async function command(d: Dependencies, argv: string[]): Promise<string> {
  const result = await d.run(argv);
  if (result.code !== 0) throw new Error(`${argv.join(' ')}: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

async function routes(d: Dependencies): Promise<Route[]> {
  const value = JSON.parse(await command(d, ['ip', '-j', '-4', 'route', 'show', 'table', 'main']));
  if (!Array.isArray(value)) throw new Error('Invalid route listing');
  return value;
}

function physicalDefault(d: Dependencies, all: Route[]): { device: string; gateway: string } {
  const defaults = all.filter((r) => r.dst === 'default' || r.dst === '0.0.0.0/0');
  if (defaults.some((r) => r.nexthops)) throw new Error('Ambiguous physical default route (multipath)');
  const physical = defaults.filter(
    (r) => r.dev && DEVICE.test(r.dev) && d.files.exists(`/sys/class/net/${r.dev}/device`),
  );
  if (physical.length !== 1) throw new Error('Missing or ambiguous physical default route');
  const route = physical[0]!;
  if ((route.type && route.type !== 'unicast') || route.flags?.includes('linkdown'))
    throw new Error('Physical default route is unavailable');
  return { device: route.dev!, gateway: ipv4(route.gateway) };
}

function hostIP(route: Route): string | undefined {
  const ip = route.dst?.replace(/\/32$/, '');
  return ip && isIPv4(ip) ? ip : undefined;
}

function owned(route: Route, state?: State): boolean {
  return (
    !!state &&
    state.addresses.includes(hostIP(route)!) &&
    route.dev === state.device &&
    (route.protocol === 'static' || route.protocol === 4) &&
    route.metric === METRIC &&
    (!route.type || route.type === 'unicast') &&
    !route.nexthops &&
    isIPv4(route.gateway ?? '')
  );
}

function conflicts(all: Route[], addresses: string[], state?: State): void {
  for (const route of all) {
    if (addresses.includes(hostIP(route)!) && !owned(route, state)) {
      throw new Error(`Conflicting existing route: ${JSON.stringify(route)}`);
    }
  }
}

function routeArgs(action: string, ip: string, gateway: string, device: string): string[] {
  return [
    'ip',
    '-4',
    'route',
    action,
    `${ip}/32`,
    'via',
    gateway,
    'dev',
    device,
    'table',
    'main',
    'proto',
    'static',
    'metric',
    String(METRIC),
  ];
}

// Standalone, standard-library-only hook: no checkout, user-owned runtime or DHCP event environment is trusted.
export const DISPATCHER = `#!/usr/bin/python3 -I
# REZICS managed check-host routes
import ipaddress, json, os, re, stat, subprocess, sys, syslog
STATE = ${JSON.stringify(STATE)}
METRIC = ${METRIC}
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}
def run(args):
    result = subprocess.run(args, capture_output=True, text=True, env=ENV)
    if result.returncode:
        raise RuntimeError(" ".join(args) + ": " + result.stderr.strip())
    return result.stdout
def ip(value):
    if not isinstance(value, str):
        raise RuntimeError("Invalid IPv4 literal")
    return str(ipaddress.IPv4Address(value))
def host(route):
    return route.get("dst", "").removesuffix("/32")
def owned(route, state):
    return (host(route) in state["addresses"] and route.get("dev") == state["device"]
        and route.get("protocol") in ("static", 4) and route.get("metric") == METRIC
        and route.get("type", "unicast") == "unicast" and not route.get("nexthops")
        and isinstance(route.get("gateway"), str))
def args(action, address, gateway, device):
    return ["ip", "-4", "route", action, address + "/32", "via", ip(gateway),
        "dev", device, "table", "main", "proto", "static", "metric", str(METRIC)]
def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("up", "reapply", "dhcp4-change", "down"):
        return
    with os.fdopen(os.open(STATE, os.O_RDONLY | os.O_NOFOLLOW)) as file:
        info = os.fstat(file.fileno())
        if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISREG(info.st_mode):
            raise RuntimeError("Unsafe managed route state")
        state = json.load(file)
    if not isinstance(state["device"], str) or not re.fullmatch(r"[a-zA-Z0-9_.:-]{1,15}", state["device"]):
        raise RuntimeError("Invalid physical device")
    if not isinstance(state["addresses"], list) or not state["addresses"]:
        raise RuntimeError("Invalid host addresses")
    state["addresses"] = [ip(address) for address in state["addresses"]]
    device = state["device"]
    if sys.argv[1] != device:
        return
    routes = json.loads(run(["ip", "-j", "-4", "route", "show", "table", "main"]))
    def cleanup():
        for route in routes:
            if owned(route, state):
                run(args("del", host(route), route["gateway"], device))
    if sys.argv[2] == "down":
        cleanup()
        return
    defaults = [route for route in routes if route.get("dst") in ("default", "0.0.0.0/0")
        and route.get("dev") == device and route.get("type", "unicast") == "unicast"
        and "linkdown" not in route.get("flags", [])]
    if (len(defaults) != 1 or defaults[0].get("nexthops") or not defaults[0].get("gateway")
            or not os.path.exists("/sys/class/net/" + device + "/device")):
        cleanup()
        raise RuntimeError("Missing or ambiguous live physical gateway; direct routes removed")
    gateway = ip(defaults[0]["gateway"])
    for route in routes:
        if host(route) in state["addresses"] and not owned(route, state):
            raise RuntimeError("Conflicting existing host route: " + json.dumps(route))
    for address in dict.fromkeys(state["addresses"]):
        run(args("replace", address, gateway, device))
try:
    main()
except Exception as error:
    syslog.syslog(syslog.LOG_ERR, "check-host-route: " + str(error))
    print("check-host-route: " + str(error), file=sys.stderr)
    sys.exit(1)
`;

function sshProbe(policy: ControlPolicy['hostRoute']): string { return `printf 'REZICS_SSH_CONNECTION=%s\\n' "$SSH_CONNECTION"
printf 'REZICS_PROBE_TIME=%s\\n' "$(date +%s)"
journalctl --no-pager -o json --since '-${policy.journalAgeSeconds % 60 === 0 ? `${policy.journalAgeSeconds / 60} minutes` : `${policy.journalAgeSeconds} seconds`}' -u ssh.service -u sshd.service`; }

function peerEvidence(output: string, expected: string, policy: ControlPolicy['hostRoute']): string {
  const lines = output.trim().split('\n');
  const fields = lines
    .find((line) => line.startsWith('REZICS_SSH_CONNECTION='))
    ?.slice(22)
    .trim()
    .split(/\s+/);
  if (
    !fields ||
    fields.length !== 4 ||
    ipv4(fields[0]) !== expected ||
    !isIPv4(fields[2]!) ||
    ![fields[1], fields[3]].every((port) => /^\d+$/.test(port!) && Number(port) > 0 && Number(port) <= 65535)
  ) {
    throw new Error(`SSH_CONNECTION peer does not match ${expected}; observed ${fields?.[0] ?? '<missing>'}`);
  }
  const timestamp = Number(lines.find((line) => line.startsWith('REZICS_PROBE_TIME='))?.slice(18));
  const match = new RegExp(
    '^Accepted \\S+ for .+ from ' + expected.replaceAll('.', '\\.') + ' port ' + fields[1] + '(?:\\s|$)',
  );
  const journal = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !journal.some(
      (entry) =>
        typeof entry.MESSAGE === 'string' &&
        match.test(entry.MESSAGE) &&
        Number(entry.__REALTIME_TIMESTAMP) / 1e6 >= timestamp - policy.journalAgeSeconds &&
        Number(entry.__REALTIME_TIMESTAMP) / 1e6 <= timestamp + policy.clockSkewSeconds,
    )
  ) {
    throw new Error('Missing matching sshd journal evidence for probe timestamp and client port');
  }
  return fields[0]!;
}

export async function execute(argv: string[], d: Dependencies): Promise<void> {
  const policy = (d.policy ?? defaultPolicy).hostRoute;
  const [action, ...options] = argv;
  if (!['plan', 'apply', 'verify', 'remove'].includes(action ?? ''))
    throw new Error('Use plan|apply|verify|remove --hosts <file> [--expected-peer <IPv4>]');
  const values = new Map<string, string>();
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i]!;
    const value = options[i + 1];
    if (!['--hosts', '--expected-peer'].includes(key) || !value || value.startsWith('--') || values.has(key))
      throw new Error('Invalid or duplicate option');
    values.set(key, value);
  }
  if ((action === 'apply' || action === 'remove') && d.uid() !== 0) throw new Error(`${action} requires sudo`);
  const expected =
    action === 'verify' || values.has('--expected-peer') ? ipv4(values.get('--expected-peer')) : undefined;
  const hostsPath = values.get('--hosts');
  if (action !== 'remove' && !hostsPath) throw new Error('--hosts is required');
  const hosts =
    action === 'remove'
      ? []
      : readHosts(
          JSON.parse(d.files.read(hostsPath!)),
          action === 'verify' ? (identity) => checkedIdentityPath(identity, d) : undefined,
        );
  const previous = readState(d);
  if ((action === 'apply' || action === 'remove') && d.files.exists(HOOK)) {
    d.files.secure(HOOK);
    if (!d.files.read(HOOK).startsWith('#!/usr/bin/python3 -I\n# REZICS managed check-host routes\n'))
      throw new Error('Refusing to change an unrelated hook');
  }
  const all = await routes(d);
  if (action === 'remove') {
    for (const route of all.filter((route) => owned(route, previous))) {
      await command(d, routeArgs('del', hostIP(route)!, route.gateway!, route.dev!));
    }
    d.files.remove(HOOK);
    d.files.remove(STATE);
    d.print('Removed managed hook, state and routes');
    return;
  }
  const addresses = [...new Set(hosts.map((host) => host.ip))];
  const { device, gateway } = physicalDefault(d, all);
  if (action === 'plan' || action === 'apply') conflicts(all, addresses, previous);
  d.print(`Physical default: via ${gateway} dev ${device}`);
  if (action === 'apply') {
    // Retire only the old managed tuples when the host set or physical device changes.
    for (const route of all.filter(
      (route) => owned(route, previous) && (route.dev !== device || !addresses.includes(hostIP(route)!)),
    )) {
      await command(d, routeArgs('del', hostIP(route)!, route.gateway!, route.dev!));
    }
    d.files.writeRoot(STATE, JSON.stringify({ device, addresses }) + '\n', 0o644);
    d.files.writeRoot(HOOK, DISPATCHER, 0o755);
    await command(d, [HOOK, device, 'reapply']);
    d.print(`Installed ${HOOK} and reconciled ${addresses.length} host routes`);
    return;
  }
  if (action === 'plan') {
    for (const route of all.filter(
      (route) => owned(route, previous) && (route.dev !== device || !addresses.includes(hostIP(route)!)),
    )) {
      d.print(routeArgs('del', hostIP(route)!, route.gateway!, route.dev!).join(' '));
    }
  }
  let failed = false;
  for (const host of hosts) {
    try {
      const lookup = await command(d, ['ip', '-4', 'route', 'get', host.ip, 'ipproto', 'tcp', 'dport', '22']);
      d.print(`${host.name} ${host.address}: ${lookup.trim()}`);
      if (action === 'plan') {
        d.print(routeArgs('replace', host.ip, gateway, device).join(' '));
      } else {
        const tokens = lookup.trim().split(/\s+/);
        const devIndex = tokens.indexOf('dev');
        const viaIndex = tokens.indexOf('via');
        if (devIndex < 0 || viaIndex < 0 || tokens[devIndex + 1] !== device || tokens[viaIndex + 1] !== gateway)
          throw new Error('TCP/22 route does not use the physical device and current gateway');
        const output = await command(d, [
          'ssh',
          '-i',
          host.identity!,
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'ProxyCommand=none',
          '-o',
          'ProxyJump=none',
          '-o',
          'BatchMode=yes',
          '-o',
          'ControlMaster=no',
          '-o',
          'ControlPath=none',
          '-o',
          'ControlPersist=no',
          '-o',
          `ConnectTimeout=${policy.connectTimeoutSeconds}`,
          host.address,
          sshProbe(policy),
        ]);
        d.print(`${host.name}: PASS sshd peer ${peerEvidence(output, expected!, policy)}`);
      }
    } catch (error) {
      failed = true;
      d.print(`${host.name}: FAIL ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) throw new Error(`${action} failed`);
}

const realFiles: FileSystem = {
  read: (path) => fs.readFileSync(path, 'utf8'),
  exists: (path) => {
    try {
      fs.lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  lstat: (path) => fs.lstatSync(path),
  secure: (path) => {
    const info = fs.lstatSync(path);
    if (!info.isFile() || info.uid !== 0 || info.mode & 0o022) throw new Error(`Unsafe root-owned file: ${path}`);
  },
  writeRoot: (path, data, mode) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.fchownSync(fd, 0, 0);
      fs.writeFileSync(fd, data);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
      fs.renameSync(temporary, path);
    } finally {
      fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  },
  remove: (path) => fs.rmSync(path, { force: true }),
};

if (import.meta.main) {
  try {
    await execute(process.argv.slice(2), {
      policy: (await import('../src/config.ts')).loadSettings().policy,
      files: realFiles,
      uid: () => process.getuid!(),
      print: console.log,
      run: async (argv) => {
        const child = Bun.spawn(argv, {
          env: {
            PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
            LC_ALL: 'C',
            HOME: process.env.HOME,
            SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
          },
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
