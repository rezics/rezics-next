import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPlacedTests } from '../scripts/placed-tests.ts';
import type { withTestDatabaseLane } from '../scripts/database.ts';

function lane(events: string[]): typeof withTestDatabaseLane {
  return async (env, action) => {
    events.push('create');
    try {
      return await action({ ...env, PLACEMENT_FIXTURE: 'owned' });
    } finally {
      events.push('drop');
    }
  };
}

function temporary(): string {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(resolve(root, 'auth-placement-'));
}

test('placed runner preserves executable, caller cwd, production environment, reference and exact test filter', async () => {
  const directory = temporary();
  const events: string[] = [];
  try {
    const file = resolve(directory, 'selected.test.ts');
    writeFileSync(
      file,
      `import { expect, test } from 'bun:test';
       test('selected native case', () => {
         expect(process.cwd()).toBe(${JSON.stringify(directory)});
         expect(process.execPath).toBe(${JSON.stringify(process.execPath)});
         expect(process.env.NODE_ENV).toBe('production');
         expect(process.env.CONSENT_OUTCOME_REFERENCE).toBe('correct');
         expect(process.env.SPEC_STRICT).toBe('1');
         expect(process.env.PLACEMENT_FIXTURE).toBe('owned');
         console.info('selected native receipt');
       });
       test('unselected wrong case', () => { throw new Error('filter was lost'); });`,
    );
    const result = await runPlacedTests(
      [process.execPath, 'test', file, '--test-name-pattern', '^selected native case$'],
      {
        cwd: directory,
        env: { ...process.env, NODE_ENV: 'production', CONSENT_OUTCOME_REFERENCE: 'correct', SPEC_STRICT: '1' },
      },
      lane(events),
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('selected native receipt');
    expect(result.output).toMatch(/\b1 pass\b/);
    expect(result.output).toMatch(/\b0 fail\b/);
    expect(result.output).not.toContain('filter was lost');
    expect(events).toEqual(['create', 'drop']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('normal nonzero child status and both output streams survive lane cleanup', async () => {
  const events: string[] = [];
  const result = await runPlacedTests(
    [process.execPath, '--eval', "console.log('stdout receipt'); console.error('stderr receipt'); process.exit(7)"],
    {},
    lane(events),
  );
  expect(result).toEqual({ code: 7, output: 'stdout receipt\nstderr receipt\n' });
  expect(events).toEqual(['create', 'drop']);
});

test('a spawn failure still drops its owned lane', async () => {
  const events: string[] = [];
  await expect(runPlacedTests(['/does-not-exist/auth-test-bun'], {}, lane(events))).rejects.toThrow();
  expect(events).toEqual(['create', 'drop']);
});

test('timeout ends the child tree before cleanup, including descendants holding output open', async () => {
  const events: string[] = [];
  const result = await runPlacedTests(
    [
      process.execPath,
      '--eval',
      `Bun.spawn([process.execPath, '--eval', 'setInterval(() => {}, 1000)'], {
         stdout: 'inherit', stderr: 'inherit' });
       console.info('tree started'); setInterval(() => {}, 1000);`,
    ],
    { timeout: 1_000 },
    lane(events),
  );
  expect(result.code).toBe(124);
  expect(result.output).toContain('tree started');
  expect(events).toEqual(['create', 'drop']);
});

test('forwarded termination preserves signal status and drops the lane after exit', async () => {
  const events: string[] = [];
  const result = await runPlacedTests(
    [process.execPath, '--eval', "process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000)"],
    {},
    lane(events),
  );
  expect(result.code).toBe(143);
  expect(events).toEqual(['create', 'drop']);
});

test('a normal child exit also ends descendants before returning its lane', async () => {
  const events: string[] = [];
  const result = await runPlacedTests(
    [
      process.execPath,
      '--eval',
      `const child = Bun.spawn([process.execPath, '--eval', 'setInterval(() => {}, 1000)'], {
         stdout: 'inherit', stderr: 'inherit' });
       child.unref(); process.exit(9);`,
    ],
    { timeout: 1_000 },
    lane(events),
  );
  expect(result.code).toBe(9);
  expect(events).toEqual(['create', 'drop']);
});

test('direct unplaced and foreign-owner database access stay refused before any Docker call', async () => {
  const databaseModule = new URL('../scripts/database.ts', import.meta.url).href;
  for (const owner of [undefined, 'foreign-owner']) {
    const env = { ...process.env, AUTH_CHECK_CONTAINER: 'foreign-container', DATABASE_URL: 'postgres://foreign/db' };
    delete env.AUTH_CHECK_LANE_OWNER;
    if (owner) env.AUTH_CHECK_LANE_OWNER = owner;
    const child = Bun.spawn(
      [
        process.execPath,
        '--eval',
        `import { ownDatabase, testDatabase, withTestDatabaseLane } from ${JSON.stringify(databaseModule)};
         for (const open of [ownDatabase, testDatabase]) {
           try { open(); process.exit(91); }
           catch (error) { if (!error.message.includes('require placement')) throw error; }
         }
         try { await withTestDatabaseLane(process.env, async () => { process.exit(92); }); process.exit(93); }
         catch (error) { if (!error.message.includes('directly owned check lane')) throw error; }
         console.info('unplaced and foreign owner refused');`,
      ],
      { env, stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, output, errors] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, errors).toBe(0);
    expect(output).toContain('unplaced and foreign owner refused');
  }
});
