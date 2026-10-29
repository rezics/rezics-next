import { expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const repository = resolve(import.meta.dir, '../../..');
const database = resolve(import.meta.dir, '../scripts/database.ts');

type Event = { args?: string[]; kind: string; timeout?: number; script?: string };

function fixture() {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repository, '.temp/auth-placement-'));
  const log = join(root, 'events.jsonl');
  const state = join(root, 'created');
  const preload = join(root, 'preload.ts');
  const hosts = join(root, 'hosts.json');
  writeFileSync(log, '');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: [
        {
          name: 'fake',
          address: 'test@fake.test',
          identity: '/unused',
          memoryMaxGiB: 16,
          cpuQuotaPercent: 800,
          slots: 2,
        },
      ],
    }),
  );
  writeFileSync(
    preload,
    `
import { mock } from 'bun:test';
import * as childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
const original = childProcess.spawnSync;
mock.module('node:child_process', () => ({ ...childProcess, spawnSync(program, args, options) {
  if (program === 'docker') appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'wait', args, timeout: options?.timeout }) + '\\n');
  // Exercise a real spawnSync timeout against a hanging fake executable without a two-minute test.
  return original(program, args, program === 'docker' && args[0] === 'run' && process.env.FAKE_HANG === '1' ? { ...options, timeout: 200 } : options);
}}));
// Placement tests must also run on real check hosts. Virtualize only the host-root identity;
// keep stack-run's probing, placement, lease and remote command implementation intact.
const remote = await import(${JSON.stringify(join(repository, 'scripts/remote-check.ts'))});
mock.module(${JSON.stringify(join(repository, 'scripts/remote-check.ts'))}, () => ({ ...remote, ROOT: ${JSON.stringify(join(root, 'host'))} }));
`,
  );
  const scripts = {
    docker: `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'docker', args }) + '\\n');
if (args[0] === 'run') {
  const label = args.find(arg => arg.startsWith('rezics.auth.check.nonce='));
  writeFileSync(${JSON.stringify(state)}, label ?? 'missing nonce');
  if (process.env.FAKE_HANG === '1') setInterval(() => {}, 1000);
  else { console.error('created but never started'); process.exit(73); }
} else if (args[0] === 'ps' && args.includes('-aq')) {
  const filter = args.at(-1);
  if (process.env.FAKE_PID_RESOURCES === '1' && filter.startsWith('label=rezics.auth.check.pid=')) console.log('owned-container');
  else if (existsSync(${JSON.stringify(state)}) && filter === 'label=' + readFileSync(${JSON.stringify(state)}, 'utf8')) console.log('created-container');
} else if (args[0] === 'rm') {
  // Delayed removal proves the caller waits, rather than detaching docker rm.
  Bun.sleepSync(100);
  rmSync(${JSON.stringify(state)}, { force: true });
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind: 'removed' }) + '\\n');
} else if (args[0] === 'volume' && args[1] === 'ls' && process.env.FAKE_PID_RESOURCES === '1') { console.log('owned-volume');
} else if (!['ps', 'exec', 'volume'].includes(args[0])) process.exit(74);
`,
    ssh: `
import { appendFileSync } from 'node:fs';
const script = process.argv.at(-1);
const log = kind => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ kind, script }) + '\\n');
if (script.includes('MemAvailable')) {
  log('probe');
  if (process.env.FAKE_DOWN === '1') process.exit(255);
  console.log('MEMORY_CURRENT -\\nMEMORY_MAX -\\nMEMORY_HEADROOM 17179869184\\nPROCESSORS 16\\nSLICE_PROCESSORS 8\\nLOAD 0\\nORDINARY_SLOTS_USED 0\\nEXPRESS_SLOT_USED 0\\nGATE_WAITING 0\\nMULTI_SLOT_WAITING_SLOTS 0\\nMULTI_SLOT_WAITING_ID -');
} else if (script.includes('REMOTE_CHECK_RESERVATION') || script.includes('REMOTE_CHECK_SLOT_')) {
  log('lease');
  console.log(script.includes('REMOTE_CHECK_RESERVATION') ? 'RESERVATION' : 'SLOTS 1');
  process.stdin.resume();
} else if (script.includes('REMOTE_CHECK_BASE_STATE')) {
  console.log('BASE -\\nAGE -\\nZSTD 0');
} else if (script.includes('systemd-run')) { log('remote'); }
else { log('remote-cleanup'); }
`,
    // Host copies intentionally omit .git; this fixture sends one known file through fake rsync.
    git: `if (process.argv[2] !== 'ls-files') process.exit(74); process.stdout.write('services/auth/scripts/check.ts\\0');`,
    rsync: `await Bun.stdin.text();`,
  };
  for (const [name, script] of Object.entries(scripts)) {
    const file = join(root, name);
    writeFileSync(file, `#!${process.execPath}\n${script}`);
    chmodSync(file, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ''}`,
    KERNEL_CHECK_REMOTE: hosts,
    REZICS_STACK_LEASE: 'off',
    REZICS_STACK_REMOTE: '',
    REZICS_STACK_SLOT: undefined,
    AUTH_CHECK_CONTAINER: undefined,
    AUTH_CHECK_LANE_OWNER: undefined,
    DATABASE_URL: undefined,
    REMOTE_CHECK_POLL_MS: '10',
  };
  return {
    root,
    state,
    env,
    events: (): Event[] =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    run: (source: string, overrides: NodeJS.ProcessEnv = {}) =>
      Bun.spawnSync([process.execPath, '--preload', preload, '-e', source], {
        cwd: repository,
        env: { ...env, ...overrides },
        timeout: 15_000,
      }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const entry of ['testDatabase()', 'ownDatabase()', "run('docker', ['run', '-d', POSTGRES_IMAGE])"]) {
  test(`direct ${entry} refuses before touching Docker and names the placed command`, () => {
    const f = fixture();
    try {
      for (const worker of ['worker', '']) {
        const result = f.run(
          `import { testDatabase, ownDatabase, run, POSTGRES_IMAGE } from ${JSON.stringify(database)}; ${entry};`,
          { GOAL_TASK_ID: worker },
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain('bun run --cwd services/auth check <file>');
        expect(f.events()).toEqual([]);
      }
    } finally {
      f.close();
    }
  });
}

test('direct bun test refuses the real-Docker regression before its child check can start', () => {
  const f = fixture();
  try {
    const result = f.run(
      `
const child = Bun.spawnSync([process.execPath, 'test', ${JSON.stringify(resolve(import.meta.dir, 'database.test.ts'))}], { env: process.env, timeout: 10_000 });
process.stderr.write(child.stderr);
process.exitCode = child.exitCode;`,
      { GOAL_TASK_ID: 'worker' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('bun run --cwd services/auth check <file>');
    expect(f.events()).toEqual([]);
  } finally {
    f.close();
  }
});

for (const hang of [false, true]) {
  test(`a docker run ${hang ? 'timeout' : 'failure'} reaps created containers by nonce before rethrowing`, () => {
    const f = fixture();
    try {
      const result = f.run(
        `
import { ownDatabase } from ${JSON.stringify(database)};
import { existsSync, appendFileSync } from 'node:fs';
try { ownDatabase(); } catch (error) {
  appendFileSync(${JSON.stringify(join(f.root, 'events.jsonl'))}, JSON.stringify({ kind: 'caught' }) + '\\n');
  if (existsSync(${JSON.stringify(f.state)})) throw new Error('container survived rethrow');
  console.error(error);
  process.exitCode = 79;
}`,
        {
          AUTH_CHECK_CONTAINER: 'lane',
          AUTH_CHECK_LANE_OWNER: String(process.pid),
          DATABASE_URL: 'postgres://fake/lane',
          FAKE_HANG: hang ? '1' : '0',
        },
      );
      expect(result.exitCode).toBe(79);
      expect(result.stderr.toString()).toContain(hang ? 'ETIMEDOUT' : 'created but never started');
      expect(existsSync(f.state)).toBe(false);
      const events = f.events();
      const run = events.find((event) => event.kind === 'docker' && event.args?.[0] === 'run')!.args!;
      expect(run.slice(1, 3)).toEqual(['--stop-timeout', '2']);
      const nonce = run.find((arg) => arg.startsWith('rezics.auth.check.nonce='))!;
      expect(events.filter((event) => event.kind === 'docker').map((event) => event.args)).toContainEqual([
        'ps',
        '-aq',
        '--filter',
        `label=${nonce}`,
      ]);
      expect(events.findIndex((event) => event.kind === 'removed')).toBeLessThan(
        events.findIndex((event) => event.kind === 'caught'),
      );
      expect(
        events
          .filter(
            (event) =>
              event.kind === 'wait' &&
              (event.args?.includes('-aq') || ['rm', 'volume'].includes(event.args?.[0] ?? '')),
          )
          .every((event) => event.timeout! > 0 && event.timeout! <= 5_000),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
}

for (const worker of ['worker', '']) {
  test(`the placed check uses an answering host for ${worker ? 'a worker' : 'the gate'}`, () => {
    const f = fixture();
    try {
      const result = f.run(
        `import { databaseCheck, ownDatabase } from ${JSON.stringify(database)}; process.exitCode = await databaseCheck(['bun', 'scripts/check.ts', 'test/database-placement.test.ts'], async () => { ownDatabase(); return 0; });`,
        { GOAL_TASK_ID: worker },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toContain('stack-run: auth check on fake');
      expect(f.events().some((event) => event.kind === 'remote' && event.script?.includes('scripts/check.ts'))).toBe(
        true,
      );
      expect(f.events().some((event) => event.kind === 'docker')).toBe(false);
    } finally {
      f.close();
    }
  });
}

test('an unanswered host falls back locally with stderr notice and cleans up the failed check', () => {
  const f = fixture();
  try {
    const result = f.run(
      `import { databaseCheck, ownDatabase } from ${JSON.stringify(database)}; await databaseCheck(['bun', 'scripts/check.ts'], async () => { ownDatabase(); return 0; });`,
      { GOAL_TASK_ID: 'worker', FAKE_DOWN: '1' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('stack-run: auth check local, no check host answered');
    expect(result.stderr.toString()).toContain('created but never started');
    expect(existsSync(f.state)).toBe(false);
    expect(f.events().some((event) => event.kind === 'docker' && event.args?.[0] === 'volume')).toBe(true);
  } finally {
    f.close();
  }
});

test('a check lane reuses its server and makes further copies without docker run', () => {
  const f = fixture();
  try {
    const result = f.run(
      `
import { testDatabase } from ${JSON.stringify(database)};
const first = testDatabase(); const second = testDatabase();
if (first.container !== 'lane' || first.url !== 'postgres://fake/lane' || second.container !== 'lane' || !second.url.includes('lane_copy_1')) throw new Error('lane was not reused');
first.close(); second.close();`,
      {
        AUTH_CHECK_CONTAINER: 'lane',
        AUTH_CHECK_LANE_OWNER: String(process.pid),
        DATABASE_URL: 'postgres://fake/lane',
      },
    );
    expect(result.exitCode).toBe(0);
    expect(
      f
        .events()
        .filter((event) => event.kind === 'docker')
        .map((event) => event.args?.[0]),
    ).not.toContain('run');
    expect(
      f.events().some((event) => event.args?.includes('CREATE DATABASE lane_copy_1 TEMPLATE rezics_auth_test')),
    ).toBe(true);
  } finally {
    f.close();
  }
});

test('a check already on a check host starts there without probing another host', () => {
  const f = fixture();
  try {
    const root = join(f.root, 'host/runs/run');
    mkdirSync(join(root, 'services/auth/scripts'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const copy = join(root, 'services/auth/scripts/database.ts');
    copyFileSync(database, copy);
    writeFileSync(
      join(root, 'scripts/stack-run.ts'),
      `export { stackRun } from ${JSON.stringify(join(repository, 'scripts/stack-run.ts'))};`,
    );
    const result = f.run(
      `import { databaseCheck, ownDatabase } from ${JSON.stringify(copy)}; await databaseCheck(['bun', 'scripts/check.ts'], async () => { ownDatabase(); return 0; });`,
      { GOAL_TASK_ID: 'worker' },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('stack-run: auth check local, already on a check host');
    expect(result.stderr.toString()).toContain('created but never started');
    expect(f.events().some((event) => event.kind === 'probe')).toBe(false);
    expect(existsSync(f.state)).toBe(false);
  } finally {
    f.close();
  }
});

for (const failure of [false, true]) {
  test(`check exit removes all pid-labelled containers and volumes on ${failure ? 'failure' : 'success'}`, () => {
    const f = fixture();
    try {
      const result = f.run(
        `import { databaseCheck } from ${JSON.stringify(database)}; await databaseCheck(['bun', 'scripts/check.ts'], async () => { ${failure ? "throw new Error('check failed')" : 'return 0'}; });`,
        { GOAL_TASK_ID: 'worker', FAKE_DOWN: '1', FAKE_PID_RESOURCES: '1' },
      );
      expect(result.exitCode).toBe(failure ? 1 : 0);
      const commands = f
        .events()
        .filter((event) => event.kind === 'docker')
        .map((event) => event.args!);
      expect(commands.slice(0, 4)).toEqual([
        ['ps', '-aq', '--filter', expect.stringMatching(/^label=rezics.auth.check.pid=\d+$/)],
        ['rm', '-f', '-v', 'owned-container'],
        ['volume', 'ls', '-q', '--filter', expect.stringMatching(/^label=rezics.auth.check.pid=\d+$/)],
        ['volume', 'rm', '-f', 'owned-volume'],
      ]);
    } finally {
      f.close();
    }
  });
}
