import { spawn } from 'node:child_process';
import { processIdentity, sameProcess } from './process.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  installService,
  stopLegacySupervisor,
  reportServices,
  SERVICE_UNITS,
  startHostHeartbeat,
  type ServiceCommand,
} from './service.ts';
import { runMaintenance } from './maintenance.ts';
import { temporaryDirectory } from './test-support.ts';
import type { Runtime } from './config.ts';

function recorder() {
  const calls: string[][] = [];
  const run: ServiceCommand = async (argv) => {
    calls.push(argv);
    return {
      code: 0,
      output: argv.includes('--property=LoadState') ? 'loaded' : 'ActiveState=active\nResult=success\n',
    };
  };
  return { calls, run };
}

test('install renders repository units, one private environment file, linger and independent resident services', async () => {
  const dir = temporaryDirectory();
  const { calls, run } = recorder();
  try {
    const main = join(dir.path, 'checkout with spaces%$');
    const units = join(dir.path, 'units');
    await installService(
      {
        mainCheckout: main,
        localConfig: join(main, 'local.json'),
        home: dir.path,
        unitDirectory: units,
        user: 'fixture',
        path: '/usr/bin:/bin',
        bun: '/fixture/bun',
        kernelCheckRemote: '1',
      },
      run,
    );
    const file = join(main, '.temp/goal/goal.env');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=')[0]),
    ).toEqual(['GOAL_MAIN_CHECKOUT', 'GOAL_LOCAL_CONFIG', 'KERNEL_CHECK_REMOTE', 'PATH', 'HOME']);
    for (const unit of SERVICE_UNITS.filter((unit) => unit.endsWith('.service'))) {
      const text = readFileSync(join(units, unit), 'utf8');
      expect(text.match(/^EnvironmentFile=/gm)).toHaveLength(1);
      expect(text).toContain('ExecStart=/usr/bin/env -i ');
      expect(text).not.toMatch(/CLAUDE_|CODEX_THREAD_ID|\/bin\/(ba)?sh/);
      expect(text).not.toContain('@CHECKOUT@');
      expect(text).toContain('spaces%%');
    }
    const host = readFileSync(join(units, SERVICE_UNITS[0]), 'utf8');
    expect(host).toContain('Restart=always');
    expect(host).toContain('KillMode=process');
    expect(host).toContain('WatchdogSec=60s');
    expect(host).toContain('_manager-host');
    expect(readFileSync(join(units, SERVICE_UNITS[1]), 'utf8')).toContain('service run-verifier');
    expect(readFileSync(join(units, SERVICE_UNITS[3]), 'utf8')).toContain('OnUnitInactiveSec=1min');
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['loginctl', 'enable-linger', 'fixture'],
      ['systemctl', '--user', 'enable', SERVICE_UNITS[0], SERVICE_UNITS[1], SERVICE_UNITS[3]],
      ['systemctl', '--user', 'show', '--property=LoadState', '--value', 'rezics-goal-supervisor.service'],
      ['systemctl', '--user', 'stop', 'rezics-goal-supervisor.service'],
      ['systemctl', '--user', 'start', SERVICE_UNITS[0], SERVICE_UNITS[1], SERVICE_UNITS[3]],
      ['systemctl', '--user', 'start', SERVICE_UNITS[2]],
    ]);
  } finally {
    dir.close();
  }
});

test('legacy shutdown uses supervisor and host birth identities and leaves worker processes alive', async () => {
  const dir = temporaryDirectory();
  const children = [0, 1, 2].map(() =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }),
  );
  const exited = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
  try {
    const identities = children.map((child) => processIdentity(child.pid!)!);
    const lease = join(dir.path, 'manager-host-supervisor.lease');
    mkdirSync(lease);
    writeFileSync(join(lease, 'owner.json'), JSON.stringify({ ...identities[0], token: 'owner' }));
    writeFileSync(join(lease, 'stale.json'), JSON.stringify({ ...identities[2], start: '0', token: 'stale' }));
    writeFileSync(
      join(dir.path, 'manager-host-liveness.json'),
      JSON.stringify({ identity: identities[1], desired: true }),
    );
    await stopLegacySupervisor(dir.path, async () => ({ code: 1, output: 'not-found' }));
    await Promise.all(exited.slice(0, 2));
    expect(identities.map((identity) => sameProcess(identity))).toEqual([false, false, true]);
  } finally {
    for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await Promise.all(exited);
    dir.close();
  }
});

test('status, restart and logs include each unit health and keep a unit failure visible', async () => {
  for (const action of ['status', 'restart', 'logs'] as const) {
    const { calls, run } = recorder();
    const lines: string[] = [];
    expect(await reportServices(action, run, (line) => lines.push(line))).toBe(0);
    for (const unit of SERVICE_UNITS) {
      expect(lines.some((line) => line.includes(unit) && line.includes('ActiveState=active'))).toBe(true);
      if (action === 'logs') expect(calls.some((call) => call[0] === 'journalctl' && call.includes(unit))).toBe(true);
    }
    if (action === 'restart') expect(calls[0]).toEqual(['systemctl', '--user', 'restart', ...SERVICE_UNITS]);
  }
  expect(
    await reportServices(
      'status',
      async () => ({ code: 0, output: 'ActiveState=failed\nResult=watchdog' }),
      () => {},
    ),
  ).toBe(1);
  await expect(
    installService({ mainCheckout: '/invalid\npath', localConfig: '/local' }, async () => ({ code: 0, output: '' })),
  ).rejects.toThrow('single-line');
});

test('host readiness and heartbeat follow systemd watchdog timing and stop on shutdown', async () => {
  const messages: string[] = [];
  const stop = await startHostHeartbeat(
    { NOTIFY_SOCKET: '/fixture/notify', WATCHDOG_USEC: '20000' },
    async (message) => {
      messages.push(message);
    },
  );
  await Bun.sleep(35);
  stop();
  const count = messages.length;
  await Bun.sleep(25);
  expect(messages[0]).toBe('READY=1');
  expect(messages.slice(1).length).toBeGreaterThan(0);
  expect(messages.slice(1).every((message) => message === 'WATCHDOG=1')).toBe(true);
  expect(messages).toHaveLength(count);
});

test('maintenance keeps detecting incidents when the output alarm fails and respects regeneration cadence', async () => {
  const dir = temporaryDirectory();
  mkdirSync(dir.path, { recursive: true });
  writeFileSync(join(dir.path, 'dev-derived.json'), JSON.stringify({ at: Date.now() }));
  let detected = 0;
  const runtime = {
    stateDirectory: dir.path,
    store: { tasks: () => [] },
    evaluateFlow: async () => {
      throw new Error('fixture alarm failure');
    },
    deliverReminders: async () => {
      await Bun.sleep(5);
      detected++;
      return detected;
    },
  } as unknown as Runtime;
  const original = console.error;
  const errors: string[] = [];
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    expect(await runMaintenance('all', runtime)).toBe(1);
    expect(detected).toBe(1);
    expect(errors.join('\n')).toContain('fixture alarm failure');
  } finally {
    console.error = original;
    dir.close();
  }
});

test('maintenance reaps recorded groups in deleted worktrees and spares workers in retained worktrees', async () => {
  const dir = temporaryDirectory();
  const retained = join(dir.path, 'retained');
  mkdirSync(retained);
  const children = [0, 1].map(() =>
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }),
  );
  const exited = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
  try {
    const identities = children.map((child) => processIdentity(child.pid!)!);
    const runtime = {
      stateDirectory: dir.path,
      store: {
        tasks: () => [
          { id: 'gone', worktree: join(dir.path, 'deleted') },
          { id: 'kept', worktree: retained },
        ],
        attempts: (id: string) => [{ process: identities[id === 'gone' ? 0 : 1] }],
      },
    } as unknown as Runtime;
    expect(await runMaintenance('reap', runtime)).toBe(0);
    await exited[0];
    expect(sameProcess(identities[0]!)).toBe(false);
    expect(sameProcess(identities[1]!)).toBe(true);
  } finally {
    for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await Promise.all(exited);
    dir.close();
  }
});
