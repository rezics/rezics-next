import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { driveGateParity, parseParityArguments, planGateParity } from '../scripts/gate-parity.ts';
import { gateParityScenario } from '../test-support/lifecycle-scenarios.ts';
import { parseSmokeArguments } from '../scripts/launch-smoke.ts';

const repository = resolve(import.meta.dir, '../../..');
const title = "a group's transport failure is retried once and a load-induced workspace is rerun within its group";

function fixture() {
  const base = join(repository, '.temp/goal');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'parity-consumer-test-'));
  const runGit = (directory: string, ...args: string[]) => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 5_000 });
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim();
  };
  const input = join(root, 'input');
  const scripts = join(root, 'delivered');
  for (const directory of [input, scripts]) {
    mkdirSync(directory);
    runGit(directory, 'init', '--quiet');
    runGit(
      directory,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Initial source',
    );
  }
  const write = (file: string, text: string) => {
    const path = join(scripts, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const commit = () => {
    runGit(scripts, 'add', '.');
    runGit(
      scripts,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '--quiet',
      '-m',
      'Delivered producer',
    );
  };
  return { root, input, scripts, write, commit, runGit, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('Lifecycle suite executes actual worker/root workspace gate parity with owned Auth placement, usable synced Git and real concurrent runtime isolation', async () => {
  const f = fixture();
  try {
    // The historical outcome is a later native obligation. Minimal mode must never fabricate its evidence.
    expect(await gateParityScenario({ root: f.input })).toMatchObject({
      status: 'unverified',
      detail: expect.stringContaining('Deferred'),
    });
    expect(parseSmokeArguments(['--parity', 'execute', '--scripts-root', f.scripts])).toEqual({
      parity: 'execute',
      scriptsRoot: f.scripts,
    });
    await expect(gateParityScenario({ root: f.input, execute: true })).rejects.toThrow('--scripts-root');
    f.write('scripts/gate.ts', "throw new Error('an older full gate must never run during discovery');");
    f.write('scripts/gate.test.ts', `// test(${JSON.stringify(title)}, () => {});`);
    f.commit();
    const plan = planGateParity({ inputRoot: f.input, scriptsRoot: f.scripts });
    expect(plan.input.commit).toBe(f.runGit(f.input, 'rev-parse', 'HEAD'));
    expect(plan.scripts.commit).toBe(f.runGit(f.scripts, 'rev-parse', 'HEAD'));
    expect(plan.scripts.commit).not.toBe(plan.input.commit);
    expect(plan.commands).toEqual([]);
    expect(plan.unavailable.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'selected-root-gate',
        'auth-placement-runner',
        'synced-usable-git',
        'concurrent-web-runtimes',
      ]),
    );
    const result = await driveGateParity({ inputRoot: f.input, scriptsRoot: f.scripts });
    expect(result.status).toBe('deferred');
    expect(result.cleanup).toBe('not-started');
    expect(result.executions).toEqual([]);
  } finally {
    f.close();
  }
});

test('Parity regression fails closed on historical missing placement/Git/shared persistence wiring and preserves exact candidate evidence and owned cleanup', async () => {
  const f = fixture();
  try {
    const sibling = join(f.root, 'keep.txt');
    writeFileSync(sibling, 'caller-owned');
    // A consumer fixture validates bounded orchestration only. Passing it must leave native parity unavailable.
    f.write('scripts/gate.ts', "throw new Error('never invoke the root gate without a supported bounded selection');");
    f.write(
      'scripts/gate.test.ts',
      `import { test, expect } from 'bun:test';\ntest(${JSON.stringify(title)}, () => expect(2 + 2).toBe(4));\n`,
    );
    f.commit();
    const options = { inputRoot: f.input, scriptsRoot: f.scripts, execute: true };
    const plan = planGateParity(options);
    let reported = 0;
    const result = await driveGateParity({
      ...options,
      report: (value) => {
        reported++;
        expect(value).toEqual(plan);
        expect(value.unavailable.some(({ id }) => id === 'synced-usable-git')).toBe(true);
      },
    });
    expect(reported).toBe(1);
    expect(result.status).toBe('unavailable');
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]!.result.status).toBe(0);
    expect(result.executions[0]!.argv).not.toContain('--workspaces');
    expect(result.cleanup).toBe('removed');
    expect(existsSync(result.executions[0]!.cwd)).toBe(false);
    expect(result.plan).toEqual(plan);
    expect(readFileSync(sibling, 'utf8')).toBe('caller-owned');
    expect(f.runGit(f.input, 'status', '--porcelain')).toBe('');
    expect(f.runGit(f.scripts, 'status', '--porcelain')).toBe('');

    f.write(
      'scripts/gate.test.ts',
      `import { test, expect } from 'bun:test';\ntest(${JSON.stringify(title)}, () => expect(true).toBe(false));\n`,
    );
    f.commit();
    const failed = await driveGateParity(options);
    expect(failed.status).toBe('failed');
    expect(failed.executions[0]!.result.status).not.toBe(0);
    expect(failed.cleanup).toBe('removed');
    expect(readFileSync(sibling, 'utf8')).toBe('caller-owned');
  } finally {
    f.close();
  }
});

test('parity requires explicit roots and refuses dirty candidates before execution', async () => {
  expect(() => parseParityArguments([])).toThrow('--input-root');
  expect(() => parseParityArguments(['--input-root', '.', '--scripts-root', '.', '--workspaces'])).toThrow('Invalid');
  const f = fixture();
  try {
    writeFileSync(join(f.input, 'uncommitted.txt'), 'not in candidate');
    const result = await driveGateParity({ inputRoot: f.input, scriptsRoot: f.scripts, execute: true });
    expect(result.status).toBe('unavailable');
    expect(result.plan.unavailable.some(({ id }) => id === 'input.clean-candidate')).toBe(true);
    expect(result.executions).toEqual([]);
    expect(result.cleanup).toBe('not-started');
  } finally {
    f.close();
  }
});
