import { describe, expect, test } from 'bun:test';
import { DISPATCHER, execute, HOOK, METRIC, readHosts, STATE } from './check-host-route.ts';
import type { Dependencies, Result } from './check-host-route.ts';

const A = '159.195.83.211';
const B = '159.195.212.125';
const PEER = '203.0.113.9';
const GATEWAY = '192.168.0.1';
const DEVICE = 'enp67s0';
const HOSTS = 'hosts.json';
const DEFAULT = { dst: 'default', gateway: GATEWAY, dev: DEVICE, protocol: 'dhcp', metric: 100 };
const managed = (ip = A, changes = {}) => ({
  dst: `${ip}/32`,
  gateway: GATEWAY,
  dev: DEVICE,
  protocol: 'static',
  metric: METRIC,
  ...changes,
});
const state = (addresses = [A, B]) => ({ device: DEVICE, addresses });
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
const lookup = (ip: string) => `${ip} via ${GATEWAY} dev ${DEVICE} src 192.168.0.10 uid 1000\n    cache\n`;
const evidence = (peer = PEER, port = '45231', time = 1700000000) =>
  `REZICS_SSH_CONNECTION=${peer} ${port} ${A} 22\nREZICS_PROBE_TIME=${time}\n` +
  JSON.stringify({
    MESSAGE: `Accepted publickey for root from ${peer} port ${port} ssh2: ED25519 SHA256:example`,
    __REALTIME_TIMESTAMP: String(time * 1e6),
  });

function fixture() {
  const files = new Map<string, string>([
    [
      HOSTS,
      JSON.stringify({
        hosts: [
          { name: 'a', address: `root@${A}`, identity: '/must/not/read' },
          { name: 'b', address: `root@${B}`, identity: '/must/not/read/either' },
        ],
      }),
    ],
  ]);
  const writes: { path: string; data: string; mode: number }[] = [];
  const reads: string[] = [];
  const secured: string[] = [];
  const calls: string[][] = [];
  const output: string[] = [];
  const f = {
    files,
    writes,
    reads,
    secured,
    calls,
    output,
    uid: 1000,
    routes: [DEFAULT] as object[],
    lookup: (ip: string) => lookup(ip),
    ssh: (_argv: string[]) => ok(evidence()),
    hook: async (_argv: string[]) => ok(),
    physical: true,
    d: undefined as unknown as Dependencies,
  };
  f.d = {
    uid: () => f.uid,
    print: (line) => output.push(line),
    files: {
      read: (path) => {
        reads.push(path);
        if (!files.has(path)) throw new Error(`Unexpected read ${path}`);
        return files.get(path)!;
      },
      exists: (path) => (path === `/sys/class/net/${DEVICE}/device` ? f.physical : files.has(path)),
      secure: (path) => {
        secured.push(path);
      },
      writeRoot: (path, data, mode) => {
        writes.push({ path, data, mode });
        files.set(path, data);
      },
      remove: (path) => {
        files.delete(path);
      },
    },
    run: async (argv) => {
      calls.push(argv);
      if (argv[0] === HOOK) return f.hook(argv);
      if (argv[0] === 'ssh') return f.ssh(argv);
      if (argv.join(' ') === 'ip -j -4 route show table main') return ok(JSON.stringify(f.routes));
      if (argv.slice(0, 4).join(' ') === 'ip -4 route get') return ok(f.lookup(argv[4]!));
      if (argv.slice(0, 4).join(' ') === 'ip -4 route del') return ok();
      throw new Error(`Unexpected command ${JSON.stringify(argv)}`);
    },
  };
  return f;
}

// Execute the installed Python bytes, substituting every network command and filesystem access in memory.
// The only real child is the Python interpreter; it cannot reach ip, ssh, /etc or sysfs through this harness.
const PYTHON_HARNESS = `
import io, json, os, stat, subprocess, sys, syslog, types
data = json.load(sys.stdin)
calls, logs = [], []
def run(args, **kwargs):
    calls.append(args)
    if args == ["ip", "-j", "-4", "route", "show", "table", "main"]:
        return types.SimpleNamespace(returncode=0, stdout=json.dumps(data["routes"]), stderr="")
    if data.get("fail"):
        return types.SimpleNamespace(returncode=2, stdout="", stderr="injected route failure")
    return types.SimpleNamespace(returncode=0, stdout="", stderr="")
class StateFile(io.StringIO):
    def fileno(self): return 42
os.open = lambda *args: 42
os.fdopen = lambda *args: StateFile(json.dumps(data["state"]))
os.fstat = lambda *args: types.SimpleNamespace(st_uid=data.get("uid", 0), st_mode=stat.S_IFREG | data.get("mode", 0o644))
os.path.exists = lambda path: data.get("physical", True)
subprocess.run = run
syslog.syslog = lambda *args: logs.append(args[-1])
sys.argv = ["hook", data.get("device", "enp67s0"), data.get("event", "reapply")]
code = 0
try:
    exec(data["source"], {"__name__": "__main__"})
except SystemExit as error:
    code = error.code
print(json.dumps({"code": code, "calls": calls, "logs": logs}))
`;

async function hook(options: object = {}) {
  const process = Bun.spawn(['/usr/bin/python3', '-c', PYTHON_HARNESS], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  process.stdin.write(JSON.stringify({ source: DISPATCHER, routes: [DEFAULT], state: state(), ...options }));
  process.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Python harness: ${stderr}`);
  return JSON.parse(stdout) as { code: number; calls: string[][]; logs: string[] };
}

function routeCommand(action: string, ip: string, gateway = GATEWAY) {
  return [
    'ip',
    '-4',
    'route',
    action,
    `${ip}/32`,
    'via',
    gateway,
    'dev',
    DEVICE,
    'table',
    'main',
    'proto',
    'static',
    'metric',
    String(METRIC),
  ];
}

test("plan prints each host's /32 route via the physical default gateway and refuses an ambiguous default route or a conflicting existing route", async () => {
  const f = fixture();
  f.lookup = (ip) => `${ip} via 198.18.0.2 dev FlClash table 2022 src 198.18.0.1`;
  f.routes.push({ dst: 'default', dev: 'FlClash', gateway: '198.18.0.2' });
  await execute(['plan', '--hosts', HOSTS], f.d);
  expect(f.output.join('\n')).toContain(`Physical default: via ${GATEWAY} dev ${DEVICE}`);
  for (const [name, ip] of [
    ['a', A],
    ['b', B],
  ]) {
    expect(f.output.join('\n')).toContain(`${name} root@${ip}: ${ip} via 198.18.0.2 dev FlClash`);
    expect(f.output).toContain(routeCommand('replace', ip!).join(' '));
    expect(f.calls).toContainEqual(['ip', '-4', 'route', 'get', ip!, 'ipproto', 'tcp', 'dport', '22']);
  }
  expect(f.writes).toEqual([]);
  expect(
    f.calls.every((args) => args[0] === 'ip' && ['show', 'get'].includes(args[4] === 'show' ? args[4] : args[3]!)),
  ).toBe(true);

  for (const routes of [
    [],
    [DEFAULT, { ...DEFAULT, gateway: '192.168.0.2', metric: 200 }],
    [{ ...DEFAULT, nexthops: [{ gateway: GATEWAY, dev: DEVICE }] }],
    [DEFAULT, managed(A, { metric: 10 })],
    [DEFAULT, managed(A)],
    [DEFAULT, { dst: A, type: 'blackhole' }],
  ]) {
    const denied = fixture();
    denied.routes = routes;
    await expect(execute(['plan', '--hosts', HOSTS], denied.d)).rejects.toThrow(/default route|Conflicting/);
    expect(denied.writes).toEqual([]);
  }
});

test('apply writes the root-owned dispatcher hook and host state and reconciles once, and the hook replaces only its own routes', async () => {
  const f = fixture();
  f.uid = 0;
  f.hook = async (argv) => {
    expect(argv).toEqual([HOOK, DEVICE, 'reapply']);
    const result = await hook({ source: f.files.get(HOOK), state: JSON.parse(f.files.get(STATE)!) });
    expect(result.code).toBe(0);
    expect(result.calls.slice(1)).toEqual([routeCommand('replace', A), routeCommand('replace', B)]);
    return ok();
  };
  await execute(['apply', '--hosts', HOSTS], f.d);
  expect(f.writes).toEqual([
    { path: STATE, data: JSON.stringify(state()) + '\n', mode: 0o644 },
    { path: HOOK, data: DISPATCHER, mode: 0o755 },
  ]);
  expect(f.calls.filter((args) => args[0] === HOOK)).toHaveLength(1);
  expect(f.reads).toEqual([HOSTS]);
  expect(f.files.get(STATE)).not.toContain('identity');

  const foreign = managed(B, { metric: 10 });
  const denied = await hook({ routes: [DEFAULT, managed(), foreign] });
  expect(denied.code).toBe(1);
  expect(denied.calls).toHaveLength(1);
  expect(denied.logs.join()).toContain('Conflicting');
});

test('verify passes only when the TCP/22 route lookup uses the physical device and sshd sees the expected home address', async () => {
  const f = fixture();
  await execute(['verify', '--hosts', HOSTS, '--expected-peer', PEER], f.d);
  expect(f.output).toContain(`a: PASS sshd peer ${PEER}`);
  expect(f.output).toContain(`b: PASS sshd peer ${PEER}`);
  for (const args of f.calls.filter((args) => args[0] === 'ssh')) {
    expect(args).toContain('ProxyCommand=none');
    expect(args).toContain('ProxyJump=none');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ControlPath=none');
    expect(args.at(-1)).toContain('$SSH_CONNECTION');
    expect(args.at(-1)).toContain('journalctl');
    expect(args).not.toContain('-i');
  }
  for (const route of [
    `${A} via 198.18.0.2 dev FlClash table 2022`,
    `${A} via 192.168.0.2 dev ${DEVICE}`,
    `${A} dev ${DEVICE}`,
  ]) {
    const wrong = fixture();
    wrong.lookup = () => route;
    await expect(execute(['verify', '--hosts', HOSTS, '--expected-peer', PEER], wrong.d)).rejects.toThrow(
      'verify failed',
    );
    expect(wrong.calls.some((args) => args[0] === 'ssh')).toBe(false);
    expect(wrong.output.filter((line) => line.includes(': FAIL'))).toHaveLength(2);
  }
  const wrong = fixture();
  wrong.ssh = () => ok(evidence('203.0.113.99'));
  await expect(execute(['verify', '--hosts', HOSTS, '--expected-peer', PEER], wrong.d)).rejects.toThrow(
    'verify failed',
  );
  expect(wrong.output.join()).toContain('SSH_CONNECTION peer does not match');
});

describe('input and ownership boundaries', () => {
  test('never accesses identity properties and rejects nonliteral or unsafe destinations', async () => {
    const host = {
      name: 'a',
      address: `root@${A}`,
      get identity(): never {
        throw new Error('Identity accessed');
      },
    };
    expect(readHosts({ hosts: [host] })).toEqual([{ name: 'a', address: `root@${A}`, ip: A }]);
    expect(readHosts({ hosts: [{ name: 'a', address: A }] })[0]?.ip).toBe(A);
    for (const address of [
      'root@example.com',
      '127.1',
      '01.2.3.4',
      '256.1.2.3',
      '::1',
      'root@1.2.3.4;touch',
      '-oProxyCommand=x@1.2.3.4',
      'root@@1.2.3.4',
      'root@1.2.3.4\n',
    ]) {
      const f = fixture();
      f.files.set(HOSTS, JSON.stringify({ hosts: [{ name: 'x', address }] }));
      await expect(execute(['plan', '--hosts', HOSTS], f.d)).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
    const f = fixture();
    await expect(execute(['verify', '--hosts', HOSTS], f.d)).rejects.toThrow('Invalid IPv4');
    await expect(execute(['verify', '--hosts', HOSTS, '--expected-peer', 'home.example'], f.d)).rejects.toThrow(
      'Invalid IPv4',
    );
    expect(f.calls).toEqual([]);
  });

  test('only apply and remove require root and unsafe state is rejected', async () => {
    for (const action of ['apply', 'remove']) {
      const f = fixture();
      await expect(execute([action, '--hosts', HOSTS], f.d)).rejects.toThrow('requires sudo');
      expect(f.calls).toEqual([]);
      expect(f.writes).toEqual([]);
    }
    const f = fixture();
    f.files.set(STATE, JSON.stringify(state()));
    f.d.files.secure = () => {
      throw new Error('Unsafe root-owned file');
    };
    await expect(execute(['plan', '--hosts', HOSTS], f.d)).rejects.toThrow('Unsafe');
    for (const options of [{ uid: 1000 }, { mode: 0o666 }, { mode: 0o664 }]) {
      const result = await hook(options);
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });

  test('does not treat an arbitrary default or an unavailable device as physical', async () => {
    const f = fixture();
    f.physical = false;
    await expect(execute(['plan', '--hosts', HOSTS], f.d)).rejects.toThrow('physical default');
    for (const route of [
      { ...DEFAULT, gateway: 'router.local' },
      { ...DEFAULT, flags: ['linkdown'] },
      { ...DEFAULT, gateway: undefined },
    ]) {
      const bad = fixture();
      bad.routes = [route];
      await expect(execute(['apply', '--hosts', HOSTS], { ...bad.d, uid: () => 0 })).rejects.toThrow();
      expect(bad.writes).toEqual([]);
    }
  });
});

describe('dispatcher lifecycle', () => {
  test('re-reads the live gateway on all supported up events, never using event environment', async () => {
    for (const event of ['up', 'reapply', 'dhcp4-change']) {
      const result = await hook({
        event,
        routes: [{ ...DEFAULT, gateway: '192.168.0.254' }, managed(), { dst: '10.0.0.0/8', dev: DEVICE }],
      });
      expect(result.code).toBe(0);
      expect(result.calls.slice(1)).toEqual([
        routeCommand('replace', A, '192.168.0.254'),
        routeCommand('replace', B, '192.168.0.254'),
      ]);
    }
    for (const options of [{ event: 'vpn-up' }, { device: 'FlClash' }]) {
      expect((await hook(options)).calls).toEqual([]);
    }
  });

  test('down and a missing live gateway delete only fully identified managed routes', async () => {
    const routes = [
      managed(),
      managed(B, { protocol: 'boot' }),
      managed(B, { metric: 10 }),
      managed(B, { dev: 'other' }),
      managed('203.0.113.100'),
    ];
    const down = await hook({ event: 'down', routes });
    expect(down.code).toBe(0);
    expect(down.calls.slice(1)).toEqual([routeCommand('del', A)]);
    const missing = await hook({ routes });
    expect(missing.code).toBe(1);
    expect(missing.calls.slice(1)).toEqual([routeCommand('del', A)]);
    expect(missing.logs.join()).toContain('live physical gateway');
    const ambiguous = await hook({ routes: [DEFAULT, DEFAULT, managed()] });
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.calls.slice(1)).toEqual([routeCommand('del', A)]);
    const failed = await hook({ fail: true });
    expect(failed.code).toBe(1);
    expect(failed.logs.join()).toContain('injected route failure');
  });

  test('reapply retires removed hosts and accepts only previously owned exact routes', async () => {
    const f = fixture();
    f.uid = 0;
    f.files.set(STATE, JSON.stringify(state()));
    f.files.set(HOOK, DISPATCHER);
    f.routes.push(managed(), managed(B), managed('203.0.113.100'));
    f.files.set(HOSTS, JSON.stringify({ hosts: [{ name: 'a', address: `root@${A}` }] }));
    await execute(['plan', '--hosts', HOSTS], f.d);
    expect(f.output).toContain(routeCommand('del', B).join(' '));
    await execute(['apply', '--hosts', HOSTS], f.d);
    expect(JSON.parse(f.files.get(STATE)!)).toEqual(state([A]));
    expect(f.calls.filter((args) => args[3] === 'del')).toEqual([routeCommand('del', B)]);
    expect(f.secured).toContain(STATE);
    expect(f.secured).toContain(HOOK);
    const unrelated = fixture();
    unrelated.uid = 0;
    unrelated.files.set(HOOK, '#!/bin/sh\necho unrelated');
    await expect(execute(['apply', '--hosts', HOSTS], unrelated.d)).rejects.toThrow('unrelated hook');
    expect(unrelated.writes).toEqual([]);
  });

  test('remove uses saved state even without a gateway or hosts file, and leaves other routes alone', async () => {
    const f = fixture();
    f.uid = 0;
    f.files.set(STATE, JSON.stringify(state()));
    f.files.set(HOOK, DISPATCHER);
    f.routes = [managed(), managed(B, { metric: 1 }), managed(B, { dev: 'FlClash' }), managed('203.0.113.100')];
    await execute(['remove'], f.d);
    expect(f.calls.filter((args) => args[3] === 'del')).toEqual([routeCommand('del', A)]);
    expect(f.files.has(STATE)).toBe(false);
    expect(f.files.has(HOOK)).toBe(false);
    expect(f.reads).toEqual([STATE, HOOK]);
    await execute(['remove'], f.d);
    expect(f.calls.filter((args) => args[3] === 'del')).toHaveLength(1);
  });

  test('remove refuses an unrelated or insecure hook before deleting routes', async () => {
    const f = fixture();
    f.uid = 0;
    f.files.set(STATE, JSON.stringify(state()));
    f.files.set(HOOK, '#!/bin/sh\necho unrelated');
    f.routes.push(managed());
    await expect(execute(['remove'], f.d)).rejects.toThrow('unrelated hook');
    expect(f.calls).toEqual([]);
    expect(f.files.has(STATE)).toBe(true);
    expect(f.files.has(HOOK)).toBe(true);
  });

  test('dispatcher rejects invalid persisted addresses and cannot run interpolated commands', async () => {
    for (const address of ['example.com', '1.2.3.4;touch /tmp/bad', 1234, '01.2.3.4']) {
      const result = await hook({ state: { device: DEVICE, addresses: [address] } });
      expect(result.code).toBe(1);
      expect(result.calls).toEqual([]);
    }
  });
});

test('verification fails closed without timestamp-correlated journal evidence and reports every host', async () => {
  for (const output of [
    evidence().split('\n').slice(0, 2).join('\n'),
    evidence().replace('port 45231 ssh2', 'port 45232 ssh2'),
    evidence().replace('1700000000000000', '1699999000000000'),
    evidence().replace('REZICS_PROBE_TIME=1700000000', 'REZICS_PROBE_TIME=garbage'),
    evidence().replace('Accepted publickey', 'Disconnected'),
    '',
    'unexpected banner',
  ]) {
    const f = fixture();
    f.ssh = () => ok(output);
    await expect(execute(['verify', '--hosts', HOSTS, '--expected-peer', PEER], f.d)).rejects.toThrow('verify failed');
    expect(f.output.filter((line) => line.includes(': FAIL'))).toHaveLength(2);
    expect(f.output.some((line) => line.includes(': PASS'))).toBe(false);
  }
  const f = fixture();
  f.ssh = (args) =>
    args.includes(`root@${A}`) ? { code: 255, stdout: '', stderr: 'Permission denied' } : ok(evidence());
  await expect(execute(['verify', '--hosts', HOSTS, '--expected-peer', PEER], f.d)).rejects.toThrow('verify failed');
  expect(f.output.join()).toContain('a: FAIL');
  expect(f.output).toContain(`b: PASS sshd peer ${PEER}`);
});
