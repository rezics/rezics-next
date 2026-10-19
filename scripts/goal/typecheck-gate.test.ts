import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { processRunning } from '../../tests/qa/support/process-liveness.ts';
import { terminateProcessGroupSync } from '../qa/process/terminate.ts';
import { legacyTypecheckBaseline, runTypecheck, typecheckGate, TypecheckBudget } from './typecheck-gate.ts';

const root = resolve(import.meta.dir, '../..');
const directories: string[] = [];
const holders: { kill(): void; exited: Promise<number> }[] = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) { holder.kill(); await holder.exited; }
  for (const directory of directories.splice(0)) {
    for (const file of readdirSync(directory).filter(file => file.endsWith('.pids.json'))) {
      for (const pid of JSON.parse(readFileSync(join(directory, file), 'utf8')) as number[]) {
        try {
          if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(directory)) terminateProcessGroupSync(pid, 0);
        } catch { /* The owned fixture already exited. */ }
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

interface CompilerCase {
  waitMs?: number;
  activeMs?: number;
  status?: number;
  diagnostic?: boolean;
  signal?: boolean;
  fork?: boolean;
  cpuWait?: boolean;
  serial?: boolean;
  legacy?: boolean;
  commandBudgetMs?: number;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(cases: Record<string, CompilerCase>): string {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/typecheck-admission-'));
  directories.push(directory);
  const compiler = join(directory, 'compiler.ts');
  writeFileSync(compiler, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const config = JSON.parse(process.argv[2]);
if (!config.legacy && ['REZICS_QA_ADMITTED_COMMAND_BUDGET_MS', 'REZICS_QA_ADMITTED_COMMAND_TOKEN', 'REZICS_QA_ADMISSION_LOG_FD']
  .some(key => process.env[key] !== undefined)) process.exit(7);
if (config.fork || config.child) process.on('SIGTERM', () => {});
const pids = [process.pid];
if (config.fork) {
  const child = spawn(process.execPath, [import.meta.path, JSON.stringify({ child: true, activeMs: 60_000 })],
    { detached: true, stdio: 'ignore' });
  pids.push(child.pid);
}
if (config.marker) writeFileSync(config.marker, JSON.stringify(pids));
if (config.diagnostic) console.error('fixture.ts(1,1): error TS2322: fixture problem');
if (config.signal) process.kill(process.pid, 'SIGTERM');
await Bun.sleep(config.activeMs ?? 0);
process.exit(config.status ?? 0);
`);
  const admission = join(directory, 'admit.ts');
  writeFileSync(admission, `
import { runHostAdmission } from ${JSON.stringify(join(root, 'scripts/qa/host-admission.ts'))};
const config = JSON.parse(process.argv[2]);
const ready = Date.now() + (config.waitMs ?? 0);
const env = { ...process.env, REZICS_STACK_PROFILE: 'qa', REZICS_QA_HOST_RESERVE_GIB: '0',
  GOAL_QA_SLOT_DIRECTORY: undefined, GOAL_QA_WAIT_DIR: undefined };
process.exit(await runHostAdmission(config.serial ? 5.5 : 1, [process.execPath, ${JSON.stringify(compiler)}, JSON.stringify(config)], {
  env, cpu: config.cpuWait, serialLock: config.serial ? ${JSON.stringify(join(directory, 'large.lock'))} : undefined,
  deadline: Number(env.REZICS_QA_MEMORY_DEADLINE), announce: () => {},
  cpuOptions: { env: { ...env, GOAL_QA_SLOT_DIRECTORY: ${JSON.stringify(join(directory, 'slots'))} },
    stateFile: ${JSON.stringify(join(directory, 'cpu.sqlite'))}, processors: 1, pollMs: 5,
    readPressure: () => Date.now() < ready ? 80 : 0, announce: console.error },
  read: async () => {
    if (!config.cpuWait) await Bun.sleep(Math.max(0, ready - Date.now()));
    return { vmTotal: 0, vmUsed: 0, hostAvailable: 64 * 1024 ** 3 };
  },
}));
`);
  const tasks = Object.fromEntries(Object.entries(cases).map(([workspace, config]) => [`${workspace}:typecheck`, {
    ...(config.commandBudgetMs === undefined ? {} : { env: { REZICS_QA_ADMITTED_COMMAND_BUDGET_MS: String(config.commandBudgetMs) } }),
    cmds: [`bun ${quote(config.legacy ? compiler : admission)} ${quote(JSON.stringify({ ...config,
      marker: join(directory, `${workspace}.pids.json`) }))}`],
  }]));
  writeFileSync(join(directory, 'Taskfile.yml'), JSON.stringify({ version: '3', tasks }));
  return directory;
}

test('one side charges overlapping active compilers once and never charges idle admission', () => {
  let now = 0;
  const budget = new TypecheckBudget(1000, 20_000, () => now);
  now = 5000;
  expect(budget.remainingMs()).toBe(1000);
  const first = budget.start();
  now += 100;
  const second = budget.start();
  now += 200;
  first();
  expect(budget.remainingMs()).toBe(700);
  now += 100;
  second();
  expect(budget.remainingMs()).toBe(600);
  now += 5000;
  expect(budget.remainingMs()).toBe(600);
  const third = budget.start();
  now += 600;
  expect(budget.remainingMs()).toBe(0);
  third();
});

test('late concurrent admission notifications preserve the union of completed active spans', () => {
  let now = 100;
  const budget = new TypecheckBudget(1000, 20_000, () => now);
  const first = budget.start();
  now = 200;
  first();
  now = 300;
  const second = budget.start(150);
  expect(budget.remainingMs()).toBe(800);
  now = 400;
  second();
  expect(budget.remainingMs()).toBe(700);
});

for (const cpuWait of [false, true]) {
  test(`${cpuWait ? 'CPU' : 'memory'} admission longer than the active budget still permits a fast compiler`, async () => {
    const directory = fixture({ queued: { waitMs: 600, cpuWait } });
    const budget = new TypecheckBudget(300, Date.now() + 5000);
    const started = Date.now();
    const result = await runTypecheck(directory, 'queued', budget);
    expect(Date.now() - started).toBeGreaterThan(600);
    expect(result, result.output).toMatchObject({ done: true, status: 0 });
    expect(budget.remainingMs()).toBeGreaterThan(0);
  }, 10_000);
}

test('the outer serial lock preserves admission reporting and the compiler budget', async () => {
  const directory = fixture({ queued: { serial: true } });
  const holder = Bun.spawn(['flock', join(directory, 'large.lock'), 'bun', '-e',
    "console.log('held'); await Bun.sleep(800)"], { stdout: 'pipe', stderr: 'inherit' });
  holders.push(holder);
  const reader = holder.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('held');
  reader.releaseLock();
  const budget = new TypecheckBudget(400, Date.now() + 5000);
  const result = await runTypecheck(directory, 'queued', budget);
  expect(result, result.output).toMatchObject({ done: true, status: 0 });
  expect(budget.remainingMs()).toBeGreaterThan(0);
}, 10_000);

test('a slow admitted compiler exhausts the budget and stops its detached descendants', async () => {
  const directory = fixture({ slow: { activeMs: 60_000, fork: true, diagnostic: true } });
  const result = await runTypecheck(directory, 'slow', new TypecheckBudget(500, Date.now() + 5000));
  expect(result, result.output).toMatchObject({ done: false, status: null });
  const pids = JSON.parse(readFileSync(join(directory, 'slow.pids.json'), 'utf8')) as number[];
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(processRunning(pid), `owned pid ${pid} survived the deadline`).toBe(false);
}, 10_000);

test('one waiting workspace does not pause another active branch compiler', async () => {
  const directory = fixture({ active: { activeMs: 2000 }, queued: { waitMs: 2000 } });
  const refusal = await typecheckGate(['active', 'queued'], (workspace, _side, budget) =>
    runTypecheck(directory, workspace, budget), 400);
  expect(refusal).toContain('type check inconclusive');
  expect(existsSync(join(directory, 'active.pids.json'))).toBe(true);
  expect(existsSync(join(directory, 'queued.pids.json'))).toBe(false);
}, 10_000);

test('sequential main comparisons spend one active budget despite their intervening admission wait', async () => {
  const directory = fixture({
    'a-branch': { diagnostic: true, status: 2 }, 'b-branch': { diagnostic: true, status: 2 },
    'a-main': { diagnostic: true, status: 2, activeMs: 250 },
    'b-main': { diagnostic: true, status: 2, activeMs: 250, waitMs: 600 },
  });
  const refusal = await typecheckGate(['a', 'b'], (workspace, side, budget) =>
    runTypecheck(directory, `${workspace}-${side}`, budget), 450);
  expect(refusal).toContain('b: the type check on main is inconclusive');
  expect(existsSync(join(directory, 'b-main.pids.json'))).toBe(true);
}, 10_000);

test('admission has a finite independent bound and starts no compiler after it expires', async () => {
  const directory = fixture({ queued: { waitMs: 10_000 } });
  const budget = new TypecheckBudget(1000, Date.now() + 250);
  const result = await runTypecheck(directory, 'queued', budget);
  expect(result).toMatchObject({ done: false, status: null });
  expect(existsSync(join(directory, 'queued.pids.json'))).toBe(false);
  expect(budget.remainingMs()).toBe(1000);
}, 10_000);

test('a real nonzero compiler result is compared and an admitted timeout or signal remains inconclusive', async () => {
  const directory = fixture({
    bad: { diagnostic: true, status: 2 }, clean: {},
    timeout: { diagnostic: true, activeMs: 2000, commandBudgetMs: 100 },
    signal: { diagnostic: true, signal: true },
  });
  const refusal = await typecheckGate(['bad'], (_workspace, side, budget) =>
    runTypecheck(directory, side === 'branch' ? 'bad' : 'clean', budget), 1000);
  expect(refusal).toContain('introduced type errors');
  for (const workspace of ['timeout', 'signal']) {
    const result = await runTypecheck(directory, workspace, new TypecheckBudget(1000, Date.now() + 5000));
    expect(result, result.output).toMatchObject({ done: false });
  }
}, 10_000);

test('known pre-protocol main comparisons preserve inherited diagnostics while missing notifications fail closed', async () => {
  const directory = fixture({ branch: { diagnostic: true, status: 2 }, old: { diagnostic: true, status: 2, legacy: true } });
  const refusal = await typecheckGate(['scripts'], (_workspace, side, budget) =>
    runTypecheck(directory, side === 'branch' ? 'branch' : 'old', budget, { legacyAdmission: side === 'main' }), 1000);
  expect(refusal).toBeUndefined();
  const unknown = await runTypecheck(directory, 'old', new TypecheckBudget(1000, Date.now() + 5000));
  expect(unknown).toMatchObject({ done: false });
}, 10_000);

test('legacy comparisons keep one wall deadline through baseline preparation and between runs', async () => {
  const directory = fixture({ first: { legacy: true }, second: { legacy: true } });
  let now = Date.now();
  const budget = new TypecheckBudget(1000, Date.now() + 5000, () => now);
  const first = await runTypecheck(directory, 'first', budget, { legacyAdmission: true });
  expect(first, first.output).toMatchObject({ done: true, status: 0 });
  now += 1001;
  const second = await runTypecheck(directory, 'second', budget, { legacyAdmission: true });
  expect(second).toMatchObject({ done: false, status: null });
  expect(second.output).toContain('no work started');
  expect(existsSync(join(directory, 'second.pids.json'))).toBe(false);

  const prepared = new TypecheckBudget(1000, Date.now() + 5000, () => now);
  now += 1001;
  const result = await runTypecheck(directory, 'second', prepared, { legacyAdmission: true });
  expect(result.output).toContain('no work started');
  expect(existsSync(join(directory, 'second.pids.json'))).toBe(false);
}, 10_000);

test('only the exact known pre-protocol host implementation can use legacy baseline mode', () => {
  const directory = fixture({});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
  git('init', '--quiet');
  const helper = join(directory, 'scripts/qa/host-admission.ts');
  mkdirSync(join(directory, 'scripts/qa'), { recursive: true });
  const old = execFileSync('git', ['show', '0510625863c6d24de1194fb68fbf503d8074336d'], { cwd: root, encoding: 'utf8' });
  const commit = () => {
    git('add', 'scripts/qa/host-admission.ts');
    git('-c', 'user.name=Gate test', '-c', 'user.email=gate-test@rezics.test', 'commit', '--quiet', '-m', 'fixture');
  };
  writeFileSync(helper, old);
  commit();
  expect(legacyTypecheckBaseline(directory, 'HEAD')).toBe(true);
  writeFileSync(helper, `${old}\nexport const admittedCommandTokenEnv = 'REZICS_QA_ADMITTED_COMMAND_TOKEN';\n`);
  commit();
  expect(legacyTypecheckBaseline(directory, 'HEAD')).toBe(false);
  writeFileSync(helper, '// unknown implementation\n');
  commit();
  expect(legacyTypecheckBaseline(directory, 'HEAD')).toBe(false);
  git('rm', '--quiet', 'scripts/qa/host-admission.ts');
  git('-c', 'user.name=Gate test', '-c', 'user.email=gate-test@rezics.test', 'commit', '--quiet', '-m', 'missing');
  expect(() => legacyTypecheckBaseline(directory, 'HEAD')).toThrow();
});
