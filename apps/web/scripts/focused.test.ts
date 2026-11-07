import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  focusedChildTestCommand,
  focusedChildTestFile,
  focusedTestCommands,
  prepareFocusedRun,
  runFocusedCommand,
} from './focused.ts';
import { processIdentity } from '../tests/support/server-custody.ts';

const leftoverRoot = mkdtempSync(join(tmpdir(), 'rezics-web-check-leftover-'));

afterAll(() => rmSync(leftoverRoot, { recursive: true, force: true }));

test('an earlier occupied or unknown invocation does not stop a new focused check from starting', async () => {
  mkdirSync(join(leftoverRoot, 'earlier'), { recursive: true });
  writeFileSync(
    join(leftoverRoot, 'earlier', 'web-custody.json'),
    `${JSON.stringify({
      custody: 'occupied',
      nativeExitCode: null,
      failure: 'invocation custody occupied; source/returns/finalCustody/cancellation unknown',
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(leftoverRoot, 'earlier', 'prepared-descriptor.json'), '{"stale":true}\n', { mode: 0o600 });

  const commands: string[][] = [];
  const first = await runFocusedCommand(['bun', 'test', 'tests/earlier.test.ts'], {
    place: async (run) => {
      commands.push(run.command);
      return 75;
    },
  });
  expect(first).toBe(75);

  const second = await runFocusedCommand(['bun', 'test', 'tests/retry.test.ts'], {
    place: async (run) => {
      commands.push(run.command);
      return 0;
    },
  });
  expect(second).toBe(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toContain('tests/earlier.test.ts');
  expect(commands[1]).toContain('tests/retry.test.ts');
  expect(commands[0]).not.toContain('reconcile');
  expect(commands[1]).not.toContain('reconcile');
});

test('a stale leftover journal is ignored rather than treated as a focused-check refusal', async () => {
  writeFileSync(
    join(leftoverRoot, 'stale-journal.json'),
    `${JSON.stringify({ custody: 'occupied', descriptorFile: join(leftoverRoot, 'earlier', 'prepared-descriptor.json') })}\n`,
  );
  const result = await runFocusedCommand(['bun', 'test', 'tests/fresh.test.ts'], {
    place: async (run) => {
      expect(run.command).toContain('tests/fresh.test.ts');
      expect(run.command).not.toContain(join(leftoverRoot, 'earlier', 'prepared-descriptor.json'));
      return 0;
    },
  });
  expect(result).toBe(0);
});

test('explicit test files keep CLI flags but cannot share module mocks', () => {
  expect(focusedTestCommands(['bun', 'test', '--timeout', '10000', 'tests/one.test.ts', 'tests/two.test.tsx'])).toEqual(
    [
      ['bun', 'test', '--timeout', '10000', 'tests/one.test.ts'],
      ['bun', 'test', '--timeout', '10000', 'tests/two.test.tsx'],
    ],
  );
  expect(focusedTestCommands(['bun', 'test', 'tests/one.test.ts'])).toEqual([['bun', 'test', 'tests/one.test.ts']]);
  expect(focusedTestCommands(['bun', 'run', 'typecheck'])).toEqual([['bun', 'run', 'typecheck']]);
});

function fakeWebApp() {
  const root = mkdtempSync(join(tmpdir(), 'rezics-focused-selectors-'));
  const appDirectory = join(root, 'apps', 'web');
  mkdirSync(join(appDirectory, 'messages'), { recursive: true });
  mkdirSync(join(appDirectory, 'src', 'paraglide'), { recursive: true });
  writeFileSync(join(appDirectory, 'messages', 'en.json'), '{}\n');
  writeFileSync(join(appDirectory, 'src', 'paraglide', 'messages.js'), 'export {}\n');
  writeFileSync(
    join(appDirectory, 'package.json'),
    `${JSON.stringify({
      name: 'focused-selector-fixture',
      type: 'module',
      scripts: { 'generate:routes': 'true' },
    })}\n`,
  );
  return { root, appDirectory };
}

function writeMarkerTest(appDirectory: string, name: string, marker: string) {
  writeFileSync(
    join(appDirectory, `${name}.test.ts`),
    `import { appendFileSync } from 'node:fs';
import { expect, test } from 'bun:test';
test(${JSON.stringify(name)}, () => {
  appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});
  expect(true).toBe(true);
});
`,
  );
}

test('repo-relative, app-relative and absolute selectors map onto the child working directory', () => {
  const { root, appDirectory } = fakeWebApp();
  try {
    const absolute = join(appDirectory, 'tests', 'selected.test.ts');
    expect(focusedChildTestFile('apps/web/tests/selected.test.ts', appDirectory, root)).toBe('tests/selected.test.ts');
    expect(focusedChildTestFile('tests/selected.test.ts', appDirectory, root)).toBe('tests/selected.test.ts');
    expect(focusedChildTestFile(absolute, appDirectory, root)).toBe('tests/selected.test.ts');
    expect(
      focusedChildTestCommand(
        ['bun', 'test', '--timeout', '10000', 'apps/web/one.test.ts', 'two.test.ts', absolute],
        appDirectory,
        root,
      ),
    ).toEqual(['bun', 'test', '--timeout', '10000', 'one.test.ts', 'two.test.ts', 'tests/selected.test.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repo-relative, app-relative and absolute selectors execute the same child files', async () => {
  const { root, appDirectory } = fakeWebApp();
  const marker = join(root, 'ran.txt');
  writeMarkerTest(appDirectory, 'alpha', marker);
  writeMarkerTest(appDirectory, 'beta', marker);
  try {
    const selectors = ['apps/web/alpha.test.ts', 'alpha.test.ts', join(appDirectory, 'alpha.test.ts')];
    for (const selector of selectors) {
      rmSync(marker, { force: true });
      const status = await runFocusedCommand(['bun', 'test', selector], {
        appDirectory,
        place: async () => null,
      });
      expect(status).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe('alpha\n');
    }
    rmSync(marker, { force: true });
    const multi = await runFocusedCommand(
      ['bun', 'test', '--timeout', '15000', 'apps/web/alpha.test.ts', 'beta.test.ts'],
      { appDirectory, place: async () => null },
    );
    expect(multi).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('alpha\nbeta\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('canceling focused route generation settles its owned descendants', async () => {
  if (process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'rezics-focused-route-cancel-'));
  const appDirectory = join(root, 'apps', 'web');
  const pidFile = join(root, 'route-descendant.pid');
  const abort = new AbortController();
  let preparation: Promise<number> | undefined;
  try {
    mkdirSync(join(appDirectory, 'messages'), { recursive: true });
    mkdirSync(join(appDirectory, 'src', 'paraglide', 'messages'), { recursive: true });
    writeFileSync(join(appDirectory, 'messages', 'en.json'), '{}\n');
    writeFileSync(
      join(appDirectory, 'src', 'paraglide', 'messages.js'),
      `export { access_account } from './messages/access_account.js';\n`,
    );
    writeFileSync(join(appDirectory, 'src', 'paraglide', 'runtime.js'), 'export const locales = ["en"];\n');
    writeFileSync(join(appDirectory, 'src', 'paraglide', 'messages', 'access_account.js'), 'export {}\n');
    writeFileSync(
      join(appDirectory, 'package.json'),
      JSON.stringify({ scripts: { 'generate:routes': 'bun route.js' } }),
    );
    writeFileSync(
      join(appDirectory, 'route.js'),
      `import { spawn } from 'node:child_process';\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n` +
        `child.once('spawn', () => writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)));\n` +
        `process.on('SIGTERM', () => {});\n` +
        `setInterval(() => {}, 1000);\n`,
    );

    preparation = prepareFocusedRun(appDirectory, process.env, abort.signal);
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    const descendant = Number(readFileSync(pidFile, 'utf8'));
    abort.abort('SIGTERM');

    expect(await preparation).not.toBe(0);
    const identity = processIdentity(descendant);
    expect(identity === undefined || identity.state === 'Z').toBe(true);
  } finally {
    abort.abort('SIGTERM');
    if (preparation) await preparation.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
