import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTestCommandLanes } from '../scripts/isolated.ts';

// Containers starting and stopping on the host add and remove network interfaces while tests run. Chromium aborts
// in-flight requests, even to 127.0.0.1, with net::ERR_NETWORK_CHANGED whenever an interface changes, so a page whose
// client script was in flight never hydrates. Browser tests therefore run in a private network namespace that holds
// only loopback, where the host's interface changes cannot reach them.
const root = join(import.meta.dir, '..', '..', '..');
const packages = ['apps/web', 'packages/ui'];
const bun = process.execPath;
const isolatable =
  process.platform === 'linux' &&
  Bun.spawnSync(['unshare', '--user', '--map-root-user', '--net', 'true'], { stderr: 'ignore' }).exitCode === 0;

const probe = `
const names = Object.keys(require('node:os').networkInterfaces()).sort();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('ok') });
const body = await (await fetch(server.url)).text();
server.stop(true);
console.log(JSON.stringify({ names, body }));
`;

function run(pkg: string, command: string[], env: Record<string, string | undefined> = process.env) {
  const result = Bun.spawnSync([bun, 'scripts/isolated.ts', ...command], {
    cwd: join(root, pkg),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test('UI-only selections stay in the private lane with every CLI argument preserved', () => {
  const command = ['bun', 'test', '--timeout', '4000', 'tests/shell.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([{ args: command, isolate: true }]);
});

test('native-only selections run in the host lane', () => {
  const command = ['bun', 'test', '--timeout', '4000', 'tests/native/stack.host.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([{ args: command, isolate: false }]);
});

test('mixed UI and native selections preserve the original arguments in separate lanes', () => {
  const command = ['bun', 'test', '--timeout', '4000', 'tests/shell.test.ts', 'tests/native/stack.host.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([
    { args: ['bun', 'test', '--timeout', '4000', 'tests/shell.test.ts'], isolate: true },
    { args: ['bun', 'test', '--timeout', '4000', 'tests/native/stack.host.test.ts'], isolate: false },
  ]);
});

test('the recorder remains a host-lane exception in a mixed selection', () => {
  const command = ['bun', 'test', 'tests/search.test.ts', 'tests/record-script.test.ts'];
  expect(planTestCommandLanes(command, join(root, 'apps/web'))).toEqual([
    { args: ['bun', 'test', 'tests/search.test.ts'], isolate: true },
    { args: ['bun', 'test', 'tests/record-script.test.ts'], isolate: false },
  ]);
});

test('a default package selection routes all native receipts and the recorder to the host lane', () => {
  const lanes = planTestCommandLanes(['bun', 'test'], join(root, 'apps/web'));
  expect(lanes).toHaveLength(2);
  expect(lanes[0]!.isolate).toBe(true);
  expect(lanes[0]!.args.every((argument) => !argument.endsWith('.host.test.ts'))).toBe(true);
  expect(lanes[1]!.isolate).toBe(false);
  expect(lanes[1]!.args.some((argument) => argument.endsWith('native-site-foundation.host.test.ts'))).toBe(true);
  expect(lanes[1]!.args.some((argument) => argument.endsWith('record-script.test.ts'))).toBe(true);
});

for (const pkg of packages) {
  test.if(isolatable)(
    `${pkg} runs a command in a private network namespace where only loopback exists and works`,
    () => {
      const result = run(pkg, [bun, '-e', probe]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({ names: ['lo'], body: 'ok' });
    },
  );

  test.if(isolatable)(`${pkg} passes the command's exit code through`, () => {
    expect(run(pkg, [bun, '-e', 'process.exit(3)']).exitCode).toBe(3);
  });

  test.if(process.platform === 'linux')(
    `${pkg} runs the command on the host network, and says so, where it cannot isolate it`,
    () => {
      const bin = mkdtempSync(join(tmpdir(), 'no-unshare-'));
      try {
        symlinkSync(bun, join(bin, 'bun'));
        const env = { ...process.env, PATH: bin };
        const result = run(pkg, [bun, '-e', probe], env);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!).body).toBe('ok');
        expect(result.stderr.trim().split('\n').length).toBe(1);
        expect(run(pkg, [bun, '-e', 'process.exit(3)'], env).exitCode).toBe(3);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  test(`${pkg} runs its tests through the isolation script, in its check too`, async () => {
    const { scripts } = await Bun.file(join(root, pkg, 'package.json')).json();
    expect(scripts.test).toBe('bun scripts/isolated.ts bun test');
    expect(scripts.check).toContain('bun run test');
    expect(` ${scripts.check} `).not.toMatch(/[\s&;]bun test[\s&;]/);
  });
}

test('apps/web removes its owned state directory after the child exits', () => {
  const environment = { ...process.env };
  delete environment.WEB_TEST_STATE_DIR;
  const result = run(
    'apps/web',
    [bun, '-e', 'console.log(process.env.WEB_TEST_STATE_DIR); process.exit(7)'],
    environment,
  );
  expect(result.exitCode).toBe(7);
  const stateDirectory = result.stdout
    .trim()
    .split('\n')
    .find((line) => line.startsWith(join(tmpdir(), 'rezics-web-test-')));
  expect(stateDirectory).toBeDefined();
  expect(existsSync(join(stateDirectory!, '..'))).toBe(false);
});
